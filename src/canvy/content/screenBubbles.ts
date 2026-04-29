import { STORAGE_KEYS } from '../shared/constants';
import {
  buildFinalBubbleViewModel,
  normalizeConfidence,
  sanitizeDisplayText,
  shouldRetryLowConfidence,
  type FinalBubbleViewModel
} from '../shared/answerFormat';
import type {
  OverlayUpdateResponse,
  ScreenAnalysisItem,
  ScreenBubblePosition,
  ScreenBubblePositionMap,
  ScreenBubbleRenderPayload,
  ScreenFollowUpResponse,
  ScreenQuestionAnchor
} from '../shared/types';
import { buildScreenPageSignature } from './screenContext';
import {
  MAKO_OVERLAY_UI_CSS,
  createMakoActionButton,
  createMakoElement as createElement,
  createMakoIconButton
} from './overlayUi';

const OVERLAY_ROOT_ID = 'mako-iq-overlay-root';
const VIEWPORT_MARGIN = 16;
const BUBBLE_GAP = 12;
const SCREEN_BUBBLE_Z_INDEX = 2147483630;
const DEFAULT_BUBBLE_WIDTH = 340;
const DEFAULT_COLLAPSED_HEIGHT = 124;
const DEFAULT_EXPANDED_HEIGHT = 360;
const AVOID_RECT_LIMIT = 150;
const RESTRICTED_MESSAGE =
  'Mako IQ can help explain concepts or create study notes, but it will not provide live answers for restricted assessments.';

const SCREEN_BUBBLE_CSS = `
  ${MAKO_OVERLAY_UI_CSS}

  .mako-screen-layer {
    position: fixed;
    inset: 0;
    z-index: 2147483630;
    pointer-events: none;
  }

  .mako-screen-bubble {
    position: fixed;
    z-index: 2147483630;
    width: min(340px, calc(100vw - 32px));
    max-width: 360px;
    min-width: min(240px, calc(100vw - 32px));
    padding: 13px;
    pointer-events: auto;
    border-color: rgba(100, 245, 235, 0.26);
    border-radius: 26px;
    color: rgba(255, 255, 255, 0.96);
    transition:
      opacity 180ms ease,
      transform 180ms ease,
      border-color 180ms ease;
  }

  .mako-screen-bubble::after {
    content: "";
    position: absolute;
    left: -22px;
    top: 28px;
    width: 22px;
    height: 1px;
    background: linear-gradient(90deg, rgba(34, 211, 238, 0), rgba(103, 232, 249, 0.82));
    box-shadow: 0 0 18px rgba(34, 211, 238, 0.38);
  }

  .mako-screen-bubble[data-placement="left"]::after {
    left: auto;
    right: -22px;
    background: linear-gradient(90deg, rgba(103, 232, 249, 0.82), rgba(34, 211, 238, 0));
  }

  .mako-screen-bubble[data-placement="above"]::after,
  .mako-screen-bubble[data-placement="below"]::after,
  .mako-screen-bubble[data-placement="top-right"]::after,
  .mako-screen-bubble[data-placement="bottom-right"]::after,
  .mako-screen-bubble[data-placement="bottom-center"]::after,
  .mako-screen-bubble[data-placement="center-right"]::after,
  .mako-screen-bubble[data-placement="manual"]::after {
    display: none;
  }

  .mako-screen-bubble[data-stale="true"] {
    opacity: 0.34;
  }

  .mako-screen-bubble__drag {
    display: grid;
    gap: 8px;
    cursor: grab;
    user-select: none;
    touch-action: none;
  }

  .mako-screen-bubble__drag:active {
    cursor: grabbing;
  }

  .mako-screen-bubble__topline,
  .mako-screen-bubble__controls,
  .mako-screen-bubble__actions,
  .mako-screen-bubble__confidence {
    display: flex;
    align-items: center;
  }

  .mako-screen-bubble__topline {
    justify-content: space-between;
    gap: 10px;
  }

  .mako-screen-bubble__controls,
  .mako-screen-bubble__actions {
    gap: 8px;
    flex-wrap: wrap;
  }

  .mako-screen-bubble__controls {
    flex-shrink: 0;
  }

  .mako-screen-bubble--low-confidence {
    border-color: rgba(245, 158, 11, 0.30);
    border-radius: 20px;
    padding: 13px;
  }

  .mako-screen-bubble--low-confidence .mako-screen-bubble__drag {
    gap: 10px;
  }

  .mako-screen-bubble--low-confidence .mako-screen-bubble__topline {
    align-items: center;
  }

  .mako-screen-bubble--low-confidence .mako-screen-bubble__controls {
    gap: 8px;
    flex-wrap: nowrap;
  }

  .mako-screen-bubble__review-message {
    margin: 0;
    color: rgba(245, 248, 255, 0.82);
    font-size: 13px;
    line-height: 1.38;
    text-shadow: 0 1px 8px rgba(0, 0, 0, 0.34);
  }

  .mako-screen-bubble__review-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .mako-screen-bubble__title {
    margin: 0;
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #67efff;
    text-shadow: 0 0 16px rgba(103, 239, 255, 0.25);
  }

  .mako-screen-bubble__question {
    margin: 2px 0 0;
    color: rgba(245, 248, 255, 0.78);
    font-size: 12px;
    line-height: 1.35;
    text-shadow: 0 1px 8px rgba(0, 0, 0, 0.35);
  }

  .mako-screen-bubble__answer {
    margin: 4px 0 0;
    font-size: 15px;
    line-height: 1.35;
    font-weight: 750;
    color: rgba(255, 255, 255, 0.96);
    text-shadow: 0 1px 10px rgba(0, 0, 0, 0.45);
    white-space: pre-wrap;
  }

  .mako-screen-bubble__body {
    display: none;
    margin-top: 10px;
    gap: 10px;
  }

  .mako-screen-bubble[data-expanded="true"] .mako-screen-bubble__body {
    display: grid;
  }

  .mako-screen-bubble__section {
    padding: 10px;
    border-radius: 12px;
  }

  .mako-screen-bubble__label {
    margin: 0;
    color: var(--mako-text-muted);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  .mako-screen-bubble__explanation,
  .mako-screen-bubble__followup-result {
    margin: 0;
    font-size: 13px;
    line-height: 1.35;
    color: rgba(245, 248, 255, 0.78);
    text-shadow: 0 1px 8px rgba(0, 0, 0, 0.34);
    white-space: pre-wrap;
  }

  .mako-screen-bubble__confidence {
    gap: 6px;
    color: var(--mako-text-muted);
    font-size: 12px;
    white-space: nowrap;
  }

  .mako-screen-bubble__icon-button,
  .mako-screen-bubble__button {
    min-height: 38px;
  }

  .mako-screen-bubble__icon-button {
    width: 38px;
    min-width: 38px;
    padding: 0;
  }

  .mako-screen-bubble__button {
    padding: 0 12px;
    font-size: 12px;
    font-weight: 700;
  }

  .mako-screen-bubble__followup {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
  }

  .mako-screen-bubble__input {
    min-height: 36px;
    padding: 8px 10px;
    border-radius: 12px;
  }

  .mako-screen-empty,
  .mako-screen-status {
    position: fixed;
    right: 16px;
    bottom: 16px;
    width: min(340px, calc(100vw - 32px));
    z-index: 2147483630;
    padding: 12px 14px;
    border-radius: 16px;
    pointer-events: auto;
  }

  .mako-screen-empty strong,
  .mako-screen-status strong {
    display: block;
    font-size: 13px;
    line-height: 1.35;
    color: rgba(255, 255, 255, 0.96);
    text-shadow: 0 1px 10px rgba(0, 0, 0, 0.45);
  }

  .mako-screen-empty span,
  .mako-screen-status span {
    display: block;
    margin-top: 4px;
    color: rgba(245, 248, 255, 0.78);
    font-size: 12px;
    line-height: 1.4;
    text-shadow: 0 1px 8px rgba(0, 0, 0, 0.34);
  }

  .mako-screen-status {
    overflow: hidden;
    border-color: rgba(100, 245, 235, 0.26);
    pointer-events: none;
  }

  .mako-screen-status[data-status="thinking"] {
    pointer-events: auto;
  }

  .mako-screen-status[data-status="error"] {
    pointer-events: auto;
  }

  .mako-screen-status::after {
    content: "";
    position: absolute;
    inset: 0;
    background:
      linear-gradient(
        110deg,
        rgba(255, 255, 255, 0),
        rgba(103, 232, 249, 0.14),
        rgba(255, 255, 255, 0)
      );
    transform: translateX(-100%);
    animation: mako-screen-shimmer 1.2s linear infinite;
    pointer-events: none;
  }

  .mako-screen-status[data-status="error"]::after,
  .mako-screen-status[data-status="success"]::after {
    display: none;
  }

  .mako-screen-status__row {
    display: flex;
    align-items: center;
    gap: 9px;
  }

  .mako-screen-status__content {
    min-width: 0;
    flex: 1;
  }

  .mako-screen-status__topline {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .mako-screen-status__controls {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .mako-screen-status__hide {
    margin-top: 10px;
  }

  .mako-screen-status__dot {
    width: 9px;
    height: 9px;
    border-radius: 999px;
    background: #67efff;
    box-shadow: 0 0 18px rgba(103, 239, 255, 0.55);
    animation: mako-screen-pulse 950ms ease-in-out infinite;
  }

  .mako-screen-status[data-status="error"] .mako-screen-status__dot {
    background: #fb7185;
    box-shadow: 0 0 18px rgba(251, 113, 133, 0.42);
    animation: none;
  }

  @keyframes mako-screen-shimmer {
    to {
      transform: translateX(100%);
    }
  }

  @keyframes mako-screen-pulse {
    0%, 100% {
      opacity: 0.58;
      transform: scale(0.9);
    }
    50% {
      opacity: 1;
      transform: scale(1.08);
    }
  }

  @media (max-width: 640px) {
    .mako-screen-bubble {
      width: calc(100vw - 24px);
      left: 12px !important;
      right: auto !important;
    }
  }
`;

