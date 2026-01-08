import { useEffect, useMemo, useState } from "react";

type PrimaryMode = "serious" | "active" | "idle";
type EffectiveMode = "serious" | "active" | "idle";
type ModeState = {
  primaryMode: PrimaryMode;
  effectiveMode: EffectiveMode;
  effectiveReason: string;
  idleMs: number;
  isIdle: boolean;
  focusLocked: boolean;
  lastUserSendAt: number;
};

type Memory = {
  updatedAt: number;
  facts: string[];
};

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

declare global {
  interface Window {
    electronAPI?: {
      chat: (messages: ChatMessage[]) => Promise<string>;

      loadHistory: () => Promise<ChatMessage[]>;
      clearHistory: () => Promise<boolean>;

      getMemory: () => Promise<Memory>;
      addMemoryFact: (fact: string) => Promise<Memory>;

      getMode: () => Promise<ModeState>;
      setPrimaryMode: (mode: PrimaryMode) => Promise<ModeState>;
      toggleFocusLock: () => Promise<ModeState>;
      markUserSent: () => Promise<ModeState>;
      onModeUpdate: (cb: (state: ModeState) => void) => void;
    };
  }
}

function msToMin(ms: number) {
  return Math.floor(ms / 60000);
}

export default function App() {
  const api = window.electronAPI;

  const [fatal, setFatal] = useState<string | null>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const [modeState, setModeState] = useState<ModeState>({
    primaryMode: "active",
    effectiveMode: "active",
    effectiveReason: "primary mode active",
    idleMs: 0,
    isIdle: false,
    focusLocked: false,
    lastUserSendAt: 0,
  });

  const [memory, setMemory] = useState<Memory>({ updatedAt: Date.now(), facts: [] });
  const [rememberText, setRememberText] = useState("");

  const primaryLabel = useMemo(() => {
    if (modeState.primaryMode === "serious") return "Serious";
    if (modeState.primaryMode === "idle") return "Idle";
    return "Active";
  }, [modeState.primaryMode]);

  const effectiveLabel = useMemo(() => {
    if (modeState.effectiveMode === "serious") return "Serious";
    if (modeState.effectiveMode === "idle") return "Idle";
    return "Active";
  }, [modeState.effectiveMode]);

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

  // Load history + memory + mode safely
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
        const initial = await api.getMode();
        setModeState(initial);
      } catch (e: any) {
        setFatal(`Mode load failed: ${e?.message ?? String(e)}`);
      }

      try {
        api.onModeUpdate((state) => setModeState(state));
      } catch (e: any) {
        setFatal(`Mode subscription failed: ${e?.message ?? String(e)}`);
      }
    })();
  }, [api]);

  async function sendMessage() {
    if (!api) return;
    if (!input.trim() || loading) return;

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: input.trim(),
    };

    const nextUI = [...messages, userMsg];
    setMessages(nextUI);
    setInput("");
    setLoading(true);

    try {
      await api.markUserSent();

      const payload: ChatMessage[] = nextUI.map((m) => ({ role: m.role, content: m.content }));
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
  }

  async function toggleFocusLock() {
    if (!api) return;
    const next = await api.toggleFocusLock();
    setModeState(next);
  }

  async function setPrimaryMode(nextMode: PrimaryMode) {
    if (!api) return;
    const next = await api.setPrimaryMode(nextMode);
    setModeState(next);
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
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <div style={{ fontSize: 14, opacity: 0.9 }}>Sidekick</div>
          <div style={{ fontSize: 12, opacity: 0.65 }}>
            Primary: <b>{primaryLabel}</b> · Effective: <b>{effectiveLabel}</b>{" "}
            <span style={{ opacity: 0.75 }}>({modeState.effectiveReason})</span> · Idle:{" "}
            {msToMin(modeState.idleMs)}m
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ display: "flex", gap: 6 }}>
            {([
              { value: "serious", label: "Serious" },
              { value: "active", label: "Active" },
              { value: "idle", label: "Idle" },
            ] as const).map((option) => (
              <button
                key={option.value}
                onClick={() => setPrimaryMode(option.value)}
                style={{
                  padding: "6px 10px",
                  borderRadius: 999,
                  border: "1px solid rgba(255,255,255,0.15)",
                  background:
                    modeState.primaryMode === option.value
                      ? "rgba(79,140,255,0.35)"
                      : "rgba(255,255,255,0.06)",
                  color: "#fff",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button
            onClick={toggleFocusLock}
            style={{
              padding: "6px 10px",
              borderRadius: 999,
              border: "1px solid rgba(255,255,255,0.15)",
              background: modeState.focusLocked ? "rgba(79,140,255,0.35)" : "rgba(255,255,255,0.06)",
              color: "#fff",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {modeState.focusLocked ? "Unlock focus" : "Lock focus"}
          </button>

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
          onKeyDown={(e) => e.key === "Enter" && rememberFact()}
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

        {messages.map((m) => (
          <div
            key={m.id}
            style={{
              display: "flex",
              justifyContent: m.role === "user" ? "flex-end" : "flex-start",
              marginBottom: 6,
            }}
          >
            <div
              style={{
                maxWidth: "90%",
                padding: "6px 10px",
                borderRadius: 12,
                background: m.role === "user" ? "rgba(90,150,255,0.35)" : "rgba(255,255,255,0.08)",
                fontSize: 13,
                whiteSpace: "pre-wrap",
              }}
            >
              {m.content}
            </div>
          </div>
        ))}

        {loading && <div style={{ opacity: 0.6, fontSize: 12 }}>Thinking…</div>}
      </div>

      {/* Input */}
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendMessage()}
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
