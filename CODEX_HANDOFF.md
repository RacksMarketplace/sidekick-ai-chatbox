# CODEX HANDOFF — SIDEKICK BACKBONE v2

This document defines the project’s non-negotiable constraints, architecture map, and operating rules.
If a requested change conflicts with this document, it must NOT be implemented.

---

## Project Overview

Sidekick is a calm but alive desktop companion for Electron + Vite + React.
It is a presence, not a tool.
It is helpful, not restrictive.
It is alive, not creepy.

---

## How to Run

```bash
npm install
npm run dev
```

---

## Core Principles (NON-NEGOTIABLE)

1) The user is always in control.
2) One adaptive personality; no focus lock, no gating, no separate personalities.
3) Explicit beats implicit.
4) Trust beats cleverness.
5) Presence beats engagement.

---

## Architecture Map

**Main process** (`main/main.ts`)
- Source of truth for context, memory, and vision.
- Owns OpenAI calls and screenshot capture.
- Maintains persistent chat history and memory facts.

**Preload bridge** (`main/preload.ts`)
- Minimal IPC surface only.
- No OpenAI keys or privileged logic.

**Renderer** (`renderer/src/App.tsx`)
- UI only.
- Detects vision intent for UI feedback only ("Looking…" bubble).
- Never decides whether capture is allowed.

**Persistence**
- Chat history: `chat_history.json`
- Memory facts: `memory.json`

---

## Vision Rules (CRITICAL)

Vision is user-invoked only.

Allowed:
- Explicit user request
- One-shot screenshot capture
- Attached to the same request
- Acknowledged once, then answer
- Immediate discard (no storage)

Forbidden:
- Background capture
- Continuous monitoring
- Inference-based capture
- Reuse of screenshots
- Any claim of visual access without an attached image

If capture fails, the **app** must return a deterministic message without calling the LLM.

---

## Memory Rules

- Memory is persistent across restarts.
- Memory is simple facts only.
- No silent inference. Only user-provided facts are stored.

---

## OpenAI Pipeline

- Use Chat Completions only: `POST /v1/chat/completions`.
- Model: `gpt-4o-mini`.
- Messages are built in the main process.
- Parse assistant output from `data.choices[0].message.content`.
- Never claim vision without an attached image.

---

## Safety Boundaries

- No always-on screen capture.
- No background vision.
- No OpenAI Responses API.
- No hidden restrictions or hidden-state language.
- No emotional dependency language.

---

## Extending the System (Without Breaking Behavior)

When adding features:
- Keep the single adaptive personality.
- Never introduce focus locks or gating.
- Treat vision as one-shot and user-invoked only.
- Keep proactivity rare and ignorable.
- Ensure UI remains simple and calm.

---

## Design Intent

Comfort > engagement
Control > autonomy
Presence > performance
