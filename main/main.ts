import "dotenv/config";
import * as electron from "electron";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";

const { app, BrowserWindow, globalShortcut, ipcMain, screen, powerMonitor } = electron;

type PrimaryMode = "serious" | "active" | "idle";
type EffectiveMode = "serious" | "active" | "idle";
type AppCategory = "work" | "casual" | "unknown";
type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

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
  effectiveReason: "primary mode active",
  idleMs: 0,
  isIdle: false,
  focusLocked: false,
  lastUserSendAt: 0,
  activeApp: null,
  appCategory: "unknown",
};

const IDLE_THRESHOLD_MS = 2 * 60 * 1000; // idle >= 2m => idle
const SERIOUS_AFTER_SEND_MS = 2 * 60 * 1000; // after user sends => serious for 2m
const MODE_BROADCAST_INTERVAL_MS = 1500;

function computeEffectiveMode(now: number) {
  const idleMs = powerMonitor.getSystemIdleTime() * 1000;
  modeState.idleMs = idleMs;
  modeState.isIdle = idleMs >= IDLE_THRESHOLD_MS;

  if (modeState.primaryMode === "idle") {
    return { mode: "idle" as const, reason: "primary mode set to idle" };
  }

  if (modeState.primaryMode === "serious") {
    return { mode: "serious" as const, reason: "primary mode set to serious" };
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

  if (modeState.isIdle) return { mode: "idle" as const, reason: "system idle" };

  // Default while active: companion-friendly
  return { mode: "active" as const, reason: "primary mode active" };
}

function broadcastMode() {
  if (!mainWindow) return;
  mainWindow.webContents.send("mode:update", { ...modeState });
}

// -------------------- PROMPT ROUTING --------------------

function buildSystemPrompt(state: ModeState, mem: Memory) {
  const contextHeader = [
    `Context: primaryMode=${state.primaryMode}`,
    `effectiveMode=${state.effectiveMode}`,
    `effectiveReason=${state.effectiveReason}`,
    `focusLocked=${state.focusLocked}`,
    `idleMinutes=${Math.floor(state.idleMs / 60000)}`,
    `activeApp=${state.activeApp ?? "unknown"}`,
    `appCategory=${state.appCategory}`,
  ].join(" | ");

  const memoryBlock =
    mem.facts.length > 0
      ? `Memory (persistent facts):\n- ${mem.facts.join("\n- ")}`
      : "Memory (persistent facts):\n- (none yet)";

  if (state.effectiveMode === "serious") {
    return [
      contextHeader,
      memoryBlock,
      "",
      "You are Sidekick, a serious, high-utility desktop assistant.",
      "Rules:",
      "- Be concise and structured.",
      "- Prefer bullet points and steps.",
      "- No jokes or playful banter unless the user explicitly asks.",
      "- Do not send proactive messages or nudges.",
      "- If the user asks about focus lock or mode, answer using the Context header.",
      "- If something is ambiguous, ask ONE clarifying question.",
    ].join("\n");
  }

  if (state.effectiveMode === "idle") {
    return [
      contextHeader,
      memoryBlock,
      "",
      "You are Sidekick, a calm, quiet desktop assistant.",
      "Rules:",
      "- Respond only when the user explicitly asks.",
      "- Keep responses minimal, calm, and low-energy.",
      "- Do not send proactive messages, nudges, or suggestions.",
      "- Avoid jokes or playful banter unless the user explicitly asks.",
      "- If the user asks about focus lock or mode, answer using the Context header.",
    ].join("\n");
  }

  return [
    contextHeader,
    memoryBlock,
    "",
    "You are Sidekick, a warm, playful desktop companion.",
    "Rules:",
    "- Keep it short, light, and friendly.",
    "- Offer small, low-pressure suggestions.",
    "- Avoid long lists unless asked.",
    "- Do not be clingy or overly emotional.",
    "- Do not send proactive messages or nudges.",
    "- If the user asks about focus lock or mode, answer using the Context header.",
  ].join("\n");
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

  const settings = readSettings();
  modeState.primaryMode = settings.primaryMode;
  const next = computeEffectiveMode(Date.now());
  modeState.effectiveMode = next.mode;
  modeState.effectiveReason = next.reason;
  broadcastMode();

  runModeLoop();
  setInterval(() => {
    void runModeLoop();
  }, MODE_BROADCAST_INTERVAL_MS);

  powerMonitor.on("lock-screen", () => {
    if (modeState.primaryMode === "active") {
      modeState.effectiveMode = "idle";
      modeState.effectiveReason = "screen locked";
    } else if (modeState.primaryMode === "serious") {
      modeState.effectiveMode = "serious";
      modeState.effectiveReason = "primary mode set to serious";
    } else {
      modeState.effectiveMode = "idle";
      modeState.effectiveReason = "primary mode set to idle";
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
  return { ...modeState };
});

ipcMain.handle("mode:toggleFocusLock", async () => {
  modeState.focusLocked = !modeState.focusLocked;
  const next = computeEffectiveMode(Date.now());
  modeState.effectiveMode = next.mode;
  modeState.effectiveReason = next.reason;
  broadcastMode();
  return { ...modeState };
});

ipcMain.handle("mode:userSent", async () => {
  modeState.lastUserSendAt = Date.now();
  const next = computeEffectiveMode(Date.now());
  modeState.effectiveMode = next.mode;
  modeState.effectiveReason = next.reason;
  broadcastMode();
  return { ...modeState };
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

  const payload: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...messages.filter((m) => m.role !== "system"),
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
