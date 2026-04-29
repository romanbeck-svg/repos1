# Mako IQ Extension Shell

Mako IQ is a **screen-aware Chrome extension** that analyzes the visible tab screenshot and places transparent answer bubbles near detected questions or tasks.

This revision keeps the product local-first for normal use:

- popup-first `Analyze Screen` launcher flow from the toolbar
- screenshot capture through the MV3 background service worker
- backend analysis through the local Mako IQ Companion app
- Kimi/Moonshot as the default AI provider through the local backend
- transparent content-script answer bubbles anchored to detected question regions
- optional Chrome side panel workspace for history, notes, follow-up chat, and settings
- Ollama as an optional local model provider only when explicitly configured

It does **not** include stealth, proctoring bypass, hidden screen-share behavior, or restricted-assessment answer tooling.

Render is no longer required for normal use. See `docs/LOCAL_FIRST_SETUP.md`.

## Active source of truth

- Active extension source is `src/canvy/**` and `public/manifest.json`.
- Active backend source is `backend/src/**`.
- Active companion source is `apps/companion/**`.
- `dist/**` is build output only (do not edit manually).
- The historical `src/canvy` path and `CANVY_*` message/storage names remain as internal compatibility names. User-facing copy should use Mako IQ.

## Updated folder structure

```text
public/
  manifest.json
  icons/

src/canvy/
  background/
    main.ts                MV3 service worker, screenshot capture, side panel orchestration
    mockAssignments.ts     Legacy local fallback assignment feed
  content/
    main.tsx               Content-script bridge for page extraction and bubble rendering
    assistantPanel.ts      In-page assistant panel shell
    overlayUi.ts           Shared overlay DOM/button helpers
    screenBubbles.ts       Transparent answer bubbles for screenshot analysis
    screenContext.ts       Compact DOM/screen context extractor
    screenPageWatcher.ts   Clears stale answer context after navigation or page changes
    pageContext.ts         Universal page context extraction
    canvas.ts              Canvas-specific enhancer layer
    sidebar.css            Shared Mako IQ workspace styling
    quiz/                  Quiz Mode extraction, hashing, and screenshot fallback helpers
    overlay/               Workflow output overlay
    components/
      ActionTiles.tsx
      Composer.tsx
      ContextSnapshot.tsx
  sidepanel/
    App.tsx                Real Chrome side panel UI
    main.tsx
    panel.css              Side-panel layout overrides
    components/
      PanelTabs.tsx        Top-level workspace tabs
  popup/
    App.tsx                Screen assistant launcher
    main.tsx
  options/
    App.tsx                Local shell configuration page
    main.tsx
  shared/
    app.css                Shared visual tokens
    answerFormat.ts        Frontend answer/confidence normalization
    config.ts              Local config helpers
    constants.ts           Default settings/session state
    analysis.ts            Rule-based page analysis helper
    lms.ts                 Page detection + launch support logic
    runtime.ts             Runtime message helpers
    storage.ts             chrome.storage wrapper
    quizTypes.ts           Quiz Mode frontend/backend contracts
    types.ts               Shared extension contracts

backend/src/
  app.ts                   Express app and route mounting
  server.ts                Backend entry point
  routes/                  Health, analyze, screen, quiz, task, auth, and export routes
  services/                AI normalization, screen analysis, quiz analysis, safety, and usage
  ai/                      Kimi/Moonshot and Ollama provider helpers
  config/env.ts            Environment loading and startup validation

apps/companion/
  src/main.js              Electron tray app and backend process manager
  src/preload.js           Safe renderer IPC bridge
  src/renderer/            Status window UI
```

## Local desktop architecture

```text
Chrome extension
  -> Mako IQ Companion for Windows
  -> local backend at http://127.0.0.1:8787
  -> Kimi/Moonshot API at https://api.moonshot.ai/v1
```

The companion app manages the existing backend. It starts the backend at login, keeps a tray menu available, restarts the backend if it crashes, shows whether Kimi and `MOONSHOT_API_KEY` are configured, can test `/health/ai?test=true`, and exposes logs and diagnostics. The extension never calls Kimi, Moonshot, Ollama, or any other AI provider directly.

