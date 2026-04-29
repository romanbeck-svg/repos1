# Mako IQ Direction Shift Plan

Date: 2026-04-25

## Product Decision

Mako IQ is moving away from Canvas-first workflows. The primary product is now a screen-aware assistant:

Popup trigger -> visible-tab screenshot -> backend vision analysis -> structured question answers -> content-script answer bubbles anchored near detected screen regions.

Canvas can remain as a future optional context source, but it must not be the main user experience, main CTA, or main data dependency.

## Research Notes

Official Chrome extension APIs used by the new architecture:

- `chrome.tabs.captureVisibleTab`: captures the visible area of the active tab in a window and requires `activeTab` or `<all_urls>`. Docs: https://developer.chrome.com/docs/extensions/reference/tabs#method-captureVisibleTab
- Runtime messaging: extension pages, service workers, and content scripts exchange JSON-serializable messages through `chrome.runtime.sendMessage` and `chrome.runtime.onMessage`. Docs: https://developer.chrome.com/docs/extensions/develop/concepts/messaging
- `chrome.tabs.sendMessage`: service worker sends render commands to the content script in the target tab. Docs: https://developer.chrome.com/docs/extensions/reference/tabs#method-sendMessage
- Content scripts: content scripts are the right surface for page DOM overlays and can be declared in the manifest or injected programmatically. Docs: https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
- `chrome.scripting.executeScript`: used as a recovery path when the manifest content script is not awake. Docs: https://developer.chrome.com/docs/extensions/reference/api/scripting
- `chrome.storage.local`: stores user-adjusted bubble positions and UI preferences. Docs: https://developer.chrome.com/docs/extensions/reference/api/storage

## A. Canvas-Specific Logic Located

Backend:

- [backend/src/app.ts](../backend/src/app.ts): registers `/api/v1/canvas`.
- [backend/src/routes/canvas.ts](../backend/src/routes/canvas.ts): Canvas API context route.
- [backend/src/services/canvas.ts](../backend/src/services/canvas.ts): Canvas API calls for user, course, and upcoming events.
- [backend/src/config/env.ts](../backend/src/config/env.ts): `CANVAS_API_BASE_URL`, `CANVAS_API_TOKEN`, `canvasConfigured`.
- [backend/src/types/api.ts](../backend/src/types/api.ts): `CanvasContext`, `CanvasApiSummary`, upcoming assignment types.
- [backend/src/services/safety.ts](../backend/src/services/safety.ts): Canvas context/request sanitizers.
- [backend/src/ai/prompts.ts](../backend/src/ai/prompts.ts): old Canvas LMS guardrail copy, now generalized.
- [backend/src/ai/provider.ts](../backend/src/ai/provider.ts): mock task output had Canvas-specific fallback language, now generalized.

Extension:

