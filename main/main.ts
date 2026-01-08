import "dotenv/config";
import * as electron from "electron";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";

const { app, BrowserWindow, globalShortcut, ipcMain, screen, powerMonitor, desktopCapturer } = electron;

type PrimaryMode = "serious" | "active" | "idle";
type EffectiveMode = "serious" | "active" | "idle";
type AppCategory = "work" | "casual" | "unknown";
type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  meta?: {
    type?: "proactive";
  };
};

type ImageContentPart = {
  type: "image_url";
  image_url: {
    url: string;
  };
};

type TextContentPart = {
  type: "text";
  text: string;
};

type OpenAIContent = string | Array<TextContentPart | ImageContentPart>;

type OpenAIMessage = {
  role: "system" | "user" | "assistant";
  content: OpenAIContent;
  meta?: {
    type?: "proactive";
  };
};

type ModeState = {
  primaryMode: PrimaryMode;
  effectiveMode: EffectiveMode;
  effectiveReason: string;
  idleMs: number;
  isIdle: boolean;
  focusLocked: boolean;
  lastUserSendAt: number; // epoch ms
  activeApp: string | null;
  appCategory: AppCategory;
};

type Memory = {
  updatedAt: number;
  facts: string[]; // simple v1, expandable later
};

let mainWindow: electron.BrowserWindow | null = null;
let pendingScreenshot: string | null = null;

const execFileAsync = promisify(execFile);

// -------------------- STORAGE --------------------

function getDataDir() {
  const dir = app.getPath("userData");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getHistoryPath() {
  return path.join(getDataDir(), "chat_history.json");
}

function readHistory(): ChatMessage[] {
  try {
    const p = getHistoryPath();
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant" || m.role === "system") &&
        typeof m.content === "string"
    );
  } catch {
    return [];
  }
}

function writeHistory(messages: ChatMessage[]) {
  fs.writeFileSync(getHistoryPath(), JSON.stringify(messages, null, 2), "utf-8");
}

// -------------------- MEMORY (PERSISTENT) --------------------

function getMemoryPath() {
  return path.join(getDataDir(), "memory.json");
}

function readMemory(): Memory {
  try {
    const p = getMemoryPath();
    if (!fs.existsSync(p)) return { updatedAt: Date.now(), facts: [] };

    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw);

    const facts = Array.isArray(parsed?.facts) ? parsed.facts.map(String) : [];
    const updatedAt = Number(parsed?.updatedAt) || Date.now();

    return { updatedAt, facts };
  } catch {
    return { updatedAt: Date.now(), facts: [] };
  }
}

function writeMemory(mem: Memory) {
  const next: Memory = { ...mem, updatedAt: Date.now() };
  fs.writeFileSync(getMemoryPath(), JSON.stringify(next, null, 2), "utf-8");
}

// -------------------- SETTINGS (PERSISTENT) --------------------

type Settings = {
  primaryMode: PrimaryMode;
};

const DEFAULT_PRIMARY_MODE: PrimaryMode = "active";

function getSettingsPath() {
  return path.join(getDataDir(), "settings.json");
}

function isPrimaryMode(value: unknown): value is PrimaryMode {
  return value === "serious" || value === "active" || value === "idle";
}

function readSettings(): Settings {
  try {
    const p = getSettingsPath();
    if (!fs.existsSync(p)) return { primaryMode: DEFAULT_PRIMARY_MODE };
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw);
    const primaryMode = isPrimaryMode(parsed?.primaryMode)
      ? parsed.primaryMode
      : DEFAULT_PRIMARY_MODE;
    return { primaryMode };
  } catch {
    return { primaryMode: DEFAULT_PRIMARY_MODE };
  }
}

function writeSettings(settings: Settings) {
  fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2), "utf-8");
}

// -------------------- ACTIVE APP DETECTION --------------------

