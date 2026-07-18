#!/usr/bin/env node

import express from "express";
import { CopilotClient, RuntimeConnection, approveAll, defineTool } from "@github/copilot-sdk";
import { v4 as uuidv4 } from "uuid";
import { Command } from "commander";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { homedir } from "os";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname, join } from "path";

// Read package.json for version
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf-8"));

// True only when run as the entry point. When imported (e.g. by the test
// suite) we skip argv parsing and server startup so the pure helpers below can
// be exercised in isolation.
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

function parseOptions() {
  const program = new Command();
  program
    .name("copilot-proxy")
    .description("OpenAI-compatible proxy server for GitHub Copilot SDK")
    .version(pkg.version, "-V, --version", "output the version number")
    .option("-p, --port <number>", "port to listen on", "3001")
    .option("-m, --model <name>", "default model id to use (ex. 'gpt-5.2')")
    .option("-l, --list", "list available models and exit")
    .option("--cli-path <path>", "path to copilot CLI binary (if not in $PATH)", process.env.COPILOT_CLI_PATH)
    .option("--session-ttl <minutes>", "delete sessions idle longer than this many minutes (0 disables GC)", process.env.COPILOT_PROXY_SESSION_TTL_MIN || "60")
    .option("-v, --verbose", "enable verbose log output")
    .helpOption("-h, --help", "display this help")
    .parse(process.argv);

  const parsed = program.opts();

  // -m is required unless --list is used
  if (!parsed.list && !parsed.model) {
    program.error("required option '-m, --model <name>' not specified");
  }
  return parsed;
}

const opts = isMain ? parseOptions() : {};

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = opts.port;
const DEFAULT_MODEL = opts.model;

function writeLog(...args) {
  const parts = args.map(a => typeof a === 'string' ? a : JSON.stringify(a, null, 2));
  process.stderr.write(`[${new Date().toISOString()}] ${parts.join(' ')}\n`);
}

// Informational messages — only printed when --verbose is specified
function log(...args) {
  if (opts.verbose) writeLog(...args);
}

// Errors — always printed to stderr
const error = writeLog;

// Singleton CopilotClient instance
let copilotClient = null;

async function getCopilotClient() {
  if (!copilotClient) {
    copilotClient = new CopilotClient(
      opts.cliPath
        ? { connection: RuntimeConnection.forStdio({ path: opts.cliPath }) }
        : {}
    );
    await copilotClient.start();
    log("CopilotClient started");
  }
  return copilotClient;
}

