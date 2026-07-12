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

- [ ] 🟡 **Heuristic validators with false positives** — `checkJsxBalanced` (char-by-char parser, breaks on TS generics) and `checkFileTruncated` (regex brace counting over strings/comments) in `luna-code-validator.cjs:19-169`. Deferred to Wave 5 (needs a real parser).
- [ ] 🟡 **writeFile schema `pathMustNotContain: ['..','~']` contradicts the path guard** (found in Wave 3 Fix H review) — soul's realpath guard correctly expands `~`/`..`, then the legacy schema rejects the raw string. Narrow window (master prompt trains absolute paths); reconcile in Wave 5.
- [ ] 🟡 **Checksum drift protection only reads `params.path`** (`luna-tool-guard.cjs:475,518`) — `filePath` alias silently bypasses drift verify/record. Also `replaceInFile` schema requires `old`/`new` while dispatch accepts `oldStr`/`newStr`.
- [ ] 🟡 **`dashboardCommandRouter` reports `success:true` on inner failure** (`luna-soul.cjs:2138` ff.) — failed dashboard mutations get marked processed (exposed by mark-on-success idempotency).
- [ ] 🟡 **~15 direct `fs.writeFileSync` sites in `luna-soul.cjs`** (`:1043, :1074, :1115, :1144, :1174-1178, :1245-1334, :3050, :4749, :4847, :4904`) — personas/skills/memory writes still non-atomic (Fix B covered only the tool paths).

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

### Wave 3 (2026-07-12) — guard/tools security & correctness

- [x] 🟠 **readFile: no binary detection, no byte cap** — `lib/text-file.cjs` `looksBinary` + 2MB cap with honest truncation note; mode-preserving. (`441fe95`, `86cb3f9`; tests A1/A2)
- [x] 🟠 **writeFile not atomic** — `lib/atomic-write.cjs` tmp+rename for writeFile/replaceInFile/soul auto-fix, preserving file mode (scripts keep +x). (`2ebe587`, `d947cda`; tests B1–B4)
- [x] 🟠 **IdempotencyStore: no TTL + marks on failure** — 10min TTL, mark-only-on-success, `success:true` on skips, scoped to mutating tools; auto-commit gate excludes skipped results (no drift bypass). (`2b83aef`, `4bc8e79`, H3 in `0dce8ac`; tests C1–C4)
- [x] 🟠 **Timeouts that don't kill anything** — safeExec default 60s/600s cap + GNU `timeout` process-GROUP kill (no orphans); dashboardApi 15s AbortSignal. (`6c9270a`, `5fa7259`; tests D1–D3 incl. pgrep death proof)
- [x] 🔴 **Command injection** — `lib/shell-quote.cjs` (shellQuote/toNonNegInt/assertSafeName) at all 6 sites PLUS the JSON.stringify-in-double-quotes sites the plan wrongly declared safe (searchFiles/grep pattern+cwd+globs, gitCommit message, checkSyntax paths, clipboard fallbacks). (`574b9b3`, `b29bcf0`; tests E1–E4 with live PoCs)
- [x] 🔴 **Path traversal** — `lib/path-guard.cjs` kernel-faithful symlink resolution (follows symlinks before `..`, verified against the real kernel), all alias keys + cwd + glob static prefixes, scoped to file tools only (dashboard `to`/`from`/`source` unblocked), per-user workspace. (`45d7f4f`, `e1f00a1`, `ef4a435`; tests F1–F5)
- [x] 🔴 **SSRF** — `lib/url-safety.cjs` default-deny private/loopback/metadata/CGNAT (all IPv4 literal forms, IPv6 incl. v4-compat/NAT64 tails, trailing-dot), per-redirect re-validation, 5MB/100MB caps, 15s timeouts, `LUNA_FETCH_ALLOW_HOSTS` override. (`24c17d8`, `cbf87d4`; tests G1–G5)
- [x] 🔴 **Guard schema registry desync** — fail-open default schema with warn-once (111 tools unblocked), guard now ACTIVE for web/Telegram via `_ensureToolGuard(options.userId)`; circuit breaker fixed for executeShell (clamp hoisted, skips feed breaker). Full per-tool schema coverage deferred to Wave 5. (`0dce8ac`, `ebe7748`; tests H1–H5)
- [x] 🟡 **replaceInFile creates empty file / executeScript dual success / runBuildCheck 180s** — error instead of empty file, unified err()/ok() semantics, 60s build cap. (`f0113a5`; tests I1–I3)

---

## Recommended attack order (owner-approved 2026-07-11)

- **Wave 1 — Flow quick wins** (small, localized, high visible impact): prompt placeholders + follow-up JSON examples; persona path; frontend append bug; backend action_* dedup key + toolInstanceId transport; phantom-action guard (don't execute tools quoted inside responses); `done` emission on all silent exits.
- **Wave 2 — Stream/bridge correctness**: single source of truth for response text (or per-source cursors); extension selector parent+child fix; poller stop + stale-event purge; ReferenceError `session`; cross-user buffer filter.
- **Wave 3 — Guard/tools correctness**: schema registry from single source (start of modularization Phase 1); timeouts that actually kill; traversal aliases; idempotency TTL + retry-on-failure; writeFile atomic; readFile caps.
- **Wave 4 — Frontend hygiene**: interval leaks, zombie reconnect, ack protocol, session-switch reset, render perf, dead code removal.
- **Wave 5 — Modularization**: Phase 0 (node --test characterization net) → Phase 1 (tools registry) → continuing phases per the architecture evaluation in decisions.md.