const WORK_APP_HINTS = [
  "code",
  "visual studio code",
  "code-insiders",
  "xcode",
  "intellij",
  "pycharm",
  "webstorm",
  "notion",
  "obsidian",
  "word",
  "winword",
  "excel",
  "powerpoint",
  "chrome",
  "google chrome",
  "chromium",
  "brave",
  "safari",
  "firefox",
  "edge",
  "msedge",
  "arc",
  "opera",
  "vivaldi",
  "teams",
  "slack",
  "terminal",
  "iterm",
];

const CASUAL_APP_HINTS = [
  "spotify",
  "steam",
  "netflix",
  "youtube",
];

function normalizeProcessName(name: string | null): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase().replace(/\.exe$/, "").replace(/\.app$/, "");
}

function matchesAny(name: string, hints: string[]) {
  return hints.some((hint) => name.includes(hint));
}

function classifyApp(processName: string | null): AppCategory {
  if (!processName) return "unknown";
  if (matchesAny(processName, CASUAL_APP_HINTS)) return "casual";
  if (matchesAny(processName, WORK_APP_HINTS)) return "work";
  return "unknown";
}

async function getActiveAppName(): Promise<string | null> {
  try {
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("osascript", [
        "-e",
        'tell application "System Events" to get name of (first application process whose frontmost is true)',
      ]);
      const name = stdout.trim();
      return name.length > 0 ? name : null;
    }

    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("powershell", [
        "-NoProfile",
        "-Command",
        [
          "Add-Type @\"",
          "using System;",
          "using System.Runtime.InteropServices;",
          "public class Win32 {",
          "  [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
          "  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);",
          "}",
          "\"@;",
          "$hwnd = [Win32]::GetForegroundWindow();",
          "$pid = 0;",
          "[Win32]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null;",
          "if ($pid -gt 0) { (Get-Process -Id $pid).ProcessName }",
        ].join(" "),
      ]);
      const name = stdout.trim();
      return name.length > 0 ? name : null;
    }

    if (process.platform === "linux") {
      const { stdout: pidOut } = await execFileAsync("xdotool", ["getwindowfocus", "getwindowpid"]);
      const pid = pidOut.trim();
      if (!pid) return null;
      const { stdout } = await execFileAsync("ps", ["-p", pid, "-o", "comm="]);
      const name = stdout.trim();
      return name.length > 0 ? name : null;
    }
  } catch {
    return null;
  }

  return null;
}

let activeAppCheckInFlight = false;

async function refreshActiveApp() {
  if (activeAppCheckInFlight) return;
  activeAppCheckInFlight = true;
  try {
    const name = await getActiveAppName();
    const normalized = normalizeProcessName(name);
    modeState.activeApp = name ?? null;
    modeState.appCategory = classifyApp(normalized);
  } finally {
    activeAppCheckInFlight = false;
  }
}

// -------------------- MODE ENGINE --------------------
// Safe + non-creepy:
// - Idle time from OS (no keylogging, no content reading)
// - Active app process name only (no window content)
// - User can lock focus manually
// - Recently chatted => serious for a while
// - Idle => idle

const modeState: ModeState = {
  primaryMode: DEFAULT_PRIMARY_MODE,
  effectiveMode: "active",
  effectiveReason: "primary setting: Hang out",
  idleMs: 0,
  isIdle: false,
  focusLocked: false,
  lastUserSendAt: 0,
  activeApp: null,
  appCategory: "unknown",
};

const IDLE_THRESHOLD_MS = 1 * 60 * 1000; // idle >= 1m => idle
const SERIOUS_AFTER_SEND_MS = 2 * 60 * 1000; // after user sends => serious for 2m
const MODE_BROADCAST_INTERVAL_MS = 1500;

