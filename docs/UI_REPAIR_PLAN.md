# Mako IQ UI Repair Plan

## Research Notes

Primary UI surfaces found in this repo:

- Toolbar launcher: `src/canvy/popup/App.tsx`, mounted by `launcher.html`.
- Screen answer bubbles: `src/canvy/content/screenBubbles.ts`, rendered by content-script messages.
- Workflow/action overlay: `src/canvy/content/overlay/overlayRoot.tsx` and `CanvyOutputOverlay.tsx`.
- Side panel/workspace: `src/canvy/sidepanel/App.tsx` plus `src/canvy/sidepanel/panel.css`.
- Shared React UI: `src/canvy/shared/components/ui.tsx`.
- Shared theme: `src/canvy/shared/app.css`.
- Older content overlay styles: `src/canvy/content/sidebar.css`.
- Background action routing and capture flow: `src/canvy/background/main.ts`.
- UI persistence keys and defaults: `src/canvy/shared/constants.ts`, `src/canvy/shared/storage.ts`.
- Logo/icon wiring: `public/manifest.json`, `public/icons/*`, `AppIcon` in `ui.tsx`.

## Current Issues

- The toolbar popup is still treated like the main working surface. Chrome action popups cannot be a durable dragged window.
- Screen bubbles are separate from the assistant window; users must return to the launcher to scan again.
- Bubble controls sit inside the drag handle, so pointer capture can compete with button clicks.
- Bubbles, workflow overlay, side panel, and older content UI use multiple style systems.
- Purple/gray colors are hard-coded in CSS and component SVGs.
- The screen bubble root and workflow overlay root use the same extreme z-index, so overlays can visually compete.
- Workflow/action overlays reuse one React root, but the screen assistant and answer-bubble system do not yet have a shared page-level manager.

## Root Causes

- Launcher, side panel, workflow overlay, and screen bubbles evolved as separate surfaces with duplicated styling and state.
- Position persistence exists for the workflow overlay (`makoiq.overlayUi`) but not for the screen-analysis assistant panel requested as the main movable popup.
- Button events on bubbles are not isolated from drag events.
- Color tokens exist but old purple values are still hard-coded throughout primary UI CSS.
- Overlay root ownership is implicit; there is no clear z-index contract or rule for replacing major panels.

## Target Architecture

- Toolbar popup becomes a launcher only. It opens the injected page assistant and offers lightweight fallback actions.
- The injected assistant panel is the main movable popup:
  - content-script overlay
  - draggable by header
  - persisted with `mako.panel.position`, `mako.panel.size`, and `mako.panel.collapsed`
  - clamped into the viewport on open and resize
- Answer bubbles remain anchored page overlays and coexist with the assistant panel.
- Workflow/action overlay remains a single React overlay root. Opening it hides the assistant panel to prevent major panels from stacking.
- Opening the assistant panel hides the workflow/action overlay for the same reason.
- Screen rescans are available directly from the assistant and from expanded bubbles.

## Implementation Plan

1. Add an injected floating assistant panel in the content script.
2. Route launcher actions through the background script to open that panel in the active tab.
3. Add panel actions for `Scan Again`, `Clear Bubbles`, and `Open Workspace`.
4. Add `Scan Again` to answer bubbles and clear/replace old bubbles through the existing capture pipeline.
5. Fix bubble button handling by separating button pointer events from drag capture.
6. Set a consistent overlay layering contract:
   - page
   - answer bubbles
   - assistant panel
   - workflow/action overlay
   - temporary tooltips/menus
7. Replace purple/gray primary UI styles with black/cyan tokens.
8. Create and wire a minimal Mako IQ logo source asset and regenerated extension icons.
9. Verify with typecheck/build and available scripts.

## Verification Checklist

- Toolbar launcher opens and acts as a launcher.
- `Open Assistant` opens an injected panel on the active page.
- Assistant panel drags smoothly from the header.
- Assistant position persists after close/reopen.
- Off-screen saved positions clamp back into view.
- `Scan Again` works from the assistant.
- Expanded bubbles expose scan, follow-up, copy, expand/collapse, and close actions.
- `+` expands in one click.
- `x` closes in one click.
- Major action overlays do not stack with the assistant panel.
- Answer bubbles and assistant use the same black/cyan visual language.
- Extension icons and headers use the new logo.
- `npm run typecheck` and `npm run build:extension` pass.
