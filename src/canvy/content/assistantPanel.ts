import { STORAGE_KEYS } from '../shared/constants';
import type { OverlayUpdateResponse, ScreenAnalyzeActionResponse } from '../shared/types';
import {
  MAKO_OVERLAY_UI_CSS,
  createMakoActionButton,
  createMakoElement as createElement,
  createMakoIconButton
} from './overlayUi';

const ASSISTANT_ROOT_ID = 'mako-iq-assistant-root';
const VIEWPORT_MARGIN = 16;
const DEFAULT_PANEL_SIZE = {
  width: 392,
  height: 420
};

const ASSISTANT_CSS = `
  ${MAKO_OVERLAY_UI_CSS}

  .mako-assistant-layer {
    position: fixed;
    inset: 0;
    z-index: 2147483640;
    pointer-events: none;
  }

  .mako-assistant-panel {
    position: fixed;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    width: min(var(--mako-panel-width, 392px), calc(100vw - 32px));
    min-width: min(320px, calc(100vw - 32px));
    max-width: calc(100vw - 32px);
    max-height: calc(100vh - 32px);
    overflow: hidden;
    border: 1px solid var(--mako-border);
    border-radius: 20px;
    background:
      radial-gradient(circle at 18% 0%, rgba(103, 232, 249, 0.12), transparent 34%),
      linear-gradient(180deg, rgba(8, 16, 24, 0.92), rgba(5, 7, 10, 0.96)),
      var(--mako-surface-dark);
    color: var(--mako-text-primary);
    box-shadow:
      0 24px 70px rgba(0, 0, 0, 0.46),
      0 0 0 1px rgba(244, 251, 255, 0.04),
      0 0 34px rgba(34, 211, 238, 0.16);
    backdrop-filter: blur(22px) saturate(1.35);
    -webkit-backdrop-filter: blur(22px) saturate(1.35);
    pointer-events: auto;
    transition:
      opacity 200ms ease,
      transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1),
      border-color 150ms ease,
      box-shadow 150ms ease;
  }

  .mako-assistant-panel[data-collapsed="true"] {
    grid-template-rows: auto;
    width: min(344px, calc(100vw - 32px));
  }

  .mako-assistant-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    min-height: 70px;
    padding: 14px 14px 12px;
    border-bottom: 1px solid rgba(103, 232, 249, 0.14);
    cursor: grab;
    user-select: none;
    touch-action: none;
  }

  .mako-assistant-header:active {
    cursor: grabbing;
  }

  .mako-assistant-brand {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    min-width: 0;
  }

  .mako-assistant-logo {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 38px;
    height: 38px;
    flex: 0 0 auto;
    border-radius: 13px;
    background:
      radial-gradient(circle at 35% 20%, rgba(103, 232, 249, 0.34), transparent 42%),
      linear-gradient(145deg, #081018, #05070A);
    box-shadow:
      inset 0 0 0 1px rgba(103, 232, 249, 0.28),
      0 12px 26px rgba(34, 211, 238, 0.18);
  }

  .mako-assistant-copy {
    min-width: 0;
  }

  .mako-assistant-kicker,
  .mako-assistant-label {
    margin: 0;
    color: var(--mako-cyan-3);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .mako-assistant-title {
    margin: 3px 0 0;
    color: var(--mako-text-primary);
    font-size: 18px;
    font-weight: 720;
    line-height: 1.16;
  }

  .mako-assistant-subtitle {
    margin: 4px 0 0;
    color: var(--mako-text-secondary);
    font-size: 12px;
    line-height: 1.4;
  }

  .mako-assistant-controls,
  .mako-assistant-actions,
  .mako-assistant-status-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .mako-assistant-controls {
    justify-content: flex-end;
    flex: 0 0 auto;
  }

  .mako-assistant-body {
    display: grid;
    gap: 12px;
    min-height: 0;
    padding: 14px;
    overflow: auto;
  }

  .mako-assistant-panel[data-collapsed="true"] .mako-assistant-body {
    display: none;
  }

  .mako-assistant-section {
    display: grid;
    gap: 8px;
    padding: 12px;
    border: 1px solid rgba(103, 232, 249, 0.14);
    border-radius: 16px;
    background:
      linear-gradient(180deg, rgba(103, 232, 249, 0.07), rgba(34, 211, 238, 0.018)),
      rgba(5, 7, 10, 0.62);
  }

  .mako-assistant-message {
    margin: 0;
    color: var(--mako-text-secondary);
    font-size: 13px;
    line-height: 1.55;
  }

  .mako-assistant-message strong {
    color: var(--mako-text-primary);
  }

  .mako-assistant-status {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    width: fit-content;
    min-height: 30px;
    padding: 0 10px;
    border: 1px solid rgba(103, 232, 249, 0.18);
    border-radius: 999px;
    background: rgba(34, 211, 238, 0.08);
    color: var(--mako-text-primary);
    font-size: 12px;
    font-weight: 700;
  }

  .mako-assistant-status::before {
    content: "";
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: var(--mako-cyan-1);
    box-shadow: 0 0 14px rgba(34, 211, 238, 0.72);
  }

  .mako-assistant-status[data-tone="warning"] {
    border-color: rgba(245, 158, 11, 0.25);
    background: rgba(245, 158, 11, 0.09);
  }

  .mako-assistant-status[data-tone="warning"]::before {
    background: var(--mako-warning);
    box-shadow: 0 0 12px rgba(245, 158, 11, 0.5);
  }

  .mako-assistant-button,
  .mako-assistant-icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 40px;
    border: 1px solid rgba(103, 232, 249, 0.18);
    border-radius: 999px;
    background: rgba(15, 23, 32, 0.72);
    color: var(--mako-text-primary);
    cursor: pointer;
    transition:
      transform 130ms ease,
      border-color 130ms ease,
      background 130ms ease,
      box-shadow 130ms ease,
      opacity 130ms ease;
  }

  .mako-assistant-button {
    gap: 8px;
    padding: 0 13px;
    font-size: 13px;
    font-weight: 720;
  }

  .mako-assistant-button[data-variant="primary"] {
    border-color: rgba(103, 232, 249, 0.36);
    background:
      linear-gradient(135deg, rgba(34, 211, 238, 0.30), rgba(6, 182, 212, 0.16)),
      rgba(8, 16, 24, 0.88);
    box-shadow: 0 14px 32px rgba(34, 211, 238, 0.16);
  }

  .mako-assistant-icon-button {
    width: 40px;
    min-width: 40px;
    padding: 0;
  }

  .mako-assistant-button:hover:not(:disabled),
  .mako-assistant-icon-button:hover:not(:disabled) {
    transform: translateY(-1px);
    border-color: rgba(103, 232, 249, 0.42);
    background: rgba(34, 211, 238, 0.12);
    box-shadow: 0 0 20px rgba(34, 211, 238, 0.12);
  }

  .mako-assistant-button:active:not(:disabled),
  .mako-assistant-icon-button:active:not(:disabled) {
    transform: scale(0.985);
  }

  .mako-assistant-button:disabled,
  .mako-assistant-icon-button:disabled {
    opacity: 0.54;
    cursor: not-allowed;
  }

  .mako-assistant-button:focus-visible,
  .mako-assistant-icon-button:focus-visible {
    outline: none;
    box-shadow: 0 0 0 1px rgba(244, 251, 255, 0.16), 0 0 0 4px rgba(34, 211, 238, 0.22);
  }

  .mako-assistant-mini-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .mako-assistant-mini-card {
    display: grid;
    gap: 4px;
    min-width: 0;
    padding: 10px;
    border: 1px solid rgba(103, 232, 249, 0.12);
    border-radius: 14px;
    background: rgba(15, 23, 32, 0.62);
  }

  .mako-assistant-mini-card strong {
    overflow: hidden;
    color: var(--mako-text-primary);
    font-size: 13px;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (max-width: 520px) {
    .mako-assistant-panel {
      left: 10px !important;
      width: calc(100vw - 20px) !important;
      min-width: 0;
    }

    .mako-assistant-mini-grid {
      grid-template-columns: 1fr;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation: none !important;
      transition: none !important;
      scroll-behavior: auto !important;
    }
  }
`;