## How screen analysis works

On any normal `http` or `https` page, Mako IQ can:

- capture the visible tab screenshot
- send the screenshot to the backend vision route
- receive structured question/task answers with normalized coordinates
- render transparent answer bubbles near detected screen regions
- open the Chrome side panel as an optional workspace
- optionally enable Quiz Mode, which watches for visible question changes, clears stale bubbles, and prefetches study suggestions without clicking or submitting anything

This runs through `CAPTURE_VISIBLE_SCREEN` in the background service worker and `RENDER_ANSWER_BUBBLES` in the content script.

Quiz Mode is documented in `docs/QUIZ_MODE.md`.

## Legacy Canvas layer

Canvas-specific extraction and API code still exists as a legacy context layer, but it is not the primary product flow. Keep it behind future feature flags unless a later product decision reintroduces LMS integrations.

## Why the prior sidebar approach was unreliable

The previous implementation rendered the main workspace by injecting a React sidebar into the webpage itself. That made the product depend on:

- content-script attachment timing
- tab readiness and message passing
- page DOM availability
- page CSS/z-index conflicts
- successful shadow-root injection on every site

That path is still useful for future inline helpers, but it is not a reliable core container for the main assistant surface.

Mako IQ now uses content-script bubbles as the immediate answer surface and Chrome&apos;s real **Side Panel API** as an optional expanded workspace.

## Popup behavior

The popup now:

- opens first when the user clicks the extension icon
- is the primary user experience
- keeps the current screen context compact and concise
- uses `Analyze Screen` as the main action
- sends screenshot analysis to the backend
- renders results as page bubbles through the content script
- keeps settings and workspace links secondary

`Analyze Screen` sends `CAPTURE_VISIBLE_SCREEN` to the MV3 background worker. That flow captures the visible tab, starts the backend vision request, and sends the structured result to the content script for bubble rendering.

`Open Workspace` remains available as a secondary action from the launcher window and opens the side panel explicitly when the user wants the larger workspace.

The analysis flow now:

- target the active tab in the current window
- log popup clicks, active tab info, and analysis attempts
- detect unsupported/restricted pages clearly
- wait for the tab to finish loading
- ping the page first
- retry content-script injection only for page-context extraction
- keep the side panel independent from webpage DOM injection
- return clearer extraction and backend errors back to the popup and side panel

## Keyboard shortcut

The shortcut is defined in `public/manifest.json` under `commands.open-mako-iq`.

- Default shortcut: `Ctrl+Shift+Y`
- macOS suggestion: `Command+Shift+Y`

Chrome may let users customize extension shortcuts at:

`chrome://extensions/shortcuts`

The launcher window and side panel both display this shortcut help directly in the UI.

## Launcher window behavior

- Clicking the toolbar icon opens a single Mako IQ launcher window instead of Chrome's fixed action bubble
- The MV3 worker clears `action.default_popup` behavior with `chrome.action.setPopup({ popup: '' })`
- The MV3 worker handles `chrome.action.onClicked` and opens `launcher.html` with `chrome.windows.create({ type: 'popup' })`
- The launcher window is re-used instead of duplicated and its last bounds are stored in `chrome.storage.local`
- `Open Workspace` from the launcher uses `chrome.sidePanel.open({ windowId })` as an explicit user action

## Side panel behavior

- The main Mako IQ workspace loads from `sidepanel.html`
- `manifest.json` includes the `sidePanel` permission and `side_panel.default_path`
- clicking the toolbar icon does not auto-open the side panel
- the active MV3 worker keeps `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })` in place so the action icon cannot hijack into the side panel
- the launcher window opens the real workspace side panel directly with `chrome.sidePanel.open({ windowId })`, so workspace launch stays tied to an explicit launcher gesture instead of a follow-up worker message
- the keyboard shortcut now opens the launcher window through the service worker
- content scripts extract page metadata and render answer bubbles