let shadowRoot: ShadowRoot | null = null;
let layer: HTMLElement | null = null;
let currentPayload: ScreenBubbleRenderPayload | null = null;
let positionsCache: ScreenBubblePositionMap = {};
let frozenPlacementCache: Record<string, { left: number; top: number; placement: string }> = {};
let scrollListenerAttached = false;
let screenScanInFlight = false;
let repositionTimer: number | undefined;
let pointerTrackingAttached = false;
let lastPointer: { x: number; y: number; at: number } | null = null;
let thinkingPopupsHidden = readThinkingPopupPreference();
const dismissedThinkingKeys = new Set<string>();
const overlayInstances = new Map<string, OverlayInstanceRecord>();

type ScreenScanStatus = 'idle' | 'scanning' | 'thinking' | 'success' | 'partial' | 'error';
type ManagedBubbleType = 'thinking' | 'final';

interface RenderStatusOptions {
  requestId?: string;
  questionHash?: string;
  anchor?: ScreenQuestionAnchor;
}

interface OverlayRect {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

interface BubbleRecord {
  bubble: HTMLElement;
  item: ScreenAnalysisItem;
  index: number;
  payload: ScreenBubbleRenderPayload;
  questionHash: string;
}

interface OverlayInstanceRecord {
  bubble: HTMLElement;
  questionHash: string;
  bubbleType: ManagedBubbleType;
  requestId?: string;
  locked: boolean;
}

let activeBubbleRecords: BubbleRecord[] = [];

function createRequestId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function sanitizeText(value: string | undefined, fallback = '') {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function truncateText(value: string, maxLength: number) {
  const text = sanitizeText(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}...` : text;
}

function readThinkingPopupPreference() {
  try {
    return localStorage.getItem('mako.thinkingPopupsHidden') === '1';
  } catch {
    return false;
  }
}

function writeThinkingPopupPreference(hidden: boolean) {
  thinkingPopupsHidden = hidden;
  try {
    localStorage.setItem('mako.thinkingPopupsHidden', hidden ? '1' : '0');
  } catch {
    // Some LMS pages restrict storage access. The in-memory preference still applies.
  }
}

function logOverlay(event: string, payload: Record<string, unknown>) {
  console.info(`[MakoIQ Overlay] ${event}`, payload);
}

function logAnswer(event: string, payload: Record<string, unknown>) {
  console.info(`[MakoIQ Answer] ${event}`, payload);
}

function isDebugPerfEnabled() {
  try {
    return Boolean(import.meta.env.DEV || localStorage.getItem('MAKO_DEBUG_PERF') === '1');
  } catch {
    return Boolean(import.meta.env.DEV);
  }
}

function getPositionKey(analysisId: string, itemId: string) {
  return `${analysisId}:${itemId}`;
}

function getQuestionHashForItem(item: ScreenAnalysisItem) {
  const id = sanitizeDisplayText(item.id);
  if (id) {
    return id;
  }

  return sanitizeDisplayText(item.question).toLowerCase().slice(0, 160);
}

function getQuestionDedupeKey(item: ScreenAnalysisItem) {
  const normalizedQuestion = sanitizeDisplayText(item.question).toLowerCase().slice(0, 240);
  const id = sanitizeDisplayText(item.id);
  if (id && !/^q_\d+$/i.test(id) && id.length > 10) {
    return id;
  }

  return normalizedQuestion || id;
}

function getOverlayInstanceKey(questionHash: string, bubbleType: ManagedBubbleType) {
  return `${questionHash || 'global'}:${bubbleType}`;
}

function createIconButton(label: string, text: string) {
  return createMakoIconButton(label, text, 'mako-screen-bubble__icon-button');
}

function createActionButton(label: string) {
  return createMakoActionButton(label, 'secondary', 'mako-screen-bubble__button');
}

function createPrimaryActionButton(label: string) {
  return createMakoActionButton(label, 'primary', 'mako-screen-bubble__button');
}

function ensureRoot() {
  if (shadowRoot && layer) {
    return { shadowRoot, layer };
  }

  let host = document.getElementById(OVERLAY_ROOT_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = OVERLAY_ROOT_ID;
    host.style.position = 'fixed';
    host.style.inset = '0';
    host.style.pointerEvents = 'none';
    document.documentElement.appendChild(host);
  }
  host.style.zIndex = String(SCREEN_BUBBLE_Z_INDEX);
  host.style.pointerEvents = 'none';

  shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  if (!shadowRoot.querySelector('style[data-mako-screen-bubbles]')) {
    const style = document.createElement('style');
    style.setAttribute('data-mako-screen-bubbles', 'true');
    style.textContent = SCREEN_BUBBLE_CSS;
    shadowRoot.appendChild(style);
  }

  layer = shadowRoot.querySelector<HTMLElement>('[data-mako-screen-layer]');
  if (!layer) {
    layer = createElement('div', 'mako-ui-layer mako-screen-layer');
    layer.setAttribute('data-mako-screen-layer', 'true');
    shadowRoot.appendChild(layer);
  }

  return { shadowRoot, layer };
}

function isInteractiveTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('button, input, textarea, select, a, [data-mako-interactive="true"]'));
}

async function readPositions() {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.screenBubblePositions]);
  positionsCache = (stored[STORAGE_KEYS.screenBubblePositions] as ScreenBubblePositionMap | undefined) ?? {};
  return positionsCache;
}

async function persistPosition(analysisId: string, itemId: string, position: ScreenBubblePosition) {
  positionsCache = {
    ...positionsCache,
    [getPositionKey(analysisId, itemId)]: position
  };
  await chrome.storage.local.set({
    [STORAGE_KEYS.screenBubblePositions]: positionsCache
  });
}

function ensurePointerTracking() {
  if (pointerTrackingAttached) {
    return;
  }

  pointerTrackingAttached = true;
  window.addEventListener(
    'pointerdown',
    (event) => {
      if (event.target instanceof Element && event.target.closest('#mako-iq-overlay-root')) {
        return;
      }
      lastPointer = {
        x: event.clientX,
        y: event.clientY,
        at: Date.now()
      };
    },
    { passive: true, capture: true }
  );
}

function isManualPositioned(bubble: HTMLElement) {
  return bubble.dataset.userMoved === 'true';
}

function isPositionLocked(bubble: HTMLElement) {
  return bubble.dataset.positionLocked === 'true';
}

function readBubbleRect(bubble: HTMLElement, fallbackWidth = DEFAULT_BUBBLE_WIDTH, fallbackHeight = DEFAULT_COLLAPSED_HEIGHT) {
  const left = Number.parseFloat(bubble.style.left);
  const top = Number.parseFloat(bubble.style.top);
  const width = bubble.offsetWidth || fallbackWidth;
  const height = bubble.offsetHeight || fallbackHeight;

  if (!Number.isFinite(left) || !Number.isFinite(top) || left < -1000 || top < -1000) {
    return null;
  }

  return toOverlayRect({ left, top, width, height });
}

function rememberFrozenPlacement(questionHash: string, bubble: HTMLElement) {
  const rect = readBubbleRect(bubble);
  if (!rect || !questionHash) {
    return;
  }

  frozenPlacementCache = {
    ...frozenPlacementCache,
    [questionHash]: {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      placement: bubble.getAttribute('data-placement') || 'manual'
    }
  };
}

function applyFrozenPlacement(questionHash: string, bubble: HTMLElement, occupiedRects: OverlayRect[] = []) {
  const frozen = frozenPlacementCache[questionHash];
  if (!frozen) {
    return false;
  }

  const width = bubble.offsetWidth || DEFAULT_BUBBLE_WIDTH;
  const expanded = bubble.getAttribute('data-expanded') === 'true';
  const height = bubble.offsetHeight || (expanded ? DEFAULT_EXPANDED_HEIGHT : DEFAULT_COLLAPSED_HEIGHT);
  const left = clamp(frozen.left, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN));
  const top = clamp(frozen.top, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN));
  bubble.style.left = `${Math.round(left)}px`;
  bubble.style.top = `${Math.round(top)}px`;
  bubble.dataset.positionLocked = 'true';
  bubble.dataset.smartPositioned = 'false';
  bubble.setAttribute('data-placement', frozen.placement || 'manual');
  occupiedRects.push(toOverlayRect({ left, top, width, height }));
  return true;
}

function applyBubblePosition(
  bubble: HTMLElement,
  item: ScreenAnalysisItem,
  _index: number,
  payload: ScreenBubbleRenderPayload,
  occupiedRects: OverlayRect[] = []
) {
  const width = bubble.offsetWidth || DEFAULT_BUBBLE_WIDTH;
  const expanded = bubble.getAttribute('data-expanded') === 'true';
  const height = bubble.offsetHeight || (expanded ? DEFAULT_EXPANDED_HEIGHT : DEFAULT_COLLAPSED_HEIGHT);
  const questionHash = getQuestionHashForItem(item);

  if (isPositionLocked(bubble)) {
    const rect = readBubbleRect(bubble, width, height);
    if (rect) {
      occupiedRects.push(rect);
      return;
    }
  }

  if (applyFrozenPlacement(questionHash, bubble, occupiedRects)) {
    return;
  }

  const positionKey = getPositionKey(payload.analysis.analysisId, item.id);
  const storedPosition = positionsCache[positionKey];

  if (storedPosition) {
    const left = clamp(storedPosition.left, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN));
    const top = clamp(storedPosition.top, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN));
    bubble.style.left = `${Math.round(left)}px`;
    bubble.style.top = `${Math.round(top)}px`;
    bubble.dataset.userMoved = 'true';
    bubble.dataset.positionLocked = 'true';
    bubble.dataset.smartPositioned = 'false';
    bubble.setAttribute('data-placement', 'manual');
    occupiedRects.push(toOverlayRect({ left, top, width, height }));
    rememberFrozenPlacement(questionHash, bubble);
    return;
  }

  const anchorRect = getAnchorRect(item);
  const avoidRects = [...collectAvoidRects(anchorRect), ...occupiedRects];
  const position = getBestOverlayPosition(anchorRect, { width, height }, avoidRects);
  bubble.style.left = `${position.left}px`;
  bubble.style.top = `${position.top}px`;
  bubble.dataset.userMoved = 'false';
  bubble.dataset.smartPositioned = 'true';
  bubble.dataset.positionLocked = 'true';
  bubble.setAttribute('data-placement', position.name);
  occupiedRects.push(toOverlayRect({ left: position.left, top: position.top, width, height }));
  rememberFrozenPlacement(questionHash, bubble);

  if (isDebugPerfEnabled()) {
    console.info('[MakoIQ Perf]', {
      stage: 'overlay-position',
      itemId: item.id,
      placement: position.name,
      score: Math.round(position.score),
      avoidRects: avoidRects.length,
      hasAnchor: Boolean(anchorRect)
    });
  }
}

function repositionActiveBubbles() {
  if (!activeBubbleRecords.length) {
    return;
  }

  const occupiedRects: OverlayRect[] = [];
  activeBubbleRecords.forEach((record) => {
    if (!record.bubble.isConnected || isManualPositioned(record.bubble) || isPositionLocked(record.bubble)) {
      return;
    }
    applyBubblePosition(record.bubble, record.item, record.index, record.payload, occupiedRects);
  });
}

function scheduleReposition() {
  if (repositionTimer !== undefined) {
    window.clearTimeout(repositionTimer);
  }

  repositionTimer = window.setTimeout(() => {
    repositionTimer = undefined;
    repositionActiveBubbles();
  }, 120);
}

function hasUsableBbox(item: ScreenAnalysisItem) {
  return Boolean(
    item.bbox &&
      Number.isFinite(item.bbox.x) &&
      Number.isFinite(item.bbox.y) &&
      Number.isFinite(item.bbox.width) &&
      Number.isFinite(item.bbox.height) &&
      item.bbox.width > 0 &&
      item.bbox.height > 0
  );
}

function toOverlayRect(rect: Pick<OverlayRect, 'left' | 'top' | 'width' | 'height'>): OverlayRect {
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height
  };
}

function getAnchorRect(item: ScreenAnalysisItem): OverlayRect | null {
  const anchorRect = item.anchor?.rect;
  if (
    anchorRect &&
    Number.isFinite(anchorRect.left) &&
    Number.isFinite(anchorRect.top) &&
    anchorRect.width > 0 &&
    anchorRect.height > 0
  ) {
    const scrollDeltaX = window.scrollX - (item.anchor?.scroll.x ?? window.scrollX);
    const scrollDeltaY = window.scrollY - (item.anchor?.scroll.y ?? window.scrollY);
    return toOverlayRect({
      left: anchorRect.left - scrollDeltaX,
      top: anchorRect.top - scrollDeltaY,
      width: anchorRect.width,
      height: anchorRect.height
    });
  }

  if (!hasUsableBbox(item) || !item.bbox) {
    return null;
  }

  return toOverlayRect({
    left: item.bbox.x * window.innerWidth,
    top: item.bbox.y * window.innerHeight,
    width: item.bbox.width * window.innerWidth,
    height: item.bbox.height * window.innerHeight
  });
}

function getAnchorRectFromAnchor(anchor?: ScreenQuestionAnchor): OverlayRect | null {
  const anchorRect = anchor?.rect;
  if (!anchorRect || !Number.isFinite(anchorRect.left) || !Number.isFinite(anchorRect.top) || anchorRect.width <= 0 || anchorRect.height <= 0) {
    return null;
  }

  const scrollDeltaX = window.scrollX - (anchor?.scroll.x ?? window.scrollX);
  const scrollDeltaY = window.scrollY - (anchor?.scroll.y ?? window.scrollY);
  return toOverlayRect({
    left: anchorRect.left - scrollDeltaX,
    top: anchorRect.top - scrollDeltaY,
    width: anchorRect.width,
    height: anchorRect.height
  });
}

function overlapArea(a: OverlayRect, b: OverlayRect) {
  const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return width * height;
}

function rectDistance(a: OverlayRect, b: OverlayRect) {
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  const bx = b.left + b.width / 2;
  const by = b.top + b.height / 2;
  return Math.hypot(ax - bx, ay - by);
}

function clampRectToViewport(candidate: { name: string; left: number; top: number }, width: number, height: number) {
  return {
    name: candidate.name,
    left: Math.round(clamp(candidate.left, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN))),
    top: Math.round(clamp(candidate.top, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN)))
  };
}

function getElementRect(element: Element): OverlayRect | null {
  const htmlElement = element as HTMLElement;
  if (
    htmlElement.hidden ||
    htmlElement.getAttribute('aria-hidden') === 'true' ||
    htmlElement.closest('#mako-iq-overlay-root, #mako-iq-assistant-root, #canvy-output-overlay-host, #walt-overlay-root')
  ) {
    return null;
  }

  const style = window.getComputedStyle(htmlElement);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return null;
  }

  const rect = htmlElement.getBoundingClientRect();
  if (
    rect.width < 6 ||
    rect.height < 6 ||
    rect.bottom < 0 ||
    rect.right < 0 ||
    rect.top > window.innerHeight ||
    rect.left > window.innerWidth ||
    rect.width > window.innerWidth ||
    rect.height > window.innerHeight * 0.82
  ) {
    return null;
  }

  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    right: rect.right,
    bottom: rect.bottom
  };
}

function collectAvoidRects(anchorRect: OverlayRect | null) {
  const selectors = [
    'button',
    'a',
    'input',
    'select',
    'textarea',
    'label',
    '[role="button"]',
    '[role="radio"]',
    '[role="checkbox"]',
    '[role="option"]',
    '[tabindex]',
    '[data-answer-id]',
    '[data-answer-index]',
    '.ic-Button',
    '.Button',
    '.btn',
    '.quiz_button',
    '.next',
    '.previous',
    '.submit',
    '.answers .answer',
    '.answer_label',
    '.choice',
    '.option',
    '[class*="answer" i]',
    '[class*="choice" i]',
    '[class*="option" i]',
    '[class*="card" i]',
    '[class*="tile" i]',
    '[data-testid]',
    '[aria-label]'
  ].join(', ');
  const elements = Array.from(document.querySelectorAll(selectors)).slice(0, 520);
  const scored: Array<{ rect: OverlayRect; score: number }> = [];
  const seen = new Set<string>();

  elements.forEach((element) => {
    const rect = getElementRect(element);
    if (!rect) {
      return;
    }

    const key = `${Math.round(rect.left)}:${Math.round(rect.top)}:${Math.round(rect.width)}:${Math.round(rect.height)}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);

    const text = `${element.textContent ?? ''} ${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('title') ?? ''} ${
      typeof element.className === 'string' ? element.className : ''
    }`.toLowerCase();
    const isNavigationControl = /\b(next|previous|submit|continue|save|back|quiz|question|attempt)\b/.test(text);
    const distance = anchorRect ? rectDistance(rect, anchorRect) : 0;
    scored.push({
      rect,
      score: (isNavigationControl ? -500 : 0) + distance
    });
  });

  return scored
    .sort((a, b) => a.score - b.score)
    .slice(0, AVOID_RECT_LIMIT)
    .map((entry) => entry.rect);
}