type AssistantTone = 'ready' | 'warning';

interface AssistantUiState {
  left: number;
  top: number;
  width: number;
  height: number;
  collapsed: boolean;
}

interface AssistantRuntimeState extends AssistantUiState {
  busy: boolean;
  status: string;
  tone: AssistantTone;
  lastSummary: string;
  lastCount: number | null;
}

let shadowRoot: ShadowRoot | null = null;
let layer: HTMLElement | null = null;
let panel: HTMLElement | null = null;
let initialized = false;
let activeAssistantRequestId: string | null = null;
let scanProgressTimers: number[] = [];
let state: AssistantRuntimeState = {
  left: 0,
  top: 0,
  width: DEFAULT_PANEL_SIZE.width,
  height: DEFAULT_PANEL_SIZE.height,
  collapsed: false,
  busy: false,
  status: 'Ready',
  tone: 'ready',
  lastSummary: 'Analyze the visible screen to place answer bubbles near detected questions.',
  lastCount: null
};

let drag:
  | {
      pointerId: number;
      startX: number;
      startY: number;
      originLeft: number;
      originTop: number;
      rafId: number | null;
      nextLeft: number;
      nextTop: number;
    }
  | null = null;

function createRequestId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function defaultUiState(): AssistantUiState {
  return {
    left: Math.max(VIEWPORT_MARGIN, window.innerWidth - DEFAULT_PANEL_SIZE.width - VIEWPORT_MARGIN),
    top: Math.max(VIEWPORT_MARGIN, 84),
    width: DEFAULT_PANEL_SIZE.width,
    height: DEFAULT_PANEL_SIZE.height,
    collapsed: false
  };
}

