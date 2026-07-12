# Bugs

> Living document. Updated by luna-brain-sync and by the owner manually.
> Old audit documents (v10.8, v10.32) are NOT a reliable source — everything below was verified against code on 2026-07-11.
> Severity: 🔴 critical (breaks the flow / security) · 🟠 high (visible malfunction) · 🟡 medium (hygiene / edge case)

## Open

### Soul (`luna-soul.cjs`)

- [ ] 🟡 **`invalidatePromptCache` never called** (`:117-127`) — prompt edits via UI never take effect until process restart.
- [ ] 🟡 **Workspace `'luna-cli'` hardcoded in follow-up context** (`:3756-3757`) — multi-user isolation violation; same root cause makes the tool guard null for web/Telegram (see Tools section).
- [ ] 🟡 **Config keys ignored** — `miniReminder`, `toolResultPrompt` (`:2767-2782` hardcoded instead), `loopRules` contradicted by `MAX_AUTO_CONTINUES = 3` (`:2367`).

### Bridge (`kimi-bridge.cjs` + extension)

- [ ] 🟠 **Tools lost: `_extractJsonToolCalls` counts braces inside strings** (`:6846-6852`) — writeFile with HTML/JS content breaks the slice → JSON.parse fails → tool silently dropped. The string-aware `extractFirstCompleteJsonObject` (`:2483-2521`) exists but isn't used here.
- [ ] 🟠 **Tools lost: extension fallback regex can't parse nested params** (`injected.js:92-93`) — non-greedy `\{[\s\S]*?\}` stops at first `}`; no jsonrepair in the extension.
- [ ] 🟡 **JSON wrapper accumulator misses mid-text wrappers** (`:7556`) — only fires when delta starts with `{`; raw JSON leaks to chat.
- [ ] 🟡 **Parser duplication** — 3–5 copies of tool-JSON parsing across bridge/extension/observer with divergent capabilities (refactor target).
- [ ] 🟠 **Cross-user filter unverified in agent/swarm mode** (found in Wave 2 Fix C review) — agent-mode URLs (`/agent`, `/agent-swarm`) may not navigate to a per-thread path; if two users run agent sessions with the same normalized URL, the tab-URL filter (Wave 2 Fix C) cross-matches. Needs one live URL observation; if confirmed, correlate by `tabId` (already buffered at `luna-extension-handler.cjs:149`) instead of URL. Also: new-chat landing window (bare `kimi.com` before SPA navigation) has the same narrow exposure.

### Frontend (`luna-web`)

- [ ] 🟡 **Chunk replay duplication on reconnect** (found in Wave 4 T9 review) — `action_progress` chunks have no message-level dedup in ChatArea; if a reconnect's `Last-Event-ID` was already acked out of the ledger, replay-from-0 re-appends already-rendered chunks to ToolCard live output. Cosmetic, self-heals on history reload. Fix candidate: dedup chunk events client-side by id, or keep chunk ids out of the ack-trim path.

### Tools / Guard (`luna-tools.cjs`, `luna-tool-guard.cjs`, `luna-code-validator.cjs`)

- [ ] 🟡 **Heuristic validators with false positives** — `checkJsxBalanced` (char-by-char parser, breaks on TS generics) and `checkFileTruncated` (regex brace counting over strings/comments) in `luna-code-validator.cjs:19-169`. Deferred (needs a real parser); Wave 5 kept the fail-open default by decision.
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

### Wave 4 (2026-07-12) — frontend hygiene