function computeEffectiveMode(now: number) {
  const idleMs = powerMonitor.getSystemIdleTime() * 1000;
  modeState.idleMs = idleMs;
  modeState.isIdle = idleMs >= IDLE_THRESHOLD_MS;

  if (modeState.primaryMode === "idle") {
    return { mode: "idle" as const, reason: "primary setting: Quiet" };
  }

  if (modeState.primaryMode === "serious") {
    return { mode: "serious" as const, reason: "primary setting: Focus" };
  }

  if (modeState.focusLocked) return { mode: "serious" as const, reason: "focus lock enabled" };

  const recentlySent =
    modeState.lastUserSendAt > 0 && now - modeState.lastUserSendAt < SERIOUS_AFTER_SEND_MS;
  if (recentlySent) return { mode: "serious" as const, reason: "recent activity" };

  if (modeState.appCategory === "work") {
    return { mode: "serious" as const, reason: "work app detected" };
  }
  if (modeState.appCategory === "casual") {
    return { mode: "active" as const, reason: "casual app detected" };
  }

  if (modeState.isIdle) return { mode: "idle" as const, reason: "system inactive" };

  // Default while active: companion-friendly
  return { mode: "active" as const, reason: "primary setting: Hang out" };
}

function broadcastMode() {
  if (!mainWindow) return;
  mainWindow.webContents.send("mode:update", { ...modeState });
}

// -------------------- PROACTIVE PRESENCE --------------------

const PROACTIVE_IDLE_THRESHOLD_MS = 3 * 60 * 1000;
const PROACTIVE_RATE_LIMIT_MS = 50 * 60 * 1000;
const PROACTIVE_RETRY_MS = 2 * 60 * 1000;
const PROACTIVE_TYPING_GRACE_MS = 3000;

const PROACTIVE_TEMPLATES = [
  "I'm here if you want to chat.",
  "I'm around if you need anything.",
  "I'll be here if you need me.",
  "Feel free to pull me in anytime.",
  "I'm here whenever you want a quick check-in.",
];

let proactiveTimer: NodeJS.Timeout | null = null;
let lastProactiveAt = 0;
let lastProactiveMessage: string | null = null;
let lastUserActivityAt = Date.now();
let isUserTyping = false;
let typingTimer: NodeJS.Timeout | null = null;

function clearProactiveTimer() {
  if (!proactiveTimer) return;
  clearTimeout(proactiveTimer);
  proactiveTimer = null;
}

function scheduleProactiveCheck(delayMs: number) {
  clearProactiveTimer();
  proactiveTimer = setTimeout(() => {
    proactiveTimer = null;
    void attemptProactiveMessage();
  }, delayMs);
}

function noteUserActivity() {
  lastUserActivityAt = Date.now();
  clearProactiveTimer();
  scheduleProactiveCheck(PROACTIVE_IDLE_THRESHOLD_MS);
}

function noteUserTyping() {
  isUserTyping = true;
  if (typingTimer) clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    isUserTyping = false;
  }, PROACTIVE_TYPING_GRACE_MS);
  noteUserActivity();
}

function pickProactiveTemplate() {
  const options = PROACTIVE_TEMPLATES.filter((template) => template !== lastProactiveMessage);
  const pool = options.length > 0 ? options : PROACTIVE_TEMPLATES;
  const choice = pool[Math.floor(Math.random() * pool.length)];
  lastProactiveMessage = choice;
  return choice;
}

function canSendProactive(now: number) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (!mainWindow.isVisible()) return false;
  if (modeState.primaryMode !== "active") return false;
  if (modeState.effectiveMode !== "active") return false;
  if (modeState.focusLocked) return false;
  if (isUserTyping) return false;

  const systemIdleMs = powerMonitor.getSystemIdleTime() * 1000;
  if (systemIdleMs < PROACTIVE_IDLE_THRESHOLD_MS) return false;
  if (now - lastUserActivityAt < PROACTIVE_IDLE_THRESHOLD_MS) return false;
  if (now - lastProactiveAt < PROACTIVE_RATE_LIMIT_MS) return false;

  return true;
}