function clampUiState(next: AssistantUiState): AssistantUiState {
  const width = clamp(
    Number.isFinite(next.width) ? next.width : DEFAULT_PANEL_SIZE.width,
    320,
    Math.max(320, window.innerWidth - VIEWPORT_MARGIN * 2)
  );
  const height = clamp(
    Number.isFinite(next.height) ? next.height : DEFAULT_PANEL_SIZE.height,
    240,
    Math.max(240, window.innerHeight - VIEWPORT_MARGIN * 2)
  );
  const visibleHeight = next.collapsed ? 72 : height;
  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
  const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - visibleHeight - VIEWPORT_MARGIN);

  return {
    ...next,
    width,
    height,
    left: clamp(Number.isFinite(next.left) ? next.left : defaultUiState().left, VIEWPORT_MARGIN, maxLeft),
    top: clamp(Number.isFinite(next.top) ? next.top : defaultUiState().top, VIEWPORT_MARGIN, maxTop)
  };
}

function sanitizeText(value: unknown, fallback = '') {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text || fallback;
}

async function isDebugModeEnabled() {
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEYS.settings]);
    return Boolean((stored[STORAGE_KEYS.settings] as { debugMode?: boolean } | undefined)?.debugMode);
  } catch {
    return false;
  }
}

function logFrontendTiming(tag: string, payload: Record<string, unknown> = {}) {
  void isDebugModeEnabled().then((enabled) => {
    if (enabled) {
      console.info(`[Mako IQ screen timing][${tag}]`, payload);
    }
  });
}

function clearScanProgressTimers() {
  scanProgressTimers.forEach((timerId) => window.clearTimeout(timerId));
  scanProgressTimers = [];
}

function scheduleScanProgress(requestId: string) {
  clearScanProgressTimers();
  scanProgressTimers = [
    window.setTimeout(() => {
      if (activeAssistantRequestId !== requestId || !state.busy) {
        return;
      }
      state = {
        ...state,
        status: 'Scanning page',
        lastSummary: 'Reading visible questions and answer choices...'
      };
      renderPanel();
    }, 450),
    window.setTimeout(() => {
      if (activeAssistantRequestId !== requestId || !state.busy) {
        return;
      }
      state = {
        ...state,
        status: 'Thinking',
        lastSummary: 'Choosing the best answer from the extracted choices...'
      };
      renderPanel();
    }, 1400)
  ];
}

function isInteractiveTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('button, input, textarea, select, a, [data-mako-interactive="true"]'));
}

function createLogo() {
  const wrap = createElement('span', 'mako-assistant-logo');
  wrap.innerHTML = `
    <svg viewBox="0 0 36 36" width="28" height="28" fill="none" aria-hidden="true">
      <path d="M6.5 25.8 12.2 9.6c.18-.5.86-.58 1.16-.14l4.64 6.95 4.64-6.95c.3-.44.98-.36 1.16.14l5.7 16.2c.18.5-.36.95-.82.68l-5.86-3.42a1.4 1.4 0 0 0-1.56.1l-3.36 2.56-3.36-2.56a1.4 1.4 0 0 0-1.56-.1L7.32 26.48c-.46.27-1-.18-.82-.68Z" fill="url(#makoAssistantLogoFill)"/>
      <path d="M12.55 19.55 18 11.8l5.45 7.75" stroke="#05070A" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/>
      <defs>
        <linearGradient id="makoAssistantLogoFill" x1="8" y1="8" x2="28" y2="28" gradientUnits="userSpaceOnUse">
          <stop stop-color="#67E8F9"/>
          <stop offset="0.5" stop-color="#22D3EE"/>
          <stop offset="1" stop-color="#06B6D4"/>
        </linearGradient>
      </defs>
    </svg>
  `;
  return wrap;
}

function createIconButton(label: string, text: string) {
  return createMakoIconButton(label, text, 'mako-assistant-icon-button');
}

function createButton(label: string, variant: 'primary' | 'secondary' = 'secondary') {
  return createMakoActionButton(label, variant, 'mako-assistant-button');
}

function ensureRoot() {
  if (shadowRoot && layer) {
    return { shadowRoot, layer };
  }

  let host = document.getElementById(ASSISTANT_ROOT_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = ASSISTANT_ROOT_ID;
    host.style.position = 'fixed';
    host.style.inset = '0';
    host.style.pointerEvents = 'none';
    document.documentElement.appendChild(host);
  }
  host.style.zIndex = '2147483640';
  host.style.pointerEvents = 'none';

  shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  if (!shadowRoot.querySelector('style[data-mako-assistant]')) {
    const style = document.createElement('style');
    style.setAttribute('data-mako-assistant', 'true');
    style.textContent = ASSISTANT_CSS;
    shadowRoot.appendChild(style);
  }

  layer = shadowRoot.querySelector<HTMLElement>('[data-mako-assistant-layer]');
  if (!layer) {
    layer = createElement('div', 'mako-ui-layer mako-assistant-layer');
    layer.setAttribute('data-mako-assistant-layer', 'true');
    shadowRoot.appendChild(layer);
  }

  if (!initialized) {
    initialized = true;
    window.addEventListener('resize', () => {
      if (!panel) {
        return;
      }
      const next = clampUiState(state);
      state = {
        ...state,
        ...next
      };
      applyPanelPosition();
      void persistUiState();
    });
  }

  return { shadowRoot, layer };
}

async function readUiState() {
  const defaults = defaultUiState();
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.panelPosition,
    STORAGE_KEYS.panelSize,
    STORAGE_KEYS.panelCollapsed
  ]);
  const position = stored[STORAGE_KEYS.panelPosition] as Partial<Pick<AssistantUiState, 'left' | 'top'>> | undefined;
  const size = stored[STORAGE_KEYS.panelSize] as Partial<Pick<AssistantUiState, 'width' | 'height'>> | undefined;
  const collapsed = stored[STORAGE_KEYS.panelCollapsed];

  return clampUiState({
    ...defaults,
    left: typeof position?.left === 'number' ? position.left : defaults.left,
    top: typeof position?.top === 'number' ? position.top : defaults.top,
    width: typeof size?.width === 'number' ? size.width : defaults.width,
    height: typeof size?.height === 'number' ? size.height : defaults.height,
    collapsed: typeof collapsed === 'boolean' ? collapsed : defaults.collapsed
  });
}

