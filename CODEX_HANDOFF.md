# CODEX HANDOFF — SIDEKICK BACKBONE v1

This document defines the project’s non-negotiable constraints, architecture map, and operating rules.
If a requested change conflicts with this document, it must NOT be implemented.

---

## Project Goal

Sidekick is a desktop companion that feels calm, optional, and safe to leave open.
It is NOT a chatbot or a surveillance tool.
It IS a user-controlled, respectful presence.

---

## Core Principles (NON-NEGOTIABLE)

1) The user is always in control.
2) Inference may adjust behavior, never identity.
3) Explicit beats implicit.
4) Trust beats cleverness.
5) Presence beats engagement.

---

## Internal vs User-Facing Labels

Internal identifiers:
- serious
- active
- idle

User-facing labels (MANDATORY):
- Focus
- Hang out
- Quiet

Never expose the word “mode” to the user.

---

## State Definitions

### Focus
- Purpose: work
- Behavior: concise, structured, no banter
- Proactivity: forbidden

### Hang out (Default)
- Purpose: companionship
- Behavior: warm, light, brief
- Proactivity: allowed (gentle only, rate-limited)

### Quiet
- Purpose: non-intrusion
- Behavior: minimal, calm responses only when asked
- Proactivity: forbidden

---

## Architecture Map

**Main process** (`main/main.ts`)
- Source of truth for state, memory, and vision gating.
- Computes effective behavior and broadcasts via `mode:update`.
- Owns OpenAI calls and screenshot capture.

**Preload bridge** (`main/preload.ts`)
- Minimal IPC surface only.
- No OpenAI keys or privileged logic.

**Renderer** (`renderer/src/App.tsx`)
- UI only.
- Detects vision intent for UI feedback only.
- Never decides whether capture is allowed.

**Persistence**
- Chat history: `chat_history.json`
- Memory facts: `memory.json`
- Settings: `settings.json`

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

If a request is blocked, the **app** must return a deterministic message without calling the LLM.

---

## OpenAI Pipeline

- Use Chat Completions only: `POST /v1/chat/completions`.
- Model: `gpt-4o-mini`.
- Messages are built in main process.
- Assistant output must never claim vision without an attached image.

---

## Authority & Truth

The application state is the source of truth.
The assistant must report state, not reason about it.
Never invent restrictions or contradict the UI.

---

## Constraints (DO NOT VIOLATE)

- OpenAI calls stay in the main process.
- `contextIsolation` remains enabled.
- Preload bridge stays minimal.
- No hidden permissions.
- No background surveillance.
- No emotional dependency language.
- No anthropomorphized control (“I decided”, “I locked you”).

---

## Design Intent

Comfort > engagement
Control > autonomy
Presence > performance