async function attemptProactiveMessage() {
  const now = Date.now();
  if (!canSendProactive(now)) {
    const rateLimitRemaining = Math.max(0, PROACTIVE_RATE_LIMIT_MS - (now - lastProactiveAt));
    scheduleProactiveCheck(Math.max(PROACTIVE_RETRY_MS, rateLimitRemaining));
    return;
  }

  const content = pickProactiveTemplate();
  const proactiveMessage: ChatMessage = { role: "assistant", content, meta: { type: "proactive" } };

  const history = readHistory();
  writeHistory([...history, proactiveMessage]);

  if (mainWindow) {
    mainWindow.webContents.send("proactive:message", proactiveMessage);
  }

  lastProactiveAt = now;
  scheduleProactiveCheck(PROACTIVE_RATE_LIMIT_MS);
}

// -------------------- PROMPT ROUTING --------------------

function buildSystemPrompt(state: ModeState, mem: Memory) {
  const formatLabel = (mode: PrimaryMode | EffectiveMode) => {
    if (mode === "serious") return "Focus";
    if (mode === "active") return "Hang out";
    return "Quiet";
  };

  const contextHeader = [
    `Context: primaryMode=${state.primaryMode}`,
    `effectiveMode=${state.effectiveMode}`,
    `effectiveReason=${state.effectiveReason}`,
    `focusLocked=${state.focusLocked}`,
    `idleMinutes=${Math.floor(state.idleMs / 60000)}`,
    `activeApp=${state.activeApp ?? "unknown"}`,
    `appCategory=${state.appCategory}`,
  ].join(" | ");

  const modeStatusBlock = [
    "Status:",
    `- Primary setting: ${formatLabel(state.primaryMode)}`,
    `- Current behavior: ${formatLabel(state.effectiveMode)}`,
    `- Reason: ${state.effectiveReason}`,
    "",
    "Rules:",
    "- The user can always change the primary setting using the UI.",
    "- You must never say the user cannot change this setting.",
    "- You must never contradict the setting values above.",
    "- When asked about your setting or behavior, REPORT them exactly as stated.",
    "- If unsure, defer to the UI state.",
    '- Never use the word "mode" with the user.',
    "- Quiet is a behavior policy: no proactive messages, minimal tone, still accurate and calm responses.",
    '- When describing Quiet, say: "I won’t initiate conversation, but I can respond if you ask."',
  ].join("\n");

  const memoryBlock =
    mem.facts.length > 0
      ? `Memory (persistent facts):\n- ${mem.facts.join("\n- ")}`
      : "Memory (persistent facts):\n- (none yet)";

  if (state.effectiveMode === "serious") {
    return [
      contextHeader,
      memoryBlock,
      modeStatusBlock,
      "",
      "You are Sidekick in Focus.",
      "Rules:",
      "- Be concise and structured.",
      "- Prefer bullet points and steps.",
      "- No jokes or playful banter unless the user explicitly asks.",
      "- Do not send proactive messages or nudges.",
      "- If something is ambiguous, ask ONE clarifying question.",
    ].join("\n");
  }

  if (state.effectiveMode === "idle") {
    return [
      contextHeader,
      memoryBlock,
      modeStatusBlock,
      "",
      "You are Sidekick in Quiet.",
      "Rules:",
      "- Respond only when the user explicitly asks.",
      "- Keep responses minimal, calm, and low-energy.",
      "- Do not send proactive messages, nudges, or suggestions.",
      "- Avoid jokes or playful banter unless the user explicitly asks.",
    ].join("\n");
  }

  return [
    contextHeader,
    memoryBlock,
    modeStatusBlock,
    "",
    "You are Sidekick in Hang out.",
    "Rules:",
    "- Keep it short, light, and friendly.",
    "- Light banter is allowed if the user seems open to it.",
    "- Avoid long lists unless asked.",
    "- Do not be clingy or overly emotional.",
    "- Do not send proactive messages or nudges.",
  ].join("\n");
}

