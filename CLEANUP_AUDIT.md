# Mako IQ Cleanup Audit

## Summary

This pass kept the active Mako IQ extension/backend/companion architecture intact and focused on low-risk cleanup, response normalization, and stale-overlay reliability.

The active source of truth is:

- Extension: `src/canvy/**`, `public/manifest.json`, root Vite HTML entry points.
- Backend: `backend/src/**`.
- Companion app: `apps/companion/**`.

The historical `src/canvy` folder name, `CANVY_*` runtime messages, `canvy.*` storage keys, and some `canvy-*` CSS classes are intentionally preserved as internal compatibility names. User-facing copy should use Mako IQ.

## What Changed

- Removed legacy, build-excluded source trees:
  - `chrome-extension/**`
  - root `src/**` outside `src/canvy`
  - `backend/server.js`
  - `workspace.html`
  - obsolete `SCREENSHOT_SOLVER_SETUP.md`
- Removed unused active imports, helpers, and parameters found by stricter TypeScript checks.
- Wired `src/canvy/content/screenPageWatcher.ts` into the active content script so page changes clear stale answer context and notify the background worker.
- Normalized missing-confidence behavior in backend AI parsing:
  - structured page analysis
  - screen answer bubbles
  - Quiz Mode prefetch
- Preserved conservative behavior for empty answers, insufficient context, restricted/proctored assessment contexts, malformed AI JSON, and stale page signatures.
- Updated user-facing workflow copy from Canvy to Mako IQ where safe.
- Updated README source-of-truth notes and active structure.

## Files Simplified

- `src/canvy/content/main.tsx`
- `src/canvy/content/screenBubbles.ts`
- `src/canvy/background/main.ts`
- `src/canvy/services/api.ts`
- `src/canvy/shared/storage.ts`
- `src/canvy/shared/types.ts`
- `src/canvy/shared/workflow/*`
- `backend/src/services/model.ts`
- `backend/src/services/screen-analysis.ts`
- `backend/src/services/quiz-analysis.ts`
- `backend/src/routes/screen.ts`
- `README.md`

## Functionality Preserved

- Extension popup and `Analyze Screen` flow.
- Chrome side panel workspace flow.
- Content-script page and screen context extraction.
- Transparent/glass answer bubbles.
- Bubble close, copy, rescan, drag, expand, and follow-up behavior.
- Thinking/status bubble behavior.
- Page-change cleanup behavior, now active in the content bridge.
- Backend API connection and health routes.
- Kimi/Moonshot backend integration.
- Optional Ollama health/config paths.
- Production extension, backend, and companion build process.

## Dead Code Removed

The removed legacy files were not part of the active Vite inputs, TypeScript include set, backend package scripts, Render config, or current manifest flow. The active extension now builds from `src/canvy` only.

## Known Risks

- `src/canvy/background/main.ts` remains large and should not be split aggressively without a dedicated test plan for MV3 message flow.
- Internal Canvy names remain in runtime messages/storage/CSS for compatibility. Renaming them would risk corrupting persisted settings and breaking content/background messaging.
- Manual browser verification depends on having Chrome/Brave/Edge available locally and a backend API key for live AI calls.
- The repository had extensive pre-existing uncommitted changes before this cleanup. This pass worked with that state rather than reverting it.

## Local Setup

Install dependencies:

```bash
npm install
npm --prefix backend install
npm --prefix apps/companion install
```

Start the backend:

```bash
npm run dev:backend
```

Start the companion app:

```bash
npm run dev:companion
```

Build everything:

```bash
npm run build
```

Build only the extension:

```bash
npm run build:extension
```

Load the extension from the built `dist` folder in `chrome://extensions`.

## Required Environment Variables

For local Kimi/Moonshot-backed analysis:

- `MOONSHOT_API_KEY`
- `AI_PROVIDER=kimi`
- `KIMI_BASE_URL=https://api.moonshot.ai/v1`
- `KIMI_MODEL=kimi-k2.6`

For production Render deployment:

- `MOONSHOT_API_KEY`
- `JWT_SECRET`
- `ALLOWED_EXTENSION_ORIGINS`
- `ALLOW_ANONYMOUS_USAGE=true` unless authenticated usage is required

Optional:

- `VITE_MAKOIQ_API_BASE_URL`
- `VITE_CANVY_API_BASE_URL` for legacy build compatibility
- `OLLAMA_BASE_URL`
- `OLLAMA_MODEL`
- `OLLAMA_VISION_MODEL`

No `.env` files or secrets should be committed.

## Verification

Baseline before cleanup:

- `npm run build` passed.

After cleanup:

- `npm install` passed. Root install reported 3 moderate audit findings.
- `npm --prefix backend install` passed with 0 vulnerabilities.
- `npm --prefix apps/companion install` passed. Companion install reported 1 high audit finding.
- `npx tsc --noEmit --noUnusedLocals --noUnusedParameters --pretty false` passed.
- `npx tsc -p backend/tsconfig.json --noUnusedLocals --noUnusedParameters --pretty false` passed.
- `npm run build` passed.
- `npm run local:doctor` passed.
- `Invoke-RestMethod http://127.0.0.1:8787/health` returned `ok: true`.
- `npm run smoke:quiz-mode` passed.
- `npm run smoke:extension` passed in Brave against `https://example.com/`.

Manual/local checks to run with browser and backend available:

- Extension loads from `dist`.
- Popup opens from the toolbar.
- `Analyze Screen` sends page context to backend.
- Backend `/health` responds.
- Backend `/api/screen/analyze` returns structured output.
- Answer bubbles render and can be closed.
- Repeated scans replace old bubbles.
- Page changes clear stale answer bubbles.
- Follow-up requests call `/api/screen/follow-up`.

## Git Info

Planned commit message:

```text
Refactor and stabilize Mako IQ extension codebase
```

Push target: current branch.
