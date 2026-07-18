# Copilot Proxy

An OpenAI-compatible proxy server that forwards requests to GitHub Copilot via the Copilot SDK.

## Overview

This proxy allows local applications expecting an OpenAI-compatible API to use GitHub Copilot as their backend. Applications connect to this proxy without needing API keys—the proxy handles authentication with GitHub Copilot.

## Requirements

- Node.js >= 18.0.0
- GitHub Copilot CLI installed and in PATH (or configure custom path)
- Active GitHub Copilot subscription

## Installation

```bash
npm install
```

## Configuration

### Command-Line Options

| Option | Default | Description |
|--------|---------|-------------|
| `-p, --port <number>` | `3001` | Port the proxy listens on |
| `-m, --model <name>` | (required) | Default model to use when not specified in request |
| `-l, --list` | | List available models and exit |
| `--cli-path <path>` | (system PATH) | Custom path to Copilot CLI executable |
| `--session-ttl <minutes>` | `60` | Delete abandoned proxy-created sessions left idle longer than this (`0` disables GC). See [Session Garbage Collection](#session-garbage-collection) |
| `-v, --verbose` | | Enable verbose log output |
| `-h, --help` | | Display help for command |
| `-V, --version` | | Output the version number |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `COPILOT_CLI_PATH` | (system PATH) | Custom path to Copilot CLI executable |
| `COPILOT_PROXY_SESSION_TTL_MIN` | `60` | Default for `--session-ttl` (minutes; `0` disables GC) |
| `COPILOT_PROXY_SESSION_LEDGER` | `~/.copilot/proxy-session-ledger.json` | Path to the GC session ledger (see [Session Garbage Collection](#session-garbage-collection)) |

## Usage

Start the server:

```bash
npm start -- -m gpt-5.2
```

Or run directly:

```bash
node index.js -m gpt-5.2
```

The server will be available at `http://localhost:3001` (or your configured port).

## API Endpoints

### POST /v1/chat/completions

OpenAI-compatible chat completions endpoint.

**Request:**
```json
{
  "model": "gpt-5.2",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Hello!"}
  ],
  "stream": false
}
```

**Response:**
```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1706300000,
  "model": "gpt-5.2",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you today?"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 23,
    "completion_tokens": 9,
    "total_tokens": 32
  }
}
```

### GET /v1/models

List available models.

### GET /v1/models/:model

Get information about a specific model.

### GET /health

Health check endpoint.

## Streaming

Set `"stream": true` in your request to receive Server-Sent Events (SSE) streaming responses, compatible with OpenAI's streaming format.

## Function Calling (Tools)

Both `/v1/chat/completions` and `/v1/responses` support OpenAI-style function calling, where **the client owns the tool loop** (the model requests a tool, your client executes it and returns the result). This works for any OpenAI-compatible client, streaming or non-streaming.

How it works:

1. Send `tools` (and optionally `tool_choice`) with your request.
2. When the model calls a tool, the proxy returns a `tool_calls` response (Chat Completions) or a `function_call` item (Responses API) with `finish_reason: "tool_calls"`.
3. Execute the tool on your side and send the result back — a `role: "tool"` message (Chat Completions) or a `function_call_output` item (Responses API), echoing the `tool_call_id` / `call_id` the proxy gave you.
4. The proxy resumes the model turn and continues — more tool calls or a final answer.

Notes:

- Parallel tool calls and multiple sequential tool rounds are supported.
- The session that backs an in-progress tool call is persisted by the Copilot CLI, so a tool round-trip **survives a proxy restart** — correlation is carried entirely on the `tool_call_id` / `call_id`.
- `tool_choice: "none"` disables tool use for that request. Other `tool_choice` values are best-effort (the underlying SDK has no forced-tool control).
- Tool names that aren't `[a-zA-Z0-9_-]+` (e.g. MCP names with dots) are sanitized for the backend and mapped back to the original name in responses.
- Abandoned tool sessions are garbage-collected after `--session-ttl` minutes (see [Session Garbage Collection](#session-garbage-collection)).

## Session Garbage Collection

Every request creates a Copilot SDK **session** that is persisted to disk by the
Copilot CLI (under `~/.copilot/session-state`). This persistence is deliberate:
it's what lets an in-progress tool call **survive a proxy restart**. The cost is
that an abandoned session — one where the client requested a tool but never sent
the result back — would otherwise linger on disk forever. The garbage collector
reclaims these.

### What it does

A periodic background sweep permanently deletes proxy-created sessions that have
been **idle longer than `--session-ttl` minutes** (default 60). "Idle" is judged
by each session's own last-modified time, so a session in the middle of a
multi-round tool exchange is never collected — real activity refreshes that
timestamp within seconds. The sweep runs every quarter of the TTL, clamped to a
1–15 minute interval. Set `--session-ttl 0` (or `COPILOT_PROXY_SESSION_TTL_MIN=0`)
to disable it entirely.

Deletion is **permanent and irreversible** — it removes the session's
conversation history, planning state, and artifacts from disk. The session
cannot be resumed afterward.

### How it avoids touching your Copilot CLI sessions

The Copilot session store is **shared**: if you also use the `copilot` CLI
directly, its conversations live in the same place as the proxy's. The SDK
exposes no field marking who created a session, so a naive "delete every idle
session" sweep would also delete your idle CLI conversations.

To prevent this, the proxy keeps a **ledger** — a small JSON file listing only
the session IDs *it* created:

- On every new session, the proxy records its ID in the ledger.
- The sweep only ever considers IDs **in the ledger**. A session the proxy never
  created (i.e. a Copilot CLI session) is never a deletion candidate — it is
  structurally impossible for the GC to remove it.
- IDs are pruned from the ledger once their session is deleted or is found to be
  already gone, so the ledger does not grow without bound.

The ledger is stored on disk (default `~/.copilot/proxy-session-ledger.json`,
override with `COPILOT_PROXY_SESSION_LEDGER`) so the proxy still knows which
sessions are its own **after a restart**.

> **Migration note:** the ledger only contains sessions created *after* you
> upgrade to this version. Sessions created by older proxy builds (or any
> existing backlog) are not in the ledger and will therefore **not** be
> auto-collected — this is intentional, to guarantee no shared CLI session is
> ever deleted. Clean up any pre-existing backlog manually if desired.

## Supported Models

The list of available models is fetched dynamically from the Copilot SDK
using `client.listModels()`. The results are cached for 5 minutes. Call
`GET /v1/models` to see the currently available models.

Each model object also reports the model's token limits, sourced from the SDK's
capability metadata. Because the OpenAI `/v1/models` schema has no standard
context-window field, the same context-window value is published under several
keys that different clients read (`context_window`, `context_length`,
`max_context_window_tokens`), alongside `max_input_tokens` and
`max_output_tokens`. Clients can use these to display context-window usage
(e.g. "% of context used"). Note this is the model's full advertised context
window; GitHub Copilot may serve requests under tiered prompt budgets below it.

## Example: Using with curl

```bash
# Non-streaming
curl http://localhost:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.2",
    "messages": [{"role": "user", "content": "Say hello!"}]
  }'

# Streaming
curl http://localhost:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.2",
    "messages": [{"role": "user", "content": "Tell me a short story"}],
    "stream": true
  }'
```

## Example: Using with OpenAI Python Client

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3001/v1",
    api_key="not-needed"  # Any value works
)

response = client.chat.completions.create(
    model="gpt-5.2",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

## License

MIT
