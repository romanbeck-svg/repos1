# Mako IQ Performance And Accuracy Repair

## Files Inspected

- `public/manifest.json`
- `launcher.html`, `sidepanel.html`, `vite.config.ts`, `vite.content.config.ts`
- `src/canvy/popup/App.tsx`
- `src/canvy/background/main.ts`
- `src/canvy/services/api.ts`
- `src/canvy/content/main.tsx`
- `src/canvy/content/assistantPanel.ts`
- `src/canvy/content/screenBubbles.ts`
- `src/canvy/content/pageContext.ts`
- `src/canvy/content/extraction.ts`
- `src/canvy/content/scan.ts`
- `src/canvy/content/overlay/overlayRoot.tsx`
- `src/canvy/content/overlay/CanvyOutputOverlay.tsx`
- `src/canvy/shared/app.css`
- `src/canvy/shared/components/ui.tsx`
- `src/canvy/sidepanel/App.tsx`
- `src/canvy/sidepanel/panel.css`
- `src/canvy/content/sidebar.css`
- `backend/src/routes/screen.ts`
- `backend/src/services/screen-analysis.ts`
- `backend/src/types/screen.ts`
- `backend/src/app.ts`
- `backend/src/config/env.ts`
- `backend/src/lib/logger.ts`

## Current Architecture

The screen-bubble workflow is:

1. Toolbar action opens the Workspace side panel by default.
2. Workspace can open the injected Floating Popup or send `CAPTURE_VISIBLE_SCREEN`.
3. Content assistant button sends `CAPTURE_VISIBLE_SCREEN`.
4. Background resolves the active page tab, ensures content script attachment, reads compact visible DOM context, and uses the fast DOM-context path when clear question candidates are available.
5. If DOM context is insufficient, background captures a compressed/resized screenshot with `chrome.tabs.captureVisibleTab`, calls `/api/screen/analyze`, then sends `RENDER_ANSWER_BUBBLES`.
6. Backend validates the request, sends screenshot or compact text context plus metadata to Kimi/Moonshot, parses JSON, normalizes items, and returns screen analysis.
7. Content script maps normalized bboxes into viewport-fixed answer bubbles and keeps the floating assistant panel separate.

## Root Causes Found

Response-time bottlenecks:

- Screenshot capture used PNG, producing large base64 payloads.
- The screenshot was sent at full viewport/device pixel size with no width cap.
- Repeated scans could stack because the background did not cancel or stale-check screen requests.
- Duplicate identical screenshots were always sent back to the AI.
- The backend used one retry after a model/schema failure, which can double perceived latency when parsing fails.
- No stage timings existed for capture, upload/backend, AI, parsing, or rendering.
- The request path always waited for screenshot capture even when compact visible DOM context already contained clear question candidates.

Accuracy bottlenecks:

- The screen prompt asked for visible questions but did not strongly separate question, answer choice, confidence, and insufficient-context behavior.
- Only page title/url/viewport were sent with the screenshot. Visible DOM text, selected text, headings, labels, and nearby answer choices were not included in screen analysis.
- The schema did not include `ok`, `answerChoice`, or `needsMoreContext`.
- Validation removed items with missing answers, but it did not dedupe, clamp low confidence into `needsMoreContext`, or return a safe empty response with useful warnings when schema repair failed.
- Bbox normalization clamped width/height but did not clamp x+width or y+height into the visible range.

Open Workspace failure cause:

- `public/manifest.json` has `side_panel.default_path` set to `sidepanel.html`, so registration is present.
- The popup button awaited `resolvePageWindowId()` and `chrome.sidePanel.setOptions()` before calling `chrome.sidePanel.open()`.
- Chrome requires `sidePanel.open()` from a user action. The awaited work can make the actual open call fall outside the gesture path.
- The floating assistant routes through content script to service worker. That path can also be rejected by Chrome as not being a side panel user gesture.
- Errors were shown generically and the assistant path treated any runtime response as success.
- The toolbar action was still configured around the old launcher popup instead of the Workspace side panel.

