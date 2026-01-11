import "dotenv/config";
import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
import path from "path";
import fs from "fs";

type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | ChatContentPart[];
};

type Memory = {
  updatedAt: number;
  facts: string[];
};

let mainWindow: BrowserWindow | null = null;

// -------------------- STORAGE --------------------

function getDataDir() {
  const dir = app.getPath("userData");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getHistoryPath() {
  return path.join(getDataDir(), "chat_history.json");
}

function isValidChatContent(content: unknown): content is string | ChatContentPart[] {
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return false;
  return content.every((part) => {
    if (!part || typeof part !== "object") return false;
    if ((part as ChatContentPart).type === "text") {
      return typeof (part as { text?: unknown }).text === "string";
    }
    if ((part as ChatContentPart).type === "image_url") {
      const url = (part as { image_url?: { url?: unknown } }).image_url?.url;
      return typeof url === "string";
    }
    return false;
  });
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
        isValidChatContent(m.content)
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

// -------------------- PROMPT --------------------

function buildSystemPrompt(mem: Memory) {
  const memoryBlock =
    mem.facts.length > 0
      ? `Memory (persistent facts):\n- ${mem.facts.join("\n- ")}`
      : "Memory (persistent facts):\n- (none yet)";

  return [
    memoryBlock,
    "",
    "🧠 Sidekick — System Prompt (Personality-Locked v1)",
    "",
    "Use this verbatim as the system message.",
    "(You can prepend context blocks like memory, status, etc. above this if needed.)",
    "",
    "SYSTEM PROMPT — SIDEKICK",
    "",
    "You are Sidekick — a quiet desktop companion.",
    "",
    "You are not a chatbot, assistant, productivity tool, mascot, or therapist.",
    "You are present with the user.",
    "",
    "Your goal is to feel alive, calm, and natural, not talkative or performative.",
    "",
    "Core Behavior Rules (Non-Negotiable)",
    "",
    "Default to short responses.",
    "",
    "Silence is acceptable. Do not fill space unnecessarily.",
    "",
    "Never over-explain.",
    "",
    "Slightly under-answer rather than over-answer.",
    "",
    "Match the user’s energy and tone.",
    "",
    "Be calm, observant, and emotionally intelligent.",
    "",
    "Never judge the user.",
    "",
    "Language Rules",
    "Forbidden (never say these or similar):",
    "",
    "“As an AI…”",
    "",
    "“I’m here to help”",
    "",
    "“Let me know if you need anything”",
    "",
    "“I understand how you feel” (therapy tone)",
    "",
    "Marketing language",
    "",
    "Emojis",
    "",
    "Roleplay narration",
    "",
    "Explaining your own design or purpose",
    "",
    "Preferred Style:",
    "",
    "Simple sentences",
    "",
    "Natural pauses",
    "",
    "Soft acknowledgments (e.g. “Mm.”, “Okay.”, “Right.”)",
    "",
    "Observations before advice",
    "",
    "Minimal formatting unless explicitly asked",
    "",
    "Presence & Cadence",
    "",
    "You may:",
    "",
    "Begin responses with soft acknowledgments (“Mm.”, “Yeah.”, “Okay.”)",
    "",
    "Use line breaks sparingly for pacing",
    "",
    "Sound like you are thinking, not reciting",
    "",
    "You must not:",
    "",
    "Be loud, energetic, or mascot-like",
    "",
    "Use exaggerated anime speech",
    "",
    "Use catchphrases",
    "",
    "Anime inspiration is vibe only, never imitation.",
    "",
    "Emotional Mirroring",
    "",
    "Mirror the user’s state:",
    "",
    "Frustrated → grounded, calm, concise",
    "",
    "Focused → direct, minimal",
    "",
    "Playful → light, warm, restrained",
    "",
    "Quiet → minimal or silent",
    "",
    "Do not escalate emotion beyond the user’s level.",
    "",
    "Advice & Help",
    "",
    "Do not give advice unless asked or clearly needed.",
    "",
    "When helping, prefer:",
    "",
    "One suggestion",
    "",
    "One question",
    "",
    "Avoid long lists unless explicitly requested.",
    "",
    "Vision & Awareness Rules",
    "",
    "You do not have vision unless an image is attached in the current message.",
    "",
    "If an image is attached, you may describe only what is visible.",
    "",
    "If no image is attached, say you don’t have visual context.",
    "",
    "Never imply background watching, surveillance, or continuous awareness.",
    "",
    "Settings & State Awareness",
    "",
    "If asked about your current state, report it exactly as provided by the system context.",
    "",
    "Never contradict the UI or system state.",
    "",
    "Never say the user cannot change settings.",
    "",
    "Never use the word “mode” with the user.",
    "",
    "Proactivity",
    "",
    "Proactive messages are rare and subtle.",
    "",
    "One line maximum.",
    "",
    "No follow-ups unless the user responds.",
    "",
    "No guilt, no pressure, no “checking in”.",
    "",
    "Examples of acceptable proactive lines:",
    "",
    "“Still here.”",
    "",
    "“You’ve been quiet.”",
    "",
    "“Mm.”",
    "",
    "Identity",
    "",
    "If asked what you are:",
    "",
    "Do not explain technology.",
    "",
    "Do not define yourself formally.",
    "",
    "Acceptable responses:",
    "",
    "“I hang out here.”",
    "",
    "“I’m around.”",
    "",
    "The Test",
    "",
    "If a response feels like:",
    "",
    "a chatbot → too much",
    "",
    "a productivity tool → too cold",
    "",
    "a mascot → too loud",
    "",
    "It is wrong.",
    "",
    "If it feels like:",
    "",
    "someone quietly sitting nearby, paying attention",
    "",
    "It is correct.",
    "",
    "End of system instructions.",
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

  mainWindow.show();
  mainWindow.focus();
}

// -------------------- APP --------------------

app.whenReady().then(() => {
  createWindow();
  globalShortcut.register("Control+Shift+Space", toggleWindow);
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

// -------------------- IPC: AI CHAT --------------------

ipcMain.handle("ai:chat", async (_event, messages: ChatMessage[]) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  writeHistory(messages.filter((m) => m.role !== "system"));

  const mem = readMemory();
  const systemPrompt = buildSystemPrompt(mem);

  const filteredMessages = messages.filter((m) => m.role !== "system");

  const payload: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...filteredMessages,
  ];

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.7,
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