function scoreOverlayCandidate(candidate: OverlayRect, anchorRect: OverlayRect | null, avoidRects: OverlayRect[], name: string) {
  const overlayArea = Math.max(1, candidate.width * candidate.height);
  const distancePenalty = anchorRect ? rectDistance(candidate, anchorRect) * 0.22 : 0;
  const anchorOverlap = anchorRect ? overlapArea(candidate, anchorRect) : 0;
  const anchorOverlapPenalty = anchorOverlap > 0 ? 6_000 + (anchorOverlap / overlayArea) * 4_000 : 0;
  const avoidPenalty = avoidRects.reduce((total, rect) => {
    const overlap = overlapArea(candidate, rect);
    return total + (overlap > 0 ? 4_500 + Math.min(1, overlap / overlayArea) * 3_000 : 0);
  }, 0);
  const sideBonus =
    name === 'right'
      ? 180
      : name === 'below'
        ? 145
        : name === 'bottom-right'
          ? 115
          : name === 'center-right'
            ? 95
            : name === 'top-right'
              ? 80
              : name === 'left' || name === 'above'
                ? 45
                : 0;
  const safeZonePenalty = name === 'bottom-center' ? 90 : 0;
  const pointerPenalty =
    lastPointer && Date.now() - lastPointer.at < 2500 && lastPointer.x >= candidate.left - 12 && lastPointer.x <= candidate.right + 12
      ? lastPointer.y >= candidate.top - 12 && lastPointer.y <= candidate.bottom + 12
        ? 340
        : 0
      : 0;

  return 1000 + sideBonus - safeZonePenalty - distancePenalty - anchorOverlapPenalty - avoidPenalty - pointerPenalty;
}

