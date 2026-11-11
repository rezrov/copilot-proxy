# TODO

Remaining work after the tool-invocation overhaul. Ordered roughly by value.

## 1. End-to-end validation through a real client
All tool-calling work was verified live against `gpt-5-mini` on an **isolated test
proxy** (port 3099). It has **not** yet been exercised through the live proxy with a
real client (opencode) driving real tools end-to-end.

- Restart the live proxy on the updated `index.js`.
- Run a session that triggers real tool calls (`bash`/`edit`/`read`/parallel calls).
- Confirm round-trips, multi-round sequences, and streaming all behave in practice.

## 2. Reasoning support (SDK 1.0.11 — DONE)

`reasoning_effort` is a standard OpenAI field that the proxy previously ignored
entirely. Unlike the sampling params below, the SDK **does** forward it
(`reasoningEffort` / `reasoningSummary` are in the `session.create` allowlist).

- [x] `/v1/chat/completions` parses `reasoning_effort`; `/v1/responses` parses
  the nested `reasoning: { effort, summary }`.
- [x] Values are validated per-model against `supportedReasoningEfforts`. The CLI
  **silently accepts junk** (verified: `reasoningEffort: "bogus"` creates a
  session with no error), so validation must happen proxy-side or an invalid
  value becomes another invisible no-op.
- [x] Vocabularies differ (OpenAI documents `minimal`; the SDK adds
  `xhigh`/`max`; each model offers a different subset), so unsupported values
  degrade to the nearest offered level rather than being dropped — e.g. on
  `gpt-5-mini`: `minimal` -> `low`, `xhigh`/`max` -> `high`. Unmappable values
  and reasoning-incapable models (`auto`) log a warning and are ignored.
- [x] Reasoning **text** is surfaced: `reasoning_content` deltas + message field
  on chat completions (the de-facto DeepSeek/vLLM/OpenRouter convention, since
  Chat Completions has no official field), and a native `reasoning` output item
  with `response.reasoning_summary_text.delta` events on `/v1/responses`.
- [x] Two runtime constraints found empirically and handled:
  - Reasoning text is emitted **only when `reasoningSummary` is set** (with none,
    or `"none"`, zero reasoning deltas arrive). Chat Completions has no summary
    field, so the proxy defaults it to `"detailed"` whenever an effort is
    accepted — otherwise callers ask for reasoning and silently get none.
  - Reasoning text is emitted **only in streaming mode**. Non-streaming turns
    receive an `assistant.reasoning` event whose `content` is empty, so
    non-streaming responses correctly omit reasoning rather than faking it.
- [x] Verified live (port 3399): 1306 chars of `reasoning_content` on a chat
  stream; a correctly-indexed `['reasoning', 'message']` output on a responses
  stream; all four validation paths warn as expected.

## 3. Model capability flags + real health check (DONE)

- [x] `/v1/models` now publishes `supports_vision`, `supports_reasoning_effort`,
  `supported_reasoning_efforts`, and `default_reasoning_effort` from the SDK's
  `capabilities.supports`, so clients can tell which models accept images or
  reasoning before sending a request.
- [x] `/health` now probes the CLI via `getStatus()` + `getAuthStatus()` and
  returns `cli_version` / `protocol_version` / `authenticated`, or 503 on
  failure. It previously returned a static `{status:"ok"}` that stayed green
  even with a dead runtime.

## 4. Bugs found while testing the above (DONE)

- [x] **Tools without a `description` crashed the turn.** `description` is
  optional in the OpenAI schema, but the runtime types it as a non-nullable
  String, so passing `undefined` failed the whole request with `Failed to
  convert JavaScript value "Undefined" into rust type "String"` (surfaced as a
  500 / hung stream). Now defaults to `""`. Pre-existing, unrelated to 1.0.11 —
  it reproduces on the previous code.
