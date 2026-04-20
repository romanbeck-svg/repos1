# Deploy Backend To Render

This repo is prepared for GitHub-backed Render deployment.

What is now in the repo:
- A local Git-ready layout with `main` as the intended default branch and `staging` as the optional staging branch.
- A `render.yaml` Blueprint that can create both `mako-iq-backend` and `mako-iq-backend-staging`.
- A stable extension `key` in `public/manifest.json`, derived from the existing local extension signing key.
- A non-active GitHub Actions example at `.github/examples/render-deploy-hook.yml` for deploy-hook workflows if you later disable native Render auto-deploys.

## What Render Should Deploy

- GitHub repo: the repo that contains this project root
- Main branch: `main`
- Optional staging branch: `staging`
- Root Directory: `backend`
- Runtime: `Node`
- Build Command: `npm ci && npm run build`
- Start Command: `npm run start`
- Health Check Path: `/health`
- Auto-Deploy: `Yes`

Do not point Render at the repo root unless you intentionally change the service layout later. The deployable backend package lives in `backend/`.

## Default Deployment Path

Default path:
- Use native Render auto-deploy from the linked GitHub branch.
- Use `main` for production-like testing.
- Use `staging` only if you want a separate staging service.

If you want Render to create both services from code, use the repo's `render.yaml`.

If you prefer the dashboard flow:
- create one web service for `main` first,
- confirm it works,
- then optionally add a second service pointed at `staging`.

## Required Render Environment Variables

Set these for the backend web service if you use the Render dashboard flow manually:

```text
NODE_ENV=production
HOST=0.0.0.0
JWT_SECRET=YOUR_LONG_RANDOM_SECRET
MOONSHOT_API_KEY=YOUR_MOONSHOT_KEY
ALLOWED_ORIGINS=http://localhost:5173
ALLOWED_EXTENSION_ORIGINS=chrome-extension://YOUR_EXTENSION_ID
ALLOW_ALL_EXTENSION_ORIGINS=false
ALLOW_ANONYMOUS_USAGE=true
```

Notes:
- Do not set `PORT`. Render injects it automatically.
- `ALLOWED_EXTENSION_ORIGINS` must be the exact unpacked or packaged extension origin you are testing with.
- The active popup scan flow depends on `MOONSHOT_API_KEY`. Without it, `/api/analyze` will not work.
- If you use `render.yaml`, Render can generate `JWT_SECRET` for you automatically.

## Recommended Post-Deploy Environment Variables

These are not required for the backend to boot, but you should set them once you know the final service URL:

```text
APP_URL=https://YOUR-RENDER-SERVICE.onrender.com
AUTH_MAGIC_LINK_REDIRECT_URL=https://YOUR-RENDER-SERVICE.onrender.com/auth/callback
```

## Optional Environment Variables

Only add these if you use the related features:

```text
MOONSHOT_MODEL=
MOONSHOT_QUICK_MODEL=
MOONSHOT_REASONING_MODEL=
MOONSHOT_VISION_MODEL=
MOONSHOT_BASE_URL=
AI_PROVIDER=
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=
OPENAI_API_KEY=
OPENAI_MODEL=
CANVAS_API_BASE_URL=
CANVAS_API_TOKEN=
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_JWT_SECRET=
AUTH_MAGIC_LINK_REDIRECT_URL=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_MONTHLY_PRICE_ID=
STRIPE_PORTAL_RETURN_URL=
```

For basic hosted extension testing, the core requirement is the first block plus `MOONSHOT_API_KEY`.

## Stable Extension ID

The active manifest now includes a fixed `key`, so the unpacked extension ID stays stable across machines and Chrome profiles.

How it was chosen:
- The manifest key was derived from the existing local `dist.pem` signing key.
- `dist.pem` remains local-only and is ignored by Git.

Important consequence:
- This gives you a stable development ID for `chrome-extension://...` allowlisting.
- If you later publish in the Chrome Web Store and want the exact same ID, replace the manifest `key` with the public key from the Chrome Developer Dashboard package page, per Chrome's manifest `key` docs.

## Extension Backend URL

There are two supported places to point the extension at the hosted backend:

