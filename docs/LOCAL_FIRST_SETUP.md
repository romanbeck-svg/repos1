# Mako IQ Local-First Setup

Mako IQ now runs as a local-first stack:

```text
Chrome extension
  -> Mako IQ Companion for Windows
  -> local backend at http://127.0.0.1:8787
  -> Kimi/Moonshot API
  -> popup / side panel / overlay response
```

Render is optional. Ollama is optional. The Chrome extension does not store `MOONSHOT_API_KEY` and never calls Kimi, Moonshot, Ollama, or any other AI provider directly.

## Defaults

- Extension API base URL: `http://127.0.0.1:8787`
- Backend bind: `HOST=127.0.0.1`, `PORT=8787`
- AI provider: `AI_PROVIDER=kimi`
- Kimi base URL: `https://api.moonshot.ai/v1`
- Kimi model: `kimi-k2.6`
- Secret location: `backend/.env` as `MOONSHOT_API_KEY`

## One-time setup

1. Install Node 20 or newer.
2. Install dependencies:

   ```bash
   npm install
   npm --prefix backend install
   npm --prefix apps/companion install
   ```

3. Confirm `backend/.env` contains `MOONSHOT_API_KEY`.
4. Build the backend and extension:

   ```bash
   npm run build:backend
   npm run build:extension
   ```

5. Load the unpacked extension from `dist/` in `chrome://extensions`.

## Companion app

Start the companion during development with:

```bash
npm run dev:companion
```

The companion starts the backend automatically, keeps running in the tray, restarts the backend if it crashes, shows Kimi/API-key/model status, can test Kimi through `/health/ai?test=true`, and keeps Ollama under an optional local provider section.

The tray menu includes backend controls, Kimi status, Test Kimi Connection, optional Ollama checks, logs, the local health check, launch-at-login, and quit.

## Health checks

Open:

```text
http://127.0.0.1:8787/health
```

Expected local fields include:

- `backendRunning: true`
- `host: "127.0.0.1"`
- `port: 8787`
- `aiProvider: "kimi"`
- `kimiConfigured: true`
- `kimiBaseUrl: "https://api.moonshot.ai/v1"`
- `kimiModel: "kimi-k2.6"`
- `moonshotApiKeyLoaded: true`
- `ollamaEnabled: false`
- `aiConfigured: true`

Kimi-specific status is available at:

```text
http://127.0.0.1:8787/health/ai
```

To make a tiny live Kimi request:

```text
http://127.0.0.1:8787/health/ai?test=true
```

Ollama-specific status remains available only for the optional local model provider:

```text
http://127.0.0.1:8787/health/ollama
```

## Troubleshooting

Backend not running:

- Open Mako IQ Companion.
- Click `Start Backend`.
- Open `http://127.0.0.1:8787/health`.

Extension cannot reach local backend:

- The extension should show: `Mako IQ Local Server is not running. Open Mako IQ Companion and try again.`
- Confirm the extension API base URL is `http://127.0.0.1:8787` in Options.

Missing API key:

- Add `MOONSHOT_API_KEY` to `backend/.env`.
- Restart the backend from Mako IQ Companion.
- Check `http://127.0.0.1:8787/health/ai`.

Invalid API key:

- `/health/ai?test=true` returns: `Kimi rejected the API key. Check MOONSHOT_API_KEY in backend/.env.`

Kimi request failure:

- `/health/ai?test=true` returns: `Kimi API request failed. Check internet connection, API key, billing, or model name.`

CORS or extension ID mismatch:

- Set `ALLOWED_EXTENSION_ORIGINS=chrome-extension://<your-extension-id>`.
- Keep `ALLOW_ALL_EXTENSION_ORIGINS=false` for normal local packaged use.

Switching to Ollama later:

```text
AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=<installed-model>
```

Only then should Companion Ollama errors be treated as blocking.

## Packaging the companion

Build and package:

```bash
npm run build:backend
npm run package:companion
```

The companion package includes the built backend and backend dependencies as Electron extra resources. The installed companion can launch at Windows login and start the backend without a terminal.

## Doctor command

Run:

```bash
npm run local:doctor
```

It checks Node, backend health, Kimi configuration, the backend API key status, and the extension local URL default.
