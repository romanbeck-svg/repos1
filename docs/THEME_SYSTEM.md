# Mako IQ Theme System

## Target Palette

Mako IQ uses a black/cyan interface:

- `--mako-bg-0: #05070A`
- `--mako-bg-1: #081018`
- `--mako-bg-2: #0B1722`
- `--mako-cyan-1: #22D3EE`
- `--mako-cyan-2: #06B6D4`
- `--mako-cyan-3: #67E8F9`
- `--mako-cyan-glow: rgba(34, 211, 238, 0.30)`
- `--mako-surface-dark: rgba(7, 14, 20, 0.78)`
- `--mako-surface-glass: rgba(15, 23, 32, 0.62)`
- `--mako-border: rgba(103, 232, 249, 0.22)`
- `--mako-text-primary: #F4FBFF`
- `--mako-text-secondary: rgba(244, 251, 255, 0.72)`
- `--mako-text-muted: rgba(244, 251, 255, 0.52)`

## Token Rules

- Use tokens from `src/canvy/shared/app.css` for React surfaces.
- Use matching local tokens inside content-script shadow DOM CSS.
- Avoid purple, violet, and gray-black gradients in primary UI.
- Cyan is the accent and active state. Black/near-black is the base.
- Glass panels use subtle cyan borders and restrained glow.
- Motion uses one timing system:
  - hover/press: 120ms-150ms
  - open/close: 180ms-240ms
  - respect `prefers-reduced-motion`

## Shared Components

Primary components should share:

- radius: `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-pill`
- border: `--stroke-glass`
- text: `--text-primary`, `--text-secondary`, `--text-tertiary`
- accent: `--accent-primary`, `--accent-secondary`, `--accent-glow`
- shadows: `--shadow-soft`, `--shadow-glow`, `--shadow-float`

Component equivalents:

- FloatingPanel: `.mako-overlay-window` and `.mako-assistant-panel`
- AnswerBubble: `.mako-screen-bubble`
- ActionPanel: workflow overlay root
- IconButton: `.mako-icon-button` and bubble icon button equivalent
- PrimaryButton / SecondaryButton: `.mako-button--primary`, `.mako-button--secondary`
- StatusChip: `.mako-pill`
- Card: `.mako-panel`, `.mako-overlay-window__section`, `.mako-screen-bubble__section`
- FollowUpInput: `.mako-input`, `.mako-overlay-input`, bubble input equivalent

## Logo Use

The logo is a minimal cyan M/fin mark on a near-black base. It is used in:

- Chrome extension icons
- Toolbar launcher header
- Assistant panel header
- Workspace/side panel header through `AppIcon`

## Verification Checklist

- No primary surface uses purple accent tokens.
- Popup, panel, overlay, and bubbles use black/cyan tokens.
- Icons and logo read clearly at 16px and 32px.
- Button hover/focus/active states are consistent.
- Reduced motion disables nonessential animation.