- [src/canvy/content/canvas.ts](../src/canvy/content/canvas.ts): Canvas DOM extraction.
- [src/canvy/canvas/extractCanvasMetadata.ts](../src/canvy/canvas/extractCanvasMetadata.ts): Canvas metadata helpers.
- [src/canvy/shared/lms.ts](../src/canvy/shared/lms.ts): Canvas URL detection and mode labels.
- [src/canvy/background/main.ts](../src/canvy/background/main.ts): Canvas context extraction, Canvas API summary fetch, Canvas-aware workflow routing.
- [src/canvy/background/mockAssignments.ts](../src/canvy/background/mockAssignments.ts): legacy assignment fallback data.
- [src/canvy/classification/*](../src/canvy/classification/classifyTaskType.ts): assignment/course/quiz classification signals.
- [src/canvy/shared/workflow/*](../src/canvy/shared/workflow/buildWorkflowState.ts): assignment/discussion/quiz workflow cards.
- [src/canvy/shared/types.ts](../src/canvy/shared/types.ts): Canvas, assignment, course, quiz, due-date, and workflow types.
- [src/canvy/sidepanel/App.tsx](../src/canvy/sidepanel/App.tsx): previously surfaced Canvas targets when assignment data existed; now hidden from the primary UI.

Docs/static:

- [README.md](../README.md): still describes Canvas-enhanced mode and should be revised in a later docs cleanup.
- [SCREENSHOT_SOLVER_SETUP.md](../SCREENSHOT_SOLVER_SETUP.md): older screenshot setup notes, now superseded by this plan and the screen bubble architecture docs.

## B. Classification

Remove now:

- Popup Canvas/page-first launcher flow. Replaced with "Analyze Screen" as the primary CTA.
- User-facing Canvas-first copy in launcher, workspace status labels, manifest description, backend prompt defaults, and mock provider copy.
- Canvas targets panel as a visible workspace rail. It is hidden behind `showLegacyCanvasTargets = false`.

Keep but make generic:

- Existing `/api/analyze` page-question endpoint, because it still supports generic page context and can back workspace history.
- Content script messaging/injection, because it is needed for the new bubble renderer.
- Shared UI components and Mako IQ styling.
- Side panel/workspace as an optional deeper surface for history, notes, follow-up chat, and settings.
- Storage helpers and extension state.

Archive behind future feature flag:

- `/api/v1/canvas`, `backend/src/services/canvas.ts`, Canvas API env vars.
- Canvas DOM extraction modules.
- Canvas assignment mock data.
- Canvas-specific classification/workflow branches.
- Canvas API summary fetch inside the background bootstrap flow.

Leave untouched because not actually Canvas-first:

- Build system and Vite entry points.
- Auth/API-base configuration.
- Kimi/Moonshot integration.
- Chrome side panel registration.
- Generic page extraction and scan helpers.
- Existing result cards and workspace components used for optional history.

## C. Architecture Preserved

Preserved:

- Express backend structure and middleware.
- Kimi/Moonshot model integration.
- Popup, content script, side panel, options page.
- Background/service worker as the coordinator.
- Manifest permissions: `activeTab`, `tabs`, `scripting`, `storage`, `sidePanel`.
- `chrome.storage.local` state helpers and shared runtime messaging helpers.
- Existing build scripts: `npm run typecheck`, `npm run build`, backend `npm run build`.

## D. New Architecture Needed

Implemented target flow:

1. Popup sends `CAPTURE_VISIBLE_SCREEN`.
2. Background resolves the real active browser tab, not the extension popup window.
3. Background ensures the content script is attached with manifest injection or `chrome.scripting.executeScript`.
4. Background asks the content script for viewport dimensions.
5. Background calls `chrome.tabs.captureVisibleTab(windowId, { format: "png" })`.
6. Background posts the screenshot data URL to `POST /api/screen/analyze`.
7. Backend sends the image to the vision model with the strict screen-analysis prompt.
8. Backend returns structured JSON with `summary`, `items`, `bbox`, `confidence`, and `warnings`.
9. Background sends `RENDER_ANSWER_BUBBLES` to the content script.
10. Content script renders fixed-position transparent answer bubbles in a Shadow DOM root named `mako-iq-overlay-root`.
11. Bubble follow-up form sends `ASK_BUBBLE_FOLLOWUP` to background.
12. Background calls `POST /api/screen/follow-up` and returns the answer to the same bubble.

New action names:

- `CAPTURE_VISIBLE_SCREEN`
- `ANALYZE_SCREENSHOT_REQUEST`
- `RENDER_ANSWER_BUBBLES`
- `CLEAR_ANSWER_BUBBLES`
- `ASK_BUBBLE_FOLLOWUP`
- `SCREEN_GET_VIEWPORT`

## E. Chrome APIs Needed

- `chrome.tabs.captureVisibleTab`: screenshot capture for the visible viewport.
- `chrome.runtime.sendMessage` and `chrome.runtime.onMessage`: popup/content-to-background commands.
- `chrome.tabs.sendMessage`: background-to-content render commands.
- Content scripts: render overlays because they can access the page DOM and viewport.
- `chrome.scripting.executeScript`: wake/inject content script when needed.
- `chrome.storage.local`: persist bubble positions and UI settings.

## Files Changed In This Pass

- [backend/src/app.ts](../backend/src/app.ts)
- [backend/src/routes/screen.ts](../backend/src/routes/screen.ts)
- [backend/src/services/screen-analysis.ts](../backend/src/services/screen-analysis.ts)
- [backend/src/types/screen.ts](../backend/src/types/screen.ts)
- [backend/src/ai/prompts.ts](../backend/src/ai/prompts.ts)
- [backend/src/ai/provider.ts](../backend/src/ai/provider.ts)
- [backend/src/services/safety.ts](../backend/src/services/safety.ts)
- [src/canvy/popup/App.tsx](../src/canvy/popup/App.tsx)
- [src/canvy/background/main.ts](../src/canvy/background/main.ts)
- [src/canvy/content/main.tsx](../src/canvy/content/main.tsx)
- [src/canvy/content/screenBubbles.ts](../src/canvy/content/screenBubbles.ts)
- [src/canvy/services/api.ts](../src/canvy/services/api.ts)
- [src/canvy/shared/types.ts](../src/canvy/shared/types.ts)
- [src/canvy/shared/constants.ts](../src/canvy/shared/constants.ts)
- [src/canvy/shared/lms.ts](../src/canvy/shared/lms.ts)
- [src/canvy/sidepanel/App.tsx](../src/canvy/sidepanel/App.tsx)
- [public/manifest.json](../public/manifest.json)

## Guardrails

- The overlay is normal visible extension UI. It is not stealth, hidden from screen share, or anti-proctoring behavior.
- Restricted/proctored environments return no direct answers and show: "Mako IQ can help explain concepts or create study notes, but it will not provide live answers for restricted assessments."
- The product framing is learning, explanation, productivity, page help, and study notes.