async function captureOneShotScreenshot(): Promise<string> {
  const primaryDisplay = screen.getPrimaryDisplay();
  const scaleFactor = primaryDisplay.scaleFactor || 1;
  const { width, height } = primaryDisplay.size;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.max(1, Math.round(width * scaleFactor)),
      height: Math.max(1, Math.round(height * scaleFactor)),
    },
  });

  const primarySource =
    sources.find((source) => source.display_id === String(primaryDisplay.id)) ?? sources[0];

  if (!primarySource) {
    throw new Error("No screen sources available");
  }

  return primarySource.thumbnail.toDataURL();
}

// -------------------- WINDOW --------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 560,
    show: true,
    frame: false,
    alwaysOnTop: true,
    transparent: true,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const url =
    process.env.VITE_DEV_SERVER_URL ||
    `file://${path.join(__dirname, "../renderer/index.html")}`;

  mainWindow.loadURL(url);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// -------------------- TOGGLE WINDOW --------------------

function toggleWindow() {
  if (!mainWindow) return;

  if (mainWindow.isVisible()) {
    mainWindow.hide();
    return;
  }

  const { width, height } = mainWindow.getBounds();
  const { workArea } = screen.getPrimaryDisplay();

  mainWindow.setPosition(
    Math.round(workArea.x + (workArea.width - width) / 2),
    Math.round(workArea.y + workArea.height * 0.25)
  );

  mainWindow.show();
  mainWindow.focus();
}

// -------------------- APP --------------------

async function runModeLoop() {
  await refreshActiveApp();
  const now = Date.now();
  const next = computeEffectiveMode(now);
  if (next.mode !== modeState.effectiveMode || next.reason !== modeState.effectiveReason) {
    modeState.effectiveMode = next.mode;
    modeState.effectiveReason = next.reason;
  }
  broadcastMode();
}

app.whenReady().then(() => {
  createWindow();
  globalShortcut.register("Control+Shift+Space", toggleWindow);
  if (mainWindow) {
    mainWindow.on("focus", () => noteUserActivity());
  }

  const settings = readSettings();
  modeState.primaryMode = settings.primaryMode;
  const next = computeEffectiveMode(Date.now());
  modeState.effectiveMode = next.mode;
  modeState.effectiveReason = next.reason;
  broadcastMode();

  runModeLoop();
  scheduleProactiveCheck(PROACTIVE_IDLE_THRESHOLD_MS);
  setInterval(() => {
    void runModeLoop();
  }, MODE_BROADCAST_INTERVAL_MS);

  powerMonitor.on("lock-screen", () => {
    if (modeState.primaryMode === "active") {
      modeState.effectiveMode = "idle";
      modeState.effectiveReason = "screen locked";
    } else if (modeState.primaryMode === "serious") {
      modeState.effectiveMode = "serious";
      modeState.effectiveReason = "primary setting: Focus";
    } else {
      modeState.effectiveMode = "idle";
      modeState.effectiveReason = "primary setting: Quiet";
    }
    broadcastMode();
  });
});

app.on("window-all-closed", () => {});

// -------------------- IPC: HISTORY --------------------
// "New chat" resets UI history, but memory stays.

ipcMain.handle("history:load", async () => readHistory());

ipcMain.handle("history:clear", async () => {
  writeHistory([]);
  return true;
});

// -------------------- IPC: MEMORY --------------------

ipcMain.handle("memory:get", async () => readMemory());

ipcMain.handle("memory:addFact", async (_e, fact: string) => {
  const trimmed = (fact || "").trim();
  const mem = readMemory();
  if (!trimmed) return mem;

  if (!mem.facts.includes(trimmed)) {
    mem.facts.unshift(trimmed);
    mem.facts = mem.facts.slice(0, 50); // cap
    writeMemory(mem);
  }
  return readMemory();
});

// -------------------- IPC: MODE --------------------

ipcMain.handle("mode:get", async () => ({ ...modeState }));