async function persistUiState() {
  await chrome.storage.local.set({
    [STORAGE_KEYS.panelPosition]: {
      left: Math.round(state.left),
      top: Math.round(state.top)
    },
    [STORAGE_KEYS.panelSize]: {
      width: Math.round(state.width),
      height: Math.round(state.height)
    },
    [STORAGE_KEYS.panelCollapsed]: state.collapsed
  });
}

function applyPanelPosition() {
  if (!panel) {
    return;
  }
  panel.style.left = `${Math.round(state.left)}px`;
  panel.style.top = `${Math.round(state.top)}px`;
  panel.style.setProperty('--mako-panel-width', `${Math.round(state.width)}px`);
  panel.style.height = state.collapsed ? '' : `${Math.round(state.height)}px`;
  panel.dataset.collapsed = String(state.collapsed);
}

function renderPanel() {
  const root = ensureRoot();
  root.layer.replaceChildren();

  panel = createElement('section', 'mako-ui-surface mako-assistant-panel');
  panel.setAttribute('aria-label', 'Mako IQ assistant');
  applyPanelPosition();

  const header = createElement('div', 'mako-assistant-header');
  const brand = createElement('div', 'mako-assistant-brand');
  brand.appendChild(createLogo());

  const copy = createElement('div', 'mako-assistant-copy');
  copy.appendChild(createElement('p', 'mako-assistant-kicker', 'Mako IQ'));
  copy.appendChild(createElement('h2', 'mako-assistant-title', 'Screen Assistant'));
  copy.appendChild(createElement('p', 'mako-assistant-subtitle', 'Scan, place answer bubbles, and rescan from here.'));
  brand.appendChild(copy);

  const controls = createElement('div', 'mako-assistant-controls');
  const collapseButton = createIconButton(state.collapsed ? 'Expand assistant' : 'Minimize assistant', state.collapsed ? '+' : '-');
  const closeButton = createIconButton('Close assistant', 'x');
  controls.append(collapseButton, closeButton);
  header.append(brand, controls);

  const body = createElement('div', 'mako-assistant-body');
  const statusSection = createElement('div', 'mako-ui-section mako-assistant-section');
  const statusRow = createElement('div', 'mako-assistant-status-row');
  const status = createElement('span', 'mako-ui-status-chip mako-assistant-status', state.status);
  status.dataset.tone = state.tone === 'warning' ? 'warning' : 'ready';
  statusRow.appendChild(status);
  statusSection.appendChild(statusRow);
  statusSection.appendChild(createElement('p', 'mako-assistant-message', state.lastSummary));
  body.appendChild(statusSection);

  const actionsSection = createElement('div', 'mako-ui-section mako-assistant-section');
  actionsSection.appendChild(createElement('p', 'mako-assistant-label', 'Actions'));
  const actions = createElement('div', 'mako-assistant-actions');
  const scanButton = createButton(state.lastCount === null ? 'Analyze Screen' : 'Scan Again', 'primary');
  const clearButton = createButton('Clear Bubbles');
  const workspaceButton = createButton('Open Workspace');
  const cancelButton = state.busy ? createButton('Cancel') : null;
  scanButton.disabled = state.busy;
  clearButton.disabled = state.busy;
  workspaceButton.disabled = state.busy;
  actions.append(scanButton, clearButton, workspaceButton);
  if (cancelButton) {
    actions.append(cancelButton);
  }
  actionsSection.appendChild(actions);
  body.appendChild(actionsSection);

  const metrics = createElement('div', 'mako-assistant-mini-grid');
  const bubbleMetric = createElement('div', 'mako-assistant-mini-card');
  bubbleMetric.appendChild(createElement('p', 'mako-assistant-label', 'Bubbles'));
  bubbleMetric.appendChild(createElement('strong', undefined, state.lastCount === null ? 'Not scanned' : String(state.lastCount)));
  const modeMetric = createElement('div', 'mako-assistant-mini-card');
  modeMetric.appendChild(createElement('p', 'mako-assistant-label', 'Mode'));
  modeMetric.appendChild(createElement('strong', undefined, 'Questions'));
  metrics.append(bubbleMetric, modeMetric);
  body.appendChild(metrics);

  panel.append(header, body);
  root.layer.appendChild(panel);
  applyPanelPosition();

  header.addEventListener('pointerdown', handleDragStart);
  header.addEventListener('pointermove', handleDragMove);
  header.addEventListener('pointerup', handleDragEnd);
  header.addEventListener('pointercancel', handleDragEnd);

  collapseButton.addEventListener('click', (event) => {
    event.stopPropagation();
    state = {
      ...state,
      ...clampUiState({
        ...state,
        collapsed: !state.collapsed
      })
    };
    applyPanelPosition();
    renderPanel();
    void persistUiState();
  });

  closeButton.addEventListener('click', (event) => {
    event.stopPropagation();
    hideAssistantPanel();
  });

  scanButton.addEventListener('click', (event) => {
    event.stopPropagation();
    void runScreenScan();
  });

  clearButton.addEventListener('click', (event) => {
    event.stopPropagation();
    void clearBubbles();
  });

  workspaceButton.addEventListener('click', (event) => {
    event.stopPropagation();
    void openWorkspace();
  });

  cancelButton?.addEventListener('click', (event) => {
    event.stopPropagation();
    void cancelScreenScan();
  });
}

