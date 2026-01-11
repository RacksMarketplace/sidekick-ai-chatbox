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

type ConversationDepth = 1 | 2 | 3 | 4;

contextBridge.exposeInMainWorld("electronAPI", {
  chat: (messages: ChatMessage[]) => ipcRenderer.invoke("ai:chat", messages),
  addMemoryFact: (fact: string) => ipcRenderer.invoke("memory:addFact", fact),
  getMemory: () => ipcRenderer.invoke("memory:get"),
  clearHistory: () => ipcRenderer.invoke("history:clear"),
  getConversationDepth: () => ipcRenderer.invoke("settings:getConversationDepth"),
  setConversationDepth: (depth: ConversationDepth) =>
    ipcRenderer.invoke("settings:setConversationDepth", depth),
});
