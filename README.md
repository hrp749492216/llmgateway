# LLM Gateway

A lightweight, browser-based interface for sending prompts to multiple LLM APIs with real-time streaming. No frameworks, no build step — just deploy and go.

**Live:** [llmgateway-one.vercel.app](https://llmgateway-one.vercel.app)

## Supported Providers

| Provider | Models |
|----------|--------|
| **OpenAI** | GPT-5.4, GPT-5, GPT-4.1, GPT-4o, o3, o4-mini, and variants |
| **Claude (Anthropic)** | Opus 4.6, Sonnet 4.6, Opus 4.5, Sonnet 4.5, Haiku 4.5 |
| **Gemini (Google)** | Gemini 3.1 Pro, Gemini 3 Flash, Gemini 2.5 Pro/Flash, Gemini 2.0 Flash |
| **OpenRouter** | Any model — enter the model ID manually or browse the model directory |

## Features

- **Multi-provider support** — Switch between OpenAI, Claude, Gemini, and OpenRouter from a single UI
- **Real-time streaming** — Responses stream token-by-token via Server-Sent Events
- **Prompt templates** — Upload `.txt`, `.md`, `.pdf`, or `.docx` files as system prompts
- **File attachments** — Attach documents (extracted as text) and images (sent to vision models)
- **Markdown rendering** — Responses render with full Markdown support (code blocks, tables, lists)
- **Advanced controls** — Temperature, Top P, max output tokens, and output format (JSON, Markdown, plain text)
- **Session-only API keys** — Keys are stored in `sessionStorage` and cleared when the browser closes
- **No backend state** — The Edge Function is a stateless proxy; nothing is stored server-side

## Tech Stack

- **Frontend:** Vanilla HTML/CSS/JavaScript
- **Backend:** Vercel Edge Function (single `api/chat.js` handler)
- **Libraries:** [marked.js](https://github.com/markedjs/marked) (Markdown), [pdf.js](https://github.com/nicbarker/pdf.js) (PDF parsing), [mammoth.js](https://github.com/mwilliamson/mammoth.js) (DOCX parsing)

## Deploy Your Own

1. Fork this repository
2. Import into [Vercel](https://vercel.com/new)
3. Deploy — no environment variables or build configuration needed

Or deploy from the CLI:

```bash
npx vercel --prod
```

## Local Development

```bash
npx vercel dev
```

Opens at `http://localhost:3000`. The Edge Function at `/api/chat` proxies requests to each provider's API.

## Project Structure

```
├── api/
│   └── chat.js          # Edge Function — routes requests to LLM providers
├── public/
│   ├── index.html       # UI
│   ├── app.js           # Frontend logic (model selection, streaming, file parsing)
│   └── style.css        # Styles
├── vercel.json          # Vercel routing config
└── package.json
```

## How It Works

1. You select a provider, pick a model, and enter your API key
2. The frontend sends your prompt (with any templates/attachments) to `/api/chat`
3. The Edge Function transforms the request into the provider's native format and streams the response back
4. The frontend renders the streamed tokens in real time

Your API key is sent per-request and never stored on the server.

## License

MIT
