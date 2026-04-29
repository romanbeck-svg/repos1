# Mako IQ UI Audit

## 1. Current UI Surfaces

- Toolbar popup: quick launcher opened from the Chrome action popup (`launcher.html`). This should stay a short-lived command center, not a persistent window.
- Workspace side panel: persistent full workspace opened with the Side Panel API (`sidepanel.html`). This is the correct surface for deeper analysis.
- In-page floating assistant: content-script overlay rendered into a shadow root over the active page. This is the correct surface for movable, page-level answers.
- Options page: supporting settings surface (`options.html`).
- Dormant legacy React components: older `canvy-*` content and sidepanel components still compile in `src/canvy`, but the current manifest routes through the Mako launcher, side panel, options, and overlay entry points.

## 2. Files Controlling Each Surface

- Manifest and routing: `public/manifest.json`, `vite.config.ts`, `vite.content.config.ts`
- Toolbar popup: `launcher.html`, `src/canvy/popup/main.tsx`, `src/canvy/popup/App.tsx`
- Workspace side panel: `sidepanel.html`, `src/canvy/sidepanel/main.tsx`, `src/canvy/sidepanel/App.tsx`
- In-page overlay: `src/canvy/content/main.tsx`, `src/canvy/content/overlay/overlayRoot.tsx`, `src/canvy/content/overlay/CanvyOutputOverlay.tsx`, `src/canvy/content/overlay/mapWorkflowStateToOverlay.ts`
- Options page: `options.html`, `src/canvy/options/main.tsx`, `src/canvy/options/App.tsx`
- Shared UI system: `src/canvy/shared/app.css`, `src/canvy/shared/components/ui.tsx`, `src/canvy/shared/components/AnalysisResultCard.tsx`
- Legacy compiled UI paths: `src/canvy/content/sidebar.css`, `src/canvy/content/components/*`, `src/canvy/sidepanel/panel.css`, `src/canvy/sidepanel/components/*`

## 3. Current Problems

- The active UI has a shared Mako-style foundation, but token names and colors are not aligned to the requested dark purple / black system.
- The shared component file is missing explicit aliases for the requested primitives: `Button`, `Card`, `Badge`, `Tooltip`, `Input`, `Textarea`, `RecommendedAnswer`, and `SurfaceShell`.
- Some dormant `canvy-*` CSS still uses an older blue, white-dashboard visual language. Even if inactive today, it creates a maintenance path back to inconsistent UI.
- Several controls use compact layouts that can crowd actions in narrow popup/side-panel widths.
- Overlay text and controls are generally consistent, but the movable assistant needs stronger resize affordance and more deliberate glass readability.
- Motion is mostly restrained, but the system should make the 120ms hover/tap and 180-240ms panel transition rules explicit in tokens.

## 4. Target Visual Language

Name: Mako IQ Interface System

Style:
- Premium AI command center
- Dark purple / black gradient foundation
- White glass cards over dark surfaces
- Subtle violet glow
- Thin borders
- Soft blur
- Minimal icons
- Strong hierarchy
- Smooth transitions
- Clear action labels
- No random filler text

Research anchors:
- [Chrome action API](https://developer.chrome.com/docs/extensions/reference/api/action): action popups are toolbar-bound extension UI with popup sizing constraints, so the popup stays a launcher.
- [Chrome Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) and [create a side panel](https://developer.chrome.com/docs/extensions/develop/ui/create-a-side-panel): side panels are persistent extension pages that remain available while browsing, so the side panel owns the workspace.
- [Chrome MV3 message passing](https://developer.chrome.com/docs/extensions/develop/concepts/messaging): message passing remains JSON-serializable and split across extension pages, service worker, and content scripts, so UI work should not alter API/storage/message contracts.
- Apple HIG direction from [Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons), [Layout](https://developer.apple.com/design/human-interface-guidelines/layout), [Materials](https://developer.apple.com/design/human-interface-guidelines/materials), and [Motion](https://developer.apple.com/design/human-interface-guidelines/motion): clear hierarchy, comfortable hit regions, restrained materials, purposeful motion, and avoiding crowded button rows.
- INP-style responsiveness from [Interaction to Next Paint](https://web.dev/articles/inp) and [Optimize INP](https://web.dev/articles/optimize-inp): immediate visual feedback, short interaction handlers, restrained animation, and no expensive work in UI event paths.

## 5. Implementation Checklist

- Add exact Mako IQ design tokens to the shared stylesheet.
- Keep existing architecture and message names intact.
- Export all requested shared UI primitives from `src/canvy/shared/components/ui.tsx`.
- Apply consistent action sizing, focus states, hover/tap motion, cards, badges, and empty/loading states.
- Keep popup as launcher-only, side panel as workspace, overlay as movable in-page assistant.
- Normalize legacy `canvy-*` styling to token-backed Mako colors or keep it visually compatible if reactivated.
- Respect `prefers-reduced-motion` and the extension motion setting.

## 6. Risks

- Chrome APIs are unavailable in a normal browser preview; verification needs typecheck/build and extension smoke tests rather than only static page preview.
- The workspace uses live tab context and storage changes; visual changes must not block message listeners or background service-worker calls.
- Content-script overlay CSS is injected into a shadow root, so shared styles must stay self-contained.
- The worktree already contains modified backend and extension files. UI implementation should avoid reverting unrelated edits.

## 7. Final Acceptance Checklist

- `docs/UI_AUDIT.md` exists and maps current surfaces.
- Popup, side panel, options, and overlay use the shared Mako IQ visual system.
- Requested tokens and primitives are present.
- Action targets remain comfortable and readable at popup and side-panel widths.
- Motion is fast and optional.
- No backend, storage, permission, or message-passing contracts are changed.
- `npm run typecheck` passes.
- `npm run build` passes.
