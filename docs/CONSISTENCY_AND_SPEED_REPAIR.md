# Mako IQ Consistency And Speed Repair

## Product Definitions

- Workspace: the Chrome side panel at `sidepanel.html`. The toolbar action opens this by default.
- Floating Popup: the injected, draggable Screen Assistant from `src/canvy/content/assistantPanel.ts`.
- Answer Bubble: the on-page answer card from `src/canvy/content/screenBubbles.ts` and the mapped workflow bubble from `src/canvy/content/overlay/CanvyOutputOverlay.tsx`.
- Launcher: the optional extension page at `launcher.html`, kept as a direct-entry fallback/debug surface, not the default toolbar action.

## Current UI Surfaces

- Toolbar action / launcher: `public/manifest.json`, `src/canvy/background/main.ts`, and optional `src/canvy/popup/App.tsx`.
- Floating assistant panel: `src/canvy/content/assistantPanel.ts`.
- Screen-analysis answer bubbles: `src/canvy/content/screenBubbles.ts`.
- Mapped workflow answer bubble and expanded assistant overlay: `src/canvy/content/overlay/CanvyOutputOverlay.tsx`, `src/canvy/content/overlay/overlayRoot.tsx`, styled by `src/canvy/shared/app.css`.
- Workspace / side panel: `src/canvy/sidepanel/App.tsx`, `src/canvy/sidepanel/panel.css`, and shared React components in `src/canvy/shared/components/ui.tsx`.
- Follow-up UI: `FollowUpComposer` in React overlays and DOM-built follow-up form in `screenBubbles.ts`.
- Action panels: shared React panels in `src/canvy/shared/components/ui.tsx` plus workflow output overlay styles in `src/canvy/shared/app.css`.

## Surfaces Still At Risk

- `screenBubbles.ts` used its own button, chip, card, input, and panel CSS even though the colors were mostly migrated.
- `CanvyOutputOverlay.tsx` rendered the mapped answer bubble as a custom section instead of a shared floating panel component.
- `assistantPanel.ts` also carried its own DOM-only button/status/section styles, so the assistant and answer bubble could drift apart again.
- The toolbar action was still wired around the historical launcher/popup concept, which made "Workspace" ambiguous.

## Theme Inconsistency Root Cause

The token values had been moved to black/cyan, but the primary overlay surfaces were not using one shared component system. The floating assistant, raw answer bubble, and mapped workflow bubble each defined separate card, section, button, input, and status-chip CSS. That allowed the answer bubble to keep a different glass/gradient treatment from the main assistant panel even without literal purple color constants remaining in source.

## Speed Root Cause

- Screenshot capture and optimization were improved, but the payload cap was still generous at 1440px / 0.78 JPEG quality.
- Compact DOM context extraction could still inspect too many nodes and block the backend request path until its message timeout.
- The screenshot path still ran even when compact visible DOM question context was already enough to answer.
- Backend screen analysis still allowed one provider retry, which can double latency after invalid or slow AI output.
- Default model output was still sized for longer explanations than the bubble needs.

## Files To Change

- `src/canvy/content/overlayUi.ts`
- `src/canvy/content/assistantPanel.ts`
- `src/canvy/content/screenBubbles.ts`
- `src/canvy/content/overlay/CanvyOutputOverlay.tsx`
- `src/canvy/shared/app.css`
- `public/manifest.json`
- `src/canvy/sidepanel/App.tsx`
- `src/canvy/popup/App.tsx`
- `src/canvy/background/main.ts`
- `src/canvy/content/screenContext.ts`
- `src/canvy/services/api.ts`
- `backend/src/services/screen-analysis.ts`

## Implementation Plan

- Create a shared DOM overlay UI module for content-script shadow DOM surfaces.
- Make assistant-panel buttons/status/sections and screen-bubble buttons/status/sections use the shared DOM overlay classes.
- Render the mapped workflow answer bubble through the shared React floating-panel component.
- Normalize overlay/window/bubble CSS in `app.css` to the same black/cyan panel language.
- Make the extension toolbar action open the Workspace side panel, and expose "Open Floating Popup" inside the workspace.
- Lower screenshot upload size and quality to reduce bytes without losing question readability.
- Use a fast DOM-context request path when visible question candidates are already available.
- Add a short, non-fatal timeout around compact DOM context and make DOM extraction stop earlier.
- Remove backend provider retry for the screen bubble path and reduce default screen-analysis output length.

## Changes Applied

- Added `src/canvy/content/overlayUi.ts` as the shared DOM overlay UI system for shadow-DOM surfaces.
- Updated `assistantPanel.ts` and `screenBubbles.ts` to share DOM overlay buttons, icon buttons, sections, status chips, inputs, and surface classes.
- Updated the mapped answer bubble in `CanvyOutputOverlay.tsx` to render through `FloatingPanel`.
- Added `GlassCard` and `ErrorState` aliases to the shared React UI component module.
- Aligned `app.css` overlay window and mapped-bubble surfaces to the same black/cyan panel treatment used by the assistant panel.
- Removed the default toolbar action popup and configured the action to open the Workspace side panel.
- Added Workspace actions for Analyze Page, Find Questions, Show Answers, Summarize Page, Next Steps, and Open Floating Popup.
- Updated launcher labels so it refers to the floating popup and sidebar workspace consistently.
- Lowered screen capture/upload settings to 1280px max width and 0.72 JPEG quality.
- Reduced compact context limits and capped DOM inspection work.
- Added the DOM-context fast path so clear visible question candidates can be sent without waiting on full screenshot upload.
- Reduced screen-analysis client timeout from 45s to 32s.
- Removed backend provider retry for screen analysis and reduced response token budget to keep bubble output concise.

## Verification Checklist

- Main assistant panel opens.
- Toolbar action opens the Workspace side panel by default.
- Workspace exposes Open Floating Popup.
- Analyze Screen still starts immediately.
- Screen-analysis answer bubbles render near detected questions.
- Mapped workflow answer bubble uses the same black/cyan panel style as the assistant.
- Expanded bubble, follow-up input, status chip, and action buttons share the same system.
- No purple/lavender tokens remain in active source or built extension output.
- Duplicate scans are blocked/cancelled and stale results do not overwrite current results.
- Screenshot image metadata shows compressed/resized JPEG where supported.
- Build passes.
- Extension smoke test passes.
