import { contextBridge, ipcRenderer } from "electron";

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
  lastUserSendAt: number;
  activeApp: string | null;
  appCategory: AppCategory;
};

type Memory = {
  updatedAt: number;
  facts: string[];
};

contextBridge.exposeInMainWorld("electronAPI", {
  chat: (messages: ChatMessage[]) => ipcRenderer.invoke("ai:chat", messages),

  loadHistory: () => ipcRenderer.invoke("history:load"),
  clearHistory: () => ipcRenderer.invoke("history:clear"),

  getMemory: () => ipcRenderer.invoke("memory:get"),
  addMemoryFact: (fact: string) => ipcRenderer.invoke("memory:addFact", fact),

  getMode: () => ipcRenderer.invoke("mode:get"),
  setPrimaryMode: (mode: PrimaryMode) => ipcRenderer.invoke("mode:setPrimary", mode),
  toggleFocusLock: () => ipcRenderer.invoke("mode:toggleFocusLock"),
  markUserSent: () => ipcRenderer.invoke("mode:userSent"),
  onModeUpdate: (cb: (state: ModeState) => void) => {
    ipcRenderer.on("mode:update", (_event, state: ModeState) => cb(state));
  },
});
