import { contextBridge, ipcRenderer } from "electron";

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

contextBridge.exposeInMainWorld("electronAPI", {
  chat: (messages: ChatMessage[]) => ipcRenderer.invoke("ai:chat", messages),
  addMemoryFact: (fact: string) => ipcRenderer.invoke("memory:addFact", fact),
  getMemory: () => ipcRenderer.invoke("memory:get"),
  clearHistory: () => ipcRenderer.invoke("history:clear"),
});