ipcMain.handle("mode:setPrimary", async (_event, nextMode: PrimaryMode) => {
  if (!isPrimaryMode(nextMode)) return { ...modeState };
  modeState.primaryMode = nextMode;
  writeSettings({ primaryMode: nextMode });
  const next = computeEffectiveMode(Date.now());
  modeState.effectiveMode = next.mode;
  modeState.effectiveReason = next.reason;
  broadcastMode();
  noteUserActivity();
  return { ...modeState };
});

ipcMain.handle("mode:toggleFocusLock", async () => {
  modeState.focusLocked = !modeState.focusLocked;
  const next = computeEffectiveMode(Date.now());
  modeState.effectiveMode = next.mode;
  modeState.effectiveReason = next.reason;
  broadcastMode();
  noteUserActivity();
  return { ...modeState };
});

ipcMain.handle("mode:userSent", async () => {
  modeState.lastUserSendAt = Date.now();
  const next = computeEffectiveMode(Date.now());
  modeState.effectiveMode = next.mode;
  modeState.effectiveReason = next.reason;
  broadcastMode();
  noteUserActivity();
  return { ...modeState };
});

// -------------------- IPC: PROACTIVE PRESENCE --------------------

ipcMain.on("proactive:activity", () => {
  noteUserActivity();
});

ipcMain.on("proactive:typing", () => {
  noteUserTyping();
});

// -------------------- IPC: SCREEN LOOK --------------------

ipcMain.handle("screen:look", async () => {
  if (modeState.effectiveMode !== "active") {
    return { ok: false, reason: "not_available" };
  }

  const dataUrl = await captureOneShotScreenshot();
  pendingScreenshot = dataUrl;

  return { ok: true };
});

ipcMain.handle("screen:discard", async () => {
  pendingScreenshot = null;
  return true;
});

// -------------------- IPC: AI CHAT --------------------

ipcMain.handle("ai:chat", async (_event, messages: ChatMessage[]) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  // mark activity
  modeState.lastUserSendAt = Date.now();
  const nextMode = computeEffectiveMode(Date.now());
  modeState.effectiveMode = nextMode.mode;
  modeState.effectiveReason = nextMode.reason;
  broadcastMode();

  // Persist current chat thread (excluding system)
  writeHistory(messages.filter((m) => m.role !== "system"));

  const mem = readMemory();
  const systemPrompt = buildSystemPrompt(modeState, mem);
  const imageSystemNote =
    "The user provided an image for this single response. The image is user-provided, one-shot, and must not be assumed to persist. Do not reference any past images.";

  const oneShotScreenshot = pendingScreenshot;
  pendingScreenshot = null;
  const canUseScreenshot = Boolean(oneShotScreenshot) && modeState.effectiveMode === "active";

  const chatMessages: OpenAIMessage[] = messages
    .filter((m) => m.role !== "system" && m.meta?.type !== "proactive")
    .map((m) => ({ role: m.role, content: m.content, meta: m.meta }));

  if (canUseScreenshot) {
    for (let i = chatMessages.length - 1; i >= 0; i -= 1) {
      if (chatMessages[i].role === "user" && typeof chatMessages[i].content === "string") {
        chatMessages[i].content = [
          { type: "text", text: chatMessages[i].content },
          { type: "image_url", image_url: { url: oneShotScreenshot as string } },
        ];
        break;
      }
    }
  }

  const payload: OpenAIMessage[] = [
    { role: "system", content: systemPrompt },
    ...(canUseScreenshot ? [{ role: "system", content: imageSystemNote }] : []),
    ...chatMessages,
  ];

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature:
        modeState.effectiveMode === "active" ? 0.9 : modeState.effectiveMode === "idle" ? 0.2 : 0.4,
      messages: payload,
    }),
  });

  const data: any = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "OpenAI request failed");

  const assistantText: string = data?.choices?.[0]?.message?.content ?? "";

  const nextHistory: ChatMessage[] = [
    ...messages.filter((m) => m.role !== "system"),
    { role: "assistant", content: assistantText },
  ];

  writeHistory(nextHistory);

  return assistantText;
});
