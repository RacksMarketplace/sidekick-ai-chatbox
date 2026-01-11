import { useEffect, useRef, useState } from "react";
import AvatarCanvas from "./AvatarCanvas";

type Memory = {
  updatedAt: number;
  facts: string[];
};

type ConversationDepth = 1 | 2 | 3 | 4;

type ProactivityTrigger = "session-start" | "session-focus" | "memory-added";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  imageUrl?: string;
};

type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | ChatContentPart[];
};

declare global {
  interface Window {
    electronAPI?: {
      chat: (messages: ChatMessage[]) => Promise<string>;
      clearHistory: () => Promise<boolean>;
      getMemory: () => Promise<Memory>;
      addMemoryFact: (fact: string) => Promise<Memory>;
      getConversationDepth: () => Promise<ConversationDepth>;
      setConversationDepth: (depth: ConversationDepth) => Promise<ConversationDepth>;
      maybeInitiateProactivity: (trigger: ProactivityTrigger) => Promise<string | null>;
    };
  }
}

const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];

function isVisionRequest(text: string) {
  const normalized = text.toLowerCase().trim();
  if (!normalized) return false;

  const explicitPhrases = [
    "look at this",
    "what do you see",
    "what am i doing",
  ];

  return explicitPhrases.some((phrase) => normalized.includes(phrase));
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Failed to read image"));
    reader.readAsDataURL(file);
  });
}