async function stopAndExit(code = 0) {
  if (copilotClient) {
    try { await copilotClient.stop(); } catch {}
  }
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Abandoned-session GC (ledger-scoped).
//
// The tool-call bridge persists sessions to disk so they survive a proxy
// restart; if a client never returns a tool result, that session lingers
// forever. The Copilot session store is SHARED with the Copilot CLI, and the
// SDK exposes no provenance field (nor a working dir filter that matches
// proxy-created sessions), so a blind sweep of `listSessions()` would delete a
// CLI user's idle conversations too. Instead the proxy records every session id
// IT creates into a small on-disk ledger and the sweep deletes ONLY ledger ids
// that are stale — a CLI session is structurally impossible to touch. The
// ledger lives on disk so it survives a restart (preserving the original
// reclaim-after-restart guarantee).
//
// Ledger shape: { "<sessionId>": <createdAtEpochMs>, ... }
const SESSION_LEDGER_PATH = process.env.COPILOT_PROXY_SESSION_LEDGER ||
  join(homedir(), ".copilot", "proxy-session-ledger.json");

function readSessionLedger(ledgerPath = SESSION_LEDGER_PATH) {
  try {
    const raw = readFileSync(ledgerPath, "utf-8");
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

// Atomic write (tmp + rename) so a crash mid-write can't corrupt the ledger.
function writeSessionLedger(ledger, ledgerPath = SESSION_LEDGER_PATH) {
  try {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    const tmp = `${ledgerPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(ledger), "utf-8");
    renameSync(tmp, ledgerPath);
  } catch (err) {
    log("Session GC: ledger write failed:", err.message || err);
  }
}

// Record a proxy-created session id so the GC is allowed to reclaim it later.
function trackProxySession(sessionId, ledgerPath = SESSION_LEDGER_PATH) {
  if (!sessionId) return;
  const ledger = readSessionLedger(ledgerPath);
  if (ledger[sessionId]) return;
  ledger[sessionId] = Date.now();
  writeSessionLedger(ledger, ledgerPath);
}

// Pure predicate: a session is stale when its last-modified time is older than
// the cutoff. Using modifiedTime (not the ledger's created-at) means an actively
// used session — e.g. one mid tool round-trip — is never reclaimed, since real
// activity refreshes modifiedTime within seconds. Kept separate to stay testable.
function isSessionStale(meta, cutoffMs) {
  const t = meta?.modifiedTime ? new Date(meta.modifiedTime).getTime() : NaN;
  return Number.isFinite(t) && t < cutoffMs;
}

// Sweep removes only stale, proxy-owned sessions. It operates strictly on
// ledger ids: a session the proxy never created is never listed here, so CLI
// sessions can't be hit. Eligibility is ledger membership; staleness is the
// session's own modifiedTime. Deleted ids — and ids the store no longer knows
// about — are pruned from the ledger so it doesn't grow without bound.
async function sweepAbandonedSessions(client, ttlMs, { now = Date.now(), ledgerPath = SESSION_LEDGER_PATH } = {}) {
  const cutoff = now - ttlMs;
  const ledger = readSessionLedger(ledgerPath);
  const ids = Object.keys(ledger);
  if (!ids.length) return 0;

  let deleted = 0;
  let changed = false;
  for (const id of ids) {
    let meta;
    try {
      meta = await client.getSessionMetadata(id);
    } catch (err) {
      log("Session GC: getSessionMetadata failed:", id, String(err?.message || err));
      continue;
    }
    // Gone from the store already (deleted elsewhere) — drop it from the ledger.
    if (!meta) {
      delete ledger[id];
      changed = true;
      continue;
    }
    if (!isSessionStale(meta, cutoff)) continue;
    try {
      await client.deleteSession(id);
      deleted += 1;
      delete ledger[id];
      changed = true;
    } catch (err) {
      const msg = String(err?.message || err);
      if (/not\s*found|does not exist|unknown/i.test(msg)) {
        delete ledger[id];
        changed = true;
      } else {
        log("Session GC: deleteSession failed:", id, msg);
      }
    }
  }
  if (changed) writeSessionLedger(ledger, ledgerPath);
  if (deleted) log(`Session GC: deleted ${deleted} idle proxy session(s) older than ${ttlMs}ms`);
  return deleted;
}

function startSessionGC() {
  const ttlMin = Number(opts.sessionTtl);
  if (!Number.isFinite(ttlMin) || ttlMin <= 0) {
    log("Session GC disabled (--session-ttl <= 0)");
    return;
  }
  const ttlMs = ttlMin * 60 * 1000;
  // Sweep at a quarter of the TTL, capped to a sane 1-15 min window.
  const intervalMs = Math.min(15 * 60 * 1000, Math.max(60 * 1000, Math.floor(ttlMs / 4)));
  const tick = async () => {
    try {
      const client = await getCopilotClient();
      await sweepAbandonedSessions(client, ttlMs);
    } catch (err) {
      log("Session GC tick failed:", err.message || err);
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  log(`Session GC enabled: ttl=${ttlMin}min, interval=${Math.round(intervalMs / 1000)}s, ledger=${SESSION_LEDGER_PATH}`);
}

// Cache for dynamically fetched models
let cachedModels = null;
let modelsCacheTime = 0;
const MODELS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getAvailableModels() {
  const now = Date.now();
  if (cachedModels && (now - modelsCacheTime) < MODELS_CACHE_TTL) {
    return cachedModels;
  }
  const client = await getCopilotClient();
  const models = await client.listModels();
  log("Fetched models from SDK:", models.map((m) => m.id));
  cachedModels = models;
  modelsCacheTime = now;
  return models;
}

// Infer owner from model id
function inferOwnedBy(modelId) {
  if (modelId.startsWith("gpt-") || modelId.startsWith("o1") || modelId.startsWith("o3") || modelId.startsWith("o4")) return "openai";
  if (modelId.startsWith("claude-")) return "anthropic";
  if (modelId.startsWith("gemini-")) return "google";
  return "unknown";
}

// Pull the model's token limits out of the SDK capabilities block. The OpenAI
// /v1/models schema has no context-window field, so clients read it under
// assorted vendor keys (OpenRouter `context_length`, LiteLLM
// `max_input_tokens`/`max_output_tokens`); we publish all the common ones from
// the single authoritative SDK value so a client can compute "% context used".
function modelLimits(model) {
  const limits = model?.capabilities?.limits;
  if (!limits) return {};
  const ctx = limits.max_context_window_tokens;
  const out = {};
  if (Number.isFinite(ctx)) {
    out.context_window = ctx;
    out.context_length = ctx;
    out.max_context_window_tokens = ctx;
  }
  if (Number.isFinite(limits.max_prompt_tokens)) out.max_input_tokens = limits.max_prompt_tokens;
  if (Number.isFinite(limits.max_output_tokens)) out.max_output_tokens = limits.max_output_tokens;
  return out;
}

// Format a model object for the OpenAI API. Accepts either the full SDK model
// object (preferred — carries capability limits) or a bare id string.
function toModelObject(model) {
  const id = typeof model === "string" ? model : model?.id;
  return {
    id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: inferOwnedBy(id),
    ...modelLimits(typeof model === "string" ? null : model),
  };
}

// Convert a data: URI ("data:<mime>[;base64],<data>") into a Copilot SDK blob
// attachment. Returns null for anything that isn't a data URI.
function dataUriToBlob(url) {
  if (typeof url !== "string" || !url.startsWith("data:")) return null;
  const comma = url.indexOf(",");
  if (comma === -1) return null;
  const meta = url.slice(5, comma);
  const raw = url.slice(comma + 1);
  const isBase64 = /;base64/i.test(meta);
  const mimeType = meta.split(";")[0] || "application/octet-stream";
  const data = isBase64 ? raw : Buffer.from(decodeURIComponent(raw)).toString("base64");
  return { type: "blob", data, mimeType, displayName: "image" };
}

// Parse a single message's content (string or array of parts) into flat prompt
// text plus any image attachments. Recognises both Chat Completions
// ("text"/"image_url") and Responses ("input_text"/"input_image") part shapes.
// Base64 data URIs become blob attachments; remote URLs are referenced in the
// text instead of being fetched server-side (avoids SSRF).
function extractContent(content) {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) {
    return { text: content == null ? "" : String(content), images: [] };
  }
  const textParts = [];
  const images = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" || part.type === "input_text") {
      if (part.text) textParts.push(part.text);
    } else if (part.type === "image_url" || part.type === "input_image") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (!url) continue;
      const blob = dataUriToBlob(url);
      if (blob) images.push(blob);
      else textParts.push(`[image: ${url}]`);
    }
  }
  return { text: textParts.join("\n"), images };
}

// Convert OpenAI messages array to a single prompt string
function messagesToPrompt(messages) {
  return messages
    .map((msg) => {
      const role = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
      const { text } = extractContent(msg.content);
      return `${role}: ${text}`;
    })
    .join("\n\n");
}

// Gather image attachments across a messages array for a single send call.
function collectImages(messages) {
  const images = [];
  for (const msg of messages) {
    images.push(...extractContent(msg.content).images);
  }
  return images;
}

// Extract system message from messages array
function extractSystemMessage(messages) {
  const text = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  return text || null;
}

// Send a JSON error response
function sendError(res, status, message, type, code) {
  res.status(status).json({ error: { message, type, code } });
}

// Sentinel rejection for when the HTTP client drops a streaming connection
// mid-turn; callers branch on it to skip writing an error body to a dead socket.
class ClientDisconnectError extends Error {
  constructor() {
    super("client disconnected mid-stream");
    this.name = "ClientDisconnectError";
  }
}

// Reject an in-flight streaming turn on client disconnect and abort the SDK turn
// (session stays resumable). Returns a detach fn the turn MUST call once it
// settles: res.end() itself emits "close", which would otherwise abort an
// already-finished session.
function watchClientDisconnect(res, session, fail) {
  const onClose = () => {
    Promise.resolve(session.abort()).catch(() => {});
    fail(new ClientDisconnectError());
  };
  res.once("close", onClose);
  return () => res.removeListener("close", onClose);
}

// Track token usage across a session by keeping the LATEST "assistant.usage"
// snapshot, not the sum. Each event's inputTokens already includes the entire
// context for that call (system + tools + full history), so when the SDK runs
// an agentic turn with many internal LLM calls, summing compounds the same
// growing context into nonsense (millions of "prompt" tokens). The most recent
// call's snapshot is the correct per-response figure and, unlike max(), it
// reflects context shrinkage after compaction.
function trackUsage(session) {
  const usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 };
  session.on("assistant.usage", (event) => {
    const d = event.data;
    // Ignore empty/no-op events so a trailing zero report can't clobber a real one.
    if (!d.inputTokens && !d.outputTokens) return;
    usage.inputTokens = d.inputTokens ?? 0;
    usage.outputTokens = d.outputTokens ?? 0;
    usage.reasoningTokens = d.reasoningTokens ?? 0;
    usage.cachedTokens = d.cacheReadTokens ?? 0;
  });
  return usage;
}

// Format accumulated usage into the OpenAI Chat Completions usage block.
function buildChatUsage(u) {
  return {
    prompt_tokens: u.inputTokens,
    completion_tokens: u.outputTokens,
    total_tokens: u.inputTokens + u.outputTokens,
    prompt_tokens_details: { cached_tokens: u.cachedTokens },
    completion_tokens_details: { reasoning_tokens: u.reasoningTokens },
  };
}

// Format accumulated usage into the OpenAI Responses API usage block.
function buildResponsesUsage(u) {
  return {
    input_tokens: u.inputTokens,
    output_tokens: u.outputTokens,
    total_tokens: u.inputTokens + u.outputTokens,
    input_tokens_details: { cached_tokens: u.cachedTokens },
    output_tokens_details: { reasoning_tokens: u.reasoningTokens },
  };
}

// ---------------------------------------------------------------------------
// Tool-call passthrough (client owns the tool loop)
//
// OpenAI tool calling is a stateless two-request dance; the Copilot SDK runs a
// single stateful turn that suspends on a pending external tool call. We bridge
// them by encoding the SDK sessionId + external-tool requestId into the OpenAI
// tool_call_id. All correlation rides on the wire, so this survives a proxy
// restart (the session itself is persisted by the Copilot CLI).
// ---------------------------------------------------------------------------

const TOOL_CALL_ID_PREFIX = "ct_";

function encodeToolCallId(sessionId, requestId) {
  const raw = JSON.stringify({ s: sessionId, r: requestId });
  return TOOL_CALL_ID_PREFIX + Buffer.from(raw, "utf-8").toString("base64url");
}

function decodeToolCallId(id) {
  if (typeof id !== "string" || !id.startsWith(TOOL_CALL_ID_PREFIX)) return null;
  try {
    const raw = Buffer.from(id.slice(TOOL_CALL_ID_PREFIX.length), "base64url").toString("utf-8");
    const { s, r } = JSON.parse(raw);
    if (typeof s === "string" && typeof r === "string") return { sessionId: s, requestId: r };
  } catch {
    // fall through to null
  }
  return null;
}

// The Copilot CLI rejects tool names that don't match /^[a-zA-Z0-9_-]+$/ (e.g.
// MCP tools with dots). We register a sanitized name with the SDK and keep a
// reverse map so the name we emit back to the client is the original.
const VALID_TOOL_NAME = /^[a-zA-Z0-9_-]+$/;

function sanitizeToolName(name, used) {
  let safe = VALID_TOOL_NAME.test(name) ? name : name.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!safe) safe = "tool";
  let candidate = safe;
  let i = 1;
  while (used.has(candidate)) candidate = `${safe}_${i++}`;
  return candidate;
}

// Normalise a tool spec from either API shape into { name, description,
// parameters }. Chat Completions nests under `.function`; the Responses API puts
// the fields at the top level.
function normalizeToolSpec(t) {
  if (!t || t.type !== "function") return null;
  const fn = t.function || t;
  if (!fn.name || typeof fn.name !== "string") return null;
  return { name: fn.name, description: fn.description, parameters: fn.parameters };
}

// Convert OpenAI tools[] (either API shape) into declaration-only SDK tools (no
// handler). Without a handler the SDK surfaces each call as an
// "external_tool.requested" event and leaves the turn pending for the client to
// execute and report back. tool_choice "none" means "don't call tools", which we
// honour by registering nothing (the SDK has no tool_choice control).
// Returns { sdkTools, nameMap } where nameMap is sanitized -> original name.
function buildToolRegistration(tools, toolChoice) {
  const empty = { sdkTools: [], nameMap: new Map() };
  if (toolChoice === "none" || !Array.isArray(tools)) return empty;
  const used = new Set();
  const nameMap = new Map();
  const sdkTools = [];
  for (const t of tools) {
    const spec = normalizeToolSpec(t);
    if (!spec) continue;
    const safe = sanitizeToolName(spec.name, used);
    used.add(safe);
    nameMap.set(safe, spec.name);
    sdkTools.push(
      defineTool(safe, {
        description: spec.description,
        parameters: spec.parameters || { type: "object", properties: {} },
        overridesBuiltInTool: true,
      })
    );
  }
  return { sdkTools, nameMap };
}

// Map a tool name emitted by the SDK back to the client's original name.
function originalToolName(nameMap, name) {
  return (nameMap && nameMap.get(name)) || name;
}

// When tools are present, restrict the session to client-provided tools only,
// hiding the SDK's own built-ins (which also eliminates name clashes).
function toolSessionExtras(sdkTools) {
  return sdkTools.length ? { tools: sdkTools, availableTools: ["custom:*"] } : {};
}

// Collect the trailing block of tool-result messages (those after the last
// non-tool message). These correspond to the pending external tool calls from
// the tool_calls response we most recently emitted.
function extractTrailingToolResults(messages) {
  const results = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "tool") break;
    results.unshift({
      toolCallId: m.tool_call_id,
      decoded: decodeToolCallId(m.tool_call_id),
      content: typeof m.content === "string" ? m.content : extractContent(m.content).text,
    });
  }
  return results;
}

// True when a request is a continuation we can resume: it ends with tool results
// that all decode to the same SDK session.
function resolveResume(messages) {
  const trailing = extractTrailingToolResults(messages);
  if (!trailing.length || !trailing.every((r) => r.decoded)) return null;
  const sessionId = trailing[0].decoded.sessionId;
  if (!trailing.every((r) => r.decoded.sessionId === sessionId)) return null;
  return { sessionId, trailing };
}

// Drive a dispatched turn until the model either emits a batch of external tool
// calls or completes with a final message. Resolves:
//   { kind: "tools", calls: [{ requestId, toolName, arguments }], content }
//   { kind: "text", content }
// Subscribe BEFORE dispatching the prompt / resolving pending calls.
function waitForTurnOutcome(session, { batchMs = 10, nameMap = null } = {}) {
  return new Promise((resolve, reject) => {
    const calls = [];
    let content = "";
    let flushTimer = null;
    let settled = false;

    const settle = (val) => {
      if (settled) return;
      settled = true;
      if (flushTimer) clearTimeout(flushTimer);
      resolve(val);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (flushTimer) clearTimeout(flushTimer);
      reject(err);
    };

    session.on((event) => {
      try {
        switch (event.type) {
          case "assistant.message":
            if (event.data.content) content += event.data.content;
            break;
          case "external_tool.requested":
            calls.push({
              requestId: event.data.requestId,
              toolName: originalToolName(nameMap, event.data.toolName),
              arguments: event.data.arguments || {},
            });
            // Batch sibling parallel calls (they arrive in the same tick).
            if (flushTimer) clearTimeout(flushTimer);
            flushTimer = setTimeout(() => settle({ kind: "tools", calls, content }), batchMs);
            break;
          case "session.idle":
            settle({ kind: "text", content });
            break;
          case "session.error":
            fail(new Error(event.data?.message || "session error"));
            break;
        }
      } catch (err) {
        fail(err);
      }
    });
  });
}

// Build the OpenAI chat response for a turn outcome. For tool calls, the
// sessionId is encoded into each tool_call_id so the continuation resumes here.
function buildChatOutcome(outcome, sessionId, model, usage) {
  if (outcome.kind === "tools") {
    return {
      id: `chatcmpl-${uuidv4()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: outcome.content || null,
            tool_calls: outcome.calls.map((c) => ({
              id: encodeToolCallId(sessionId, c.requestId),
              type: "function",
              function: { name: c.toolName, arguments: JSON.stringify(c.arguments) },
            })),
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: buildChatUsage(usage),
    };
  }
  return toOpenAIResponse(outcome.content, model, usage);
}

// Convert to OpenAI chat completion response format
function toOpenAIResponse(content, model, usage) {
  return {
    id: `chatcmpl-${uuidv4()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: buildChatUsage(usage),
  };
}

// Convert to OpenAI streaming chunk format
function toOpenAIStreamChunk(content, model, isFirst = false, isDone = false) {
  const chunk = {
    id: `chatcmpl-${uuidv4()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: isDone ? {} : isFirst ? { role: "assistant", content } : { content },
        finish_reason: isDone ? "stop" : null,
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

// Final usage-only chunk for streaming chat completions (OpenAI sends this
// when the client requests stream_options: { include_usage: true }).
function toOpenAIUsageChunk(model, usage) {
  const chunk = {
    id: `chatcmpl-${uuidv4()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [],
    usage: buildChatUsage(usage),
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

// Streaming chunk carrying a single tool call. The SDK delivers each call's
// arguments whole (not token-streamed), so we emit one chunk per call with the
// complete arguments string. The sessionId is encoded into the tool_call_id so
// the client's follow-up resumes this session.
function toOpenAIToolCallChunk(call, index, sessionId, model, isFirst) {
  const delta = {
    tool_calls: [
      {
        index,
        id: encodeToolCallId(sessionId, call.requestId),
        type: "function",
        function: { name: call.toolName, arguments: JSON.stringify(call.arguments) },
      },
    ],
  };
  if (isFirst) delta.role = "assistant";
  const chunk = {
    id: `chatcmpl-${uuidv4()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: null }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

// Terminal chunk carrying only a finish_reason (e.g. "tool_calls").
function toOpenAIFinishChunk(model, finishReason) {
  const chunk = {
    id: `chatcmpl-${uuidv4()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

// Drive a streaming turn, writing OpenAI SSE chunks to res. Streams text deltas
// as they arrive; if the model emits external tool calls the turn suspends with
// no session.idle, so we batch sibling calls and finish with "tool_calls".
// Subscribe BEFORE dispatching the prompt / resolving pending calls.
// Resolves: { kind: "tools" } | { kind: "text" }
function streamChatTurn(session, res, sessionId, model, { includeUsage, usage, batchMs = 10, nameMap = null } = {}) {
  return new Promise((resolve, reject) => {
    let isFirst = true;
    let fullContent = "";
    const calls = [];
    let flushTimer = null;
    let settled = false;

    const finishText = () => {
      if (settled) return;
      settled = true;
      detachClose();
      if (flushTimer) clearTimeout(flushTimer);
      res.write(toOpenAIStreamChunk("", model, false, true));
      if (includeUsage) res.write(toOpenAIUsageChunk(model, usage));
      res.write("data: [DONE]\n\n");
      log("POST /v1/chat/completions streaming response complete:", { model, content: fullContent, usage });
      resolve({ kind: "text", content: fullContent });
    };
    const finishTools = () => {
      if (settled) return;
      settled = true;
      detachClose();
      if (flushTimer) clearTimeout(flushTimer);
      calls.forEach((c, i) => {
        res.write(toOpenAIToolCallChunk(c, i, sessionId, model, isFirst));
        isFirst = false;
      });
      res.write(toOpenAIFinishChunk(model, "tool_calls"));
      if (includeUsage) res.write(toOpenAIUsageChunk(model, usage));
      res.write("data: [DONE]\n\n");
      log("POST /v1/chat/completions streaming tool_calls:", { model, calls: calls.map((c) => c.toolName), usage });
      resolve({ kind: "tools", calls });
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      detachClose();
      if (flushTimer) clearTimeout(flushTimer);
      reject(err);
    };

    const detachClose = watchClientDisconnect(res, session, fail);

    session.on((event) => {
      try {
        switch (event.type) {
          case "assistant.message_delta":
            fullContent += event.data.deltaContent;
            res.write(toOpenAIStreamChunk(event.data.deltaContent, model, isFirst));
            isFirst = false;
            break;
          case "external_tool.requested":
            calls.push({
              requestId: event.data.requestId,
              toolName: originalToolName(nameMap, event.data.toolName),
              arguments: event.data.arguments || {},
            });
            if (flushTimer) clearTimeout(flushTimer);
            flushTimer = setTimeout(finishTools, batchMs);
            break;
          case "session.idle":
            finishText();
            break;
          case "session.error":
            fail(new Error(event.data?.message || "session error"));
            break;
        }
      } catch (err) {
        fail(err);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Responses API helpers (/v1/responses)
// ---------------------------------------------------------------------------

// In-memory store for previous responses (for conversation threading)
// Maps response ID → { messages, outputContent, model, previousResponseId, timestamp }
const responseStore = new Map();
const RESPONSE_STORE_MAX_SIZE = 1000;
const RESPONSE_STORE_TTL = 60 * 60 * 1000; // 1 hour

function storeResponse(responseId, messages, outputContent, model, previousResponseId) {
  // Evict oldest entries if we exceed max size
  if (responseStore.size >= RESPONSE_STORE_MAX_SIZE) {
    const oldest = responseStore.keys().next().value;
    responseStore.delete(oldest);
  }
  responseStore.set(responseId, {
    messages,
    outputContent,
    model,
    previousResponseId: previousResponseId || null,
    timestamp: Date.now(),
  });
}

function getStoredResponse(responseId) {
  const entry = responseStore.get(responseId);
  if (!entry) return null;
  // Check TTL
  if (Date.now() - entry.timestamp > RESPONSE_STORE_TTL) {
    responseStore.delete(responseId);
    return null;
  }
  return entry;
}

// Rebuild full conversation history by walking the previous_response_id chain
function rebuildConversationHistory(previousResponseId) {
  const chain = [];
  let currentId = previousResponseId;

  while (currentId) {
    const stored = getStoredResponse(currentId);
    if (!stored) break;
    chain.unshift(stored);
    currentId = stored.previousResponseId || null;
  }

  return chain;
}

// Build the full messages array including conversation history from previous_response_id
function buildFullMessages(input, instructions, previousResponseId) {
  const messages = [];

  // Prepend instructions as a system message when provided
  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }

  // If there's a previous_response_id, rebuild conversation history
  if (previousResponseId) {
    const chain = rebuildConversationHistory(previousResponseId);
    for (const entry of chain) {
      // Add the user messages from that turn (excluding system messages,
      // since we use the current instructions)
      for (const msg of entry.messages) {
        if (msg.role !== "system") {
          messages.push(msg);
        }
      }
      // Add the assistant response from that turn
      if (entry.outputContent) {
        messages.push({ role: "assistant", content: entry.outputContent });
      }
    }
  }

  // Now add the current input
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") {
        messages.push({ role: "user", content: item });
      } else if (item.role && item.content) {
        // Preserve the original content shape (string or parts array) so image
        // parts survive to the send site; flattening happens at prompt build.
        messages.push({ role: item.role, content: item.content });
      }
    }
  }

  return messages;
}

// Normalise the Responses API "input" field into an OpenAI-style messages array.
// "input" can be:
//   - a plain string  → single user message
//   - an array of message objects (role + content)
//   - an array that mixes strings and message objects
function responsesInputToMessages(input, instructions) {
  const messages = [];

  // Prepend instructions as a system message when provided
  if (instructions) {
    messages.push({ role: "system", content: instructions });
  }

  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") {
        messages.push({ role: "user", content: item });
      } else if (item.role && item.content) {
        // Stored history is text-only; image parts are referenced, not persisted.
        messages.push({ role: item.role, content: extractContent(item.content).text });
      }
    }
  }

  return messages;
}

// Build a Responses API response object (non-streaming)
function toResponsesAPIResponse(content, model, responseId, usage) {
  const id = responseId || `resp_${uuidv4().replace(/-/g, "")}`;
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    output: [
      {
        type: "message",
        id: `msg_${uuidv4().replace(/-/g, "")}`,
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: content },
        ],
      },
    ],
    status: "completed",
    usage: buildResponsesUsage(usage),
  };
}

// Responses API streaming event helpers
function responsesStreamEvent(type, data) {
  // Include the event type inside the JSON data payload — many clients
  // (including Obsidian Copilot) parse the type from the JSON rather than
  // from the SSE `event:` line.
  const payload = { type, ...data };
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

// ---------------------------------------------------------------------------
// Responses API tool-calling helpers
// ---------------------------------------------------------------------------

// Collect function_call_output items from a Responses "input" array. These are
// the client's results for the external tool calls we previously emitted.
function extractResponsesToolResults(input) {
  if (!Array.isArray(input)) return [];
  const results = [];
  for (const item of input) {
    if (item && item.type === "function_call_output") {
      const callId = item.call_id;
      const out = item.output;
      results.push({
        callId,
        decoded: decodeToolCallId(callId),
        content: typeof out === "string" ? out : extractContent(out).text,
      });
    }
  }
  return results;
}

// True when a Responses request is a tool continuation we can resume: it carries
// function_call_output items that all decode to the same SDK session.
function resolveResponsesResume(input) {
  const results = extractResponsesToolResults(input);
  if (!results.length || !results.every((r) => r.decoded)) return null;
  const sessionId = results[0].decoded.sessionId;
  if (!results.every((r) => r.decoded.sessionId === sessionId)) return null;
  return { sessionId, results };
}

// Build the Responses output array for a tool-call outcome: an optional message
// item carrying any preamble text, followed by one function_call item per call.
function buildResponsesToolOutput(calls, content, sessionId, messageId) {
  const output = [];
  if (content) {
    output.push({
      type: "message",
      id: messageId,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: content }],
    });
  }
  for (const c of calls) {
    output.push({
      type: "function_call",
      id: `fc_${uuidv4().replace(/-/g, "")}`,
      call_id: encodeToolCallId(sessionId, c.requestId),
      name: c.toolName,
      arguments: JSON.stringify(c.arguments),
      status: "completed",
    });
  }
  return output;
}

// Drive a streaming Responses turn, emitting Responses SSE events. Handles both
// text (lazy message scaffolding on first delta) and tool-call outcomes
// (function_call items). Subscribe BEFORE dispatching. Resolves with the outcome
// so the caller can persist it for previous_response_id threading.
function streamResponsesTurn(session, res, { responseId, model, usage, sessionId, nameMap, batchMs = 10 } = {}) {
  return new Promise((resolve, reject) => {
    const baseResponse = { id: responseId, object: "response", status: "in_progress", model, output: [] };
    res.write(responsesStreamEvent("response.created", { response: baseResponse }));
    res.write(responsesStreamEvent("response.in_progress", { response: baseResponse }));

    let outputIndex = 0;
    let textStarted = false;
    let textDone = false;
    let messageId = null;
    let fullContent = "";
    const calls = [];
    let flushTimer = null;
    let settled = false;

    const startText = () => {
      if (textStarted) return;
      textStarted = true;
      messageId = `msg_${uuidv4().replace(/-/g, "")}`;
      res.write(responsesStreamEvent("response.output_item.added", {
        output_index: outputIndex,
        item: { type: "message", id: messageId, role: "assistant", status: "in_progress", content: [] },
      }));
      res.write(responsesStreamEvent("response.content_part.added", {
        item_id: messageId, output_index: outputIndex, content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      }));
    };

    const endText = () => {
      if (!textStarted || textDone) return;
      textDone = true;
      res.write(responsesStreamEvent("response.output_text.done", {
        item_id: messageId, output_index: outputIndex, content_index: 0, text: fullContent,
      }));
      res.write(responsesStreamEvent("response.content_part.done", {
        item_id: messageId, output_index: outputIndex, content_index: 0,
        part: { type: "output_text", text: fullContent },
      }));
      res.write(responsesStreamEvent("response.output_item.done", {
        output_index: outputIndex,
        item: {
          type: "message", id: messageId, role: "assistant", status: "completed",
          content: [{ type: "output_text", text: fullContent }],
        },
      }));
      outputIndex += 1;
    };

    const finish = (outputItems, kind) => {
      if (settled) return;
      settled = true;
      detachClose();
      if (flushTimer) clearTimeout(flushTimer);
      res.write(responsesStreamEvent("response.completed", {
        response: {
          id: responseId, object: "response", status: "completed", model,
          output: outputItems, usage: buildResponsesUsage(usage),
        },
      }));
      resolve({ kind, content: fullContent });
    };

    const finishText = () => {
      endText();
      const output = fullContent
        ? [{ type: "message", id: messageId, role: "assistant", status: "completed", content: [{ type: "output_text", text: fullContent }] }]
        : [];
      finish(output, "text");
    };

    const finishTools = () => {
      endText();
      const output = [];
      if (fullContent) {
        output.push({ type: "message", id: messageId, role: "assistant", status: "completed", content: [{ type: "output_text", text: fullContent }] });
      }
      for (const c of calls) {
        const itemId = `fc_${uuidv4().replace(/-/g, "")}`;
        const callId = encodeToolCallId(sessionId, c.requestId);
        const argsStr = JSON.stringify(c.arguments);
        const item = { type: "function_call", id: itemId, call_id: callId, name: c.toolName, arguments: "", status: "in_progress" };
        res.write(responsesStreamEvent("response.output_item.added", { output_index: outputIndex, item }));
        res.write(responsesStreamEvent("response.function_call_arguments.delta", {
          item_id: itemId, output_index: outputIndex, delta: argsStr,
        }));
        res.write(responsesStreamEvent("response.function_call_arguments.done", {
          item_id: itemId, output_index: outputIndex, arguments: argsStr,
        }));
        const doneItem = { type: "function_call", id: itemId, call_id: callId, name: c.toolName, arguments: argsStr, status: "completed" };
        res.write(responsesStreamEvent("response.output_item.done", { output_index: outputIndex, item: doneItem }));
        output.push(doneItem);
        outputIndex += 1;
      }
      finish(output, "tools");
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      detachClose();
      if (flushTimer) clearTimeout(flushTimer);
      reject(err);
    };

    const detachClose = watchClientDisconnect(res, session, fail);

    session.on((event) => {
      try {
        switch (event.type) {
          case "assistant.message_delta":
            startText();
            fullContent += event.data.deltaContent;
            res.write(responsesStreamEvent("response.output_text.delta", {
              item_id: messageId, output_index: outputIndex, content_index: 0, delta: event.data.deltaContent,
            }));
            break;
          case "external_tool.requested":
            calls.push({
              requestId: event.data.requestId,
              toolName: originalToolName(nameMap, event.data.toolName),
              arguments: event.data.arguments || {},
            });
            if (flushTimer) clearTimeout(flushTimer);
            flushTimer = setTimeout(finishTools, batchMs);
            break;
          case "session.idle":
            finishText();
            break;
          case "session.error":
            fail(new Error(event.data?.message || "session error"));
            break;
        }
      } catch (err) {
        fail(err);
      }
    });
  });
}

// POST /v1/chat/completions - Main chat endpoint
app.post("/v1/chat/completions", async (req, res) => {
  try {
    log("POST /v1/chat/completions request:", req.body);

    const {
      messages,
      model,
      stream = false,
      stream_options,
      tools,
      tool_choice,
      temperature,
      top_p,
      max_tokens,
      max_completion_tokens,
    } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return sendError(res, 400, "messages is required and must be a non-empty array", "invalid_request_error", "invalid_messages");
    }

    const selectedModel = model || DEFAULT_MODEL;
    const client = await getCopilotClient();

    const { sdkTools, nameMap } = buildToolRegistration(tools, tool_choice);
    const hasTools = sdkTools.length > 0;

    // ---- Continuation: client returned tool results -> resume the suspended
    // session, supply each result, and continue the same turn (streaming or not).
    const resume = resolveResume(messages);
    if (resume) {
      const session = await client.resumeSession(resume.sessionId, {
        model: selectedModel,
        streaming: stream,
        onPermissionRequest: approveAll,
        continuePendingWork: true,
        infiniteSessions: { enabled: false },
        ...toolSessionExtras(sdkTools),
      });
      const usage = trackUsage(session);
      try {
        if (stream) {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          res.setHeader("X-Accel-Buffering", "no");
          const turnPromise = streamChatTurn(session, res, resume.sessionId, selectedModel, {
            includeUsage: stream_options?.include_usage,
            usage,
            nameMap,
          });
          for (const r of resume.trailing) {
            await session.rpc.tools.handlePendingToolCall({
              requestId: r.decoded.requestId,
              result: r.content,
            });
          }
          await turnPromise;
          return res.end();
        }
        const outcomePromise = waitForTurnOutcome(session, { nameMap });
        for (const r of resume.trailing) {
          await session.rpc.tools.handlePendingToolCall({
            requestId: r.decoded.requestId,
            result: r.content,
          });
        }
        const outcome = await outcomePromise;
        const response = buildChatOutcome(outcome, resume.sessionId, selectedModel, usage);
        log("POST /v1/chat/completions (resume) response:", response);
        return res.json(response);
      } finally {
        await session.disconnect();
      }
    }

    // Build session config
    const sessionConfig = {
      model: selectedModel,
      streaming: stream,
      onPermissionRequest: approveAll,
      infiniteSessions: { enabled: false },
    };

    // When tools are present, register them and hide built-ins so the client
    // owns the tool loop (applies to both streaming and non-streaming).
    if (hasTools) {
      Object.assign(sessionConfig, toolSessionExtras(sdkTools));
    }

    // Extract and set system message if present
    const systemMessage = extractSystemMessage(messages);
    if (systemMessage) {
      sessionConfig.systemMessage = { content: systemMessage };
    }

    // Forward supported model parameters when provided
    if (temperature !== undefined) {
      sessionConfig.temperature = temperature;
    }
    if (top_p !== undefined) {
      sessionConfig.topP = top_p;
    }
    // OpenAI deprecated `max_tokens` in favor of `max_completion_tokens`; honor
    // either, preferring the newer field when both are present.
    const maxTokens = max_completion_tokens ?? max_tokens;
    if (maxTokens !== undefined) {
      sessionConfig.maxTokens = maxTokens;
    }

    // Create session
    const session = await client.createSession(sessionConfig);
    trackProxySession(session.sessionId);
    const usage = trackUsage(session);

    try {
      // Filter out system messages and convert remaining to prompt
      const nonSystemMessages = messages.filter((m) => m.role !== "system");
      const prompt = messagesToPrompt(nonSystemMessages);
      const attachments = collectImages(nonSystemMessages);
      const sendOptions = attachments.length ? { prompt, attachments } : { prompt };

      if (stream) {
        // Streaming response (handles both text and tool-call turns).
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");

        const turnPromise = streamChatTurn(session, res, session.sessionId, selectedModel, {
          includeUsage: stream_options?.include_usage,
          usage,
          nameMap,
        });
        await session.send(sendOptions);
        await turnPromise;
        res.end();
      } else if (hasTools) {
        // Non-streaming, tools registered: drive events so we can intercept the
        // model's tool calls (the turn suspends with no session.idle).
        const outcomePromise = waitForTurnOutcome(session, { nameMap });
        await session.send(sendOptions);
        const outcome = await outcomePromise;
        const response = buildChatOutcome(outcome, session.sessionId, selectedModel, usage);
        log("POST /v1/chat/completions (tools) response:", response);
        res.json(response);
      } else {
        // Non-streaming response
        const result = await session.sendAndWait(sendOptions);
        const content = result?.data?.content || "";
        const response = toOpenAIResponse(content, selectedModel, usage);
        log("POST /v1/chat/completions response:", response);
        res.json(response);
      }
    } finally {
      await session.disconnect();
    }
  } catch (err) {
    if (err instanceof ClientDisconnectError) {
      log("POST /v1/chat/completions client disconnected mid-stream; aborted turn");
      return;
    }
    error("Error in /v1/chat/completions:", err);
    if (res.headersSent) return res.end();
    sendError(res, 500, err.message || "Internal server error", "api_error", "internal_error");
  }
});

// POST /v1/responses - OpenAI Responses API endpoint
app.post("/v1/responses", async (req, res) => {
  try {
    log("POST /v1/responses request:", req.body);

    const {
      input,
      model,
      instructions,
      stream = false,
      previous_response_id,
      temperature,
      top_p,
      max_output_tokens,
      tools,
      tool_choice,
      store = true,  // default true per OpenAI spec
    } = req.body;

    if (input === undefined || input === null) {
      return sendError(res, 400, "input is required", "invalid_request_error", "invalid_input");
    }

    const selectedModel = model || DEFAULT_MODEL;
    const client = await getCopilotClient();

    const { sdkTools, nameMap } = buildToolRegistration(tools, tool_choice);
    const hasTools = sdkTools.length > 0;

    // ---- Continuation: client returned function_call_output items -> resume the
    // suspended session, supply each result, and continue the same turn.
    const rResume = resolveResponsesResume(input);
    if (rResume) {
      const session = await client.resumeSession(rResume.sessionId, {
        model: selectedModel,
        streaming: stream,
        onPermissionRequest: approveAll,
        continuePendingWork: true,
        infiniteSessions: { enabled: false },
        ...toolSessionExtras(sdkTools),
      });
      const usage = trackUsage(session);
      const responseId = `resp_${uuidv4().replace(/-/g, "")}`;
      try {
        if (stream) {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          res.setHeader("X-Accel-Buffering", "no");
          const turnPromise = streamResponsesTurn(session, res, {
            responseId, model: selectedModel, usage, sessionId: rResume.sessionId, nameMap,
          });
          for (const r of rResume.results) {
            await session.rpc.tools.handlePendingToolCall({ requestId: r.decoded.requestId, result: r.content });
          }
          await turnPromise;
          return res.end();
        }
        const outcomePromise = waitForTurnOutcome(session, { nameMap });
        for (const r of rResume.results) {
          await session.rpc.tools.handlePendingToolCall({ requestId: r.decoded.requestId, result: r.content });
        }
        const outcome = await outcomePromise;
        let response;
        if (outcome.kind === "tools") {
          response = {
            id: responseId, object: "response", created_at: Math.floor(Date.now() / 1000),
            model: selectedModel,
            output: buildResponsesToolOutput(outcome.calls, outcome.content, rResume.sessionId, `msg_${uuidv4().replace(/-/g, "")}`),
            status: "completed", usage: buildResponsesUsage(usage),
          };
        } else {
          response = toResponsesAPIResponse(outcome.content, selectedModel, responseId, usage);
        }
        log("POST /v1/responses (resume) response:", response);
        return res.json(response);
      } finally {
        await session.disconnect();
      }
    }

    // Build full messages array including conversation history
    const messages = buildFullMessages(input, instructions, previous_response_id);

    log("POST /v1/responses resolved messages:", messages);

    // Build session config
    const sessionConfig = {
      model: selectedModel,
      streaming: stream,
      onPermissionRequest: approveAll,
      infiniteSessions: { enabled: false },
    };

    // When tools are present, register them and hide built-ins so the client
    // owns the tool loop.
    if (hasTools) {
      Object.assign(sessionConfig, toolSessionExtras(sdkTools));
    }

    // Forward supported model parameters when provided
    if (temperature !== undefined) {
      sessionConfig.temperature = temperature;
    }
    if (top_p !== undefined) {
      sessionConfig.topP = top_p;
    }
    if (max_output_tokens !== undefined) {
      sessionConfig.maxTokens = max_output_tokens;
    }

    // Extract and set system message if present
    const systemMessage = extractSystemMessage(messages);
    if (systemMessage) {
      sessionConfig.systemMessage = { content: systemMessage };
    }

    // Create session
    const session = await client.createSession(sessionConfig);
    trackProxySession(session.sessionId);
    const usage = trackUsage(session);
    const responseId = `resp_${uuidv4().replace(/-/g, "")}`;
    const messageId = `msg_${uuidv4().replace(/-/g, "")}`;

    try {
      // Filter out system messages and convert remaining to prompt
      const nonSystemMessages = messages.filter((m) => m.role !== "system");
      const prompt = messagesToPrompt(nonSystemMessages);
      const attachments = collectImages(nonSystemMessages);
      const sendOptions = attachments.length ? { prompt, attachments } : { prompt };

      if (stream && hasTools) {
        // Tool-aware streaming: lazy message scaffolding + function_call items.
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        const turnPromise = streamResponsesTurn(session, res, {
          responseId, model: selectedModel, usage, sessionId: session.sessionId, nameMap,
        });
        await session.send(sendOptions);
        const outcome = await turnPromise;
        if (store && outcome.kind === "text") {
          const currentTurnMessages = responsesInputToMessages(input, null);
          storeResponse(responseId, currentTurnMessages, outcome.content, selectedModel, previous_response_id);
        }
        return res.end();
      } else if (stream) {
        // Streaming response using Responses API SSE format
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");

        // Send response.created
        const responseObj = {
          id: responseId, object: "response", status: "in_progress",
          model: selectedModel, output: [],
        };
        res.write(responsesStreamEvent("response.created", {
          response: responseObj,
        }));

        // Send response.in_progress
        res.write(responsesStreamEvent("response.in_progress", {
          response: responseObj,
        }));

        // Send output_item.added
        const outputItem = {
          type: "message", id: messageId, role: "assistant",
          status: "in_progress", content: [],
        };
        res.write(responsesStreamEvent("response.output_item.added", {
          output_index: 0, item: outputItem,
        }));

        // Send content_part.added
        res.write(responsesStreamEvent("response.content_part.added", {
          item_id: messageId, output_index: 0, content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        }));

        let fullContent = "";

        const done = new Promise((resolve, reject) => {
          let settled = false;
          const detachClose = watchClientDisconnect(res, session, (err) => {
            if (settled) return;
            settled = true;
            reject(err);
          });
          session.on((event) => {
            try {
              if (event.type === "assistant.message_delta") {
                const delta = event.data.deltaContent;
                fullContent += delta;
                res.write(responsesStreamEvent("response.output_text.delta", {
                  item_id: messageId, output_index: 0, content_index: 0, delta,
                }));
              } else if (event.type === "session.idle") {
                if (settled) return;
                settled = true;
                detachClose();
                // Send output_text.done
                res.write(responsesStreamEvent("response.output_text.done", {
                  item_id: messageId, output_index: 0, content_index: 0, text: fullContent,
                }));

                // Send content_part.done
                res.write(responsesStreamEvent("response.content_part.done", {
                  item_id: messageId, output_index: 0, content_index: 0,
                  part: { type: "output_text", text: fullContent },
                }));

                // Send output_item.done
                res.write(responsesStreamEvent("response.output_item.done", {
                  output_index: 0,
                  item: {
                    type: "message", id: messageId, role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: fullContent }],
                  },
                }));

                // Send response.completed
                res.write(responsesStreamEvent("response.completed", {
                  response: {
                    id: responseId, object: "response", status: "completed",
                    model: selectedModel,
                    output: [{
                      type: "message", id: messageId, role: "assistant",
                      status: "completed",
                      content: [{ type: "output_text", text: fullContent }],
                    }],
                    usage: buildResponsesUsage(usage),
                  },
                }));

                // Store the response for conversation threading
                if (store) {
                  const currentTurnMessages = responsesInputToMessages(input, null);
                  storeResponse(responseId, currentTurnMessages, fullContent, selectedModel, previous_response_id);
                }

                log("POST /v1/responses streaming response complete:", { model: selectedModel, content: fullContent });
                resolve();
              }
            } catch (err) {
              if (settled) return;
              settled = true;
              detachClose();
              reject(err);
            }
          });
        });

        await session.send(sendOptions);
        await done;
        res.end();
      } else if (hasTools) {
        // Non-streaming, tools registered: drive events to intercept tool calls.
        const outcomePromise = waitForTurnOutcome(session, { nameMap });
        await session.send(sendOptions);
        const outcome = await outcomePromise;
        let response;
        if (outcome.kind === "tools") {
          response = {
            id: responseId, object: "response", created_at: Math.floor(Date.now() / 1000),
            model: selectedModel,
            output: buildResponsesToolOutput(outcome.calls, outcome.content, session.sessionId, messageId),
            status: "completed", usage: buildResponsesUsage(usage),
          };
        } else {
          response = toResponsesAPIResponse(outcome.content, selectedModel, responseId, usage);
          if (store) {
            const currentTurnMessages = responsesInputToMessages(input, null);
            storeResponse(responseId, currentTurnMessages, outcome.content, selectedModel, previous_response_id);
          }
        }
        log("POST /v1/responses (tools) response:", response);
        res.json(response);
      } else {
        // Non-streaming response
        const result = await session.sendAndWait(sendOptions);
        const content = result?.data?.content || "";
        const response = toResponsesAPIResponse(content, selectedModel, responseId, usage);
        log("POST /v1/responses response:", response);

        // Store the response for conversation threading
        if (store) {
          const currentTurnMessages = responsesInputToMessages(input, null);
          storeResponse(responseId, currentTurnMessages, content, selectedModel, previous_response_id);
        }

        res.json(response);
      }
    } finally {
      await session.disconnect();
    }
  } catch (err) {
    if (err instanceof ClientDisconnectError) {
      log("POST /v1/responses client disconnected mid-stream; aborted turn");
      return;
    }
    error("Error in /v1/responses:", err);
    if (res.headersSent) return res.end();
    sendError(res, 500, err.message || "Internal server error", "api_error", "internal_error");
  }
});

// GET /v1/models - List available models
app.get("/v1/models", async (req, res) => {
  try {
    const models = await getAvailableModels();
    const response = { object: "list", data: models.map((m) => toModelObject(m)) };
    log("GET /v1/models response:", response);
    res.json(response);
  } catch (err) {
    error("Error fetching models:", err);
    sendError(res, 500, err.message || "Failed to fetch models", "api_error", "internal_error");
  }
});

// GET /v1/models/:model - Get specific model
app.get("/v1/models/:model", async (req, res) => {
  try {
    const models = await getAvailableModels();
    const model = models.find((m) => m.id === req.params.model);
    if (!model) {
      return sendError(res, 404, `Model '${req.params.model}' not found`, "invalid_request_error", "model_not_found");
    }
    const response = toModelObject(model);
    log("GET /v1/models/:model response:", response);
    res.json(response);
  } catch (err) {
    error("Error fetching model:", err);
    sendError(res, 500, err.message || "Failed to fetch model", "api_error", "internal_error");
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Log unmatched requests
app.use((req, res) => {
  log("Unmatched request:", req.method, req.originalUrl, req.body);
  sendError(res, 404, `No route found for ${req.method} ${req.originalUrl}`, "invalid_request_error", "not_found");
});

// Graceful shutdown
async function shutdown() {
  log("Shutting down...");
  if (copilotClient) {
    try {
      await copilotClient.stop();
      log("CopilotClient stopped");
    } catch (err) {
      error("Error stopping CopilotClient:", err);
    }
  }
  process.exit(0);
}

if (isMain) {
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (opts.list) {
    // Handle --list: print available models and exit
    (async () => {
      try {
        const client = await getCopilotClient();
        const models = await client.listModels();
        for (const model of models) {
          console.error(`${model.id} [${model.name}]`);
        }
      } catch (err) {
        console.error("Error fetching models:", err.message || err);
        await stopAndExit(1);
      } finally {
        await stopAndExit(0);
      }
    })();
  } else {
    // Validate the default model before starting the server
    (async () => {
      try {
        const models = await getAvailableModels();
        const modelExists = models.some((m) => m.id === DEFAULT_MODEL);
        if (!modelExists) {
          console.error(`Error: Model '${DEFAULT_MODEL}' is not available.`);
          console.error("Available models:");
          for (const m of models) {
            console.error(`  ${m.id} [${m.name}]`);
          }
          await stopAndExit(1);
        }
      } catch (err) {
        console.error("Error validating model:", err.message || err);
        await stopAndExit(1);
      }

      // Start server
      app.listen(PORT, '127.0.0.1', () => {
        console.error(`OpenAI-compatible proxy server running at http://localhost:${PORT}`);
        console.error(`Default model: ${DEFAULT_MODEL}`);
        console.error("Endpoints:");
        console.error(`  POST http://localhost:${PORT}/v1/chat/completions`);
        console.error(`  POST http://localhost:${PORT}/v1/responses`);
        console.error(`  GET  http://localhost:${PORT}/v1/models`);
        console.error(`  GET  http://localhost:${PORT}/health`);
      });

      startSessionGC();
    })();
  }
}

// Pure, side-effect-free helpers exported only for the unit test suite.
export {
  inferOwnedBy,
  modelLimits,
  toModelObject,
  dataUriToBlob,
  extractContent,
  messagesToPrompt,
  collectImages,
  extractSystemMessage,
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
  toOpenAIResponse,
  toResponsesAPIResponse,
  buildFullMessages,
  responsesInputToMessages,
};
