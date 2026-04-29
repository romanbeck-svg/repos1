import { MAKO_THEME_CSS } from '../shared/theme';

export const MAKO_OVERLAY_UI_CSS = `
  :host {
    all: initial;
    color-scheme: dark;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Segoe UI", sans-serif;
    ${MAKO_THEME_CSS}
    --mako-overlay-radius: 20px;
    --mako-overlay-section-radius: 16px;
    --mako-overlay-shadow:
      0 22px 60px rgba(0, 0, 0, 0.38),
      0 0 28px rgba(47, 230, 210, 0.12),
      inset 0 1px 0 rgba(255, 255, 255, 0.10);
  }

  *, *::before, *::after {
    box-sizing: border-box;
  }

  button,
  input,
  textarea {
    font: inherit;
  }

  button {
    appearance: none;
    border: 0;
    background: none;
  }

  .mako-ui-layer {
    position: fixed;
    inset: 0;
    pointer-events: none;
  }

  .mako-ui-surface {
    position: relative;
    overflow: hidden;
    color: var(--mako-text-primary);
    border: 1px solid var(--mako-border);
    border-radius: var(--mako-overlay-radius);
    background:
      radial-gradient(circle at 0% 0%, rgba(34, 255, 215, 0.16), transparent 34%),
      radial-gradient(circle at 100% 100%, rgba(126, 82, 255, 0.18), transparent 38%),
      linear-gradient(135deg, rgba(4, 13, 22, 0.72), rgba(10, 8, 22, 0.62));
    box-shadow: var(--mako-overlay-shadow);
    backdrop-filter: blur(20px) saturate(155%);
    -webkit-backdrop-filter: blur(20px) saturate(155%);
  }

  .mako-ui-surface::before {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.08), transparent 26%),
      radial-gradient(circle at 92% 0%, rgba(34, 211, 238, 0.12), transparent 30%);
  }

  .mako-ui-surface > * {
    position: relative;
    z-index: 1;
  }

  .mako-ui-section {
    display: grid;
    gap: 8px;
    padding: 12px;
    border: 1px solid rgba(103, 232, 249, 0.14);
    border-radius: var(--mako-overlay-section-radius);
    background:
      linear-gradient(180deg, rgba(103, 232, 249, 0.08), rgba(126, 82, 255, 0.04)),
      rgba(6, 17, 28, 0.42);
  }

  .mako-ui-kicker {
    margin: 0;
    color: var(--mako-cyan-3);
    font-size: 11px;
    font-weight: 760;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .mako-ui-copy {
    margin: 0;
    color: var(--mako-text-secondary);
    line-height: 1.45;
  }

  .mako-ui-status-chip {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 28px;
    padding: 0 10px;
    border: 1px solid rgba(103, 232, 249, 0.18);
    border-radius: 999px;
    background: rgba(34, 211, 238, 0.08);
    color: var(--mako-text-primary);
    font-size: 12px;
    font-weight: 720;
    white-space: nowrap;
  }

  .mako-ui-status-chip::before {
    content: "";
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: var(--mako-cyan-1);
    box-shadow: 0 0 14px rgba(34, 211, 238, 0.72);
  }

  .mako-ui-status-chip[data-tone="success"]::before,
  .mako-ui-status-chip[data-tone="high"]::before {
    background: var(--mako-success);
    box-shadow: 0 0 12px rgba(34, 197, 94, 0.55);
  }

  .mako-ui-status-chip[data-tone="warning"],
  .mako-ui-status-chip[data-tone="medium"] {
    border-color: rgba(245, 158, 11, 0.25);
    background: rgba(245, 158, 11, 0.09);
  }

  .mako-ui-status-chip[data-tone="warning"]::before,
  .mako-ui-status-chip[data-tone="medium"]::before {
    background: var(--mako-warning);
    box-shadow: 0 0 12px rgba(245, 158, 11, 0.5);
  }

  .mako-ui-status-chip[data-tone="danger"],
  .mako-ui-status-chip[data-tone="low"] {
    border-color: rgba(251, 113, 133, 0.28);
    background: rgba(251, 113, 133, 0.10);
  }

  .mako-ui-status-chip[data-tone="danger"]::before,
  .mako-ui-status-chip[data-tone="low"]::before {
    background: var(--mako-danger);
    box-shadow: 0 0 12px rgba(251, 113, 133, 0.45);
  }

  .mako-ui-button,
  .mako-ui-icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 40px;
    border: 1px solid rgba(103, 232, 249, 0.18);
    border-radius: 999px;
    background: rgba(8, 22, 34, 0.42);
    color: var(--mako-text-primary);
    backdrop-filter: blur(12px) saturate(150%);
    -webkit-backdrop-filter: blur(12px) saturate(150%);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.08),
      0 10px 24px rgba(0, 0, 0, 0.24);
    cursor: pointer;
    transition:
      transform 130ms ease,
      border-color 130ms ease,
      background 130ms ease,
      box-shadow 130ms ease,
      opacity 130ms ease;
  }

  .mako-ui-button {
    gap: 8px;
    padding: 0 13px;
    font-size: 13px;
    font-weight: 720;
  }

  .mako-ui-button[data-variant="primary"] {
    border-color: rgba(103, 232, 249, 0.36);
    background:
      linear-gradient(135deg, rgba(34, 211, 238, 0.30), rgba(6, 182, 212, 0.16)),
      rgba(8, 16, 24, 0.88);
    box-shadow: 0 14px 32px rgba(34, 211, 238, 0.16);
  }

  .mako-ui-icon-button {
    width: 40px;
    min-width: 40px;
    padding: 0;
  }

  .mako-ui-button:hover:not(:disabled),
  .mako-ui-icon-button:hover:not(:disabled) {
    transform: translateY(-1px);
    border-color: rgba(103, 232, 249, 0.42);
    background: rgba(18, 42, 58, 0.55);
    box-shadow:
      0 14px 32px rgba(0, 0, 0, 0.30),
      0 0 20px rgba(70, 235, 220, 0.16);
  }

  .mako-ui-button:active:not(:disabled),
  .mako-ui-icon-button:active:not(:disabled) {
    transform: scale(0.985);
  }

  .mako-ui-button:disabled,
  .mako-ui-icon-button:disabled {
    opacity: 0.54;
    cursor: not-allowed;
  }

  .mako-ui-button:focus-visible,
  .mako-ui-icon-button:focus-visible,
  .mako-ui-input:focus-visible {
    outline: none;
    box-shadow: 0 0 0 1px rgba(244, 251, 255, 0.16), 0 0 0 4px rgba(34, 211, 238, 0.22);
  }

  .mako-ui-input {
    min-width: 0;
    min-height: 38px;
    padding: 9px 11px;
    border-radius: 13px;
    border: 1px solid rgba(103, 232, 249, 0.18);
    background: rgba(5, 7, 10, 0.55);
    color: var(--mako-text-primary);
    outline: none;
  }

  .mako-ui-input::placeholder {
    color: var(--mako-text-muted);
  }
`;

export function createMakoElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

export function createMakoIconButton(label: string, text: string, className = '') {
  const button = createMakoElement('button', ['mako-ui-icon-button', className].filter(Boolean).join(' '), text);
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.dataset.makoInteractive = 'true';
  button.addEventListener('pointerdown', (event) => event.stopPropagation());
  return button;
}

export function createMakoActionButton(label: string, variant: 'primary' | 'secondary' = 'secondary', className = '') {
  const button = createMakoElement('button', ['mako-ui-button', className].filter(Boolean).join(' '), label);
  button.type = 'button';
  button.dataset.variant = variant;
  button.dataset.makoInteractive = 'true';
  button.addEventListener('pointerdown', (event) => event.stopPropagation());
  return button;
}