function handleDragStart(event: PointerEvent) {
  if (event.button !== 0 || isInteractiveTarget(event.target)) {
    return;
  }

  drag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originLeft: state.left,
    originTop: state.top,
    rafId: null,
    nextLeft: state.left,
    nextTop: state.top
  };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function handleDragMove(event: PointerEvent) {
  if (!drag || drag.pointerId !== event.pointerId) {
    return;
  }

  const clamped = clampUiState({
    ...state,
    left: drag.originLeft + event.clientX - drag.startX,
    top: drag.originTop + event.clientY - drag.startY
  });

  drag.nextLeft = clamped.left;
  drag.nextTop = clamped.top;

  if (drag.rafId !== null) {
    return;
  }

  drag.rafId = window.requestAnimationFrame(() => {
    if (!drag) {
      return;
    }
    state = {
      ...state,
      left: drag.nextLeft,
      top: drag.nextTop
    };
    applyPanelPosition();
    drag.rafId = null;
  });
}

function handleDragEnd(event: PointerEvent) {
  if (!drag || drag.pointerId !== event.pointerId) {
    return;
  }

  if (drag.rafId !== null) {
    window.cancelAnimationFrame(drag.rafId);
  }

  const target = event.currentTarget as HTMLElement;
  try {
    target.releasePointerCapture(event.pointerId);
  } catch {
    // Pointer capture can already be released if the browser cancels the drag.
  }

  state = {
    ...state,
    left: drag.nextLeft,
    top: drag.nextTop
  };
  drag = null;
  applyPanelPosition();
  void persistUiState();
}

async function sendRuntimeMessage<T>(message: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: T) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function runScreenScan() {
  if (state.busy) {
    return;
  }

  const requestId = createRequestId();
  const scanStartedAt = performance.now();
  activeAssistantRequestId = requestId;
  logFrontendTiming('click-handler-start', { requestId, atMs: Math.round(scanStartedAt) });
  state = {
    ...state,
    busy: true,
    status: 'Scanning page',
    tone: 'ready',
    lastSummary: 'Scanning page for questions and answer choices...'
  };
  renderPanel();
  scheduleScanProgress(requestId);

  try {
    const response = await sendRuntimeMessage<ScreenAnalyzeActionResponse>({
      type: 'CAPTURE_VISIBLE_SCREEN',
      requestId
    });

    if (activeAssistantRequestId !== requestId) {
      return;
    }

    clearScanProgressTimers();
    logFrontendTiming('screen-analysis-response-received', {
      requestId,
      timing: response.timing,
      ok: response.ok,
      elapsedMs: Math.round(performance.now() - scanStartedAt)
    });
    const count = response.analysis?.ok ? response.analysis.items.length : null;
    state = {
      ...state,
      busy: false,
      status: response.ok ? 'Ready' : 'Needs review',
      tone: response.ok ? 'ready' : 'warning',
      lastCount: count,
      lastSummary: sanitizeText(
        response.message,
        response.ok ? 'Answer bubbles refreshed.' : 'Mako IQ could not analyze this screen.'
      )
    };
  } catch (error) {
    if (activeAssistantRequestId !== requestId) {
      return;
    }

    clearScanProgressTimers();
    state = {
      ...state,
      busy: false,
      status: 'Needs review',
      tone: 'warning',
      lastSummary: sanitizeText(error instanceof Error ? error.message : '', 'Mako IQ could not reach the AI service.')
    };
  }

  if (activeAssistantRequestId === requestId) {
    activeAssistantRequestId = null;
  }
  renderPanel();
}

