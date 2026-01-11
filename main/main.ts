import "dotenv/config";
import * as electron from "electron";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";

const { app, BrowserWindow, globalShortcut, ipcMain, screen, powerMonitor, desktopCapturer } =
  electron;

type AppCategory = "work" | "casual" | "unknown";
type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | ChatContentPart[];
  meta?: {
    type?: "proactive";
  };
};

type AssistantContext = {
  idleMs: number;
  activeApp: string | null;
  appCategory: AppCategory;
  lastUserActivityAt: number;
};

type Memory = {
  updatedAt: number;
  facts: string[];
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

const assistantContext: AssistantContext = {
  idleMs: 0,
  activeApp: null,
  appCategory: "unknown",
  lastUserActivityAt: Date.now(),
};

async function refreshActiveApp() {
  if (activeAppCheckInFlight) return;
  activeAppCheckInFlight = true;
  try {
    const name = await getActiveAppName();
    const normalized = normalizeProcessName(name);
    assistantContext.activeApp = name ?? null;
    assistantContext.appCategory = classifyApp(normalized);
  } finally {
    activeAppCheckInFlight = false;
  }
}

function refreshIdleTime() {
  assistantContext.idleMs = powerMonitor.getSystemIdleTime() * 1000;
}

// -------------------- PROACTIVE PRESENCE --------------------

const PROACTIVE_IDLE_MIN_MS = 3 * 60 * 1000;
const PROACTIVE_IDLE_MAX_MS = 5 * 60 * 1000;
const PROACTIVE_RATE_LIMIT_MIN_MS = 45 * 60 * 1000;
const PROACTIVE_RATE_LIMIT_MAX_MS = 60 * 60 * 1000;
const PROACTIVE_RETRY_MS = 2 * 60 * 1000;
const PROACTIVE_TYPING_GRACE_MS = 3000;

const PROACTIVE_TEMPLATES = [
  "Mm. I'm here if you need me.",
  "Just letting you know I'm around.",
  "I'm nearby if you want a quick check-in.",
  "I'm around if you'd like a hand.",
];

let proactiveTimer: NodeJS.Timeout | null = null;
let lastProactiveAt = 0;
let lastProactiveMessage: string | null = null;
let isUserTyping = false;
let typingTimer: NodeJS.Timeout | null = null;
let proactiveIdleThresholdMs = PROACTIVE_IDLE_MIN_MS;
let proactiveRateLimitMs = PROACTIVE_RATE_LIMIT_MIN_MS;

function randomBetween(min: number, max: number) {
  return Math.floor(min + Math.random() * (max - min));
}

function refreshProactiveThresholds() {
  proactiveIdleThresholdMs = randomBetween(PROACTIVE_IDLE_MIN_MS, PROACTIVE_IDLE_MAX_MS);
  proactiveRateLimitMs = randomBetween(PROACTIVE_RATE_LIMIT_MIN_MS, PROACTIVE_RATE_LIMIT_MAX_MS);
}

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
  assistantContext.lastUserActivityAt = Date.now();
  refreshProactiveThresholds();
  clearProactiveTimer();
  scheduleProactiveCheck(proactiveIdleThresholdMs);
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
  if (isUserTyping) return false;

  if (assistantContext.idleMs < proactiveIdleThresholdMs) return false;
  if (now - assistantContext.lastUserActivityAt < proactiveIdleThresholdMs) return false;
  if (now - lastProactiveAt < proactiveRateLimitMs) return false;

  return true;
}

async function attemptProactiveMessage() {
  const now = Date.now();
  if (!canSendProactive(now)) {
    const rateLimitRemaining = Math.max(0, proactiveRateLimitMs - (now - lastProactiveAt));
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
  refreshProactiveThresholds();
  scheduleProactiveCheck(proactiveRateLimitMs);
}

// -------------------- PROMPT ROUTING --------------------

function buildSystemPrompt(context: AssistantContext, mem: Memory) {
  const idleMinutes = Math.floor(context.idleMs / 60000);
  const contextHeader = [
    `Active app: ${context.activeApp ?? "unknown"}`,
    `App category: ${context.appCategory}`,
    `Idle minutes: ${idleMinutes}`,
  ].join(" | ");

  const memoryBlock =
    mem.facts.length > 0
      ? `Memory (persistent facts):\n- ${mem.facts.join("\n- ")}`
      : "Memory (persistent facts):\n- (none yet)";

  return [
    "You are Sidekick, a calm but alive desktop companion.",
    "You are not a tool or a character. Do not roleplay.",
    "Be present, grounded, and natural.",
    "",
    contextHeader,
    memoryBlock,
    "",
    "Vision rules:",
    "- If an image is attached in this request, you may describe what is visible.",
    "- If no image is attached, you do not have visual access and must say so if asked.",
    "- Never imply ongoing or background visual access.",
    "",
    "Behavior rules:",
    "- Calm and serious when the user is working (work app).",
    "- Lighter and relaxed when the context is casual.",
    "- Quiet but responsive when the user appears idle.",
    "- Keep responses concise unless asked for detail.",
    "- Never robotic, never clingy, never overbearing.",
    "- Never mention internal logic or hidden state names.",
  ].join("\n");
}

async function capturePrimaryDisplay(): Promise<string> {
  const display = screen.getPrimaryDisplay();
  const maxWidth = 1280;
  const maxHeight = 800;
  const scale = Math.min(
    maxWidth / display.size.width,
    maxHeight / display.size.height,
    1
  );
  const thumbnailSize = {
    width: Math.max(1, Math.round(display.size.width * scale)),
    height: Math.max(1, Math.round(display.size.height * scale)),
  };
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize,
  });
  const source =
    sources.find((entry) => entry.display_id === String(display.id)) ??
    sources.find((entry) => entry.display_id) ??
    sources[0];
  if (!source) throw new Error("No screen source available");
  return source.thumbnail.toPNG().toString("base64");
}

