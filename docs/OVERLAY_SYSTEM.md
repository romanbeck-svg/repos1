# Mako IQ Overlay System

## Surfaces

- `launcher.html` / `src/canvy/popup/App.tsx`: small Chrome toolbar launcher. It should not behave like a draggable app window.
- `src/canvy/content/assistantPanel.ts`: injected floating assistant panel. This is the main movable popup experience.
- `src/canvy/content/screenBubbles.ts`: transparent answer bubbles anchored near detected screenshot questions.
- `src/canvy/content/overlay/overlayRoot.tsx`: React root for workflow/action output.
- `src/canvy/sidepanel/App.tsx`: full workspace for history, workflow actions, and deeper context.

## Layering Contract

Use predictable page-level layers:

1. Page content.
2. Answer bubbles: anchored, transparent, allowed to coexist.
3. Assistant panel: one movable command panel.
4. Workflow/action overlay: one major action result panel.
5. Tooltips/menus: temporary controls above active panels.

The assistant panel and workflow/action overlay are both major panels. Only one should be visible at a time. Opening one hides the other.

## State Model

- Assistant panel position: `mako.panel.position`
- Assistant panel size: `mako.panel.size`
- Assistant panel collapsed state: `mako.panel.collapsed`
- Workflow overlay state: `makoiq.overlayUi`
- Bubble positions: `makoiq.screenBubblePositions`
- Session/workflow state: `makoiq.session`

Positions are stored in `chrome.storage.local`, restored on open, and clamped to the current viewport.

## Interaction Rules

- Drag starts only from explicit header/drag zones.
- Interactive controls stop pointer propagation before drag capture.
- Close buttons remove their own surface immediately.
- Expand buttons toggle expanded content immediately.
- Scan actions call the existing `CAPTURE_VISIBLE_SCREEN` background route.
- Bubble rendering replaces stale bubbles before placing new ones.
- Workflow actions reuse the existing workflow overlay root instead of creating separate modal stacks.

## Anti-Overlap Rules

- The content script clears/hides the workflow overlay before showing the assistant panel.
- The content script hides the assistant panel before showing a workflow/action overlay.
- Bubble placement offsets nearby bubbles and clamps to the viewport.
- Bubbles can coexist with the assistant because they are lightweight anchored annotations.
- If too many bubbles are produced, they stack with controlled spacing rather than random overlap.

## Verification Checklist

- One assistant panel per page.
- One workflow/action overlay per page.
- Opening workflow output hides the assistant panel.
- Opening the assistant hides workflow output.
- Multiple answer bubbles can render without blocking assistant controls.
- Button hit areas remain reliable at desktop and narrow widths.