export default function App() {
  const api = window.electronAPI;
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [fatal, setFatal] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [memory, setMemory] = useState<Memory>({ updatedAt: Date.now(), facts: [] });
  const [rememberText, setRememberText] = useState("");
  const [conversationDepth, setConversationDepth] = useState<ConversationDepth>(1);
  const [depthStatus, setDepthStatus] = useState<string | null>(null);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [imageName, setImageName] = useState<string | null>(null);

  useEffect(() => {
    if (!api) {
      const isElectron = navigator.userAgent.includes("Electron");
      if (isElectron) {
        setFatal(
          "electronAPI is missing. This usually means preload.js failed to load, or you're viewing the Vite browser tab instead of the Electron window."
        );
      }
      return;
    }
    setFatal(null);
  }, [api]);

  async function maybeInitiateProactivity(trigger: ProactivityTrigger) {
    if (!api) return;
    try {
      const message = await api.maybeInitiateProactivity(trigger);
      if (message) {
        setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "assistant", content: message }]);
      }
    } catch (e: any) {
      setFatal(`Proactivity failed: ${e?.message ?? String(e)}`);
    }
  }

  useEffect(() => {
    (async () => {
      if (!api) return;

      try {
        const mem = await api.getMemory();
        setMemory(mem);
      } catch (e: any) {
        setFatal(`Memory load failed: ${e?.message ?? String(e)}`);
      }
    })();
  }, [api]);

  useEffect(() => {
    if (!api) return;
    void maybeInitiateProactivity("session-start");
  }, [api]);

  useEffect(() => {
    if (!api) return;
    const handleFocus = () => {
      void maybeInitiateProactivity("session-focus");
    };
    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
    };
  }, [api]);

  useEffect(() => {
    (async () => {
      if (!api) return;
      try {
        const depth = await api.getConversationDepth();
        setConversationDepth(depth);
      } catch (e: any) {
        setDepthStatus(`Conversation depth load failed: ${e?.message ?? String(e)}`);
      }
    })();
  }, [api]);

  useEffect(() => {
    const handlePaste = async (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (!file || !IMAGE_MIME_TYPES.includes(file.type)) return;
          event.preventDefault();
          try {
            const dataUrl = await fileToDataUrl(file);
            setImageDataUrl(dataUrl);
            setImageName(file.name || "clipboard-image");
          } catch (e: any) {
            setFatal(`Image paste failed: ${e?.message ?? String(e)}`);
          }
          return;
        }
      }
    };

    window.addEventListener("paste", handlePaste);
    return () => {
      window.removeEventListener("paste", handlePaste);
    };
  }, []);

  async function handleImageFile(file: File) {
    if (!IMAGE_MIME_TYPES.includes(file.type)) {
      setFatal("Unsupported image format. Use PNG, JPG, or WebP.");
      return;
    }

    try {
      const dataUrl = await fileToDataUrl(file);
      setImageDataUrl(dataUrl);
      setImageName(file.name);
    } catch (e: any) {
      setFatal(`Image load failed: ${e?.message ?? String(e)}`);
    }
  }

  function clearImage() {
    setImageDataUrl(null);
    setImageName(null);
  }

  async function sendMessage() {
    if (!api) return;

    const trimmedInput = input.trim();
    const hasImage = Boolean(imageDataUrl);
    if (!trimmedInput && !hasImage) return;
    if (loading) return;

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmedInput,
      imageUrl: imageDataUrl ?? undefined,
    };

    const nextUI = [...messages, userMsg];
    setMessages(nextUI);
    setInput("");
    setLoading(true);

    const needsImagePrompt = !hasImage && isVisionRequest(trimmedInput);
    clearImage();

    if (needsImagePrompt) {
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "assistant", content: "If you want me to look, drop a screenshot or image here." },
      ]);
      setLoading(false);
      return;
    }

    try {
      const payload: ChatMessage[] = nextUI.map((m) => {
        if (m.role === "user" && m.imageUrl) {
          return {
            role: "user",
            content: [
              { type: "text", text: m.content || " " },
              { type: "image_url", image_url: { url: m.imageUrl } },
            ],
          };
        }
        return { role: m.role, content: m.content || " " };
      });

      const reply = await api.chat(payload);
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "assistant", content: reply }]);
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "assistant", content: `Error: ${err?.message ?? String(err)}` },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function newChat() {
    if (!api) return;
    await api.clearHistory();
    setMessages([]);
    clearImage();
    setInput("");
  }

  async function rememberFact() {
    if (!api) return;
    const text = rememberText.trim();
    if (!text) return;
    const mem = await api.addMemoryFact(text);
    setMemory(mem);
    setRememberText("");
    void maybeInitiateProactivity("memory-added");
  }

  async function updateConversationDepth(next: ConversationDepth) {
    if (!api) return;
    setConversationDepth(next);
    setDepthStatus(null);
    try {
      const saved = await api.setConversationDepth(next);
      setConversationDepth(saved);
    } catch (e: any) {
      setDepthStatus(`Conversation depth save failed: ${e?.message ?? String(e)}`);
    }
  }

  return (
    <div style={{ position: "relative", height: "100%", width: "100%" }}>
      <AvatarCanvas />
      <div
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const file = event.dataTransfer.files?.[0];
          if (!file) return;
          void handleImageFile(file);
        }}
        style={{
          position: "relative",
          zIndex: 2,
          height: "100%",
          maxWidth: 420,
          padding: 12,
          margin: 12,
          background: "rgba(20,20,30,0.92)",
          color: "#fff",
          fontFamily: "system-ui",
          borderRadius: 18,
          display: "flex",
          flexDirection: "column",
        }}
      >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontSize: 14, opacity: 0.9 }}>Sidekick</div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            onClick={newChat}
            style={{
              padding: "6px 10px",
              borderRadius: 999,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "rgba(255,255,255,0.06)",
              color: "#fff",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            New chat
          </button>
        </div>
      </div>

      {fatal && (
        <div
          style={{
            marginBottom: 8,
            padding: 10,
            borderRadius: 12,
            background: "rgba(255, 80, 80, 0.18)",
            border: "1px solid rgba(255, 80, 80, 0.25)",
            fontSize: 12,
            whiteSpace: "pre-wrap",
          }}
        >
          {fatal}
        </div>
      )}

      {depthStatus && (
        <div
          style={{
            marginBottom: 8,
            padding: 10,
            borderRadius: 12,
            background: "rgba(255, 180, 80, 0.18)",
            border: "1px solid rgba(255, 180, 80, 0.25)",
            fontSize: 12,
            whiteSpace: "pre-wrap",
          }}
        >
          {depthStatus}
        </div>
      )}

      <div
        style={{
          display: "flex",
          gap: 8,
          padding: 8,
          background: "rgba(255,255,255,0.05)",
          borderRadius: 12,
          marginBottom: 8,
        }}
      >
        <input
          value={rememberText}
          onChange={(e) => setRememberText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") rememberFact();
          }}
          placeholder="Remember this (persistent)…"
          style={{
            flex: 1,
            padding: "8px 12px",
            borderRadius: 999,
            border: "none",
            outline: "none",
            background: "rgba(0,0,0,0.4)",
            color: "#fff",
            fontSize: 12,
          }}
        />
        <button
          onClick={rememberFact}
          style={{
            padding: "8px 12px",
            borderRadius: 999,
            border: "none",
            background: "#4f8cff",
            color: "#fff",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          Remember
        </button>
      </div>

      <div
        style={{
          padding: 10,
          borderRadius: 12,
          background: "rgba(255,255,255,0.05)",
          marginBottom: 8,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <div style={{ fontSize: 12, opacity: 0.85 }}>Conversation Depth</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="range"
            min={1}
            max={4}
            step={1}
            value={conversationDepth}
            onChange={(e) => {
              const next = Number(e.target.value) as ConversationDepth;
              void updateConversationDepth(next);
            }}
            style={{ flex: 1 }}
          />
          <div
            style={{
              minWidth: 18,
              textAlign: "center",
              fontSize: 12,
              padding: "4px 8px",
              borderRadius: 999,
              background: "rgba(255,255,255,0.12)",
            }}
          >
            {conversationDepth}
          </div>
        </div>
        <div style={{ fontSize: 11, opacity: 0.7 }}>
          Controls how personally and proactively Sidekick interacts. You can change this anytime.
        </div>
      </div>

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 8,
          background: "rgba(255,255,255,0.05)",
          borderRadius: 12,
          marginBottom: 8,
        }}
      >
        {messages.length === 0 && (
          <div style={{ opacity: 0.6, fontSize: 13 }}>
            Press <b>Ctrl + Shift + Space</b> anytime.
          </div>
        )}

        {messages.map((m) => {
          const isUser = m.role === "user";
          return (
            <div
              key={m.id}
              style={{
                display: "flex",
                justifyContent: isUser ? "flex-end" : "flex-start",
                marginBottom: 6,
              }}
            >
              <div
                style={{
                  maxWidth: "90%",
                  padding: "6px 10px",
                  borderRadius: 12,
                  background: isUser ? "rgba(90,150,255,0.35)" : "rgba(255,255,255,0.08)",
                  fontSize: 13,
                  whiteSpace: "pre-wrap",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                {m.content && <div>{m.content}</div>}
                {m.imageUrl && (
                  <img
                    src={m.imageUrl}
                    alt="Uploaded"
                    style={{ maxWidth: 180, borderRadius: 10, border: "1px solid rgba(255,255,255,0.2)" }}
                  />
                )}
              </div>
            </div>
          );
        })}

        {loading && <div style={{ opacity: 0.6, fontSize: 12 }}>Thinking…</div>}
      </div>

      {imageDataUrl && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: 8,
            borderRadius: 12,
            background: "rgba(255,255,255,0.08)",
            marginBottom: 8,
          }}
        >
          <img
            src={imageDataUrl}
            alt="Preview"
            style={{ width: 56, height: 56, borderRadius: 10, objectFit: "cover" }}
          />
          <div style={{ flex: 1, fontSize: 12, opacity: 0.85 }}>{imageName ?? "Image ready"}</div>
          <button
            onClick={clearImage}
            style={{
              padding: "6px 10px",
              borderRadius: 999,
              border: "1px solid rgba(255,255,255,0.2)",
              background: "transparent",
              color: "#fff",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Remove
          </button>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") sendMessage();
          }}
          placeholder="Type a message…"
          style={{
            flex: 1,
            padding: "8px 12px",
            borderRadius: 999,
            border: "none",
            outline: "none",
            background: "rgba(0,0,0,0.4)",
            color: "#fff",
            fontSize: 13,
          }}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept={IMAGE_MIME_TYPES.join(",")}
          style={{ display: "none" }}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void handleImageFile(file);
            }
            if (event.target.value) {
              event.target.value = "";
            }
          }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          style={{
            padding: "8px 12px",
            borderRadius: 999,
            border: "1px solid rgba(255,255,255,0.2)",
            background: "rgba(255,255,255,0.06)",
            color: "#fff",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          Add image
        </button>
        <button
          onClick={sendMessage}
          disabled={loading || !api}
          style={{
            padding: "8px 14px",
            borderRadius: 999,
            border: "none",
            background: loading ? "rgba(79,140,255,0.5)" : "#4f8cff",
            color: "#fff",
            cursor: loading ? "default" : "pointer",
            opacity: api ? 1 : 0.6,
          }}
        >
          Send
        </button>
      </div>

      <div style={{ marginTop: 8, fontSize: 11, opacity: 0.6 }}>
        Memory facts saved: {memory.facts.length}
      </div>
      </div>
    </div>
  );
}
