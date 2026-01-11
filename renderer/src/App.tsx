import { useEffect, useState } from "react";

type Memory = {
  updatedAt: number;
  facts: string[];
};

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  meta?: {
    type?: "proactive" | "looking";
  };
};

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  meta?: {
    type?: "proactive";
  };
};

declare global {
  interface Window {
    electronAPI?: {
      chat: (messages: ChatMessage[]) => Promise<string>;

      loadHistory: () => Promise<ChatMessage[]>;
      clearHistory: () => Promise<boolean>;

      getMemory: () => Promise<Memory>;
      addMemoryFact: (fact: string) => Promise<Memory>;

      onProactiveMessage: (cb: (message: ChatMessage) => void) => void;
      reportUserActivity: () => void;
      reportUserTyping: () => void;
    };
  }
}

function shouldUseVision(userText: string) {
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

export default function App() {
  const api = window.electronAPI;

  const [fatal, setFatal] = useState<string | null>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [, setLookingMessageId] = useState<string | null>(null);

  const [memory, setMemory] = useState<Memory>({ updatedAt: Date.now(), facts: [] });
  const [rememberText, setRememberText] = useState("");

  // If preload bridge isn't available, show a useful message instead of white screen
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

  // Load history + memory
  useEffect(() => {
    (async () => {
      if (!api) return;

      try {
        const history = await api.loadHistory();
        const ui = history
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({
            id: crypto.randomUUID(),
            role: m.role as "user" | "assistant",
            content: m.content,
            meta: m.meta,
          }));
        setMessages(ui);
      } catch (e: any) {
        setFatal(`History load failed: ${e?.message ?? String(e)}`);
      }

      try {
        const mem = await api.getMemory();
        setMemory(mem);
      } catch (e: any) {
        setFatal(`Memory load failed: ${e?.message ?? String(e)}`);
      }

      try {
        api.onProactiveMessage((message) => {
          if (message.role !== "assistant") return;
          setMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role: "assistant", content: message.content, meta: message.meta },
          ]);
        });
      } catch (e: any) {
        setFatal(`Proactive subscription failed: ${e?.message ?? String(e)}`);
      }
    })();
  }, [api]);

  async function sendMessage() {
    if (!api) return;
    if (!input.trim() || loading) return;

    const trimmedInput = input.trim();
    const wantsVision = shouldUseVision(trimmedInput);
    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmedInput,
    };

    const lookingId = wantsVision ? crypto.randomUUID() : null;
    const lookingMsg = wantsVision
      ? { id: lookingId, role: "assistant" as const, content: "(Looking…)", meta: { type: "looking" } }
      : null;
    const nextUI = lookingMsg ? [...messages, userMsg, lookingMsg] : [...messages, userMsg];
    setMessages(nextUI);
    setInput("");
    setLoading(true);
    setLookingMessageId(lookingId);

    try {
      api.reportUserActivity?.();

      const payload: ChatMessage[] = nextUI
        .filter((m) => m.meta?.type !== "looking")
        .map((m) => ({
          role: m.role,
          content: m.content,
          meta: m.meta,
        }));
      const reply = await api.chat(payload);

      setMessages((prev) => {
        const cleaned = lookingId ? prev.filter((m) => m.id !== lookingId) : prev;
        return [...cleaned, { id: crypto.randomUUID(), role: "assistant", content: reply }];
      });
    } catch (err: any) {
      setMessages((prev) => {
        const cleaned = lookingId ? prev.filter((m) => m.id !== lookingId) : prev;
        return [
          ...cleaned,
          { id: crypto.randomUUID(), role: "assistant", content: `Error: ${err?.message ?? String(err)}` },
        ];
      });
    } finally {
      setLoading(false);
      setLookingMessageId(null);
    }
  }

  async function newChat() {
    if (!api) return;
    await api.clearHistory();
    setMessages([]);
  }

  async function rememberFact() {
    if (!api) return;
    const text = rememberText.trim();
    if (!text) return;
    const mem = await api.addMemoryFact(text);
    setMemory(mem);
    setRememberText("");
  }

  return (
    <div
      style={{
        height: "100%",
        padding: 12,
        background: "rgba(20,20,30,0.96)",
        color: "#fff",
        fontFamily: "system-ui",
        borderRadius: 18,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
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

      {/* Fatal banner (prevents silent white screens) */}
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

      {/* Remember */}
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
            api?.reportUserTyping();
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

      {/* Messages */}
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
          const isLooking = m.meta?.type === "looking";
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
                  padding: isLooking ? "4px 8px" : "6px 10px",
                  borderRadius: 12,
                  background: isUser
                    ? "rgba(90,150,255,0.35)"
                    : isLooking
                      ? "rgba(255,255,255,0.04)"
                      : "rgba(255,255,255,0.08)",
                  fontSize: isLooking ? 12 : 13,
                  fontStyle: isLooking ? "italic" : "normal",
                  opacity: isLooking ? 0.7 : 1,
                  whiteSpace: "pre-wrap",
                }}
              >
                {m.content}
              </div>
            </div>
          );
        })}

        {loading && <div style={{ opacity: 0.6, fontSize: 12 }}>Thinking…</div>}
      </div>

      {/* Input */}
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            api?.reportUserTyping();
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
  );
}
