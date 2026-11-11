import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  inferOwnedBy,
  modelLimits,
  modelCapabilityFlags,
  resolveReasoningEffort,
  applyReasoningConfig,
  toModelObject,
  dataUriToBlob,
  extractContent,
  messagesToPrompt,
  collectImages,
  extractSystemMessage,
  isolatedSessionConfig,
  isSessionStale,
  readSessionLedger,
  writeSessionLedger,
  trackProxySession,
  sweepAbandonedSessions,
  trackUsage,
  buildChatUsage,
  buildResponsesUsage,
  encodeToolCallId,
  decodeToolCallId,
  sanitizeToolName,
  normalizeToolSpec,
  buildToolRegistration,
  originalToolName,
  toolSessionExtras,
  extractTrailingToolResults,
  resolveResume,
  extractResponsesToolResults,
  resolveResponsesResume,
  buildResponsesToolOutput,
  buildChatOutcome,
  waitForTurnOutcome,
  streamChatTurn,
  streamResponsesTurn,
  toOpenAIResponse,
  toResponsesAPIResponse,
  buildFullMessages,
  responsesInputToMessages,
} from "../index.js";

// A minimal stand-in for the SDK session: records "assistant.usage" handlers
// and lets a test push events through them, exercising trackUsage in isolation.
function makeFakeSession() {
  const handlers = [];
  return {
    on(type, fn) {
      handlers.push({ type, fn });
    },
    emit(type, data) {
      for (const h of handlers) {
        if (h.type === type) h.fn({ type, data });
      }
    },
  };
}

test("inferOwnedBy maps model id prefixes to owners", () => {
  assert.equal(inferOwnedBy("gpt-5.2"), "openai");
  assert.equal(inferOwnedBy("o1-preview"), "openai");
  assert.equal(inferOwnedBy("o3-mini"), "openai");
  assert.equal(inferOwnedBy("o4-foo"), "openai");
  assert.equal(inferOwnedBy("claude-opus-4.8"), "anthropic");
  assert.equal(inferOwnedBy("gemini-2.0"), "google");
  assert.equal(inferOwnedBy("mystery-model"), "unknown");
});

test("modelLimits publishes context window under common vendor keys", () => {
  const model = {
    id: "claude-opus-4.8",
    capabilities: {
      limits: {
        max_context_window_tokens: 1000000,
        max_prompt_tokens: 936000,
        max_output_tokens: 64000,
      },
    },
  };
  const lim = modelLimits(model);
  assert.equal(lim.context_window, 1000000);
  assert.equal(lim.context_length, 1000000);
  assert.equal(lim.max_context_window_tokens, 1000000);
  assert.equal(lim.max_input_tokens, 936000);
  assert.equal(lim.max_output_tokens, 64000);
});

test("modelLimits returns empty object when capabilities are absent", () => {
  assert.deepEqual(modelLimits(null), {});
  assert.deepEqual(modelLimits({ id: "x" }), {});
  assert.deepEqual(modelLimits({ id: "x", capabilities: { limits: {} } }), {});
});

test("toModelObject surfaces limits from a full SDK model, tolerates a bare id", () => {
  const full = toModelObject({
    id: "claude-opus-4.8",
    capabilities: { limits: { max_context_window_tokens: 1000000 } },
  });
  assert.equal(full.id, "claude-opus-4.8");
  assert.equal(full.object, "model");
  assert.equal(full.owned_by, "anthropic");
  assert.equal(full.context_window, 1000000);

  const bare = toModelObject("gpt-5.2");
  assert.equal(bare.id, "gpt-5.2");
  assert.equal(bare.owned_by, "openai");
  assert.equal(bare.context_window, undefined);
});

test("dataUriToBlob decodes base64 data URIs", () => {
  const blob = dataUriToBlob("data:image/png;base64,QUJD");
  assert.deepEqual(blob, { type: "blob", data: "QUJD", mimeType: "image/png", displayName: "image" });
});