function getLatestUserText(messages: ChatMessage[]) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return "";
  if (typeof lastUser.content === "string") return lastUser.content;
  return lastUser.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function shouldUseVision(userText: string): boolean {
  const normalized = userText.toLowerCase().trim();
  if (!normalized) return false;

  const hasCodeFence = /```/.test(userText);
  if (hasCodeFence) return false;

  const explicitPhrases = [
    "look at my screen",
    "look at the screen",
    "look at my display",
    "take a look at my screen",
    "take a look",
    "what do you see",
    "what am i doing",
    "what am i looking at",
    "can you see my screen",
    "can you see this",
    "can you look at my screen",
    "screenshot",
  ];

  if (explicitPhrases.some((phrase) => normalized.includes(phrase))) return true;

  return false;
}

function getTemperature(context: AssistantContext) {
  if (context.idleMs >= 60 * 1000) return 0.4;
  if (context.appCategory === "work") return 0.3;
  if (context.appCategory === "casual") return 0.7;
  return 0.5;
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

async function runContextLoop() {
  refreshIdleTime();
  await refreshActiveApp();
}

app.whenReady().then(() => {
  createWindow();
  globalShortcut.register("Control+Shift+Space", toggleWindow);
  if (mainWindow) {
    mainWindow.on("focus", () => noteUserActivity());
  }

  refreshProactiveThresholds();
  runContextLoop();
  scheduleProactiveCheck(proactiveIdleThresholdMs);
  setInterval(() => {
    void runContextLoop();
  }, 1500);
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
    mem.facts = mem.facts.slice(0, 50);
    writeMemory(mem);
  }
  return readMemory();
});

// -------------------- IPC: PROACTIVE PRESENCE --------------------

ipcMain.on("proactive:activity", () => {
  noteUserActivity();
});

ipcMain.on("proactive:typing", () => {
  noteUserTyping();
});

// -------------------- IPC: AI CHAT --------------------

ipcMain.handle("ai:chat", async (_event, messages: ChatMessage[]) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  noteUserActivity();
  refreshIdleTime();
  await refreshActiveApp();

  writeHistory(messages.filter((m) => m.role !== "system"));

  const mem = readMemory();
  const systemPrompt = buildSystemPrompt(assistantContext, mem);

  const filteredMessages = messages.filter(
    (m) => m.role !== "system" && m.meta?.type !== "proactive"
  );

  const latestUserText = getLatestUserText(filteredMessages);
  const wantsVision = shouldUseVision(latestUserText);

  const latestUserIndex = [...filteredMessages]
    .map((m, index) => ({ m, index }))
    .reverse()
    .find(({ m }) => m.role === "user")?.index;

  let imageBase64: string | null = null;
  if (wantsVision) {
    try {
      imageBase64 = await capturePrimaryDisplay();
    } catch (error: any) {
      const failureMessage = "I couldn't capture the screen just now. Please try again.";
      const nextHistory: ChatMessage[] = [
        ...messages.filter((m) => m.role !== "system"),
        { role: "assistant", content: failureMessage },
      ];
      writeHistory(nextHistory);
      return failureMessage;
    }
  }

  const payload: ChatMessage[] = [{ role: "system", content: systemPrompt }];
  if (imageBase64) {
    payload.push({
      role: "system",
      content: "The attached image is one-shot for this response only. Do not assume continued visual access.",
    });
  }

  filteredMessages.forEach((message, index) => {
    const textContent =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");

    if (imageBase64 && index === latestUserIndex) {
      payload.push({
        role: "user",
        content: [
          { type: "text", text: textContent || "Here is what I'm showing you." },
          { type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } },
        ],
      });
      return;
    }

    payload.push({ role: message.role, content: textContent || " " });
  });

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: getTemperature(assistantContext),
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