function getBestOverlayPosition(anchorRect: OverlayRect | null, overlaySize: { width: number; height: number }, avoidRects: OverlayRect[]) {
  const width = overlaySize.width || DEFAULT_BUBBLE_WIDTH;
  const height = overlaySize.height || DEFAULT_COLLAPSED_HEIGHT;
  const fallbackAnchor =
    anchorRect ??
    toOverlayRect({
      left: window.innerWidth * 0.5 - 1,
      top: window.innerHeight * 0.45 - 1,
      width: 2,
      height: 2
    });
  const candidates = [
    { name: 'right', left: fallbackAnchor.right + BUBBLE_GAP, top: fallbackAnchor.top },
    { name: 'below', left: fallbackAnchor.left, top: fallbackAnchor.bottom + BUBBLE_GAP },
    { name: 'bottom-right', left: window.innerWidth - width - VIEWPORT_MARGIN, top: window.innerHeight - height - VIEWPORT_MARGIN },
    { name: 'center-right', left: window.innerWidth - width - VIEWPORT_MARGIN, top: Math.max(VIEWPORT_MARGIN, fallbackAnchor.bottom + BUBBLE_GAP) },
    { name: 'top-right', left: window.innerWidth - width - VIEWPORT_MARGIN, top: fallbackAnchor.top },
    { name: 'left', left: fallbackAnchor.left - width - BUBBLE_GAP, top: fallbackAnchor.top },
    { name: 'above', left: fallbackAnchor.left, top: fallbackAnchor.top - height - BUBBLE_GAP },
    { name: 'bottom-center', left: (window.innerWidth - width) / 2, top: window.innerHeight - height - VIEWPORT_MARGIN }
  ];

  return candidates
    .map((candidate) => clampRectToViewport(candidate, width, height))
    .map((candidate) => {
      const rect = toOverlayRect({ left: candidate.left, top: candidate.top, width, height });
      return {
        ...candidate,
        rect,
        score: scoreOverlayCandidate(rect, anchorRect, avoidRects, candidate.name)
      };
    })
    .sort((a, b) => b.score - a.score)[0];
}