test("dataUriToBlob base64-encodes non-base64 (url-encoded) data URIs", () => {
  const blob = dataUriToBlob("data:text/plain,ABC");
  assert.equal(blob.mimeType, "text/plain");
  assert.equal(Buffer.from(blob.data, "base64").toString("utf-8"), "ABC");
});

test("dataUriToBlob returns null for non-data URIs", () => {
  assert.equal(dataUriToBlob("https://example.com/cat.png"), null);
  assert.equal(dataUriToBlob("data:nocomma"), null);
  assert.equal(dataUriToBlob(42), null);
});

test("extractContent handles plain strings", () => {
  assert.deepEqual(extractContent("hello"), { text: "hello", images: [] });
});

test("extractContent passes through base64 image parts as blobs (both API shapes)", () => {
  const chat = extractContent([
    { type: "text", text: "look" },
    { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
  ]);
  assert.equal(chat.text, "look");
  assert.equal(chat.images.length, 1);
  assert.equal(chat.images[0].data, "QUJD");

  const responses = extractContent([
    { type: "input_text", text: "look" },
    { type: "input_image", image_url: "data:image/png;base64,QUJD" },
  ]);
  assert.equal(responses.text, "look");
  assert.equal(responses.images.length, 1);
});

test("extractContent references remote image URLs as text (no SSRF fetch)", () => {
  const out = extractContent([
    { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
  ]);
  assert.equal(out.images.length, 0);
  assert.equal(out.text, "[image: https://example.com/cat.png]");
});

test("messagesToPrompt renders role-prefixed lines", () => {
  const prompt = messagesToPrompt([
    { role: "user", content: "hi" },
    { role: "assistant", content: "yo" },
  ]);
  assert.equal(prompt, "User: hi\n\nAssistant: yo");
});

test("collectImages gathers blobs across messages", () => {
  const images = collectImages([
    { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }] },
    { role: "user", content: "no image here" },
    { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/gif;base64,Wg==" } }] },
  ]);
  assert.equal(images.length, 2);
  assert.equal(images[0].mimeType, "image/png");
  assert.equal(images[1].mimeType, "image/gif");
});

test("extractSystemMessage joins system messages, null when none", () => {
  assert.equal(
    extractSystemMessage([
      { role: "system", content: "a" },
      { role: "user", content: "x" },
      { role: "system", content: "b" },
    ]),
    "a\nb",
  );
  assert.equal(extractSystemMessage([{ role: "user", content: "x" }]), null);
});

test("isolatedSessionConfig strips proxy-cwd context and keeps client prompt", () => {
  const cfg = isolatedSessionConfig("client prompt");
  assert.equal(cfg.systemMessage.mode, "customize");
  assert.equal(cfg.systemMessage.content, "client prompt");
  assert.deepEqual(cfg.systemMessage.sections, {
    environment_context: { action: "remove" },
    custom_instructions: { action: "remove" },
  });
  assert.equal(cfg.enableOnDemandInstructionDiscovery, false);
  assert.equal(cfg.enableFileHooks, false);
  assert.equal(cfg.enableHostGitOperations, false);

  const bare = isolatedSessionConfig(null);
  assert.equal("content" in bare.systemMessage, false);
  assert.equal(bare.systemMessage.sections.environment_context.action, "remove");
});

test("isSessionStale compares modifiedTime against cutoff", () => {
  const now = Date.now();
  assert.equal(isSessionStale({ modifiedTime: new Date(now - 10000).toISOString() }, now - 5000), true);
  assert.equal(isSessionStale({ modifiedTime: new Date(now).toISOString() }, now - 5000), false);
  assert.equal(isSessionStale({}, now), false);
  assert.equal(isSessionStale({ modifiedTime: "not-a-date" }, now), false);
  assert.equal(isSessionStale(null, now), false);
});

// A temp ledger path that is cleaned up by the caller. Awaits fn so async
// callers finish before the temp dir is removed.
async function withTempLedger(fn) {
  const dir = mkdtempSync(join(tmpdir(), "proxy-ledger-"));
  const ledgerPath = join(dir, "ledger.json");
  try {
    return await fn(ledgerPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("ledger: trackProxySession records ids; read returns {} when absent/corrupt", () => {
  withTempLedger((p) => {
    assert.deepEqual(readSessionLedger(p), {});
    trackProxySession("aaa", p);
    trackProxySession("bbb", p);
    const led = readSessionLedger(p);
    assert.deepEqual(Object.keys(led).sort(), ["aaa", "bbb"]);
    assert.ok(typeof led.aaa === "number");

    const before = readSessionLedger(p).aaa;
    trackProxySession("aaa", p);
    assert.equal(readSessionLedger(p).aaa, before, "re-tracking must not overwrite the timestamp");

    trackProxySession("", p);
    trackProxySession(undefined, p);
    assert.deepEqual(Object.keys(readSessionLedger(p)).sort(), ["aaa", "bbb"]);

    writeFileSync(p, "{not valid json", "utf-8");
    assert.deepEqual(readSessionLedger(p), {}, "corrupt ledger reads as empty, not a throw");
  });
});

test("sweep deletes ONLY stale ledger ids and never touches untracked (CLI) sessions", async () => {
  await withTempLedger(async (p) => {
    const now = Date.now();
    const ttlMs = 60 * 60 * 1000; // 60 min
    const old = new Date(now - 2 * ttlMs).toISOString();
    const fresh = new Date(now - 1000).toISOString();

    // Ledger holds two proxy ids: one stale, one fresh.
    writeFileSync(p, JSON.stringify({ staleProxy: now - 2 * ttlMs, freshProxy: now - 1000 }), "utf-8");

    const metaStore = {
      staleProxy: { sessionId: "staleProxy", modifiedTime: old },
      freshProxy: { sessionId: "freshProxy", modifiedTime: fresh },
      // An untracked CLI session that is ancient — must NOT be deleted.
      cliSession: { sessionId: "cliSession", modifiedTime: old },
    };
    const deletedIds = [];
    const client = {
      async getSessionMetadata(id) {
        return metaStore[id];
      },
      async deleteSession(id) {
        deletedIds.push(id);
        delete metaStore[id];
      },
    };

    const deleted = await sweepAbandonedSessions(client, ttlMs, { now, ledgerPath: p });

    assert.equal(deleted, 1, "only the stale proxy session is deleted");
    assert.deepEqual(deletedIds, ["staleProxy"]);
    assert.ok(metaStore.cliSession, "the untracked CLI session is untouched");

    const led = readSessionLedger(p);
    assert.deepEqual(Object.keys(led), ["freshProxy"], "deleted id is pruned; fresh id remains");
  });
});

test("sweep prunes ledger ids whose session is already gone from the store", async () => {
  await withTempLedger(async (p) => {
    const now = Date.now();
    const ttlMs = 60 * 60 * 1000;
    writeFileSync(p, JSON.stringify({ ghost: now - 10 * ttlMs, alive: now - 1000 }), "utf-8");

    const client = {
      async getSessionMetadata(id) {
        if (id === "ghost") return undefined; // store no longer knows it
        return { sessionId: id, modifiedTime: new Date(now - 1000).toISOString() };
      },
      async deleteSession() {
        throw new Error("should not be called for a fresh session");
      },
    };

    const deleted = await sweepAbandonedSessions(client, ttlMs, { now, ledgerPath: p });
    assert.equal(deleted, 0);
    assert.deepEqual(Object.keys(readSessionLedger(p)), ["alive"], "ghost id pruned, alive id kept");
  });
});

test("sweep keeps a stale id in the ledger when deleteSession fails transiently", async () => {
  await withTempLedger(async (p) => {
    const now = Date.now();
    const ttlMs = 60 * 60 * 1000;
    writeFileSync(p, JSON.stringify({ staleProxy: now - 2 * ttlMs }), "utf-8");

    const client = {
      async getSessionMetadata(id) {
        return { sessionId: id, modifiedTime: new Date(now - 2 * ttlMs).toISOString() };
      },
      async deleteSession() {
        throw new Error("temporary backend outage");
      },
    };

    const deleted = await sweepAbandonedSessions(client, ttlMs, { now, ledgerPath: p });
    assert.equal(deleted, 0);
    assert.deepEqual(Object.keys(readSessionLedger(p)), ["staleProxy"], "kept for a later retry");
  });
});

test("trackUsage keeps the latest snapshot, not the sum, and ignores no-ops", () => {
  const session = makeFakeSession();
  const usage = trackUsage(session);
  session.emit("assistant.usage", { inputTokens: 100, outputTokens: 10, reasoningTokens: 2, cacheReadTokens: 5 });
  session.emit("assistant.usage", { inputTokens: 250, outputTokens: 40, reasoningTokens: 3, cacheReadTokens: 9 });
  // No-op event must not clobber the real snapshot.
  session.emit("assistant.usage", { inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(usage, { inputTokens: 250, outputTokens: 40, reasoningTokens: 3, cachedTokens: 9 });
});

test("buildChatUsage / buildResponsesUsage shape the usage blocks", () => {
  const u = { inputTokens: 100, outputTokens: 20, reasoningTokens: 4, cachedTokens: 7 };
  assert.deepEqual(buildChatUsage(u), {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 7 },
    completion_tokens_details: { reasoning_tokens: 4 },
  });
  assert.deepEqual(buildResponsesUsage(u), {
    input_tokens: 100,
    output_tokens: 20,
    total_tokens: 120,
    input_tokens_details: { cached_tokens: 7 },
    output_tokens_details: { reasoning_tokens: 4 },
  });
});

test("encodeToolCallId / decodeToolCallId round-trip", () => {
  const id = encodeToolCallId("ses_abc", "req_42");
  assert.ok(id.startsWith("ct_"));
  assert.deepEqual(decodeToolCallId(id), { sessionId: "ses_abc", requestId: "req_42" });
});

test("decodeToolCallId rejects foreign / malformed ids", () => {
  assert.equal(decodeToolCallId("call_openai_native"), null);
  assert.equal(decodeToolCallId("ct_not-valid-base64!!"), null);
  assert.equal(decodeToolCallId(null), null);
  assert.equal(decodeToolCallId("ct_" + Buffer.from('{"s":"only"}', "utf-8").toString("base64url")), null);
});

test("sanitizeToolName replaces illegal chars and de-dupes", () => {
  const used = new Set();
  assert.equal(sanitizeToolName("good_name-1", used), "good_name-1");
  used.add("good_name-1");
  assert.equal(sanitizeToolName("mcp.tool.read", used), "mcp_tool_read");
  used.add("mcp_tool_read");
  // Collision forces a numeric suffix.
  assert.equal(sanitizeToolName("mcp.tool.read", used), "mcp_tool_read_1");
  // Illegal chars are replaced 1:1 (so "???" -> "___", still non-empty).
  assert.equal(sanitizeToolName("???", new Set()), "___");
  // Only a name that reduces to empty falls back to "tool".
  assert.equal(sanitizeToolName("", new Set()), "tool");
});

test("normalizeToolSpec handles both API shapes, rejects junk", () => {
  assert.deepEqual(
    normalizeToolSpec({ type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } }),
    { name: "f", description: "d", parameters: { type: "object" } },
  );
  assert.deepEqual(
    normalizeToolSpec({ type: "function", name: "g", description: "d2" }),
    { name: "g", description: "d2", parameters: undefined },
  );
  assert.equal(normalizeToolSpec({ type: "other" }), null);
  assert.equal(normalizeToolSpec({ type: "function", function: {} }), null);
  assert.equal(normalizeToolSpec(null), null);
});

test("buildToolRegistration registers tools and maps sanitized -> original", () => {
  const { sdkTools, nameMap } = buildToolRegistration(
    [
      { type: "function", function: { name: "mcp.read", description: "r" } },
      { type: "function", function: { name: "bash", description: "b" } },
    ],
    "auto",
  );
  assert.equal(sdkTools.length, 2);
  assert.equal(nameMap.get("mcp_read"), "mcp.read");
  assert.equal(nameMap.get("bash"), "bash");
  assert.equal(originalToolName(nameMap, "mcp_read"), "mcp.read");
  assert.equal(originalToolName(nameMap, "unknown"), "unknown");
});

test("buildToolRegistration honors tool_choice none and missing tools", () => {
  const none = buildToolRegistration([{ type: "function", function: { name: "x" } }], "none");
  assert.equal(none.sdkTools.length, 0);
  assert.equal(none.nameMap.size, 0);

  const missing = buildToolRegistration(undefined, "auto");
  assert.equal(missing.sdkTools.length, 0);
});

test("toolSessionExtras always hides built-ins", () => {
  assert.deepEqual(toolSessionExtras([]), { availableTools: [] });
  const extras = toolSessionExtras([{}, {}]);
  assert.equal(extras.tools.length, 2);
  assert.deepEqual(extras.availableTools, ["custom:*"]);
});

test("extractTrailingToolResults collects only the trailing tool block", () => {
  const id1 = encodeToolCallId("ses_1", "r1");
  const id2 = encodeToolCallId("ses_1", "r2");
  const trailing = extractTrailingToolResults([
    { role: "user", content: "do it" },
    { role: "assistant", content: null },
    { role: "tool", tool_call_id: id1, content: "out1" },
    { role: "tool", tool_call_id: id2, content: "out2" },
  ]);
  assert.equal(trailing.length, 2);
  assert.equal(trailing[0].content, "out1");
  assert.deepEqual(trailing[0].decoded, { sessionId: "ses_1", requestId: "r1" });
});

test("resolveResume requires all trailing results to share one session", () => {
  const a = encodeToolCallId("ses_x", "r1");
  const b = encodeToolCallId("ses_x", "r2");
  const resume = resolveResume([
    { role: "user", content: "go" },
    { role: "tool", tool_call_id: a, content: "1" },
    { role: "tool", tool_call_id: b, content: "2" },
  ]);
  assert.equal(resume.sessionId, "ses_x");
  assert.equal(resume.trailing.length, 2);

  // Mixed sessions -> not resumable.
  const mixed = resolveResume([
    { role: "tool", tool_call_id: encodeToolCallId("ses_x", "r1"), content: "1" },
    { role: "tool", tool_call_id: encodeToolCallId("ses_y", "r2"), content: "2" },
  ]);
  assert.equal(mixed, null);

  // No trailing tool results -> fresh request.
  assert.equal(resolveResume([{ role: "user", content: "hi" }]), null);
});

test("Responses: extractResponsesToolResults + resolveResponsesResume", () => {
  const callId = encodeToolCallId("ses_r", "rr1");
  const input = [
    { type: "function_call_output", call_id: callId, output: "the result" },
  ];
  const results = extractResponsesToolResults(input);
  assert.equal(results.length, 1);
  assert.equal(results[0].content, "the result");

  const resume = resolveResponsesResume(input);
  assert.equal(resume.sessionId, "ses_r");
  assert.equal(resume.results.length, 1);

  // Plain string input is never a resume.
  assert.equal(resolveResponsesResume("hello"), null);
});

test("buildChatOutcome emits tool_calls with encoded ids and finish_reason", () => {
  const usage = { inputTokens: 1, outputTokens: 2, reasoningTokens: 0, cachedTokens: 0 };
  const out = buildChatOutcome(
    { kind: "tools", content: "calling", calls: [{ requestId: "r1", toolName: "mcp.read", arguments: { p: 1 } }] },
    "ses_z",
    "gpt-5.2",
    usage,
  );
  assert.equal(out.choices[0].finish_reason, "tool_calls");
  const tc = out.choices[0].message.tool_calls[0];
  assert.equal(tc.function.name, "mcp.read");
  assert.equal(tc.function.arguments, JSON.stringify({ p: 1 }));
  assert.deepEqual(decodeToolCallId(tc.id), { sessionId: "ses_z", requestId: "r1" });
});

test("buildChatOutcome falls back to a plain text completion", () => {
  const out = buildChatOutcome(
    { kind: "text", content: "final answer" },
    "ses_z",
    "gpt-5.2",
    { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 },
  );
  assert.equal(out.choices[0].finish_reason, "stop");
  assert.equal(out.choices[0].message.content, "final answer");
});

test("buildResponsesToolOutput emits optional message + function_call items", () => {
  const output = buildResponsesToolOutput(
    [{ requestId: "r1", toolName: "bash", arguments: { cmd: "ls" } }],
    "preamble",
    "ses_p",
    "msg_1",
  );
  assert.equal(output[0].type, "message");
  assert.equal(output[0].content[0].text, "preamble");
  assert.equal(output[1].type, "function_call");
  assert.equal(output[1].name, "bash");
  assert.deepEqual(decodeToolCallId(output[1].call_id), { sessionId: "ses_p", requestId: "r1" });

  // No preamble -> no leading message item.
  const noPreamble = buildResponsesToolOutput(
    [{ requestId: "r1", toolName: "bash", arguments: {} }],
    "",
    "ses_p",
    "msg_1",
  );
  assert.equal(noPreamble[0].type, "function_call");
});

test("toOpenAIResponse / toResponsesAPIResponse shape final answers", () => {
  const usage = { inputTokens: 5, outputTokens: 3, reasoningTokens: 0, cachedTokens: 0 };
  const chat = toOpenAIResponse("hi", "gpt-5.2", usage);
  assert.equal(chat.object, "chat.completion");
  assert.equal(chat.choices[0].message.content, "hi");
  assert.equal(chat.usage.total_tokens, 8);

  const resp = toResponsesAPIResponse("hi", "gpt-5.2", "resp_1", usage);
  assert.equal(resp.object, "response");
  assert.equal(resp.id, "resp_1");
  assert.equal(resp.output[0].content[0].text, "hi");
  assert.equal(resp.usage.input_tokens, 5);
});

test("buildFullMessages threads instructions + current input", () => {
  const messages = buildFullMessages("what is 2+2?", "be terse", undefined);
  assert.deepEqual(messages, [
    { role: "system", content: "be terse" },
    { role: "user", content: "what is 2+2?" },
  ]);
});

test("responsesInputToMessages flattens parts to text-only history", () => {
  const messages = responsesInputToMessages(
    [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    "sys",
  );
  assert.deepEqual(messages, [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ]);
});

// --- reasoning effort / capability flags -----------------------------------

const gptMini = {
  id: "gpt-5-mini",
  capabilities: { supports: { vision: true, reasoningEffort: true }, limits: { max_context_window_tokens: 200000 } },
  supportedReasoningEfforts: ["low", "medium", "high"],
};
const geminiFlash = {
  id: "gemini-3.6-flash",
  capabilities: { supports: { vision: false, reasoningEffort: true }, limits: { max_context_window_tokens: 100 } },
  supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
};
const noReasoning = {
  id: "auto",
  capabilities: { supports: { vision: false, reasoningEffort: false }, limits: { max_context_window_tokens: 100 } },
};

test("resolveReasoningEffort passes through supported values", () => {
  assert.equal(resolveReasoningEffort("high", gptMini).value, "high");
  assert.equal(resolveReasoningEffort("HIGH", gptMini).value, "high");
  assert.equal(resolveReasoningEffort("minimal", geminiFlash).value, "minimal");
});

test("resolveReasoningEffort maps unsupported values to the nearest level", () => {
  // gpt-5-mini has no "minimal"/"xhigh"; both degrade to an offered neighbour.
  const minimal = resolveReasoningEffort("minimal", gptMini);
  assert.equal(minimal.value, "low");
  assert.equal(minimal.downgradedFrom, "minimal");
  assert.equal(resolveReasoningEffort("xhigh", gptMini).value, "high");
  assert.equal(resolveReasoningEffort("max", gptMini).value, "high");
});

test("resolveReasoningEffort rejects junk and unsupported models", () => {
  assert.equal(resolveReasoningEffort("bogus", gptMini).ok, false);
  assert.equal(resolveReasoningEffort("high", noReasoning).ok, false);
  assert.equal(resolveReasoningEffort("high", null).ok, false);
  // absent input is a no-op, not an error
  assert.deepEqual(resolveReasoningEffort(undefined, gptMini), { ok: true });
});

test("applyReasoningConfig sets only valid fields", () => {
  const cfg = {};
  applyReasoningConfig(cfg, "/test", { effort: "high", summary: "detailed" }, gptMini);
  assert.deepEqual(cfg, { reasoningEffort: "high", reasoningSummary: "detailed" });

  const bad = {};
  applyReasoningConfig(bad, "/test", { effort: "bogus", summary: "verbose" }, gptMini);
  assert.deepEqual(bad, {}, "invalid values must not reach the session config");

  const none = {};
  applyReasoningConfig(none, "/test", { effort: undefined, summary: undefined }, gptMini);
  assert.deepEqual(none, {});
});

test("modelCapabilityFlags publishes supports + effort levels", () => {
  assert.deepEqual(modelCapabilityFlags(gptMini), {
    supports_vision: true,
    supports_reasoning_effort: true,
    supported_reasoning_efforts: ["low", "medium", "high"],
  });
  assert.deepEqual(modelCapabilityFlags(noReasoning), {
    supports_vision: false,
    supports_reasoning_effort: false,
  });
  assert.deepEqual(modelCapabilityFlags("bare-string-id"), {});
  assert.deepEqual(modelCapabilityFlags(null), {});
});

test("toModelObject merges limits and capability flags", () => {
  const obj = toModelObject(gptMini);
  assert.equal(obj.id, "gpt-5-mini");
  assert.equal(obj.context_window, 200000);
  assert.equal(obj.supports_vision, true);
  assert.deepEqual(obj.supported_reasoning_efforts, ["low", "medium", "high"]);
  // bare id still works, without capability keys
  assert.equal(toModelObject("gpt-5-mini").supports_vision, undefined);
});

// --- Turn-driver race regressions (dropped tool calls) ---------------------

function fakeSession() {
  const handlers = [];
  return {
    on(h) { handlers.push(h); return () => {}; },
    emit(type, data = {}) { for (const h of handlers) h({ type, data }); },
    abort() {},
  };
}

function fakeRes() {
  return {
    chunks: [],
    write(c) { this.chunks.push(c); return true; },
    on() {}, off() {}, once() {}, removeListener() {},
    get body() { return this.chunks.join(""); },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toolReq = (id, name = "read") => ({ requestId: id, toolName: name, arguments: { id } });
const announce = (n) => ({ content: "", toolRequests: Array.from({ length: n }, (_, i) => ({ name: "read", toolCallId: `t${i}` })) });

test("waitForTurnOutcome: session.idle inside the batch window does not drop the call", async () => {
  const s = fakeSession();
  const p = waitForTurnOutcome(s, { batchMs: 20 });
  s.emit("external_tool.requested", toolReq("r1"));
  s.emit("session.idle");
  const out = await p;
  assert.equal(out.kind, "tools");
  assert.deepEqual(out.calls.map((c) => c.requestId), ["r1"]);
});

test("waitForTurnOutcome: waits for all announced siblings past batchMs", async () => {
  const s = fakeSession();
  const p = waitForTurnOutcome(s, { batchMs: 5, maxWaitMs: 1000 });
  s.emit("assistant.message", announce(2));
  s.emit("external_tool.requested", toolReq("r1"));
  await sleep(30);
  s.emit("external_tool.requested", toolReq("r2"));
  s.emit("session.idle");
  const out = await p;
  assert.equal(out.kind, "tools");
  assert.deepEqual(out.calls.map((c) => c.requestId), ["r1", "r2"]);
});

test("waitForTurnOutcome: flushes partial batch after maxWaitMs", async () => {
  const s = fakeSession();
  const p = waitForTurnOutcome(s, { batchMs: 5, maxWaitMs: 30 });
  s.emit("assistant.message", announce(2));
  s.emit("external_tool.requested", toolReq("r1"));
  const out = await p;
  assert.equal(out.kind, "tools");
  assert.equal(out.calls.length, 1);
});

test("waitForTurnOutcome: plain text turn still settles on idle", async () => {
  const s = fakeSession();
  const p = waitForTurnOutcome(s);
  s.emit("assistant.message", { content: "hi" });
  s.emit("session.idle");
  assert.deepEqual(await p, { kind: "text", content: "hi", reasoning: "" });
});

test("streamChatTurn: idle inside batch window emits tool_calls, not stop", async () => {
  const s = fakeSession();
  const res = fakeRes();
  const p = streamChatTurn(s, res, "sess", "m", { batchMs: 20 });
  s.emit("assistant.message_delta", { deltaContent: "Reading" });
  s.emit("external_tool.requested", toolReq("r1"));
  s.emit("session.idle");
  const out = await p;
  assert.equal(out.kind, "tools");
  assert.match(res.body, /"finish_reason":"tool_calls"/);
  assert.doesNotMatch(res.body, /"finish_reason":"stop"/);
  assert.equal(res.body.match(/\[DONE\]/g).length, 1);
});

test("streamChatTurn: delayed announced sibling is delivered in the same batch", async () => {
  const s = fakeSession();
  const res = fakeRes();
  const p = streamChatTurn(s, res, "sess", "m", { batchMs: 5, maxWaitMs: 1000 });
  s.emit("assistant.message", announce(2));
  s.emit("external_tool.requested", toolReq("r1", "bash"));
  await sleep(30);
  s.emit("external_tool.requested", toolReq("r2", "bash"));
  const out = await p;
  assert.equal(out.calls.length, 2);
  assert.equal(res.body.match(/"type":"function"/g).length, 2);
});

test("streamResponsesTurn: idle inside batch window emits function_call", async () => {
  const s = fakeSession();
  const res = fakeRes();
  const p = streamResponsesTurn(s, res, { responseId: "resp_1", model: "m", usage: {}, sessionId: "sess", batchMs: 20 });
  s.emit("external_tool.requested", toolReq("r1"));
  s.emit("session.idle");
  const out = await p;
  assert.equal(out.kind, "tools");
  assert.match(res.body, /"type":"function_call"/);
  assert.equal(res.chunks.filter((c) => c.includes('"type":"response.completed"')).length, 1);
});

test("streamResponsesTurn: delayed announced sibling is delivered", async () => {
  const s = fakeSession();
  const res = fakeRes();
  const p = streamResponsesTurn(s, res, { responseId: "resp_2", model: "m", usage: {}, sessionId: "sess", batchMs: 5, maxWaitMs: 1000 });
  s.emit("assistant.message", announce(2));
  s.emit("external_tool.requested", toolReq("r1"));
  await sleep(30);
  s.emit("external_tool.requested", toolReq("r2"));
  await p;
  const done = res.chunks.filter((c) => c.includes('"type":"response.output_item.done"') && c.includes('"type":"function_call"'));
  assert.equal(done.length, 2);
});
