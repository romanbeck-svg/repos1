# Mako IQ Extension Shell

Mako IQ is a **page-aware Chrome extension shell** that works on any normal webpage and gets better on **Canvas** through an enhanced LMS-aware layer.

This revision keeps the product intentionally lightweight:

- popup-first launcher flow from the toolbar
- compact popup as the primary UX
- optional Chrome side panel workspace on all normal webpages
- Canvas-enhanced mode when LMS context is detected
- popup launcher with a single primary `Scan page` action
- keyboard shortcut to open the side panel
- backend-connected workflow generation with local fallback

It still does **not** include billing, downloads, or quiz overlays.

## Active source of truth

- Active extension source is `src/canvy/**` and `public/manifest.json`.
- Active backend source is `backend/src/**`.
- `dist/**` is build output only (do not edit manually).
- Legacy trees such as `src/**` (outside `src/canvy`) and `chrome-extension/**` are kept for reference and are not part of the active build.

## Updated folder structure

```text
public/
  manifest.json
  icons/

src/canvy/
  background/
    main.ts                MV3 service worker, side panel orchestration
    mockAssignments.ts     Legacy local fallback assignment feed
  content/
    main.tsx               Content-script bridge for page extraction only
    pageContext.ts         Universal page context extraction
    canvas.ts              Canvas-specific enhancer layer
    SidebarApp.tsx         Legacy injected-shell component (no longer primary)
    sidebar.css            Shared Mako IQ workspace styling
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
    App.tsx                Popup launcher and page status UI
    main.tsx
  options/
    App.tsx                Local shell configuration page
    main.tsx
  shared/
    app.css                Shared visual tokens
    config.ts              Local config helpers
    constants.ts           Default settings/session state
    analysis.ts            Rule-based page analysis helper
    lms.ts                 Page detection + launch support logic
    runtime.ts             Runtime message helpers
    storage.ts             chrome.storage wrapper
    types.ts               Shared extension contracts
```

## How universal mode vs Canvas-enhanced mode works

### Universal mode

On any normal `http` or `https` page, Mako IQ can:

- open the Chrome side panel
- read the page title
- read the page URL
- read a useful portion of visible page text
- show general assistant/help UI

This runs through `content/pageContext.ts`, which gives the extension a lightweight page summary.

### Canvas-enhanced mode

If the current page matches Canvas patterns, Mako IQ layers Canvas-specific behavior on top:

- Canvas-aware messaging
- Canvas context summary
- assignment cards from Canvas API context when available
- future-ready hook points for assignment-aware flows

This runs through `content/canvas.ts`, with backend Canvas context calls from the service worker.

Canvas is now an **enhancer**, not a gate.

## Why the prior sidebar approach was unreliable

The previous implementation rendered the main workspace by injecting a React sidebar into the webpage itself. That made the product depend on:

- content-script attachment timing
- tab readiness and message passing
- page DOM availability
- page CSS/z-index conflicts
- successful shadow-root injection on every site

That path is still useful for future inline helpers, but it is not a reliable core container for the main assistant surface.

Mako IQ now uses Chrome&apos;s real **Side Panel API** as an optional expanded workspace. Content scripts are only responsible for page detection and context extraction.

## Popup behavior

The popup now:

- opens first when the user clicks the extension icon
- is the primary user experience
- keeps the current page context compact and concise
- uses `Scan page` as the main action
- streams the answer into the popup while the request is running
- keeps settings and workspace links secondary

`Scan page` sends `CANVY_START_ANALYSIS_RUN` to the MV3 background worker. That flow gathers page context, starts the backend request, streams progress into session state, and keeps the launcher window updated through storage changes.

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
- content scripts only extract page metadata and Canvas context when a page supports it

This means the assistant workspace is no longer hidden or broken just because a page-level sidebar injection failed.

## Side panel tabs

The main workspace is now organized into five tabs:

- `Overview`: page summary, detected mode, readiness state, and quick actions
- `Analyze`: real extracted page context, refresh/analyze buttons, and a structured analysis result
- `Canvas`: Canvas-enhanced state, prompt preview, and assignment-aware context
- `Workspace`: message thread, workflow cards, and backend-backed helper controls
- `Settings`: debug toggle, motion toggle, backend connection status, shortcut help, and extension state details

The side panel is now optional secondary workspace. The launcher window is the default surface.

## How the Analyze tab works

The Analyze tab is now wired end to end:

1. the service worker resolves the active tab in the current window
2. it asks the content script for:
   - page title
   - URL
   - hostname
   - headings
   - a useful visible-text preview
3. if the page is Canvas, it also extracts Canvas-specific context
4. it runs a small rule-based analysis in `shared/analysis.ts`
5. it stores the result in session state
6. the side panel renders the extracted context and structured output

That means popup scans and workspace analysis both update the UI with real data from the active tab instead of only mocked status copy.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Build the extension:

   ```bash
   npm run build
   ```

## API base URL resolution

Mako IQ resolves the backend origin in this order:

1. a user-saved API base URL from extension settings
2. `VITE_MAKOIQ_API_BASE_URL` or legacy `VITE_CANVY_API_BASE_URL` at build time
3. the local fallback `http://localhost:8787`

If a built extension points at the wrong backend, open the extension options and update **API base URL**. The background worker now logs the resolved source and stores recent request diagnostics in extension session state.

The central backend URL resolver lives in `src/canvy/shared/config.ts`. For GitHub to Render deployment, use `DEPLOY_RENDER.md`.

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
4. Click `Scan page`
5. Confirm extracted title, URL, visible text, and a streamed short answer appear
6. Confirm the finished result stays concise and useful

### Canvas page

1. Open a Canvas course, assignment, or discussion page
2. Click the Mako IQ extension icon
3. Confirm the popup shows Canvas-aware context
4. Click `Scan page`
5. Confirm the popup returns a concise streamed answer
6. Open `Workspace` only if you want the larger Canvas-aware surface

### Keyboard shortcut

1. Open a normal webpage or Canvas page
2. Press `Ctrl+Shift+Y`
3. Confirm the real Chrome side panel opens without using the popup
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
