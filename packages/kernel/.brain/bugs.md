# Bugs

> Living document. Updated by luna-brain-sync and by the owner manually.
> Old audit documents (v10.8, v10.32) are NOT a reliable source — everything below was verified against code on 2026-07-11.
> Severity: 🔴 critical (breaks the flow / security) · 🟠 high (visible malfunction) · 🟡 medium (hygiene / edge case)

## Open

### Soul (`luna-soul.cjs`)

- [ ] 🔴 **Silent exits — Luna stops responding** (owner-reported symptom #4) — PARTIALLY FIXED in Wave 1 (see Resolved). Remaining paths: bridge retry exhaustion falls through without error (`:2389`); `_waitPromisesWithDrain` infinite poll when a tool hangs (`:3958-3977`); dedup-cache ping-pong loop (`:1631-1651` + `MAX_LOOPS = MAX_SAFE_INTEGER :2365`).
- [ ] 🟠 **Auto-continue triggers on pure response** (owner-reported symptom #5) — DOM poller scans response text for tool JSON ANYWHERE (bridge `:7786-7799`): a response that QUOTES a tool example gets executed for real; META/SUGGEST/LOAD_SKILL/UPDATE_MEMORY never set `output` (`:3528-3547`) → fall into `[CHECK]` auto-continue (`:2792-2799`). (Soul-side phantom guard hardened in Wave 1; bridge part remains.)
- [ ] 🟡 **`invalidatePromptCache` never called** (`:117-127`) — prompt edits via UI never take effect until process restart.
- [ ] 🟡 **Workspace `'luna-cli'` hardcoded in follow-up context** (`:3756-3757`) — multi-user isolation violation; same root cause makes the tool guard null for web/Telegram (see Tools section).
- [ ] 🟡 **`_executedActionCache` grows unbounded** (`:1624`) — lazy per-key expiry only.
- [ ] 🟡 **Config keys ignored** — `miniReminder`, `toolResultPrompt` (`:2767-2782` hardcoded instead), `loopRules` contradicted by `MAX_AUTO_CONTINUES = 3` (`:2367`).

### Bridge (`kimi-bridge.cjs` + extension)

- [ ] 🟠 **Tools lost: `_extractJsonToolCalls` counts braces inside strings** (`:6846-6852`) — writeFile with HTML/JS content breaks the slice → JSON.parse fails → tool silently dropped. The string-aware `extractFirstCompleteJsonObject` (`:2483-2521`) exists but isn't used here.
- [ ] 🟠 **Tools lost: extension fallback regex can't parse nested params** (`injected.js:92-93`) — non-greedy `\{[\s\S]*?\}` stops at first `}`; no jsonrepair in the extension.
- [ ] 🟠 **DeepSeek tools may never be delivered** — generic path only enqueues tools after 5 stable response cycles (`:6004-6036`); if completion heuristics never fire, tools never reach the soul.
- [ ] 🟡 **JSON wrapper accumulator misses mid-text wrappers** (`:7556`) — only fires when delta starts with `{`; raw JSON leaks to chat.
- [ ] 🟡 **Infinite waits by design** (`:7384-7390`, `:7184-7190`) — guaranteed silent hangs when a selector breaks.
- [ ] 🟡 **Parser duplication** — 3–5 copies of tool-JSON parsing across bridge/extension/observer with divergent capabilities (refactor target).
- [ ] 🟠 **Cross-user filter unverified in agent/swarm mode** (found in Wave 2 Fix C review) — agent-mode URLs (`/agent`, `/agent-swarm`) may not navigate to a per-thread path; if two users run agent sessions with the same normalized URL, the tab-URL filter (Wave 2 Fix C) cross-matches. Needs one live URL observation; if confirmed, correlate by `tabId` (already buffered at `luna-extension-handler.cjs:149`) instead of URL. Also: new-chat landing window (bare `kimi.com` before SPA navigation) has the same narrow exposure.

### Frontend (`luna-web`)

- [ ] 🟠 **Tool cards: failed tools stuck "running"** (owner-reported symptom #2, last remaining cause) — failed tools never get `action_end` → card stuck "running"; frontend `TOOL_TIMEOUT_MS` is dead code. (Transport causes fixed in Wave 1 — see Resolved.)
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

### Wave 1 (2026-07-11/12) — flow quick wins

- [x] 🟠 **Master prompt discarded** — now injected into the system prompt, appended LAST so its exact JSON examples land at the end; the 20k cap applies only to the pre-master portion so the examples survive large brain context. (`11f0ce2`, `20a7b91`; tests `wave1-soul.test.cjs` A1/A1b)
- [x] 🟠 **Follow-up/toolLoop templates without JSON examples** — exact `{"response": ...}` / `{"tool": ...}` examples appended to both templates. (`11f0ce2`; test A2)
- [x] 🔴 **Silent exits (3 of the confirmed paths)** — `done` now emitted on context_limit, STREAM_CANCELLED, and empty-response (which also emits error + PT-BR system message). (`11f0ce2`) Remaining paths still open above.
- [x] 🟠 **Telegram persona path broken** — fixed to `path.join(lunaKernel, 'personas', 'telegram-assistant.json')` + console.warn on miss. (`11f0ce2`)
- [x] 🟠 **Phantom-tool guard too eager** — guard now fires only when the response came through a valid `{"response": ...}` JSON wrapper (oracle: plain non-array object with string `.response`). (`11f0ce2`, `8af1912`; test A3)
- [x] 🟠 **Tool cards transport causes (3 of 4)** — dedup key includes `toolInstanceId || id` for action_* events; `toolInstanceId` persisted and forwarded on both SSE paths; event ids now `ev-${Date.now()}-${seq}` collision-free. (`62c4c96`, `838b758`; tests `wave1-chat-routes.test.cjs`)
- [x] 🟠 **Transport dropped error/system event text** — content extracted from `ev.error || ev.message || ...`; SSE payloads match ChatArea handlers. (`62c4c96`)
- [x] 🔴 **Append bug — quadratic text duplication** — `responseBuffer` cleared after every successful flush (and on duplicate-guard paths); dist rebuilt. (`0f5023d`, `4a781f8`, `1195fd6`)

### Wave 2 (2026-07-12) — bridge/stream correctness

- [x] 🟠 **ReferenceError: `session` out of scope** — declaration hoisted to the top of `pollWithTimeout`'s try; `empty-wait` branch and log throttle live again. (`0a6fff3`; tests `wave2-bridge.test.cjs` A1/A1b)
- [x] 🟠 **Parent+child selector duplication** — `.markdown-container` dropped from `textContent` in `injected.js` + `kimi-dom-observer.js`; extension VERSION bumped to 2.1.1-wave2 (owner must reload the extension). (`a248677`, `337fb3e`; tests B1/B1b)
- [x] 🔴 **Cross-user event theft** — `_consumeExtensionEvents(expectedUrl)` filters buffers by normalized tab URL; non-matching events stay buffered; fail-closed on ambiguity. (`be52a5c`, `542c824`; tests C1a–C2). Agent/swarm mode caveat tracked separately (open).
- [x] 🟠 **DOM poller never stops / stale events** — poller stopped in `sendMessageStream` finally before `processing=false`; queue + completion state purged right after Enter; premature `completion_candidate` ignored via `lib/stream-completion-guard.cjs`. (`ae12ff6`, `8a0f2bf`, `84be75a`; tests D1–D3)
- [x] 🔴 **Duplicated/triplicated text during streaming** — per-source response cursors with cross-source prefix guard (`lib/stream-text-cursor.cjs`) replace the single shared `lastResponse` diff; wired into Phase 0 seed, `state_change`, `response_delta`. Passed adversarial fuzz (200 randomized multi-source rounds, zero duplicated characters). (`0150d4f`; tests E1a–E1f). Known residual: a legit mid-stream regeneration freezes the stream until the turn-end done-replace (strictly better than the old corrupted output).

---

## Recommended attack order (owner-approved 2026-07-11)

- **Wave 1 — Flow quick wins** (small, localized, high visible impact): prompt placeholders + follow-up JSON examples; persona path; frontend append bug; backend action_* dedup key + toolInstanceId transport; phantom-action guard (don't execute tools quoted inside responses); `done` emission on all silent exits.
- **Wave 2 — Stream/bridge correctness**: single source of truth for response text (or per-source cursors); extension selector parent+child fix; poller stop + stale-event purge; ReferenceError `session`; cross-user buffer filter.
- **Wave 3 — Guard/tools correctness**: schema registry from single source (start of modularization Phase 1); timeouts that actually kill; traversal aliases; idempotency TTL + retry-on-failure; writeFile atomic; readFile caps.
- **Wave 4 — Frontend hygiene**: interval leaks, zombie reconnect, ack protocol, session-switch reset, render perf, dead code removal.
- **Wave 5 — Modularization**: Phase 0 (node --test characterization net) → Phase 1 (tools registry) → continuing phases per the architecture evaluation in decisions.md.
