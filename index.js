import "dotenv/config";
import express from "express";
import { CopilotClient } from "@github/copilot-sdk";
import { v4 as uuidv4 } from "uuid";

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.COPILOT_PROXY_PORT || 3001;
const DEFAULT_MODEL = process.env.COPILOT_PROXY_DEFAULT_MODEL || "gpt-5.2";

// Available models - extend as needed
const AVAILABLE_MODELS = [
  { id: "gpt-4.1", owned_by: "openai" },
  { id: "gpt-5", owned_by: "openai" },
  { id: "gpt-5-mini", owned_by: "openai" },
  { id: "gpt-5.1", owned_by: "openai" },
  { id: "gpt-5.1-codex", owned_by: "openai" },
  { id: "gpt-5.1-codex-max", owned_by: "openai" },
  { id: "gpt-5.2", owned_by: "openai" },
  { id: "claude-sonnet-4", owned_by: "anthropic" },
  { id: "claude-sonnet-4.5", owned_by: "anthropic" },
  { id: "claude-haiku-4.5", owned_by: "anthropic" },
  { id: "claude-opus-4.5", owned_by: "anthropic" },
];

// Singleton CopilotClient instance
let copilotClient = null;

async function getCopilotClient() {
  if (!copilotClient) {
    const options = {};
    if (process.env.COPILOT_CLI_PATH) {
      options.cliPath = process.env.COPILOT_CLI_PATH;
    }
    copilotClient = new CopilotClient(options);
    await copilotClient.start();
    console.log("CopilotClient started");
  }
  return copilotClient;
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
  const systemMessages = messages.filter((m) => m.role === "system");
  if (systemMessages.length === 0) return null;
  return systemMessages.map((m) => m.content).join("\n");
}

// Convert to OpenAI chat completion response format
function toOpenAIResponse(content, model, promptTokens = 0, completionTokens = 0) {
  return {
    id: `chatcmpl-${uuidv4()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

// Convert to OpenAI streaming chunk format
function toOpenAIStreamChunk(content, model, isFirst = false, isDone = false) {
  const chunk = {
    id: `chatcmpl-${uuidv4()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [
      {
        index: 0,
        delta: isDone ? {} : isFirst ? { role: "assistant", content: content } : { content: content },
        finish_reason: isDone ? "stop" : null,
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

// POST /v1/chat/completions - Main chat endpoint
app.post("/v1/chat/completions", async (req, res) => {
  try {
    const { messages, model, stream = false } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: {
          message: "messages is required and must be a non-empty array",
          type: "invalid_request_error",
          code: "invalid_messages",
        },
      });
    }

    const selectedModel = model || DEFAULT_MODEL;
    const client = await getCopilotClient();

    // Build session config
    const sessionConfig = {
      model: selectedModel,
      streaming: stream,
      infiniteSessions: { enabled: false }, // Disable for stateless behavior
    };

    // Extract and set system message if present
    const systemMessage = extractSystemMessage(messages);
    if (systemMessage) {
      sessionConfig.systemMessage = {
        content: systemMessage,
      };
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

        const done = new Promise((resolve, reject) => {
          session.on((event) => {
            try {
              if (event.type === "assistant.message_delta") {
                const chunk = toOpenAIStreamChunk(
                  event.data.deltaContent,
                  selectedModel,
                  isFirst
                );
                res.write(chunk);
                isFirst = false;
              } else if (event.type === "session.idle") {
                // Send final chunk with finish_reason
                res.write(toOpenAIStreamChunk("", selectedModel, false, true));
                res.write("data: [DONE]\n\n");
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
        res.json(toOpenAIResponse(content, selectedModel));
      }
    } finally {
      // Always clean up session
      await session.destroy();
    }
  } catch (error) {
    console.error("Error in /v1/chat/completions:", error);
    res.status(500).json({
      error: {
        message: error.message || "Internal server error",
        type: "api_error",
        code: "internal_error",
      },
    });
  }
});

// GET /v1/models - List available models
app.get("/v1/models", (req, res) => {
  res.json({
    object: "list",
    data: AVAILABLE_MODELS.map((m) => ({
      id: m.id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: m.owned_by,
    })),
  });
});

// GET /v1/models/:model - Get specific model
app.get("/v1/models/:model", (req, res) => {
  const model = AVAILABLE_MODELS.find((m) => m.id === req.params.model);
  if (!model) {
    return res.status(404).json({
      error: {
        message: `Model '${req.params.model}' not found`,
        type: "invalid_request_error",
        code: "model_not_found",
      },
    });
  }
  res.json({
    id: model.id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: model.owned_by,
  });
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Graceful shutdown
async function shutdown() {
  console.log("\nShutting down...");
  if (copilotClient) {
    try {
      await copilotClient.stop();
      console.log("CopilotClient stopped");
    } catch (err) {
      console.error("Error stopping CopilotClient:", err);
    }
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start server
app.listen(PORT, '127.0.0.1', () => {
  console.log(`OpenAI-compatible proxy server running at http://localhost:${PORT}`);
  console.log(`Default model: ${DEFAULT_MODEL}`);
  console.log("\nEndpoints:");
  console.log(`  POST http://localhost:${PORT}/v1/chat/completions`);
  console.log(`  GET  http://localhost:${PORT}/v1/models`);
  console.log(`  GET  http://localhost:${PORT}/health`);
});