- [x] 🟡 **Debug logs in production** — removed per-event `[SSE]`/`[done]` dumps and per-send stack-trace/branch logs from ChatArea; warns/errors kept. (`51bcc52`; tests `wave4-frontend.test.cjs` T1)
- [x] 🟡 **Resize listener never removed** — named `handleResize` + `removeEventListener` in `onDestroy` (OrbBackground). (`6c816b8`; test T2)
- [x] 🟡 **`processedEventIds` eviction removed only 1 entry** — `lib/evictSet.js` `evictOldestEntries` trims to 80% of the cap in one pass. (`496d95a`; test T3)
- [x] 🟡 **Markdown re-parse + highlight per delta** — module-scope `Marked` instance (no more per-instance `marked.use()` global mutation) + 120ms debounced render/highlight during streaming, immediate render when idle (`lib/debounce.js`); review follow-ups: scheduler cancelled on destroy, redundant renders on global `isStreaming` flips skipped. (`ac75927`, `1855de0`; test T4)
- [x] 🟡 **`window.fetch` monkey-patch reloaded page on 401** — `lib/authGuard.js` `shouldForceLogout`; token cleared + `user.set(null)` shows the login screen reactively, no reload. (`83f1990`, `07bb579`; test T5)
- [x] 🟠 **Zombie SSE reconnect** — backoff timer stored on `SSEManager.reconnectTimer`, cancelled by `disconnect()`/`connect()`, callback re-checks the closed flags; ChatArea reuses the manager instead of `new SSEManager()` per reconnect. (`a5d7645`, `33b0167`; test T6)
- [x] 🟡 **`lastMessageCount` not reset on session switch** — `connect()` resets it when `sessionId` changes; same-session reconnects preserve it. (`a5d7645`, `33b0167`; test T6)
- [x] 🟠 **Tool cards stuck "running"** — `lib/toolTimers.js` registry arms a 60s watchdog per tool (`TOOL_TIMEOUT_MS` no longer dead code); on timeout the card is marked failed with a PT-BR message and the input unlocks; review follow-up: late `action_end` for a timed-out card can no longer kill the next turn's streaming state. (`bd449ba`, `7b4ef9a`; test T7)
- [x] 🟠 **`setInterval` leak per tool** — the same registry owns every UI ticker + watchdog; `clearAll()` on reconnect and `onDestroy`. (`bd449ba`; test T7)
- [x] 🟡 **`/api/chat/ack` never called** — `lib/ackBatcher.js` batches acks (1s/100 ids); ChatArea acks every received ledger event id (`ev-*`/`done-*`/`err-*`); backend route already existed and prunes the ledger; review follow-up: batcher reset before the cancelStream await on session switch. (`915575c`, `a094ba7`; test T8)
- [x] 🟡 **`action_progress.chunk` dropped in transport** — `lib/progress-event.cjs` normalizes the soul's positional progress callback (string spread produced garbage keys); chat-routes stores `chunk`, forwards it in both SSE serializers, and stops deduping `action_progress`; review follow-up: progress chunks skip per-event session persistence (N sync writes → 1 amortized). (`0e2a45a`, `e70f908`; test T9)

### Wave 5 (2026-07-12) — tool registry (modularization Phase 0+1)

- [x] 🟡 **writeFile schema `pathMustNotContain: ['..','~']` contradicts the path guard** — rule removed from the registry's writeFile schema; soul's realpath path-guard (`lib/path-guard.cjs`) remains the sole traversal authority (verified end-to-end: `..`, `~`, symlink and tmp-allowlist escapes all blocked). (`30baf59`; tests `wave5-tool-registry.test.cjs` P0-2, wave3 H1 updated)
- [x] 🟡 **Checksum drift protection only read `params.path`** — guard resolves `path || filePath || file` for drift verify/record; `replaceInFile` schema now accepts the `oldStr`/`newStr` aliases the dispatch already took. (`30baf59`; tests P0-3, P0-11)
- [x] 🟡 **Four sources of truth for tools → three** — `lib/tool-registry.cjs` (132 entries) is THE source: guard schemas derive from it (`buildToolSchemas()`, frozen copies); frontend icon/color maps are GENERATED from it (`scripts/gen-tool-meta.cjs` → `luna-web/src/lib/toolMeta.generated.js`, byte-drift test T4). Accepted residual: the master-prompt tool docs (`LUNA_MASTER_PROMPT.md`) stay hand-maintained. (`2997da4`, `fae3af1`, `05485dc`, `060d5b5`, `4540176`, `59c33f7`)
- [x] 🟡 **Tracked dist chunk `index-Co_pucoo.js` suspected orphaned** — VERIFIED NOT orphaned: it is the highlight.js lazy chunk, dynamically imported from the main bundle; a fresh deterministic build regenerates and references it. Kept. (Wave 5 T4 review; `59c33f7`)
- [x] ℹ️ **Phase 0 characterization net** — 12 guard schemas + fail-open + checksum drift pinned by `wave5-tool-registry.test.cjs` (P0-1…P0-12) BEFORE any migration, making the zero-behavior-change moves provable. (`c42cb45`, `6f1b8ed`)

### Wave 6 (2026-07-12) — live validation hotfixes