- [x] **`/v1/responses` had two divergent streaming implementations.** The
  non-tools path was a ~90-line inline block that hardcoded `output_index: 0`
  and emitted the message item upfront, so it could not carry a reasoning item.
  It now shares `streamResponsesTurn` with the tools path, removing the
  duplication and keeping output indexing/disconnect handling in one place.
- [x] The `/v1/responses` catch block logged errors as `{}` (Error objects do not
  JSON-stringify), which is why the crash above was invisible. It now logs the
  stack.

## 5. Sampling params (finding #5 — REVERSED: not supported by the SDK)
This was previously marked DONE on the assumption that assigning
`sessionConfig.temperature` / `topP` / `maxTokens` forwarded them. It did not.
The earlier "verified live, no errors" check only confirmed requests *succeeded*
— it never confirmed the values took effect.

`CopilotClient.createSession` builds an explicit allowlist payload for the
`session.create` JSON-RPC call, and `SessionConfigBase` has no
temperature/topP/maxTokens field (true in both SDK 1.0.4 and 1.0.11). Verified by
wrapping the live connection: none of the three keys appear on the wire, and the
CLI silently accepts the session. There is no supported alternative —
`ModelCapabilities` only exposes token *limits*, not sampling controls.

- [x] Removed the dead assignments from both handlers.
- [x] Added `warnUnsupportedSamplingParams()`; both endpoints now log which
  params were ignored (naming `max_tokens` vs `max_completion_tokens` correctly)
  instead of dropping them silently. Requests still succeed.
- Revisit only if a future SDK adds real sampling support.

## 6. Streaming client-disconnect handling (finding #4 — DONE)
Previously, if a client aborted mid-stream the SDK turn and the turn promise could
linger until idle. All three streaming sites now watch for client disconnect.

- [x] Added a `watchClientDisconnect(res, session, fail)` helper: on `res`
  `"close"` it calls `session.abort()` (turn stops; session stays resumable) and
  rejects the turn promise with a `ClientDisconnectError` sentinel. Returns a
  detach fn each turn calls on normal settle, since `res.end()` also emits
  `"close"`.
- [x] Wired into `streamChatTurn`, `streamResponsesTurn`, and the inline
  Responses non-tools streaming block (added a settle guard there).
- [x] Both endpoint `catch` blocks swallow `ClientDisconnectError` (no error
  write to a dead socket) and fall back to `res.end()` when headers were sent.
- [x] Verified live on the isolated test proxy (port 3099): chat + responses
  streaming disconnects both log "aborted turn", the proxy survives, and happy
  paths (streaming + non-streaming) still complete with no unhandled rejections.

## 7. First live GC sweep / backlog cleanup
The session-GC scheduler (`--session-ttl`, default 60 min) is wired and verified.

**Shared-store safety (DONE).** A risk was found and fixed: the Copilot session
store is shared with the Copilot CLI, and the SDK exposes no provenance field —
so the original blind `listSessions()` sweep could delete a CLI user's idle
conversations. Option #1 (scope by `workingDirectory`) was **empirically tested
and rejected**: the SDK does not persist `workingDirectory` into session metadata
nor match it in `listSessions({ workingDirectory })`, so that filter returns zero
and would silently disable the GC.

The GC now uses a **persisted ID ledger** (`~/.copilot/proxy-session-ledger.json`,
override `COPILOT_PROXY_SESSION_LEDGER`):
- [x] Every proxy-created session id is recorded in the ledger.
- [x] The sweep only ever deletes ids **in the ledger**; eligibility is ledger
  membership, staleness is the session's own `modifiedTime` (so an active
  pending-tool session is never reclaimed). CLI sessions are structurally
  untouchable.
- [x] Ledger self-prunes deleted/already-gone ids; atomic tmp+rename writes;
  corrupt ledger reads as empty.
- [x] 4 unit tests + a **live SDK end-to-end** check: tracked proxy session
  reclaimed, untracked "CLI" session (equally ancient) left untouched.

