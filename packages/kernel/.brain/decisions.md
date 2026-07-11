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
