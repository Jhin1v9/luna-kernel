# Changelog

> Living document. One entry per commit, newest first. Maintained by luna-brain-sync.

- [2026-07-11 d0ea264] chore: fix gitignore for current_session (file not dir) — corrected .gitignore entry to ignore current_session as a file
- [2026-07-11 9d5644d] chore: gitignore runtime state, commit superpowers history docs — ignored runtime state files and committed superpowers plan/design history docs
- [2026-07-11 5f81d99] chore(docs): remove obsolete prompts and pre-monorepo docs — deleted 27 legacy prompt variants, pre-monorepo docs and the luna-installer directory
- [2026-07-11 8b77531] docs: guia humano - mention dev tab 5173 and pm2 logs fallback — added Vite dev tab :5173 and pm2 logs fallback to the human guide
- [2026-07-11 7b04a6a] docs: add unified human guide in Spanish — added docs/guia-humano.md, the single human-facing guide
- [2026-07-11 b14e245] docs(agents): fix dev command and line references from quality review — corrected dev command and stale line references in .agents docs
- [2026-07-11 e943b57] docs(agents): add .agents knowledge base (architecture, conventions, prompts, runbooks) — added the .agents/ knowledge base with architecture, conventions, prompts and 3 runbooks
- [2026-07-11 637128a] docs(brain): minor consistency fixes in decisions.md — aligned wording in decisions.md after the English rewrite
- [2026-07-11 f1dfaf3] docs(brain): consolidate bugs, decisions and status in English — rewrote bugs.md, decisions.md and status.md in concise English
- [2026-07-11 4bbd29c] docs: spec - documentacao viva e unificacao (.agents + .brain + guia humano) — added design spec for unifying living docs across .agents, .brain and a human guide
- [2026-07-06 c51561e] feat(dashboard): audit log, lixeira e undo/restaurar via Telegram — added JSON audit-log service with 30-day retention, trash/undo/restore endpoints and Telegram tools
- [2026-07-05 7e25958] fix(telegram): avoid duplicate final message when response_delta already edited — skipped sending the final message if the response was already streamed via edits
- [2026-07-05 e9641c7] fix(kimi): use new_chat landing url instead of shortcut — switched Kimi provider config to the new_chat landing URL
- [2026-07-05 7465295] fix(telegram): add timeout wrapper around Kimi calls in telegram pipeline — wrapped Kimi calls in luna-soul with a timeout to avoid hanging Telegram replies
- [2026-07-05 24b295f] fix(telegram): force newChat and ensure polling is active — forced fresh chats and re-enabled polling in the Telegram bot client
- [2026-07-05 8a295b4] feat(telegram): add telegram-assistant persona — added telegram-assistant persona JSON and wired it into luna-soul
- [2026-07-05 e58256b] fix(telegram): remove dead variable in action_end handler — dropped an unused variable in the adapter's action_end handler
- [2026-07-05 05c7068] fix(telegram): clean up adapter bubble handlers — simplified bubble handler code in telegram-luna-adapter
- [2026-07-05 da853fb] feat(telegram): render dashboard tool bubbles in telegram adapter — adapter now renders dashboard tool calls as readable bubbles
- [2026-07-05 784fbb5] fix(telegram): harden telegram pipeline — defensive error handling and robustness pass over the Telegram path in luna-soul
- [2026-07-05 26838f4] feat(telegram): add simplified telegram pipeline to Luna Soul — added the streamlined Telegram message pipeline to luna-soul
- [2026-07-05 609c8c9] style(telegram): normalize registry params and freeze registry — normalized dashboard tool registry params and froze the registry object
- [2026-07-05 940205a] feat(telegram): add dashboard tool registry for telegram mode — created dashboard-tool-registry.cjs defining dashboard tools callable from Telegram
- [2026-07-04 6634eb7] fix(watchdog): read service ports from environment variables — health watchdog now reads service ports from env instead of hardcoded values
- [2026-07-04 34a23a7] fix(kimi-bridge): add --no-sandbox when running Chrome as root — Chrome launches with --no-sandbox when the process runs as root
- [2026-07-04 ec32031] fix(kimi-bridge): detect Chrome installed under /usr/local/bin — kimi-bridge also searches /usr/local/bin for the Chrome binary
- [2026-07-04 44ef35f] chore(installer): remove telegram-bot from repo ecosystem and ask for required env vars — pm2 no longer starts telegram-bot; installer prompts for NEXO_BASE_PATH and DATABASE_URL
- [2026-07-04 bf7be95] fix(kimi-bridge): honor persisted chat URL per Luna session — bridge restores the saved Kimi chat URL per session and guards against URL mismatches
- [2026-07-04 96b8958] fix(installer): export helper functions for testability — install.cjs now exports helpers so they can be unit tested
- [2026-07-04 24eaad0] docs(readme): add one-command installer instructions — README documents the one-command install flow
- [2026-07-04 8920444] feat(installer): add Kimi login wizard HTML — added install-wizard.html for guiding Kimi login during setup
- [2026-07-04 ecae74c] feat(installer): add prompts, env generation, build, pm2 and shortcuts — installer now prompts for config, generates .env, builds, registers pm2 services and shortcuts
