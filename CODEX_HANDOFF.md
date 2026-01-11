# CODEX HANDOFF — SIDEKICK v2.1

This document defines the project’s non-negotiable constraints, architecture map, and operating rules.
If a requested change conflicts with this document, it must NOT be implemented.

---

## Project Overview

Sidekick is a lively but grounded desktop companion for Electron + Vite + React.
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
2) One unified personality; no modes, no gating, no separate personas.
3) Explicit beats implicit.
4) Trust beats cleverness.
5) Presence beats engagement.

---

## Architecture Map

**Main process** (`main/main.ts`)
- Source of truth for memory and OpenAI calls.
- Builds the system prompt.
- Persists chat history and memory facts.

**Preload bridge** (`main/preload.ts`)
- Minimal IPC surface only.
- No OpenAI keys or privileged logic.

**Renderer** (`renderer/src/App.tsx`)
- UI only.
- Handles image upload, drag/drop, and clipboard paste.
- Sends image data URLs inside chat messages.

**Persistence**
- Chat history: `chat_history.json`
- Memory facts: `memory.json`

---

## Vision Philosophy (CRITICAL)

Vision is user-controlled, explicit, and one-shot.
Trust-first design forbids any surveillance or automation.

Principles:
- User provides images directly (upload, drag/drop, or paste).
- Images are attached to the current message only.
- No background capture, no continuous monitoring, no inference-based grabs.
- The assistant never claims visual access without an attached image.

---

## How Image Vision Works

- The renderer captures user-selected images and converts them to data URLs.
- The image is sent inside the Chat Completions message content as `image_url`.
- The main process passes messages directly to OpenAI and returns the response.

---

## OpenAI Pipeline

- Use Chat Completions only: `POST /v1/chat/completions`.
- Model: `gpt-4o-mini`.
- Messages are built in the main process.
- Parse assistant output from `data.choices[0].message.content`.
- Never claim vision without an attached image.

---

## Memory Rules

- Memory is persistent across restarts.
- Memory is simple facts only.
- No silent inference. Only user-provided facts are stored.

---

## Safety Boundaries

- No capture APIs or automation.
- No background vision.
- No OpenAI Responses API.
- No hidden restrictions or hidden-state language.
- No emotional dependency language.

---

## Extending Vision Safely Later

If new vision features are added:
- Preserve user-controlled inputs only.
- Keep vision one-shot and per-message.
- Require explicit user action for every image.
- Avoid hidden triggers or implicit capture.
- Keep the IPC surface minimal and auditable.

---

## Design Intent

Comfort > engagement
Control > autonomy
Presence > performance