async function copyAnswer(text: string, statusElement: HTMLElement) {
  try {
    await navigator.clipboard.writeText(text);
    statusElement.textContent = 'Copied.';
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.documentElement.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
    statusElement.textContent = 'Copied.';
  }
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

async function requestScreenScan(statusElement: HTMLElement, controls: HTMLButtonElement[] = []) {
  if (screenScanInFlight) {
    statusElement.textContent = 'A scan is already running.';
    return;
  }

  screenScanInFlight = true;
  const previousLabels = controls.map((button) => button.textContent ?? '');
  controls.forEach((button, index) => {
    button.disabled = true;
    if (index === 0) {
      button.textContent = 'Scanning...';
    }
  });
  statusElement.textContent = 'Scanning current screen...';

  try {
    const response = await sendRuntimeMessage<{ ok: boolean; message?: string; error?: string }>({
      type: 'CAPTURE_VISIBLE_SCREEN',
      requestId: createRequestId()
    });
    statusElement.textContent = response.ok
      ? response.message ?? 'Answer bubbles refreshed.'
      : response.error ?? response.message ?? 'Mako IQ could not analyze this screen.';
  } catch (error) {
    statusElement.textContent = error instanceof Error ? error.message : 'Mako IQ could not analyze this screen.';
  } finally {
    screenScanInFlight = false;
    controls.forEach((button, index) => {
      button.disabled = false;
      button.textContent = previousLabels[index] ?? button.textContent;
    });
  }
}

function attachDragHandlers(bubble: HTMLElement, dragHandle: HTMLElement, analysisId: string, itemId: string) {
  let drag:
    | {
        pointerId: number;
        startX: number;
        startY: number;
        originLeft: number;
        originTop: number;
      }
    | null = null;

  dragHandle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || isInteractiveTarget(event.target)) {
      return;
    }

    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originLeft: Number.parseFloat(bubble.style.left) || 0,
      originTop: Number.parseFloat(bubble.style.top) || 0
    };
    dragHandle.setPointerCapture(event.pointerId);
  });

  dragHandle.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    const width = bubble.offsetWidth || DEFAULT_BUBBLE_WIDTH;
    const height = bubble.offsetHeight || DEFAULT_COLLAPSED_HEIGHT;
    const left = clamp(drag.originLeft + event.clientX - drag.startX, VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
    const top = clamp(drag.originTop + event.clientY - drag.startY, VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);
    bubble.style.left = `${Math.round(left)}px`;
    bubble.style.top = `${Math.round(top)}px`;
    bubble.dataset.userMoved = 'true';
    bubble.dataset.positionLocked = 'true';
    bubble.dataset.smartPositioned = 'false';
    bubble.setAttribute('data-placement', 'manual');
  });

  const finishDrag = (event: PointerEvent) => {
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    drag = null;
    try {
      dragHandle.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released when the browser cancels the drag.
    }
    void persistPosition(analysisId, itemId, {
      left: Math.round(Number.parseFloat(bubble.style.left) || 0),
      top: Math.round(Number.parseFloat(bubble.style.top) || 0)
    });
    const record = activeBubbleRecords.find((entry) => entry.bubble === bubble);
    rememberFrozenPlacement(record?.questionHash ?? itemId, bubble);
  };

  dragHandle.addEventListener('pointerup', finishDrag);
  dragHandle.addEventListener('pointercancel', finishDrag);
}

function setExpanded(bubble: HTMLElement, item: ScreenAnalysisItem, index: number, expanded: boolean) {
  bubble.setAttribute('data-expanded', String(expanded));
  if (!currentPayload || isManualPositioned(bubble) || isPositionLocked(bubble)) {
    return;
  }

  window.requestAnimationFrame(() => {
    if (currentPayload && bubble.isConnected && !isManualPositioned(bubble)) {
      applyBubblePosition(bubble, item, index, currentPayload);
    }
  });
}

function renderAnswerBubble(
  item: ScreenAnalysisItem,
  index: number,
  payload: ScreenBubbleRenderPayload,
  viewModel = buildViewModelForItem(item)
) {
  const questionHash = getQuestionHashForItem(item);
  const bubble = createElement('section', 'mako-ui-surface mako-screen-bubble');
  bubble.setAttribute('aria-label', 'Mako IQ answer bubble');
  bubble.setAttribute('data-expanded', 'false');
  bubble.setAttribute('data-question-hash', questionHash);
  bubble.setAttribute('data-bubble-type', 'final');
  bubble.setAttribute('data-render-state', viewModel.status);
  bubble.style.left = '-10000px';
  bubble.style.top = '-10000px';
  bubble.style.visibility = 'hidden';

  const dragHandle = createElement('div', 'mako-screen-bubble__drag');
  const topLine = createElement('div', 'mako-screen-bubble__topline');
  const titleWrap = createElement('div');
  titleWrap.appendChild(createElement('p', 'mako-screen-bubble__title', viewModel.displayTitle));

  const controls = createElement('div', 'mako-screen-bubble__controls');
  const confidence = createElement('span', 'mako-ui-status-chip mako-screen-bubble__confidence');
  confidence.dataset.tone = viewModel.confidenceTone;
  confidence.textContent = viewModel.confidenceLabel;

  const expandButton = createIconButton('Expand answer', '+');
  const hideButton = createIconButton('Hide answer', 'x');
  controls.append(confidence, expandButton, hideButton);
  topLine.append(titleWrap, controls);
  dragHandle.appendChild(topLine);

  const answerPreview = createElement('p', 'mako-screen-bubble__answer', truncateText(viewModel.displayAnswer, 132));
  dragHandle.appendChild(answerPreview);
  bubble.appendChild(dragHandle);

  const body = createElement('div', 'mako-screen-bubble__body');

  const answerSection = createElement('div', 'mako-ui-section mako-screen-bubble__section');
  answerSection.appendChild(createElement('p', 'mako-screen-bubble__label', viewModel.displayTitle));
  answerSection.appendChild(createElement('p', 'mako-screen-bubble__answer', viewModel.displayAnswer));
  body.appendChild(answerSection);

  if (viewModel.shouldShowQuestionInExpanded) {
    const questionSection = createElement('div', 'mako-ui-section mako-screen-bubble__section');
    questionSection.appendChild(createElement('p', 'mako-screen-bubble__label', 'Question'));
    questionSection.appendChild(createElement('p', 'mako-screen-bubble__question', truncateText(viewModel.questionText, 320)));
    body.appendChild(questionSection);
  }

  if (item.needsMoreContext || viewModel.displayMode === 'low-confidence' || viewModel.displayMode === 'invalid') {
    const contextSection = createElement('div', 'mako-ui-section mako-screen-bubble__section');
    contextSection.appendChild(createElement('p', 'mako-screen-bubble__label', 'Confidence'));
    contextSection.appendChild(
      createElement(
        'p',
        'mako-screen-bubble__explanation',
        viewModel.displayMode === 'low-confidence' || viewModel.displayMode === 'invalid'
          ? 'I could not verify this answer confidently.'
          : 'The visible screen may not include enough context for a reliable final answer.'
      )
    );
    body.appendChild(contextSection);
  }

  const explanationSection = createElement('div', 'mako-ui-section mako-screen-bubble__section');
  explanationSection.appendChild(createElement('p', 'mako-screen-bubble__label', 'Why this fits'));
  const explanation = createElement('p', 'mako-screen-bubble__explanation', viewModel.explanation);
  explanationSection.appendChild(explanation);
  body.appendChild(explanationSection);
  let explainMoreLoaded = false;

  function requestExplainMore() {
    if (explainMoreLoaded) {
      return;
    }

    explainMoreLoaded = true;
    explanation.textContent = 'Getting a clearer explanation...';
    chrome.runtime.sendMessage(
      {
        type: 'ASK_BUBBLE_FOLLOWUP',
        analysisId: payload.analysis.analysisId,
        itemId: item.id,
        question: 'Explain why this answer is the best choice.',
        originalQuestion: item.question,
        originalAnswer: viewModel.displayAnswer
      },
      (response: ScreenFollowUpResponse | undefined) => {
        if (!response?.ok) {
          explanation.textContent = viewModel.explanation || response?.message || 'Mako IQ could not load a deeper explanation.';
          explainMoreLoaded = false;
          return;
        }

        explanation.textContent = response.explanation || response.answer;
      }
    );
  }

  const followUpResult = createElement('p', 'mako-screen-bubble__followup-result');
  const followUpForm = createElement('form', 'mako-screen-bubble__followup');
  const followUpInput = createElement('input', 'mako-ui-input mako-screen-bubble__input');
  followUpInput.placeholder = 'Ask a follow-up...';
  followUpInput.type = 'text';
  const followUpButton = createActionButton('Ask');
  followUpForm.append(followUpInput, followUpButton);

  const actions = createElement('div', 'mako-screen-bubble__actions');
  const copyButton = createActionButton('Copy');
  const scanButton = createActionButton('Scan Again');
  const explanationToggle = createActionButton('Hide explanation');
  const statusText = createElement('span', 'mako-screen-bubble__explanation');
  actions.append(scanButton, copyButton, explanationToggle);
  body.append(followUpForm, followUpResult, actions, statusText);
  bubble.appendChild(body);

  expandButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const expanded = bubble.getAttribute('data-expanded') !== 'true';
    setExpanded(bubble, item, index, expanded);
    expandButton.textContent = expanded ? '-' : '+';
    expandButton.title = expanded ? 'Collapse answer' : 'Expand answer';
    expandButton.setAttribute('aria-label', expanded ? 'Collapse answer' : 'Expand answer');
    if (expanded) {
      requestExplainMore();
    }
  });

  hideButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    bubble.remove();
    activeBubbleRecords = activeBubbleRecords.filter((record) => record.bubble !== bubble);
    overlayInstances.delete(getOverlayInstanceKey(questionHash, 'final'));
    logOverlay('removeBubble', {
      requestId: payload.scanId ?? payload.analysis.analysisId,
      questionHash,
      bubbleType: 'final'
    });
  });

  scanButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void requestScreenScan(statusText, [scanButton]);
  });

  copyButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void copyAnswer(viewModel.copyText, statusText);
  });

  explanationToggle.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const hidden = explanationSection.style.display === 'none';
    explanationSection.style.display = hidden ? '' : 'none';
    explanationToggle.textContent = hidden ? 'Hide explanation' : 'Show explanation';
  });

  followUpForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const question = followUpInput.value.trim();
    if (!question) {
      return;
    }

    followUpButton.textContent = 'Asking...';
    followUpButton.disabled = true;
    followUpResult.textContent = '';

    chrome.runtime.sendMessage(
      {
        type: 'ASK_BUBBLE_FOLLOWUP',
        analysisId: payload.analysis.analysisId,
        itemId: item.id,
        question,
        originalQuestion: item.question,
        originalAnswer: viewModel.displayAnswer
      },
      (response: ScreenFollowUpResponse | undefined) => {
        followUpButton.disabled = false;
        followUpButton.textContent = 'Ask';

        if (!response?.ok) {
          followUpResult.textContent = response?.message ?? 'Mako IQ could not answer this follow-up.';
          return;
        }

        followUpInput.value = '';
        followUpResult.textContent = response.explanation
          ? `${response.answer}\n\n${response.explanation}`
          : response.answer;
      }
    );
  });

  attachDragHandlers(bubble, dragHandle, payload.analysis.analysisId, item.id);
  bubble.addEventListener('dblclick', (event) => {
    if (isInteractiveTarget(event.target)) {
      return;
    }
    const expanded = bubble.getAttribute('data-expanded') !== 'true';
    setExpanded(bubble, item, index, expanded);
    expandButton.textContent = expanded ? '-' : '+';
    expandButton.title = expanded ? 'Collapse answer' : 'Expand answer';
    expandButton.setAttribute('aria-label', expanded ? 'Collapse answer' : 'Expand answer');
    if (expanded) {
      requestExplainMore();
    }
  });

  return bubble;
}

