#!/usr/bin/env node

import express from "express";
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import { v4 as uuidv4 } from "uuid";
import { Command } from "commander";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Read package.json for version
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf-8"));

// Parse command-line arguments
const program = new Command();
program
  .name("copilot-proxy")
  .description("OpenAI-compatible proxy server for GitHub Copilot SDK")
  .version(pkg.version, "-V, --version", "output the version number")
  .option("-p, --port <number>", "port to listen on", "3001")
  .option("-m, --model <name>", "default model id to use (ex. 'gpt-5.2')")
  .option("-l, --list", "list available models and exit")
  .option("--cli-path <path>", "path to copilot CLI binary (if not in $PATH)", process.env.COPILOT_CLI_PATH)
  .option("-v, --verbose", "enable verbose log output")
  .helpOption("-h, --help", "display this help")
  .parse(process.argv);

const opts = program.opts();

// -m is required unless --list is used
if (!opts.list && !opts.model) {
  program.error("required option '-m, --model <name>' not specified");
}

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
    copilotClient = new CopilotClient(opts.cliPath ? { cliPath: opts.cliPath } : {});
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

// Format a model object for the OpenAI API
function toModelObject(modelId) {
  return {
    id: modelId,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: inferOwnedBy(modelId),
  };
}

// Convert OpenAI messages array to a single prompt string
function messagesToPrompt(messages) {
  return messages
    .map((msg) => {
      const role = msg.role.charAt(0).toUpperCase() + msg.role.slice(1);
      const content =
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n");
      return `${role}: ${content}`;
    })
    .join("\n\n");
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

// Convert to OpenAI chat completion response format
function toOpenAIResponse(content, model) {
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
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
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
        const text =
          typeof item.content === "string"
            ? item.content
            : Array.isArray(item.content)
              ? item.content
                  .filter((c) => c.type === "input_text" || c.type === "text")
                  .map((c) => c.text)
                  .join("\n")
              : String(item.content);
        messages.push({ role: item.role, content: text });
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
        // content may be a string or an array of content parts
        const text =
          typeof item.content === "string"
            ? item.content
            : Array.isArray(item.content)
              ? item.content
                  .filter((c) => c.type === "input_text" || c.type === "text")
                  .map((c) => c.text)
                  .join("\n")
              : String(item.content);
        messages.push({ role: item.role, content: text });
      }
    }
  }

  return messages;
}

// Build a Responses API response object (non-streaming)
function toResponsesAPIResponse(content, model, responseId) {
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
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
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

// POST /v1/chat/completions - Main chat endpoint
app.post("/v1/chat/completions", async (req, res) => {
  try {
    log("POST /v1/chat/completions request:", req.body);

    const { messages, model, stream = false } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return sendError(res, 400, "messages is required and must be a non-empty array", "invalid_request_error", "invalid_messages");
    }

    const selectedModel = model || DEFAULT_MODEL;
    const client = await getCopilotClient();

    // Build session config
    const sessionConfig = {
      model: selectedModel,
      streaming: stream,
      onPermissionRequest: approveAll,
      infiniteSessions: { enabled: false },
    };

    // Extract and set system message if present
    const systemMessage = extractSystemMessage(messages);
    if (systemMessage) {
      sessionConfig.systemMessage = { content: systemMessage };
    }

    // Create session
    const session = await client.createSession(sessionConfig);

    try {
      // Filter out system messages and convert remaining to prompt
      const nonSystemMessages = messages.filter((m) => m.role !== "system");
      const prompt = messagesToPrompt(nonSystemMessages);

      if (stream) {
        // Streaming response
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");

        let isFirst = true;
        let fullContent = "";

        const done = new Promise((resolve, reject) => {
          session.on((event) => {
            try {
              if (event.type === "assistant.message_delta") {
                fullContent += event.data.deltaContent;
                res.write(toOpenAIStreamChunk(event.data.deltaContent, selectedModel, isFirst));
                isFirst = false;
              } else if (event.type === "session.idle") {
                res.write(toOpenAIStreamChunk("", selectedModel, false, true));
                res.write("data: [DONE]\n\n");
                log("POST /v1/chat/completions streaming response complete:", { model: selectedModel, content: fullContent });
                resolve();
              }
            } catch (err) {
              reject(err);
            }
          });
        });

        await session.send({ prompt });
        await done;
        res.end();
      } else {
        // Non-streaming response
        const result = await session.sendAndWait({ prompt });
        const content = result?.data?.content || "";
        const response = toOpenAIResponse(content, selectedModel);
        log("POST /v1/chat/completions response:", response);
        res.json(response);
      }
    } finally {
      await session.disconnect();
    }
  } catch (err) {
    error("Error in /v1/chat/completions:", err);
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
      store = true,  // default true per OpenAI spec
    } = req.body;

    if (input === undefined || input === null) {
      return sendError(res, 400, "input is required", "invalid_request_error", "invalid_input");
    }

    const selectedModel = model || DEFAULT_MODEL;
    const client = await getCopilotClient();

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

    const responseId = `resp_${uuidv4().replace(/-/g, "")}`;
    const messageId = `msg_${uuidv4().replace(/-/g, "")}`;

    try {
      // Filter out system messages and convert remaining to prompt
      const nonSystemMessages = messages.filter((m) => m.role !== "system");
      const prompt = messagesToPrompt(nonSystemMessages);

      if (stream) {
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
          session.on((event) => {
            try {
              if (event.type === "assistant.message_delta") {
                const delta = event.data.deltaContent;
                fullContent += delta;
                res.write(responsesStreamEvent("response.output_text.delta", {
                  item_id: messageId, output_index: 0, content_index: 0, delta,
                }));
              } else if (event.type === "session.idle") {
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
                    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
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
              reject(err);
            }
          });
        });

        await session.send({ prompt });
        await done;
        res.end();
      } else {
        // Non-streaming response
        const result = await session.sendAndWait({ prompt });
        const content = result?.data?.content || "";
        const response = toResponsesAPIResponse(content, selectedModel, responseId);
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
    error("Error in /v1/responses:", err);
    sendError(res, 500, err.message || "Internal server error", "api_error", "internal_error");
  }
});

// GET /v1/models - List available models
app.get("/v1/models", async (req, res) => {
  try {
    const models = await getAvailableModels();
    const response = { object: "list", data: models.map((m) => toModelObject(m.id)) };
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
    const response = toModelObject(model.id);
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

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Handle --list: print available models and exit
if (opts.list) {
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
  })();
}
