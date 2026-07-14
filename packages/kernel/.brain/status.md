# Status

> Living document — current state only, no history. Read together with `decisions.md` and `bugs.md`.

## What Luna is

Luna is an autonomous "mirror" agent: reasoning happens inside the Kimi or DeepSeek web apps, driven through a real Chrome via CDP (:9222) by `kimi-bridge.cjs`. Luna (`luna-soul.cjs`) parses the model's JSON tool blocks and executes them on a real Linux PC — files, shell, git, dashboards — then feeds the results back for the next turn. The model never executes anything directly; Luna is the executor.

## Working

- **Web chat UI** on :3458 (`luna-server`, `apps/dashboard/luna-server.js`) with the Vite dev server on :5173.
- **Context compaction** — automatic on Kimi's context-limit notice (web + Telegram): the soul compacts via `_compactContext` and resends the original message in the new thread, one-shot per user message (Wave 10, supersedes the 2026-07-04 manual-only decision). Manual trigger remains: header button / `/compactar` → `POST /api/luna/compact` in `apps/dashboard/luna-chat-routes.js:2061` (mounted by `luna-server.js`); `packages/kernel/luna-api-server.cjs` is only a legacy stub that simulates it.
- **Telegram pipeline** — `_telegramPipeline` in `luna-soul.cjs`: intent classification → dashboard tool registry → telegram-assistant persona formatting. Runs as the `luna-telegram-adapter` pm2 process (owner's PC only).
- **Plan mode ("Detective Mode")** — multi-turn read-only investigation loop in the backend, ending in an Approve/Reject/Revise plan card.
- **Multi-provider** — Kimi + DeepSeek via `packages/kernel/provider-configs/*.json` (modes: instant/thinking; agent/swarm removed in Wave 7).
- **Dashboard audit log + trash** — commit c51561e: `/api/audit-log`, `/audit-log/trash`, `/audit-log/undo-last`, `/audit-log/restore/:id`, with undo/restore available from Telegram.
- **Living-memory automation** — `.githooks/post-commit` queues every commit and kicks `scripts/luna-brain-sync.sh` detached in the background (flock-serialized); the sync drains the queue via `kimi -p`, updates `.brain/` and auto-commits with the `[brain-sync]` marker, which the hook skips (anti-loop). (commits 71a5740, hardened 81d0158, auto-drain added 2026-07-13)

## Known broken / risky

See `bugs.md`. Currently empty by the owner's decision (2026-07-11): old audits are unreliable, so bugs will be registered manually after verification against the code.

## Current focus

Provider Discovery System — Phase 0 implementation started (TDD, per `plans/2026-07-14-pds-phase0-foundation.md`): `lib/provider-selectors.cjs` (v1/v2 fallback chains + `waitForChain`) and deepseek.json config v2 (newChat added, cdpPatterns removed) landed with `wave11-provider-config.test.cjs`; kimi.json stays untouched per owner directive (Kimi defaults remain in-code fallbacks). Remaining Phase 0 tasks (dead CDP removal, config wiring) pending.

## How to run

`pm2 status` should show 5 online processes:

- `luna-server` — Luna API + chat backend (:3458)
- `nexo-dashboard` — NEXO dashboard (:3456)
- `luna-telegram-adapter` — Telegram bot (owner's PC only, not distributed)
- `luna-vite` — Vite dev server for the web UI (:5173)
- `luna-health-watchdog` — health monitor