function shouldRenderLowConfidenceBubble(item: ScreenAnalysisItem, viewModel: FinalBubbleViewModel) {
  return (
    viewModel.displayMode === 'low-confidence' ||
    viewModel.displayMode === 'invalid' ||
    viewModel.status !== 'answered' ||
    (item.needsMoreContext && !sanitizeText(item.answer))
  );
}

function renderLowConfidenceBubble(
  item: ScreenAnalysisItem,
  index: number,
  payload: ScreenBubbleRenderPayload,
  viewModel: FinalBubbleViewModel
) {
  const questionHash = getQuestionHashForItem(item);
  const requestId = payload.scanId ?? payload.analysis.analysisId;
  const bubble = createElement('section', 'mako-ui-surface mako-screen-bubble mako-screen-bubble--low-confidence');
  bubble.setAttribute('aria-label', 'Mako IQ low confidence result');
  bubble.setAttribute('data-expanded', 'false');
  bubble.setAttribute('data-question-hash', questionHash);
  bubble.setAttribute('data-bubble-type', 'final');
  bubble.setAttribute('data-render-state', 'low-confidence');
  bubble.style.left = '-10000px';
  bubble.style.top = '-10000px';
  bubble.style.visibility = 'hidden';

  const dragHandle = createElement('div', 'mako-screen-bubble__drag');
  const topLine = createElement('div', 'mako-screen-bubble__topline');
  const titleWrap = createElement('div');
  titleWrap.appendChild(createElement('p', 'mako-screen-bubble__title', 'LOW CONFIDENCE'));

  const controls = createElement('div', 'mako-screen-bubble__controls');
  const expandButton = createIconButton('Show details', '+');
  const hideButton = createIconButton('Close', 'X');
  controls.append(expandButton, hideButton);
  topLine.append(titleWrap, controls);
  dragHandle.appendChild(topLine);

  const reviewMessage = createElement('p', 'mako-screen-bubble__review-message', 'I could not verify this answer confidently.');
  const actions = createElement('div', 'mako-screen-bubble__review-actions');
  const scanButton = createPrimaryActionButton('Rescan');
  const statusText = createElement('span', 'mako-screen-bubble__explanation');
  actions.append(scanButton);
  dragHandle.append(reviewMessage, actions, statusText);
  bubble.appendChild(dragHandle);

  const details = createElement('div', 'mako-screen-bubble__body');
  const detailSection = createElement('div', 'mako-ui-section mako-screen-bubble__section');
  detailSection.appendChild(createElement('p', 'mako-screen-bubble__label', 'Details'));
  detailSection.appendChild(
    createElement(
      'p',
      'mako-screen-bubble__explanation',
      viewModel.explanation || 'The visible question data was not reliable enough to show an answer as correct.'
    )
  );
  if (viewModel.answerText) {
    detailSection.appendChild(createElement('p', 'mako-screen-bubble__question', truncateText(viewModel.answerText, 220)));
  }
  details.appendChild(detailSection);
  bubble.appendChild(details);

  expandButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const expanded = bubble.getAttribute('data-expanded') !== 'true';
    setExpanded(bubble, item, index, expanded);
    expandButton.textContent = expanded ? '-' : '+';
    expandButton.title = expanded ? 'Hide details' : 'Show details';
    expandButton.setAttribute('aria-label', expanded ? 'Hide details' : 'Show details');
  });

  hideButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    bubble.remove();
    activeBubbleRecords = activeBubbleRecords.filter((record) => record.bubble !== bubble);
    overlayInstances.delete(getOverlayInstanceKey(questionHash, 'final'));
    logOverlay('removeBubble', {
      requestId,
      questionHash,
      bubbleType: 'final'
    });
  });

  scanButton.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void requestScreenScan(statusText, [scanButton]);
  });

  attachDragHandlers(bubble, dragHandle, payload.analysis.analysisId, item.id);
  bubble.addEventListener('dblclick', (event) => {
    if (isInteractiveTarget(event.target)) {
      return;
    }
    const expanded = bubble.getAttribute('data-expanded') !== 'true';
    setExpanded(bubble, item, index, expanded);
    expandButton.textContent = expanded ? '-' : '+';
    expandButton.title = expanded ? 'Hide details' : 'Show details';
    expandButton.setAttribute('aria-label', expanded ? 'Hide details' : 'Show details');
  });

  console.info('[MakoIQ Bubble] rendering low-confidence', {
    requestId,
    questionHash,
    questionTextLength: item.question.length,
    modelConfidence: item.confidence,
    displayConfidence: viewModel.confidence,
    failReason: item.needsMoreContext ? 'LOW_CONFIDENCE' : viewModel.displayMode
  });

  return bubble;
}