Theme inconsistency sources:

- `src/canvy/shared/app.css` had the black/cyan tokens, but many primary surfaces still used white/gray glass values.
- `src/canvy/sidepanel/panel.css` and `src/canvy/content/sidebar.css` duplicated older glass styles.
- Content shadow DOM CSS in `assistantPanel.ts` and `screenBubbles.ts` duplicated token values instead of importing one shared token string.
- Workflow overlay highlighting used white translucent gradients.

## Implementation Plan

- Add shared black/cyan token constants for content-script shadow DOM CSS and align React CSS tokens.
- Add compact visible-screen context extraction in the content script.
- Capture JPEG where possible, resize large screenshots with `OffscreenCanvas`, include image metadata, viewport, DPR, scroll, and compact context.
- Add debug-gated timing logs in the service worker and debug-level timing logs in the backend.
- Add stale request IDs, abort controllers, duplicate screenshot cache, and newest-result-only rendering.
- Replace the screen-analysis prompt/schema with strict problem-solving JSON including `ok`, `answerChoice`, and `needsMoreContext`.
- Validate and normalize backend output before sending it to the extension.
- Fix the popup `Open Workspace` button by calling `chrome.sidePanel.open()` directly from the click handler using the already-known `windowId`; fall back to the in-page assistant with a clear message.
- Make floating assistant workspace failures visible and fall back to staying/opening the assistant panel.
- Remove the toolbar action popup and configure `openPanelOnActionClick: true` so clicking the extension icon opens the Workspace side panel by default.

## Exact Files That Need Changes

- `src/canvy/shared/theme.ts`
- `src/canvy/shared/types.ts`
- `src/canvy/services/api.ts`
- `src/canvy/content/screenContext.ts`
- `src/canvy/content/main.tsx`
- `src/canvy/content/assistantPanel.ts`
- `src/canvy/content/screenBubbles.ts`
- `src/canvy/content/overlay/CanvyOutputOverlay.tsx`
- `src/canvy/background/main.ts`
- `src/canvy/popup/App.tsx`
- `src/canvy/shared/app.css`
- `src/canvy/sidepanel/panel.css`
- `src/canvy/content/sidebar.css`
- `backend/src/types/screen.ts`
- `backend/src/routes/screen.ts`
- `backend/src/services/screen-analysis.ts`

## Risks

- `OffscreenCanvas` or `createImageBitmap` may be unavailable in an older Chromium extension worker. The implementation must fall back to captured JPEG without resizing.
- `chrome.sidePanel.open()` may still be blocked from content-script initiated actions. The assistant panel must show the fallback message instead of silently failing.
- More DOM context improves accuracy but can increase prompt size. Context extraction must stay compact.
- Duplicate screenshot cache can reuse a stale result if the visual page is identical but the user expected a fresh model answer. Cache key includes URL, viewport, scroll, and image fingerprint to limit this risk.

## Acceptance Tests

- Analyze Screen starts immediately and shows scan progress.
- Screenshot payload is JPEG and width-capped when the runtime supports resizing.
- Backend response includes timing in debug/development paths.
- AI response follows strict JSON and maps multiple visible questions separately.
- Low-confidence or insufficient-context items set `needsMoreContext`.
- Old scan responses are ignored and do not render stale bubbles.
- Duplicate rapid clicks do not stack scans or duplicate bubbles.
- Open Workspace opens the side panel in one click from the toolbar popup.
- Clicking the Chrome extension icon opens the Workspace side panel by default.
- Workspace shows `Open Floating Popup`.
- If Chrome blocks workspace opening, the UI says `Couldn't open workspace. Opening assistant panel instead.`
- Floating assistant workspace action does not silently report success on failure.
- Popup, assistant panel, answer bubbles, workflow overlay, and side panel use black/cyan tokens.
- `+`, `x`, copy, scan again, and follow-up bubble actions work in one click.
- Build, typecheck, lint, and tests pass when scripts exist.