This means the assistant workspace is no longer hidden or broken just because a page-level sidebar injection failed.

## Side panel tabs

The main workspace is optional and organized around:

- current screen/page summary and readiness state
- longer analysis history
- study notes and follow-up chat
- backend-backed helper controls
- settings, diagnostics, motion, and backend connection status

The side panel is a secondary workspace. The bubble overlay is the default answer surface.

## How screen analysis works

The screen-analysis flow is wired end to end:

1. the service worker resolves the active tab in the current window
2. it asks the content script for viewport dimensions
3. it captures the visible tab screenshot
4. it posts the image to `POST /api/screen/analyze`
5. the backend returns strict JSON with detected questions, answers, confidence, and normalized bboxes
6. the content script renders transparent answer bubbles near the detected regions

That means the primary result appears on the page, next to the screen content it explains.

## Setup

1. Install dependencies:

   ```bash
   npm install
   npm --prefix backend install
   npm --prefix apps/companion install
   ```

2. Confirm `backend/.env` has `AI_PROVIDER=kimi`, `KIMI_MODEL=kimi-k2.6`, and a backend-only `MOONSHOT_API_KEY`.

3. Build the extension and backend:

   ```bash
   npm run build:extension
   npm run build:backend
   ```

4. Start the desktop companion during development:

   ```bash
   npm run dev:companion
   ```

5. Run the local doctor when setup is unclear:

   ```bash
   npm run local:doctor
   ```

## API base URL resolution

Mako IQ resolves the backend origin in this order:

1. a user-saved API base URL from extension settings
2. `VITE_MAKOIQ_API_BASE_URL` or legacy `VITE_CANVY_API_BASE_URL` at build time
3. the local fallback `http://127.0.0.1:8787`

If a built extension points at the wrong backend, open the extension options and update **API base URL**. The background worker now logs the resolved source and stores recent request diagnostics in extension session state.

The central backend URL resolver lives in `src/canvy/shared/config.ts`. For local setup, use `docs/LOCAL_FIRST_SETUP.md`. For optional GitHub to Render deployment, use `DEPLOY_RENDER.md`.

The unpacked extension ID is now pinned through the `key` field in `public/manifest.json`, which keeps `chrome-extension://...` allowlists stable during development.

## Load the unpacked extension in Chrome

1. Open `chrome://extensions`
2. Turn on `Developer mode`
3. Click `Load unpacked`
4. Select the `dist` folder from this repo
5. Refresh the Mako IQ extension after future code changes
6. Reload the page you want to test

## Quick test flow

### General page

1. Open any normal website or article page
2. Click the Mako IQ extension icon
3. Confirm the popup opens
4. Click `Analyze Screen`
5. Confirm transparent answer bubbles appear near detected questions
6. Expand, drag, copy, hide, and ask a follow-up from a bubble

### Keyboard shortcut

1. Open a normal webpage
2. Press `Ctrl+Shift+Y`
3. Confirm Mako IQ opens from the launcher flow
4. If it does not, assign your own shortcut in `chrome://extensions/shortcuts`

### Unsupported page

1. Open a browser-internal page or the Chrome Web Store
2. Open Mako IQ from the popup
3. Confirm the side panel still opens
4. Confirm the panel explains that page-aware extraction is unavailable on that tab

## UI/UX improvements in this revision

- popup redesigned as a polished quick launcher and status center
- side panel upgraded into a tabbed workspace instead of a single shell
- clearer mode/status presentation across popup and side panel
- general and Canvas messaging now diverge cleanly
- side-panel entrance motion
- tab transitions and loading shimmer
- fade-up card motion
- pulsing status indicator
- cleaner spacing, rounded cards, and calmer visual hierarchy

## Future plug-in points

- additional AI providers can plug into the existing helper actions
- richer Canvas extraction can expand current assignment/context summaries
- scan-page fallback can extend the universal page context service
- optional inline helpers can still build on content scripts without owning the main UI
- more LMS platforms can be added beside the Canvas enhancer layer
