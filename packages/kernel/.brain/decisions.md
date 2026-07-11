# Architecture Decisions

> Living document. Updated by luna-brain-sync and by the owner manually.
> Dates are verifiable in `git log` unless marked otherwise.

## Plan Mode ("Detective Mode") implementation decisions

(Dates not recorded — these predate this log format.)

1. **Real multi-turn loop in the backend** — `processPlanModeStream` runs up to 8 turns: Kimi requests a read tool, the backend executes it on the local PC and feeds the real result back into the next inference. Motive: visible investigation (minimum 5 tools) with the plan card only at the end. Files: `packages/kernel/luna-soul.cjs` (`processPlanModeStream`, `_buildPlanModePrompt`, `_buildPlanFollowUpPrompt`, `_extractPlanMarkdown`, `_sanitizePlanResponse`).
2. **Plan-mode prompt isolated from the normal system prompt** — injected as `[SYSTEM OVERRIDE — MÁXIMA PRIORIDADE]`, demanding JSON-only output with code blocks, same tool syntax as normal chat. Motive: avoid free text. `ipython`/`python` were kept in the allowed read-tools list.
3. **Read-only tools in plan mode** — write/execute blocked; allowed: `readFile`, `glob`, `grep`, `searchFiles`, `viewDirectory`, `listFiles`, `getFileInfo`, `searchWeb`, `fetchURL`, read-only git/dashboards, `ipython`, `python`, `think`. Motive: investigate before executing; modify nothing.
4. **Sanitize Kimi's text** — `_sanitizePlanResponse` strips tool JSON blocks and leaking `Think ...` sections before plan extraction and before adding to history. Motive: Kimi was re-sending its own tool commands as plan content.
5. **Truncated follow-up history** — `_formatToolResultForPlan` caps each tool result at 2000 chars and the follow-up keeps only the 6 most recent events. Motive: prompts blew past 24k chars, leaving Kimi slow/unresponsive.
6. **Force the final plan after enough investigation** — at `totalToolCalls >= 5` or 2 turns left, the follow-up becomes a direct order to produce the final JSON `{"response": "# Plano: ..."}`. Motive: guarantee the investigation ends and the card appears.
7. **Single plan card, state in the frontend** — `plan_display` adds the plan message; `plan_awaiting_approval` only updates `planModeState`. Motive: avoid duplicate cards. Files: `packages/kernel/luna-web/src/components/ChatArea.svelte`.
8. **Accept session via URL** — `App.svelte` sets `currentSessionId` directly from `?session=...`, regardless of whether `fetchSessions` returns it. Motive: direct links and API-created test sessions.
9. **`glob` dependency added** — `npm install glob --save` in the kernel package. Motive: the `glob` tool failed with "Cannot find module 'glob'".

## Dated decisions

- **2026-06-08 — Lazy Connect (v10.0 bridge refactor).** Commit 4658522 rewrote the Luna-Kimi bridge modularly with lazy connect: the server starts without Chrome and attaches when the browser becomes available, so a missing browser no longer blocks boot.
- **2026-06-26 – 2026-06-29 — Multi-provider via `provider-configs/*.json`.** Kimi + DeepSeek configs merged into main (commits 8bf463f, 849c972, 0af5686; files in `packages/kernel/provider-configs/`). Agent/swarm modes remain Kimi-only — their mode URLs point at `kimi.com/agent*` in `kimi-bridge.cjs`.
- **2026-07-04 — Compaction 100% manual.** Commit 18a569a removed all automatic compaction triggers; compaction now only runs through the manual flow (`/api/luna/compact`, repaired in a7a4eb6). (Owner record dated this 2026-07-03; git shows 2026-07-04 00:09 +0200.)
- **2026-07-03 — "Luna Mirror" identity frame.** Kimi K2.6 refused the "you control the computer" identity, so the prompt reframes the model as a senior DevOps engineer producing JSON that the "Luna-Mirror" system executes. The framing is present in `packages/kernel/LUNA_MASTER_PROMPT.md` and `luna-soul.cjs`; the refusal episode itself is owner record, not in git.
- **2026-07-04 — Monorepo pnpm merge.** Commit d306834 merged the dashboard into the kernel workspace: `packages/kernel` + `apps/dashboard` under one pnpm workspace (`pnpm-workspace.yaml`).
- **2026-07-04 — Telegram bot NOT distributed to end-user installs.** Commit 44ef35f removed the telegram-bot from the repo ecosystem and made its env vars required at install: it runs only on the owner's PC.
- **2026-07-05 — Telegram dedicated pipeline.** Commit 26838f4 added `_telegramPipeline` in `luna-soul.cjs`: classify intent → dashboard tool registry (`dashboard-tool-registry.cjs`) → telegram-assistant persona formatting, instead of routing Telegram through the generic web-chat path.
- **2026-07-11 — Docs split by audience.** `.agents/` + `.brain/` are written in English for AI agents; the human-facing guide is in Spanish. Motive: each audience reads its own language without duplicated documents.
- **2026-07-11 — Old audits (v10.8/v10.32) declared unreliable.** They are not a source of truth for bugs; the bug list in `.brain/bugs.md` will be rebuilt manually by the owner, verified against code.
- **2026-07-11 — Living memory automated via post-commit hook.** Commit 71a5740 added `.githooks/post-commit` + `scripts/luna-brain-sync.sh`: after each commit an agent rewrites `.brain/` from the diff, so `changelog.md` is no longer hand-edited. Hardened in 81d0158 (snapshot queue, dead-hash skip, injection guard, flock). Motive: keep `.brain/` current without relying on manual discipline.