function createBubble(item: ScreenAnalysisItem, index: number, payload: ScreenBubbleRenderPayload) {
  const viewModel = buildViewModelForItem(item);
  if (shouldRenderLowConfidenceBubble(item, viewModel)) {
    return renderLowConfidenceBubble(item, index, payload, viewModel);
  }

  return renderAnswerBubble(item, index, payload, viewModel);
}

function createEmptyState(summary: string, warnings: string[]) {
  const notice = createElement('div', 'mako-ui-surface mako-screen-empty');
  const isRestricted = warnings.includes('RESTRICTED_ASSESSMENT');
  notice.appendChild(createElement('strong', undefined, isRestricted ? 'Restricted assessment support' : 'No answer bubbles placed'));
  notice.appendChild(createElement('span', undefined, isRestricted ? RESTRICTED_MESSAGE : summary || 'No clear questions found on this screen.'));
  if (!isRestricted) {
    const actions = createElement('div', 'mako-screen-bubble__actions');
    actions.style.marginTop = '10px';
    const scanButton = createActionButton('Scan Again');
    const statusText = createElement('span', 'mako-screen-bubble__explanation');
    actions.append(scanButton);
    notice.append(actions, statusText);
    scanButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void requestScreenScan(statusText, [scanButton]);
    });
  }
  return notice;
}

function normalizeRenderStatusOptions(options?: ScreenQuestionAnchor | RenderStatusOptions): RenderStatusOptions {
  if (!options) {
    return {};
  }

  if ('rect' in options || 'scroll' in options) {
    return {
      anchor: options as ScreenQuestionAnchor
    };
  }

  return options as RenderStatusOptions;
}

function placeStatusNotice(notice: HTMLElement, questionHash: string, anchor?: ScreenQuestionAnchor) {
  if (questionHash && applyFrozenPlacement(questionHash, notice)) {
    return;
  }

  const anchorRect = getAnchorRectFromAnchor(anchor);
  if (anchorRect) {
    const width = notice.offsetWidth || DEFAULT_BUBBLE_WIDTH;
    const height = notice.offsetHeight || 78;
    const position = getBestOverlayPosition(anchorRect, { width, height }, collectAvoidRects(anchorRect));
    notice.style.right = 'auto';
    notice.style.bottom = 'auto';
    notice.style.left = `${position.left}px`;
    notice.style.top = `${position.top}px`;
    notice.dataset.positionLocked = 'true';
    notice.setAttribute('data-placement', position.name);
    if (questionHash) {
      rememberFrozenPlacement(questionHash, notice);
    }
  }
}

function removeThinkingInstances() {
  overlayInstances.forEach((record, key) => {
    if (record.bubbleType !== 'thinking') {
      return;
    }

    record.bubble.remove();
    overlayInstances.delete(key);
  });
}

function renderStatusBubble(status: ScreenScanStatus, message: string, options: RenderStatusOptions) {
  const notice = createElement('div', 'mako-ui-surface mako-screen-status');
  notice.dataset.status = status;
  if (options.questionHash) {
    notice.dataset.questionHash = options.questionHash;
  }

  const row = createElement('div', 'mako-screen-status__row');
  row.appendChild(createElement('i', 'mako-screen-status__dot'));

  const content = createElement('div', 'mako-screen-status__content');
  const topLine = createElement('div', 'mako-screen-status__topline');
  const title = createElement(
    'strong',
    undefined,
    status === 'thinking'
      ? 'Thinking...'
      : status === 'error'
        ? 'Scan needs attention'
        : status === 'partial'
          ? 'Partial answer'
          : status === 'idle'
            ? 'Quiz Mode'
            : 'Scanning page...'
  );
  topLine.appendChild(title);

  if (status === 'thinking') {
    const controls = createElement('div', 'mako-screen-status__controls');
    const closeButton = createIconButton('Close thinking popup', 'x');
    controls.appendChild(closeButton);
    topLine.appendChild(controls);
    closeButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const questionHash = options.questionHash || options.requestId || 'global-thinking';
      dismissedThinkingKeys.add(questionHash);
      notice.remove();
      overlayInstances.delete(getOverlayInstanceKey(questionHash, 'thinking'));
      logOverlay('removeBubble', {
        requestId: options.requestId,
        questionHash,
        bubbleType: 'thinking'
      });
    });
  }

  content.appendChild(topLine);
  const body = createElement('span', undefined, message);
  body.dataset.makoStatusMessage = 'true';
  content.appendChild(body);
  row.appendChild(content);
  notice.appendChild(row);

  if (status === 'thinking') {
    const hideButton = createActionButton('Hide thinking popups');
    hideButton.classList.add('mako-screen-status__hide');
    notice.appendChild(hideButton);
    hideButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      writeThinkingPopupPreference(true);
      removeThinkingInstances();
      logOverlay('removeBubble', {
        requestId: options.requestId,
        questionHash: options.questionHash,
        bubbleType: 'thinking',
        reason: 'thinking-popups-hidden'
      });
    });
  }

  if (status === 'error') {
    const actions = createElement('div', 'mako-screen-bubble__actions');
    actions.style.marginTop = '10px';
    const scanButton = createActionButton('Rescan');
    const statusText = createElement('span', 'mako-screen-bubble__explanation');
    actions.append(scanButton);
    notice.append(actions, statusText);
    scanButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void requestScreenScan(statusText, [scanButton]);
    });
  }

  return notice;
}

function renderThinkingBubble(message: string, options: RenderStatusOptions) {
  return renderStatusBubble('thinking', message, options);
}

function renderErrorBubble(message: string, options: RenderStatusOptions) {
  return renderStatusBubble('error', message, options);
}

function createStatusNotice(status: ScreenScanStatus, message: string, options: RenderStatusOptions) {
  if (status === 'thinking') {
    return renderThinkingBubble(message, options);
  }

  if (status === 'error') {
    return renderErrorBubble(message, options);
  }

  return renderStatusBubble(status, message, options);
}

export function renderScreenScanStatus(
  status: ScreenScanStatus,
  message: string,
  options?: ScreenQuestionAnchor | RenderStatusOptions
): OverlayUpdateResponse {
  const root = ensureRoot();
  const renderOptions = normalizeRenderStatusOptions(options);
  const questionHash = renderOptions.questionHash || renderOptions.requestId || 'global-thinking';

  if (status === 'thinking') {
    if (thinkingPopupsHidden || dismissedThinkingKeys.has(questionHash)) {
      const existing = overlayInstances.get(getOverlayInstanceKey(questionHash, 'thinking'));
      existing?.bubble.remove();
      overlayInstances.delete(getOverlayInstanceKey(questionHash, 'thinking'));
      logOverlay('removeBubble', {
        requestId: renderOptions.requestId,
        questionHash,
        bubbleType: 'thinking',
        reason: thinkingPopupsHidden ? 'thinking-popups-hidden' : 'dismissed-for-question'
      });
      return {
        ok: true,
        visible: false,
        message
      };
    }

    const key = getOverlayInstanceKey(questionHash, 'thinking');
    const existing = overlayInstances.get(key);
    if (existing?.bubble.isConnected) {
      const body = existing.bubble.querySelector<HTMLElement>('[data-mako-status-message="true"]');
      if (body) {
        body.textContent = message;
      }
      logOverlay('updateBubble', {
        requestId: renderOptions.requestId,
        questionHash,
        bubbleType: 'thinking'
      });
      return {
        ok: true,
        visible: true,
        message
      };
    }

    root.layer.replaceChildren();
    overlayInstances.clear();
    activeBubbleRecords = [];
    const notice = createStatusNotice(status, message, { ...renderOptions, questionHash });
    root.layer.appendChild(notice);
    placeStatusNotice(notice, questionHash, renderOptions.anchor);
    overlayInstances.set(key, {
      bubble: notice,
      questionHash,
      bubbleType: 'thinking',
      requestId: renderOptions.requestId,
      locked: true
    });
    logOverlay('createBubble', {
      requestId: renderOptions.requestId,
      questionHash,
      bubbleType: 'thinking'
    });

    currentPayload = null;
    return {
      ok: true,
      visible: true,
      message
    };
  }

  const notice = createStatusNotice(status, message, renderOptions);
  root.layer.replaceChildren(notice);
  overlayInstances.clear();
  placeStatusNotice(notice, renderOptions.questionHash || '', renderOptions.anchor);
  currentPayload = null;
  activeBubbleRecords = [];

  return {
    ok: true,
    visible: true,
    reason: status === 'error' ? 'insufficient_context' : undefined,
    message
  };
}