1. Build-time default:
   - Root file: `.env`
   - Key: `VITE_MAKOIQ_API_BASE_URL`
   - Example: `VITE_MAKOIQ_API_BASE_URL=https://YOUR-RENDER-SERVICE.onrender.com`

2. Runtime override:
   - Extension page: `Options`
   - Field: `API base URL`
   - Value: `https://YOUR-RENDER-SERVICE.onrender.com`

The runtime override wins if both are set.

The central resolver for this lives in `src/canvy/shared/config.ts`.

## Allowed Extension Origins

Backend config key:
- `ALLOWED_EXTENSION_ORIGINS`

Expected format:

```text
ALLOWED_EXTENSION_ORIGINS=chrome-extension://YOUR_EXTENSION_ID
```

To get the extension ID:
1. Build and load the unpacked extension.
2. Open `chrome://extensions`.
3. Copy the Mako IQ extension ID.
4. Use `chrome-extension://<ID>` as the backend allowlist value.

## Verify The Deploy

After the Render deploy finishes, open:

```text
https://YOUR-RENDER-SERVICE.onrender.com/health
```

Expected checks:
- `ok` is `true`
- `environment` is `production`
- `analysisConfigured` is `true`
- `jwtSecretConfigured` is `true`
- `extensionOriginsConfigured` is `true`

## Manual Steps You Still Need To Do

### GitHub

1. Authenticate GitHub CLI if needed with `gh auth login`.
2. Create the repo or point this local repo at an existing GitHub repo.
3. Push `main`.
4. Push `staging` if you want the optional staging service.

Important:
- This workspace may begin as a plain folder copy. Until it exists as a real GitHub repo/branch, Render cannot link to it.

### Render

Option A: Blueprint
1. In Render, create a Blueprint from the repo's `render.yaml`.
2. Provide `MOONSHOT_API_KEY` and `ALLOWED_EXTENSION_ORIGINS` for each service when prompted.
3. Let Render create `mako-iq-backend` from `main` and optionally `mako-iq-backend-staging` from `staging`.

Option B: Dashboard web service
1. Create or update a Web Service connected to the correct GitHub repo.
2. Use branch `main`.
3. Set `Root Directory` to `backend`.
4. Set the Build and Start commands exactly as shown above.
5. Add the required environment variables.
6. Save and deploy.
7. Confirm `/health` returns the expected JSON.
8. If you want staging, create a second service from branch `staging`.

### Chrome Extension

1. Paste the final Render backend origin into either `.env` as `VITE_MAKOIQ_API_BASE_URL` or the extension `Options` page `API base URL` field.
2. If you changed the root `.env`, rebuild the extension with `npm run build`.
3. Reload the unpacked extension in `chrome://extensions`.
4. Test the extension against the hosted backend.

## Common Failure Points

- Wrong Root Directory:
  Render points at the repo root instead of `backend`, so it uses the wrong `package.json`.

- Missing environment variables:
  Production startup now fails fast if `JWT_SECRET`, `MOONSHOT_API_KEY`, or extension CORS origins are not configured.

- Missing start script:
  Use `npm run start`, not `node server.js` and not the repo root package.

- Missing staging branch:
  `render.yaml` points the optional staging service at `staging`, so you need that branch on GitHub before the staging service can sync.

- Extension still using localhost:
  The built extension still resolves `http://localhost:8787`, or a saved runtime override still points to localhost.

- Host permissions confusion:
  The active manifest is `public/manifest.json`. It already has the page-level permissions needed for the extension build.

- CORS failure:
  `ALLOWED_EXTENSION_ORIGINS` does not match the real `chrome-extension://<EXTENSION_ID>` origin you loaded in Chrome.

## Optional: Controlled Deploys With A Render Deploy Hook

Use this only if you later turn off native auto-deploys from the GitHub branch or want a manual trigger after checks.

The repo includes a non-active template here:

```text
.github/examples/render-deploy-hook.yml
```

To use it:
1. Create a Render deploy hook for the service.
2. Copy that template into `.github/workflows/render-deploy-hook.yml`.
3. Store the hook as `RENDER_DEPLOY_HOOK_URL`.
4. Trigger it manually with `workflow_dispatch`, or edit the triggers yourself if you intentionally want a gated deploy path.

For the default setup, keep Render auto-deploy enabled on `main` and skip deploy hooks.