Still open (need a long-lived live proxy on your side):
- Confirm the first real sweep deletes stale **proxy** sessions in practice.
- One-time **manual** cleanup of the pre-ledger backlog (~236 sessions) — these
  predate the ledger and are intentionally not auto-collected.

## 8. Automated test suite (finding #2 — DONE)
`npm test` was a stub; there is now a real unit suite.

- [x] Harness uses Node's built-in `node:test` + `node:assert` — **no new deps**.
  `index.js` got an `isMain` guard so importing it is side-effect-free (argv
  parsing + server startup only run as the entry point); pure helpers are exported
  at the bottom for the suite.
- [x] `test/proxy.test.js` — 29 tests covering: usage snapshot (latest, not
  summed, ignores no-op events), base64 image passthrough + remote-URL-as-text,
  tool-call id encode/decode round-trip + foreign-id rejection, resume
  continuation (chat + Responses), parallel/trailing tool-result collection,
  name sanitization + de-dupe + `tool_choice:"none"`, both-API tool-spec
  normalization, Responses-API parity, and no-tools text regressions.
- [x] Wired into `npm test` (`node --test "test/**/*.test.js"`). All 29 pass.
- [x] Regression-checked that `node index.js` still starts the server, the
  missing-`-m` error path still exits 1, and `--list`/startup moved cleanly under
  the `isMain` guard.
- Coverage is unit-level (pure helpers). The streaming/SDK-driven paths
  (`waitForTurnOutcome`, `streamChatTurn`/`streamResponsesTurn`, live resume) are
  still only covered by manual/live testing — a recorded/mock SDK session harness
  remains a future enhancement.

## Notes / smaller follow-ups
- **Proxy cwd leaking into client prompts (DONE)**: in the default `append`
  system-message mode the runtime injected an `environment_context` section
  built from the *proxy's* cwd, plus `custom_instructions` from that cwd's
  `AGENTS.md` / `copilot-instructions.md`. So opencode saw two conflicting
  working directories. Every create/resume now goes through
  `isolatedSessionConfig()`: `customize` mode removes both sections (client
  prompt appended as content), and on-demand instruction discovery, file hooks,
  and host git ops are disabled. Resume must pass it too, because a resumed
  session **rebuilds the default prompt** when `systemMessage` is omitted
  (verified live). One proxy safely serves many clients/projects; sessions are
  already per-request, so concurrent clients never share a session.
- **Built-in tools exposed on tool-less requests (DONE)**: requests without
  client tools (or with `tool_choice: "none"`) previously kept the runtime's
  built-ins (shell, edits, ...) auto-approved via `approveAll`, running in the
  proxy's cwd and invisible to the client (verified live: a plain "run `pwd`"
  request executed `bash`). `toolSessionExtras()` now always sets
  `availableTools` — `["custom:*"]` with client tools, `[]` without — on create
  and resume, so the model only ever sees tools the client supplied.
- **Context window in `/v1/models` (DONE)**: model objects now publish the SDK's
  capability limits (`context_window` / `context_length` /
  `max_context_window_tokens`, plus `max_input_tokens` / `max_output_tokens`) so
  clients can show "% of context used" (this closes the opencode "0% used" gap).
  Verified live: `claude-opus-4.8` reports a 1,000,000-token window. Token
  tracking itself was separately verified correct (proxy's "keep-latest" matches
  the SDK's authoritative `usage.getMetrics()` oracle on every turn; summing would
  over-report ~5x). The 200k figure seen in `session.usage_info.tokenLimit` is a
  provider billing-tier label, **not** an org/admin cap — a live ~485k-token
  prompt succeeded, and the account's only admin limit is the premium-request
  quota (7,000/mo), not context size.
- **Remote image URLs** are passed as `[image: <url>]` text, not fetched (SSRF
  avoidance). Revisit only if a client needs true URL-image support.
- **`tool_choice` forcing**: the SDK has no forced-tool control, so `"none"` drops
  tools and everything else is best-effort `"auto"`. A specific required-tool value
  cannot be honored.
