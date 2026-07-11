# Bugs

> Living document. Updated by luna-brain-sync and by the owner manually.
> Old audit documents (v10.8, v10.32) are NOT a reliable source — everything below was verified against code on 2026-07-11.
> Severity: 🔴 critical (breaks the flow / security) · 🟠 high (visible malfunction) · 🟡 medium (hygiene / edge case)

## Open

### Soul (`luna-soul.cjs`)

- [ ] 🟠 **Master prompt + persona + memories loaded then DISCARDED** — config template lacks `{{masterPrompt}}`/`{{personaContent}}`/`{{memoryContext}}` placeholders (`:310-325`); `LUNA_MASTER_PROMPT.md` (full tools table + exact JSON examples) never reaches the model. (owner-reported symptom #1)
- [ ] 🟠 **Follow-up/toolLoop templates have NO JSON examples** (`:3766-3784`) — model invents formats mid-conversation, especially after newChat/compaction. (owner-reported symptom #1)
- [ ] 🔴 **Silent exits — Luna stops responding** (owner-reported symptom #4), 9 confirmed paths; main: empty bridge response → CHAT `done` with empty string (`:2654-2658` + bridge `:7806`); `context_limit`/cancel return without `done` (`:2524`, `:2588`); bridge retry exhaustion falls through without error (`:2389`); `_waitPromisesWithDrain` infinite poll when a tool hangs (`:3958-3977`); dedup-cache ping-pong loop (`:1631-1651` + `MAX_LOOPS = MAX_SAFE_INTEGER :2365`).
- [ ] 🟠 **Auto-continue triggers on pure response** (owner-reported symptom #5) — DOM poller scans response text for tool JSON ANYWHERE (bridge `:7786-7799`): a response that QUOTES a tool example gets executed for real; META/SUGGEST/LOAD_SKILL/UPDATE_MEMORY never set `output` (`:3528-3547`) → fall into `[CHECK]` auto-continue (`:2792-2799`).
- [ ] 🟠 **Telegram persona path broken** — duplicated segments (`:4991`), `existsSync` fails silently → empty persona.
- [ ] 🟡 **`invalidatePromptCache` never called** (`:117-127`) — prompt edits via UI never take effect until process restart.
- [ ] 🟡 **Workspace `'luna-cli'` hardcoded in follow-up context** (`:3756-3757`) — multi-user isolation violation; same root cause makes the tool guard null for web/Telegram (see Tools section).
- [ ] 🟡 **`_executedActionCache` grows unbounded** (`:1624`) — lazy per-key expiry only.
- [ ] 🟡 **Config keys ignored** — `miniReminder`, `toolResultPrompt` (`:2767-2782` hardcoded instead), `loopRules` contradicted by `MAX_AUTO_CONTINUES = 3` (`:2367`).

### Bridge (`kimi-bridge.cjs` + extension)

- [ ] 🔴 **Duplicated/triplicated text during streaming** (owner-reported symptom #3) — 3 concurrent text producers (extension, DOM poll, ultra-light observer) feed ONE shared `lastResponse` cursor with `slice(length)` diff (`:7532-7664`); no soul→bridge handshake exists.
- [ ] 🟠 **Parent+child selector duplication** — `luna-extension/injected.js:34` and `kimi-dom-observer.js:17` match `.markdown-container` (parent) AND `.segment-text` (child) → same paragraph concatenated twice per event.
- [ ] 🟠 **ReferenceError: `session` out of scope** (`:6002` declared inside `if`, referenced at `:6044`) — swallowed by catch → `empty-wait` branch is dead code; poller logs "error" whenever all extraction layers fail.
- [ ] 🔴 **Cross-user event theft** — `global.__lunaExtensionEventBuffers` (`:5174`) drained without userId/sessionId filter (`:5179-5182`): first poller steals events from other users' sessions.
- [ ] 🟠 **DOM poller never stops** (`:7827-7828`) — stale events from the previous turn feed the next message's queue (`:7201`, Phase 0 `:7422-7451`).
- [ ] 🟠 **Tools lost: `_extractJsonToolCalls` counts braces inside strings** (`:6846-6852`) — writeFile with HTML/JS content breaks the slice → JSON.parse fails → tool silently dropped. The string-aware `extractFirstCompleteJsonObject` (`:2483-2521`) exists but isn't used here.
- [ ] 🟠 **Tools lost: extension fallback regex can't parse nested params** (`injected.js:92-93`) — non-greedy `\{[\s\S]*?\}` stops at first `}`; no jsonrepair in the extension.
- [ ] 🟠 **DeepSeek tools may never be delivered** — generic path only enqueues tools after 5 stable response cycles (`:6004-6036`); if completion heuristics never fire, tools never reach the soul.
- [ ] 🟡 **JSON wrapper accumulator misses mid-text wrappers** (`:7556`) — only fires when delta starts with `{`; raw JSON leaks to chat.
- [ ] 🟡 **Infinite waits by design** (`:7384-7390`, `:7184-7190`) — guaranteed silent hangs when a selector breaks.
- [ ] 🟡 **Parser duplication** — 3–5 copies of tool-JSON parsing across bridge/extension/observer with divergent capabilities (refactor target).

### Frontend (`luna-web`)

- [ ] 🟠 **Tool cards render only partially** (owner-reported symptom #2) — 4 confirmed causes: backend dedup drops repeated `action_*` (`luna-chat-routes.js:498-503`, key lacks params/instanceId); `toolInstanceId` dropped in transport (`:506-517`, `:655-676`); `'ev-' + Date.now()` id collisions in the same ms (`:507`); failed tools never get `action_end` → card stuck "running" (frontend `TOOL_TIMEOUT_MS` is dead code).
- [ ] 🔴 **Append bug — quadratic text duplication** (owner-reported symptom #3, primary cause) — `ChatArea.svelte:117-136`: buffer never cleared on the append path → each delta re-appends the whole buffer; settles only on `done` forceText replace.
- [ ] 🟠 **`setInterval` leak per tool** (`ChatArea.svelte:514-525`) — 100ms interval runs forever when `action_end` never arrives; map reset on reconnect without clearing old intervals (`:945`).
- [ ] 🟠 **Zombie SSE reconnect** — backoff `setTimeout` not stored/cancellable (`api.js:159`); fires `connect()` after `disconnect()`, resets `isIntentionallyClosed`; `new SSEManager()` per reconnect discards the old one with pending timer (`ChatArea.svelte:948-949`).
- [ ] 🟡 **`/api/chat/ack` never called** — backend eventLedger (cap 200) never cleared; every reconnect replays old events, relying on frontend dedup.
- [ ] 🟡 **`lastMessageCount` not reset on session switch** (`api.js:33/50-87`) — polling fallback slices wrong on the new session.
- [ ] 🟡 **`action_progress.chunk` dropped in transport** — live tool output (`liveOutput` in ToolCard) is dead.
- [ ] 🟡 **`processedEventIds` eviction removes only 1 entry** when >5000 (`ChatArea.svelte:358-361`).
- [ ] 🟡 **Markdown re-parse + highlight per delta without debounce** (`AssistantMessage.svelte:125-147`) — O(n²)+ per message; `marked.use()` mutates global config per instance (`:52-58`).
- [ ] 🟡 **`window.fetch` monkey-patch reloads page on any 401** (`api.js:429-448`) — loses stream/state without warning.
- [ ] 🟡 **Debug logs in production** — `console.log` with `new Error().stack` on every send (`ChatArea.svelte:1043, 1132`); `[SSE]` per event (`:364`).
- [ ] 🟡 **Resize listener never removed** (`OrbBackground.svelte:139`).

### Tools / Guard (`luna-tools.cjs`, `luna-tool-guard.cjs`, `luna-code-validator.cjs`)

- [ ] 🔴 **Guard schema registry desync** — only ~11 of ~120 tools have schemas (`luna-tool-guard.cjs:142-198`); `validateToolCall` THROWS for the rest → in `luna-cli` sessions most tools fail; in web/Telegram the guard is null (workspace mismatch, `luna-soul.cjs:1687-1693`) → ZERO validation/timeout/idempotency. Worst of both worlds.
- [ ] 🔴 **Path traversal** — check only covers `params.path` (`luna-soul.cjs:4122-4129`); aliases (`filePath`/`source`/`from`/`to`) bypass; `/tmp` escape hatch; `'..'` substring block is symlink-bypassable.
- [ ] 🔴 **Command injection** — `executeShellVisible` cwd interpolated in script (`luna-tools.cjs:778`); `searchFiles`/`grep` context param (`:559-592`); `gitLog` n (`:1114`); `installPackages` pkg list (`:1075-1077`); `openDebugTerminal` target (`:1355`); validator tsconfig path (`luna-code-validator.cjs:552-555`).
- [ ] 🔴 **SSRF** — `fetchURL`/`downloadFile`/`browser`: no host validation, recursive redirects to any Location, no size cap, timeout 0 (`luna-tools.cjs:748-762, 1165-1190, 713-746`); `downloadFile` timeout default 0 = none.
- [ ] 🟠 **Timeouts that don't kill anything** — `safeExec` default 0 = unlimited (`luna-tools.cjs:123-124`); guard `withTimeout` is only `Promise.race` — never kills child process or aborts request (`luna-tool-guard.cjs:282-292`); `dashboardApi` fetch has no timeout at all (`luna-tools.cjs:1380-1396`).
- [ ] 🟠 **writeFile not atomic** — direct `writeFileSync` (`luna-tools.cjs:187-189`); no tmp+rename; soul auto-fix rewrites the file a second time (`luna-soul.cjs:4333-4341`) — second corruption window.
- [ ] 🟠 **readFile: no binary detection, no byte cap** — whole file into memory + split before the 1000-line limit (`luna-tools.cjs:143-173`).
- [ ] 🟠 **IdempotencyStore: no TTL + marks processed on failure** (`luna-tool-guard.cjs:116-139, 456`) — a failed writeFile can never be legitimately retried (silently "skipped"); skip result `{skipped:true}` lacks `success` field → treated as failure downstream (`luna-soul.cjs:4552`).
- [ ] 🟡 **replaceInFile creates empty file if missing** (`luna-tools.cjs:239-245`) — surprising fallback.
- [ ] 🟡 **executeScript dual success semantics** — `ok()` then overwritten with `success: exitCode===0` (`luna-tools.cjs:334`).
- [ ] 🟡 **runBuildCheck blocks the writeFile path up to 180s** (`luna-soul.cjs:4378-4388`) + screenshot validation — one writeFile can block for minutes, fighting the guard's 30s.
- [ ] 🟡 **Heuristic validators with false positives** — `checkJsxBalanced` (char-by-char parser, breaks on TS generics) and `checkFileTruncated` (regex brace counting over strings/comments) in `luna-code-validator.cjs:19-169`.

## Resolved

(none tracked yet — resolved bugs moved here by luna-brain-sync reference the fixing commit)

---

## Recommended attack order (owner-approved 2026-07-11)

- **Wave 1 — Flow quick wins** (small, localized, high visible impact): prompt placeholders + follow-up JSON examples; persona path; frontend append bug; backend action_* dedup key + toolInstanceId transport; phantom-action guard (don't execute tools quoted inside responses); `done` emission on all silent exits.
- **Wave 2 — Stream/bridge correctness**: single source of truth for response text (or per-source cursors); extension selector parent+child fix; poller stop + stale-event purge; ReferenceError `session`; cross-user buffer filter.
- **Wave 3 — Guard/tools correctness**: schema registry from single source (start of modularization Phase 1); timeouts that actually kill; traversal aliases; idempotency TTL + retry-on-failure; writeFile atomic; readFile caps.
- **Wave 4 — Frontend hygiene**: interval leaks, zombie reconnect, ack protocol, session-switch reset, render perf, dead code removal.
- **Wave 5 — Modularization**: Phase 0 (node --test characterization net) → Phase 1 (tools registry) → continuing phases per the architecture evaluation in decisions.md.
