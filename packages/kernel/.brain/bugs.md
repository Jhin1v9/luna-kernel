# Bugs

> Living document. Updated by luna-brain-sync and by the owner manually.
> Old audit documents (v10.8, v10.32) are NOT a reliable source — verify against code before listing anything here.

## Open

Reported by owner 2026-07-11, under investigation (root cause being verified against code):

- [ ] **System prompt lacks exact JSON examples** — the model invents tool JSON shapes that don't match what Luna parses. The system prompt must end with an EXACT example for tool calls and for `{"response"}`. (owner report 2026-07-11)
- [ ] **Tool cards render only partially in the web UI** — some tools show as bubbles, others don't. (owner report 2026-07-11)
- [ ] **Bridge streams duplicated/triplicated text during processing** — Kimi text reaches the frontend 2-4x while streaming; settles correctly when processing ends. Bridge should wait for soul to confirm parsing before forwarding to frontend. (owner report 2026-07-11)
- [ ] **Luna stops responding randomly** — halts mid-conversation with no error visible. (owner report 2026-07-11)
- [ ] **Auto-continue on pure `{"response"}`** — when the model sends a plain response, Luna must wait for user interaction instead of auto-continuing on its own. (owner report 2026-07-11)
- [ ] **Telegram persona path broken** — `luna-soul.cjs:4991` builds the persona path with duplicated segments (`PATHS.lunaKernel + 'packages/kernel/...'`); `fs.existsSync` fails silently and persona falls back to empty. (found during docs work 2026-07-11, verified in code)

## Resolved

(none tracked yet — resolved bugs moved here by luna-brain-sync reference the fixing commit)