async function cancelScreenScan() {
  const requestId = activeAssistantRequestId;
  if (!requestId) {
    return;
  }

  activeAssistantRequestId = null;
  clearScanProgressTimers();
  state = {
    ...state,
    busy: false,
    status: 'Cancelled',
    tone: 'warning',
    lastSummary: 'Screen scan cancelled.'
  };
  renderPanel();

  try {
    await sendRuntimeMessage({
      type: 'CANCEL_SCREEN_ANALYSIS',
      requestId
    });
  } catch {
    // The local UI has already cancelled this scan; the next result is ignored by request id.
  }
}

async function clearBubbles() {
  state = {
    ...state,
    busy: true,
    status: 'Clearing',
    tone: 'ready',
    lastSummary: 'Removing answer bubbles from the current page...'
  };
  renderPanel();

  try {
    const response = await sendRuntimeMessage<ScreenAnalyzeActionResponse>({
      type: 'CLEAR_ANSWER_BUBBLES',
      requestId: createRequestId()
    });
    state = {
      ...state,
      busy: false,
      status: response.ok ? 'Ready' : 'Needs review',
      tone: response.ok ? 'ready' : 'warning',
      lastCount: response.ok ? 0 : state.lastCount,
      lastSummary: sanitizeText(response.message, 'Answer bubbles cleared.')
    };
  } catch (error) {
    state = {
      ...state,
      busy: false,
      status: 'Needs review',
      tone: 'warning',
      lastSummary: sanitizeText(error instanceof Error ? error.message : '', 'Mako IQ could not clear answer bubbles.')
    };
  }

  renderPanel();
}

async function openWorkspace() {
  state = {
    ...state,
    busy: true,
    status: 'Opening',
    tone: 'ready',
    lastSummary: 'Opening the workspace for deeper review...'
  };
  renderPanel();

  try {
    const response = await sendRuntimeMessage<{ ok: boolean; message?: string; error?: string; reason?: string }>({
      type: 'OPEN_SIDEPANEL',
      requestId: createRequestId()
    });
    if (!response.ok) {
      state = {
        ...state,
        busy: false,
        status: 'Needs review',
        tone: 'warning',
        lastSummary: "Couldn't open workspace. Opening assistant panel instead."
      };
      renderPanel();
      return;
    }

    state = {
      ...state,
      busy: false,
      status: 'Ready',
      tone: 'ready',
      lastSummary: 'Workspace opened.'
    };
  } catch (error) {
    state = {
      ...state,
      busy: false,
      status: 'Needs review',
      tone: 'warning',
      lastSummary: sanitizeText(error instanceof Error ? error.message : '', 'Workspace could not open.')
    };
  }

  renderPanel();
}

export async function showAssistantPanel(options: { autoScan?: boolean } = {}): Promise<OverlayUpdateResponse> {
  ensureRoot();
  const storedUi = await readUiState();
  state = {
    ...state,
    ...storedUi
  };
  renderPanel();
  await persistUiState();

  if (options.autoScan) {
    void runScreenScan();
  }

  return {
    ok: true,
    visible: true,
    hostState: 'reused',
    message: 'Mako IQ assistant opened.'
  };
}

export function hideAssistantPanel(): OverlayUpdateResponse {
  if (layer) {
    layer.replaceChildren();
  }
  panel = null;
  drag = null;
  return {
    ok: true,
    visible: false,
    message: 'Mako IQ assistant closed.'
  };
}
