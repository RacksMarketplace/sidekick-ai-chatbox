import { contextBridge, ipcRenderer } from "electron";

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  meta?: {
    type?: "proactive";
  };
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

  onProactiveMessage: (cb: (message: ChatMessage) => void) => {
    ipcRenderer.on("proactive:message", (_event, message: ChatMessage) => cb(message));
  },
  reportUserActivity: () => ipcRenderer.send("proactive:activity"),
  reportUserTyping: () => ipcRenderer.send("proactive:typing"),
});