function ensureScrollListener() {
  if (scrollListenerAttached) {
    return;
  }

  scrollListenerAttached = true;
  window.addEventListener('scroll', scheduleReposition, { passive: true });
  window.addEventListener('resize', scheduleReposition, { passive: true });
}

function buildViewModelForItem(item: ScreenAnalysisItem): FinalBubbleViewModel {
  return buildFinalBubbleViewModel({
    questionHash: getQuestionHashForItem(item),
    question: item.question,
    answer: item.answer,
    answerChoice: item.answerChoice,
    confidence: item.confidence,
    explanation: item.explanation,
    needsMoreContext: item.needsMoreContext
  });
}

function dedupeAnswerItems(items: ScreenAnalysisItem[], requestId: string) {
  const byQuestion = new Map<string, ScreenAnalysisItem>();
  let duplicateCount = 0;

  items.forEach((item) => {
    const questionHash = getQuestionDedupeKey(item);
    const existing = byQuestion.get(questionHash);
    if (!existing) {
      byQuestion.set(questionHash, item);
      return;
    }

    duplicateCount += 1;
    const existingConfidence = normalizeConfidence(existing.confidence, 0);
    const nextConfidence = normalizeConfidence(item.confidence, 0);
    if (nextConfidence > existingConfidence) {
      byQuestion.set(questionHash, item);
    }
  });

  if (duplicateCount > 0) {
    console.info('[MakoIQ Bubble] suppressing duplicate', {
      requestId,
      duplicateCount
    });
  }

  return {
    items: Array.from(byQuestion.values()),
    duplicateCount
  };
}

export async function renderAnswerBubbles(payload: ScreenBubbleRenderPayload): Promise<OverlayUpdateResponse> {
  const root = ensureRoot();
  const requestId = payload.scanId ?? payload.analysis.analysisId;
  if (payload.pageSignature && payload.pageSignature !== buildScreenPageSignature()) {
    root.layer.replaceChildren();
    currentPayload = null;
    activeBubbleRecords = [];
    overlayInstances.clear();
    return {
      ok: false,
      visible: false,
      reason: 'stale_anchors',
      message: 'The page changed before the answer could render. Scan the current question again.'
    };
  }

  currentPayload = payload;
  await readPositions();
  const hadThinking = Array.from(overlayInstances.values()).some((record) => record.bubbleType === 'thinking');
  root.layer.replaceChildren();
  activeBubbleRecords = [];
  overlayInstances.clear();
  ensurePointerTracking();
  if (hadThinking) {
    console.info('[MakoIQ Bubble] replacing thinking with final state', {
      requestId,
      itemCount: payload.analysis.items.length
    });
  }

  logAnswer('rawPayload', {
    requestId,
    itemCount: payload.analysis.items.length,
    items: payload.analysis.items.map((item) => ({
      questionHash: getQuestionHashForItem(item),
      answer: item.answer,
      answerChoice: item.answerChoice,
      confidence: item.confidence
    }))
  });

  const candidateItems = payload.analysis.items.filter((item) => {
    const viewModel = buildViewModelForItem(item);
    return Boolean(sanitizeText(item.question) && (sanitizeText(item.answer) || shouldRenderLowConfidenceBubble(item, viewModel)));
  });
  const { items: validItems, duplicateCount } = dedupeAnswerItems(candidateItems, requestId);
  const viewModels = new Map(validItems.map((item) => [item.id, buildViewModelForItem(item)]));

  logAnswer('normalizedPayload', {
    requestId,
    duplicateCount,
    items: validItems.map((item) => {
      const viewModel = viewModels.get(item.id) ?? buildViewModelForItem(item);
      return {
        questionHash: getQuestionHashForItem(item),
        normalizedAnswerLabel: viewModel.answerLabel,
        normalizedAnswerText: viewModel.answerText,
        confidence: viewModel.confidence,
        displayMode: viewModel.displayMode
      };
    })
  });

  if (!validItems.length) {
    root.layer.appendChild(createEmptyState(payload.analysis.summary, payload.analysis.warnings));
    ensureScrollListener();
    return {
      ok: true,
      visible: true,
      reason: payload.analysis.warnings.includes('RESTRICTED_ASSESSMENT') ? 'insufficient_context' : 'no_questions',
      message: payload.analysis.warnings.includes('RESTRICTED_ASSESSMENT') ? RESTRICTED_MESSAGE : 'No clear questions found on this screen.'
    };
  }

  const occupiedRects: OverlayRect[] = [];
  validItems.forEach((item, index) => {
    const questionHash = getQuestionHashForItem(item);
    const viewModel = viewModels.get(item.id) ?? buildViewModelForItem(item);
    if (shouldRetryLowConfidence(viewModel.confidence)) {
      console.info('[MakoIQ QuizMode] lowConfidence', {
        requestId,
        questionHash,
        confidence: viewModel.confidence,
        normalizedAnswerLabel: viewModel.answerLabel,
        normalizedAnswerText: viewModel.answerText
      });
    }

    const bubble = createBubble(item, index, payload);
    root.layer.appendChild(bubble);
    applyBubblePosition(bubble, item, index, payload, occupiedRects);
    bubble.style.visibility = '';
    activeBubbleRecords.push({ bubble, item, index, payload, questionHash });
    overlayInstances.set(getOverlayInstanceKey(questionHash, 'final'), {
      bubble,
      questionHash,
      bubbleType: 'final',
      requestId,
      locked: true
    });
    logOverlay('createBubble', {
      requestId,
      questionHash,
      bubbleType: 'final',
      confidence: viewModel.confidence,
      normalizedAnswerLabel: viewModel.answerLabel,
      normalizedAnswerText: viewModel.answerText
    });
    logOverlay('replaceBubble', {
      requestId,
      questionHash,
      bubbleType: 'final',
      confidence: viewModel.confidence,
      normalizedAnswerLabel: viewModel.answerLabel,
      normalizedAnswerText: viewModel.answerText,
      duplicateCount
    });
  });
  ensureScrollListener();

  return {
    ok: true,
    visible: true,
    message: `${validItems.length} answer bubble${validItems.length === 1 ? '' : 's'} placed on the screen.`
  };
}

export function clearAnswerBubbles(): OverlayUpdateResponse {
  ensureRoot().layer.replaceChildren();
  const removedCount = overlayInstances.size + activeBubbleRecords.length;
  currentPayload = null;
  activeBubbleRecords = [];
  overlayInstances.clear();
  logOverlay('removeBubble', {
    bubbleType: 'all',
    duplicateCount: removedCount
  });
  return {
    ok: true,
    visible: false,
    message: 'Answer bubbles cleared.'
  };
}

export function readViewport() {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
    scrollX: window.scrollX,
    scrollY: window.scrollY
  };
}