## 2026-07-11 — External architecture review (ChatGPT) evaluated by owner + code agent

The review reframed Luna as an "agent runtime" (kernel + pluggable providers) and proposed frontend decomposition. Evaluated item by item against the actual codebase:

**ACCEPTED (direction, scheduled in the fix plan):**

- **Provider abstraction as the end state** — "Luna never talks to a model, she talks to a Provider (`provider.send(messages)`)". This is the natural completion of the multi-provider work (2026-06-26..29, `provider-configs/*.json`). Caveat the review missed: our providers are NOT uniform — Kimi/DeepSeek are browser-scraped (login, DOM, streaming by polling), API providers (OpenAI/Claude/Gemini) are request/response with native tool-calling. The Provider interface must absorb both worlds (stream of events + tool-call normalization), not pretend they're identical. Phased: after the flow bugs are fixed and the tool registry exists.
- **Single tool registry, frontend derives from it** — replacing `TOOL_COLORS`/`TOOL_ICONS` maps with one registry. We go further: the frontend registry must be GENERATED from (or fetched from) the backend tool registry (Phase 1 of modularization), otherwise we create a 5th source of truth for tool names (today there are 4, already desynced — see bugs.md guard entry).
- **ChatArea.svelte (1530 lines) and ToolCard.svelte decomposition** — confirmed by our own audit (reset logic duplicated 4x, dead code, leaks). Decompose into StreamingManager/ToolManager/EventParser etc. AFTER the rendering bugs are fixed and behavior is pinned by tests. Refactoring on top of broken behavior hides regressions.
- **UX: human tool labels, output collapsed by default, per-tool icons, mini-app actions (view diff, copy, rerun), visible-mode toggle instead of `/visible`** — all accepted as a dedicated frontend phase. Pragmatic scope: a few specialized cards (terminal, file read, file edit/diff, search) + registry-driven generic card, NOT 120 custom components.

**DEFERRED (right idea, wrong time):**

- **Rename "Luna Soul" → "Luna Kernel / Agent Runtime"** — accurate (she is the OS, not the personality), but pure churn today: pm2 config, imports, docs. Falls out naturally in modularization Phase 4 (soul becomes the thin orchestrator).
- **"Multiple agents, one per concern" (multi-agent runtime)** — the review's framing, and an old internal draft (`PLANO_AGENTES_LUNA.md`, since deleted) went there too. YAGNI now: provider abstraction + tool registry + decomposed frontend deliver ~80% of the value at ~20% of the risk. Revisit when the kernel is modular.

**REJECTED / NOTED AS WRONG FOR US:**

- **Treating API providers as near-zero-cost additions** — the review assumes swapping Kimi→Claude→GPT changes "absolutely nothing" in execution. True for the EXECUTION layer (that separation is real and was praised correctly), but the provider layer carries real per-provider cost: auth, rate limits, tool-call dialects, streaming quirks, cost controls. Each new provider is a real adapter, not a config line.
- **Immediate ToolCard/ChatArea rewrites before bug fixes** — ordering matters: fix behavior first, pin with tests, then decompose.

What the review got objectively right and we confirmed independently: LLM/execution separation is the project's strongest asset; transparency (visible command, timing, success border) is the differentiator worth doubling down on; both monoliths (ChatArea 53k chars, ToolCard 17k chars) are confirmed maintenance risks.