- [x] 🔴 **Every executeShell failed with bogus ENOENT** — PM2 inherited `DISPLAY=:0` from the shell (`pm2 restart --update-env`), routing executeShell through the VISIBLE path (`executeShellVisible`); the graphical terminal produced no log under the PM2 session, and the close handler classified the missing log as "file not found" instead of recovering. Now: ENOENT on the log ⇒ the command never ran ⇒ automatic fallback to the invisible shell (same pattern as the v10.29 spawn-error fallback). (`38e4be7`; tests `wave3-guard-tools.test.cjs` W6a/W6b)
- [x] 🔴 **Silent exits — every confirmed path now terminates with a visible event** — bridge new-assistant detection loop bounded at 120s + cancel check (`a78114e`, `582e0ea`; tests `wave2-bridge.test.cjs` W6-T1); `_waitPromisesWithDrain` capped at 10min — hung tools force-resolve with a visible `action_end` (`268ca7f`; W6-T2); the three infinite send waits bounded: drain pre-send 60s self-heal, Phase 0 5min start timeout, Phase 1 60min safety net re-enabled (`a4536de`, `47c38db`; W6-T3); real `MAX_LOOPS = 50` ceiling + `done` on every exhaustion/error path including crash-recovery failure, `_buildContext` in catch try-guarded (`16c70e9`, `6203c8d`; W6-T4). Caveat: MAX_LOOPS=50 may clip marathon sessions (raise to 100 if the owner hits it). Known residuals: `_buildContext` call sites outside the catch (`:2382/:2753/:2860/:2874`) can still surface a raw English transport error to the user (transport catch still terminates the turn); concierge gap — `server.js:5876` POST /api/luna/chat lacks cancel-before-send (Low, T3 review).
- [x] 🔴 **Auto-continue replay loop — stale tool results and phantom re-detection killed** — action cache single-feedback (1 replay per execution), failures never cached, 200-entry FIFO cap (`23e6b01`; W6-T5); turn-scoped phantom detection: pre-send assistant marker + cross-turn dom-event dedup with 120s TTL (`825c2de`; W6-T6); all-cached results on a CHAT turn stop as pure chat (`ad45075`; W6-T7); single-writer response persistence (response_detected no longer appends; `_handleChat` sole writer) + `done` dedup + `session._streamClosed` gate with reopen on POST + ownership guard on `activeStreams.delete` (`33cd6f0`; W6-T8). Accepted trade: cancelled/error turns in non-streaming mode may lose text that only ever existed in response_detected (inherent to single-writer).
- [x] 🟠 **`{"script"}` format swallowed** — bridge `_preEscapeJsonStringNewlines` walker recovers scripts mangled by DOM text extraction; `extractResponseFromCompleteJson` + Strategy 2 regex accept `"(?:tool|script)"`; soul `_tryExtractRawToolJson` re-dispatch backstop — intent-JSON broken or with a tool/script key but no payload yields a friendly PT-BR message, valid non-tool JSON is never swallowed (`8b45c8a`; W6-T9).
- [x] 🟠 **Visible terminal broken / dependent on inherited env** — new `lib/terminal-resolver.cjs`: `resolveTerminal(env)` ($TERMINAL first, full-path lookup, realpath-aware argv overrides: gnome-terminal wrapper/kgx/gnome-console → `--wait --`, konsole → `--nofork`), `enrichSessionEnv()` fills XDG_RUNTIME_DIR/DBUS/WAYLAND/DISPLAY/XAUTHORITY only when missing; consumed by detectHeadless/spawn/gate/openDebugTerminal (`21a71cb`; W6-T10). Soul dispatches `setVisibleMode`/`getVisibleMode` with strict enabled check; the 3 fallback sites in luna-tools annotate `fallback.warning` surfaced as a warning strip in ToolCard (`bf9784e`; W6-T11). Known wart: closing the terminal window early yields partial output (pre-existing); marker-based completion deferred to Wave 7.
- [x] 🟠 **DeepSeek tools may never be delivered** — force-complete cap: `_shouldForceGenericComplete` (45s since first sight + 10s length-stable, only while uiGenerating) forces completion + `canSteer = true` so the completion vote reaches 4/4; per-turn tracking reset at the post-Enter boundary (review fix — the v10.35 "previous answer still visible" condition no longer degrades the cap to 10s) (`d28aade`, `1d55d36`; W6-T12). Residual accepted: a cursor blink that changes the extracted text LENGTH keeps the cap inert (needs a width-immune stability signal, Wave 7).

---

## Recommended attack order (owner-approved 2026-07-11)

- **Wave 1 — Flow quick wins** (small, localized, high visible impact): prompt placeholders + follow-up JSON examples; persona path; frontend append bug; backend action_* dedup key + toolInstanceId transport; phantom-action guard (don't execute tools quoted inside responses); `done` emission on all silent exits.
- **Wave 2 — Stream/bridge correctness**: single source of truth for response text (or per-source cursors); extension selector parent+child fix; poller stop + stale-event purge; ReferenceError `session`; cross-user buffer filter.
- **Wave 3 — Guard/tools correctness**: schema registry from single source (start of modularization Phase 1); timeouts that actually kill; traversal aliases; idempotency TTL + retry-on-failure; writeFile atomic; readFile caps.
- **Wave 4 — Frontend hygiene**: interval leaks, zombie reconnect, ack protocol, session-switch reset, render perf, dead code removal.
- **Wave 5 — Modularization**: Phase 0 (node --test characterization net) → Phase 1 (tools registry) → continuing phases per the architecture evaluation in decisions.md.
