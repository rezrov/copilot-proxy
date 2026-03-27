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
| `-v, --verbose` | | Enable verbose log output |
| `-h, --help` | | Display help for command |
| `-V, --version` | | Output the version number |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `COPILOT_CLI_PATH` | (system PATH) | Custom path to Copilot CLI executable |

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
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
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

## Supported Models

The list of available models is fetched dynamically from the Copilot SDK
using `client.listModels()`. The results are cached for 5 minutes. Call
`GET /v1/models` to see the currently available models.

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

ISC
