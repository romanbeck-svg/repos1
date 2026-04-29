import { createMessage, createDefaultSession, createDefaultSettings, STORAGE_KEYS } from '../shared/constants';
import { resolveApiBaseUrl } from '../shared/config';
import { hashText } from '../shared/perf';
import { normalizeAnswerPayload, normalizeConfidence, shouldRetryLowConfidence } from '../shared/answerFormat';
import { createCanvyApiClient, CanvyApiError } from '../shared/apiClient';
import {
  AnalysisApiError,
  analyzeQuizWithBackend,
  analyzeScreenshotWithBackend,
  analyzeWithBackend,
  askScreenFollowUpWithBackend,
  streamAnalysisWithBackend
} from '../services/api';
import { buildPageAnalysis } from '../shared/analysis';
import {
  buildAnalysisCacheKey,
  createAnalysisRunSnapshot,
  extractPartialStructuredPreview,
  failAnalysisRunSnapshot,
  finalizeAnalysisRunSnapshot,
  getCachedAnalysis,
  updateAnalysisRunSnapshot,
  upsertAnalysisCache
} from '../shared/analysisSession';
import { classifyTaskType } from '../classification/classifyTaskType';
import { routeWorkflow } from '../routing/routeWorkflow';
import { deriveWorkflowState, runWorkflowAction } from '../workflow/deriveWorkflowState';
import { detectAssistantMode, getLaunchSupport } from '../shared/lms';
import { createRequestDiagnostic, logTrace, logTraceError } from '../shared/requestDiagnostics';
import { persistWorkflowState } from '../shared/workflow/workflowStorage';
import {
  clearLauncherWindowState,
  getExtensionState,
  getSettings,
  getLauncherWindowState,
  migrateLegacyStorageKeys,
  saveLatestScan,
  saveLauncherWindowState,
  savePageState,
  saveSession,
  saveSettings,
  saveWorkflowState,
  setScanState
} from '../shared/storage';
import { createStalePageState, hasFreshScan } from '../state/pageState';
import type {
  AnalysisCacheStatus,
  AnalysisMode,
  AnalysisRunSnapshot,
  AnalysisTimingMetrics,
  RequestDiagnosticEvent,
  AttachStatus,
  BackendConnectionStatus,
  BootstrapPayload,
  CanvasContext,
  CanvasApiSummary,
  CanvySettings,
  CanvyTaskKind,
  ConfigureResponse,
  ImageScanRequest,
  LauncherWindowBounds,
  LauncherWindowState,
  OpenCanvyFailureReason,
  OpenCanvyResult,
  OverlayFailureReason,
  OverlayStatus,
  OverlayUpdateResponse,
  LaunchConfigurationStatus,
  PageAnalysisResult,
  PageContextSummary,
  PingResponse,
  PopupStatus,
  ReconnectBackendResponse,
  ScreenAnalyzeActionResponse,
  ScreenAnalysisItemType,
  ScreenAnswerCacheEntry,
  ScreenBubbleRenderPayload,
  ScreenAnalysisTiming,
  ScreenImageMetadata,
  ScreenPreScanCacheEntry,
  ScreenTextContext,
  ScreenFollowUpResponse,
  ScreenViewport,
  ScanPagePayload,
  ScanResponse,
  SidebarMode,
  StructuredAnalysisOutput,
  TaskOutput,
  WorkflowActionId,
  WorkflowState
} from '../shared/types';
import type {
  QuizAnalyzeRequestPayload,
  QuizAnalyzeResponse,
  QuizBoundingBox,
  QuizFailReason,
  QuizPrefetchRequestMessage,
  QuizPrefetchResponse,
  QuizQuestionExtraction
} from '../shared/quizTypes';

const DEFAULT_SHORTCUT_HINT = 'Ctrl+Shift+Y';
const DEFAULT_LAUNCHER_PATH = 'launcher.html';
const DEFAULT_ACTION_POPUP_PATH = '';
const DEFAULT_SIDEPANEL_PATH = 'sidepanel.html';
const DEFAULT_LAUNCHER_WIDTH = 440;
const DEFAULT_LAUNCHER_HEIGHT = 720;
const MIN_LAUNCHER_WIDTH = 400;
const MIN_LAUNCHER_HEIGHT = 560;
const LAUNCHER_MARGIN = 20;
const PANEL_OPEN_TIMEOUT_MS = 1800;
const ATTACH_PING_TIMEOUT_MS = 900;
const ATTACH_RETRY_DELAYS_MS = [180, 360, 720];
const TAB_READY_TIMEOUT_MS = 3200;
const LOW_TEXT_FALLBACK_THRESHOLD = 80;
const LOW_WORD_COUNT_FALLBACK_THRESHOLD = 10;
const MEANINGFUL_DOM_TEXT_THRESHOLD = 110;
const MEANINGFUL_DOM_WORD_THRESHOLD = 16;
const OCR_TEXT_IMPROVEMENT_THRESHOLD = 40;
const OCR_WORD_IMPROVEMENT_THRESHOLD = 8;
const DIAGNOSTIC_EVENT_LIMIT = 24;
const SCREEN_CAPTURE_QUALITY = 72;
const SCREEN_UPLOAD_QUALITY = 0.72;
const SCREEN_MAX_IMAGE_WIDTH = 1280;
const SCREEN_CONTEXT_TIMEOUT_MS = 650;
const SCREEN_DUPLICATE_CACHE_TTL_MS = 4 * 60 * 1000;
const SCREEN_PRESCAN_CACHE_TTL_MS = 10 * 60 * 1000;
const ACTIVE_SCREEN_SCAN_TTL_MS = 2 * 60 * 1000;
const DOM_CONTEXT_PLACEHOLDER_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const inflightOperations = new Map<string, Promise<unknown>>();
const activeAnalysisControllers = new Map<string, AbortController>();
const activeAnalysisRequests = new Map<string, string>();
const screenAnalysisControllers = new Map<number, AbortController>();
const activeScreenRequests = new Map<number, string>();
const lastScreenRequestStartedAt = new Map<number, number>();
let hasLoggedResolvedApiBase = false;

interface OptimizedScreenshot {
  dataUrl: string;
  meta: ScreenImageMetadata;
}

interface ScreenAnalysisCacheEntry {
  key: string;
  pageUrl: string;
  pageSignature?: string;
  analysis: ScreenBubbleRenderPayload['analysis'];
  renderPayload: ScreenBubbleRenderPayload;
  createdAt: number;
  expiresAt: number;
}

const screenAnalysisCache = new Map<number, ScreenAnalysisCacheEntry>();

interface QuizModeCacheEntry {
  url: string;
  questionHash: string;
  extractedQuestion: QuizQuestionExtraction;
  aiAnswer: QuizAnalyzeResponse;
  renderPayload: ScreenBubbleRenderPayload;
  createdAt: number;
  expiresAt: number;
}

const QUIZ_MODE_CACHE_TTL_MS = 8 * 60 * 1000;
const quizModeCache = new Map<number, QuizModeCacheEntry>();
const activeQuizRequests = new Map<number, string>();
const activeQuizQuestionHashes = new Map<number, string>();
const quizModeControllers = new Map<number, AbortController>();

function createRequestId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === 'string' ? error : 'Unknown error';
}

function isContentUnavailableError(message: string) {
  return /Could not establish connection|Receiving end does not exist|The message port closed before a response was received/i.test(message);
}

function normalizeExtensionPath(pathValue: string | undefined, fallback: string) {
  const source = (pathValue ?? '').trim();
  if (!source) {
    return fallback;
  }

  if (!source.includes('://')) {
    return source.replace(/^\/+/, '') || fallback;
  }

  try {
    const url = new URL(source);
    return url.pathname.replace(/^\/+/, '') || fallback;
  } catch {
    return fallback;
  }
}

function isExtensionPageUrl(url: string | undefined) {
  if (!url) {
    return false;
  }

  return url.startsWith(chrome.runtime.getURL(''));
}

function normalizeLauncherWindowBounds(bounds: Partial<LauncherWindowState> | null | undefined): LauncherWindowBounds | null {
  if (
    typeof bounds?.left !== 'number' ||
    typeof bounds.top !== 'number' ||
    typeof bounds.width !== 'number' ||
    typeof bounds.height !== 'number'
  ) {
    return null;
  }

  return {
    left: Math.round(bounds.left),
    top: Math.round(bounds.top),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function clampLauncherWindowBounds(
  bounds: LauncherWindowBounds,
  anchor?: chrome.windows.Window
): LauncherWindowBounds {
  const anchorLeft = typeof anchor?.left === 'number' ? anchor.left : 60;
  const anchorTop = typeof anchor?.top === 'number' ? anchor.top : 60;
  const anchorWidth = typeof anchor?.width === 'number' ? anchor.width : DEFAULT_LAUNCHER_WIDTH + 240;
  const anchorHeight = typeof anchor?.height === 'number' ? anchor.height : DEFAULT_LAUNCHER_HEIGHT + 140;
  const maxWidth = Math.max(MIN_LAUNCHER_WIDTH, anchorWidth - LAUNCHER_MARGIN * 2);
  const maxHeight = Math.max(MIN_LAUNCHER_HEIGHT, anchorHeight - LAUNCHER_MARGIN * 2);
  const width = clamp(bounds.width, MIN_LAUNCHER_WIDTH, maxWidth);
  const height = clamp(bounds.height, MIN_LAUNCHER_HEIGHT, maxHeight);
  const minLeft = anchorLeft + LAUNCHER_MARGIN;
  const minTop = anchorTop + LAUNCHER_MARGIN;
  const maxLeft = anchorLeft + Math.max(LAUNCHER_MARGIN, anchorWidth - width - LAUNCHER_MARGIN);
  const maxTop = anchorTop + Math.max(LAUNCHER_MARGIN, anchorHeight - height - LAUNCHER_MARGIN);

  return {
    left: clamp(bounds.left, minLeft, maxLeft),
    top: clamp(bounds.top, minTop, maxTop),
    width,
    height
  };
}

function buildDefaultLauncherBounds(anchor?: chrome.windows.Window): LauncherWindowBounds {
  const anchorLeft = typeof anchor?.left === 'number' ? anchor.left : 60;
  const anchorTop = typeof anchor?.top === 'number' ? anchor.top : 60;
  const anchorWidth = typeof anchor?.width === 'number' ? anchor.width : DEFAULT_LAUNCHER_WIDTH + 240;
  const anchorHeight = typeof anchor?.height === 'number' ? anchor.height : DEFAULT_LAUNCHER_HEIGHT + 140;
  const width = clamp(DEFAULT_LAUNCHER_WIDTH, MIN_LAUNCHER_WIDTH, Math.max(MIN_LAUNCHER_WIDTH, anchorWidth - LAUNCHER_MARGIN * 2));
  const height = clamp(DEFAULT_LAUNCHER_HEIGHT, MIN_LAUNCHER_HEIGHT, Math.max(MIN_LAUNCHER_HEIGHT, anchorHeight - LAUNCHER_MARGIN * 2));

  return clampLauncherWindowBounds(
    {
      left: anchorLeft + Math.max(LAUNCHER_MARGIN, anchorWidth - width - 42),
      top: anchorTop + 56,
      width,
      height
    },
    anchor
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logDebug(event: string, payload: Record<string, unknown> = {}) {
  console.info(`[Mako IQ background] ${event}`, payload);
}

function logScreenTiming(settings: Pick<CanvySettings, 'debugMode'> | undefined, tag: string, payload: Record<string, unknown>) {
  if (!settings?.debugMode) {
    return;
  }

  traceBackgroundEvent(`screen:timing:${tag}`, payload);
}

function estimateDataUrlBytes(dataUrl: string) {
  const base64 = dataUrl.split(',', 2)[1] ?? '';
  if (!base64) {
    return dataUrl.length;
  }

  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function detectImageFormat(dataUrl: string): ScreenImageMetadata['format'] {
  if (/^data:image\/jpe?g/i.test(dataUrl)) {
    return 'jpeg';
  }

  if (/^data:image\/png/i.test(dataUrl)) {
    return 'png';
  }

  if (/^data:image\/webp/i.test(dataUrl)) {
    return 'webp';
  }

  return 'unknown';
}

function hashStringSample(value: string) {
  return hashText(value);
}

async function blobToDataUrl(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return `data:${blob.type || 'image/jpeg'};base64,${btoa(binary)}`;
}

async function optimizeScreenshotDataUrl(dataUrl: string): Promise<OptimizedScreenshot> {
  const fallbackMeta: ScreenImageMetadata = {
    format: detectImageFormat(dataUrl),
    source: 'screenshot',
    originalBytes: estimateDataUrlBytes(dataUrl),
    bytes: estimateDataUrlBytes(dataUrl),
    resized: false
  };

  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
    return {
      dataUrl,
      meta: fallbackMeta
    };
  }

  let bitmap: ImageBitmap | null = null;

  try {
    const originalBlob = await fetch(dataUrl).then((response) => response.blob());
    bitmap = await createImageBitmap(originalBlob);
    const originalWidth = bitmap.width;
    const originalHeight = bitmap.height;
    const scale = originalWidth > SCREEN_MAX_IMAGE_WIDTH ? SCREEN_MAX_IMAGE_WIDTH / originalWidth : 1;
    const width = Math.max(1, Math.round(originalWidth * scale));
    const height = Math.max(1, Math.round(originalHeight * scale));
    const shouldResize = scale < 1;
    const shouldReencode = shouldResize || detectImageFormat(dataUrl) !== 'jpeg';

    if (!shouldReencode) {
      return {
        dataUrl,
        meta: {
          ...fallbackMeta,
          source: 'screenshot',
          originalWidth,
          originalHeight,
          width: originalWidth,
          height: originalHeight,
          quality: SCREEN_UPLOAD_QUALITY,
          resized: false
        }
      };
    }

    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) {
      return {
        dataUrl,
        meta: {
          ...fallbackMeta,
          source: 'screenshot',
          originalWidth,
          originalHeight,
          width: originalWidth,
          height: originalHeight
        }
      };
    }

    context.drawImage(bitmap, 0, 0, width, height);
    const optimizedBlob = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: SCREEN_UPLOAD_QUALITY
    });
    const optimizedDataUrl = await blobToDataUrl(optimizedBlob);

    return {
      dataUrl: optimizedDataUrl,
      meta: {
        format: 'jpeg',
        source: 'screenshot',
        originalWidth,
        originalHeight,
        width,
        height,
        quality: SCREEN_UPLOAD_QUALITY,
        originalBytes: estimateDataUrlBytes(dataUrl),
        bytes: estimateDataUrlBytes(optimizedDataUrl),
        resized: shouldResize
      }
    };
  } catch (error) {
    traceBackgroundError('screen:image-optimize:error', {
      detail: getErrorMessage(error)
    });
    return {
      dataUrl,
      meta: fallbackMeta
    };
  } finally {
    bitmap?.close();
  }
}

function hasFastDomQuestionContext(textContext?: ScreenTextContext) {
  if (!textContext) {
    return false;
  }

  const structuredQuestions = textContext.structuredExtraction?.questions ?? [];
  if (
    structuredQuestions.some((question) => {
      const hasQuestion = question.question.trim().length >= 8;
      const hasChoices = question.choices.length >= 2;
      const confidentShortPrompt = question.questionType === 'short_answer' && question.confidence >= 0.55;
      return hasQuestion && (hasChoices || confidentShortPrompt);
    })
  ) {
    return true;
  }

  return textContext.questionCandidates.some((candidate) => {
    const hasQuestion = candidate.question.trim().length >= 8;
    const hasChoices = candidate.answerChoices.length >= 2;
    const hasNearbyContext = candidate.nearbyText.join(' ').length >= 80 || textContext.visibleText.length >= 180;
    return hasQuestion && (hasChoices || hasNearbyContext) && (candidate.confidence ?? 0.5) >= 0.45;
  });
}

function hasAnyUsableScreenContext(textContext?: ScreenTextContext) {
  if (!textContext) {
    return false;
  }

  if (hasFastDomQuestionContext(textContext)) {
    return true;
  }

  const selectedText = textContext.selectedText?.trim() ?? '';
  const fallbackText = textContext.visibleText.trim();
  return selectedText.length >= 30 || /\?|which of the following|choose|select|solve|determine|identify/i.test(fallbackText);
}

function shouldRetryScreenAnalysisWithScreenshot(analysis: Awaited<ReturnType<typeof analyzeScreenshotWithBackend>>, optimized: OptimizedScreenshot) {
  if (optimized.meta.source !== 'dom_context' || !analysis.ok) {
    return false;
  }

  if (!analysis.items.length) {
    return true;
  }

  return analysis.items.some((item) => item.needsMoreContext || normalizeConfidence(item.confidence, 0) < 0.55);
}

function createDomContextPlaceholderScreenshot(): OptimizedScreenshot {
  return {
    dataUrl: DOM_CONTEXT_PLACEHOLDER_IMAGE,
    meta: {
      format: 'png',
      source: 'dom_context',
      originalWidth: 1,
      originalHeight: 1,
      width: 1,
      height: 1,
      originalBytes: estimateDataUrlBytes(DOM_CONTEXT_PLACEHOLDER_IMAGE),
      bytes: estimateDataUrlBytes(DOM_CONTEXT_PLACEHOLDER_IMAGE),
      resized: false
    }
  };
}

function createScreenCacheKey(options: {
  pageUrl: string;
  viewport: ScreenViewport;
  imageFingerprint: string;
  contextFingerprint: string;
  pageSignature?: string;
}) {
  return [
    options.pageUrl,
    options.pageSignature ?? '',
    options.viewport.width,
    options.viewport.height,
    Math.round(options.viewport.devicePixelRatio * 100) / 100,
    options.viewport.scrollX ?? 0,
    options.viewport.scrollY ?? 0,
    options.imageFingerprint,
    options.contextFingerprint
  ].join('|');
}

function getSessionStorageArea() {
  return chrome.storage.session ?? chrome.storage.local;
}

async function readSessionValue<T>(key: string): Promise<T | undefined> {
  const stored = await getSessionStorageArea().get([key]);
  return stored[key] as T | undefined;
}

async function writeSessionValue<T>(key: string, value: T) {
  await getSessionStorageArea().set({ [key]: value });
}

async function removeSessionValue(key: string) {
  await getSessionStorageArea().remove(key);
}

async function getCachedScreenAnalysis(tabId: number, key: string) {
  const cached = screenAnalysisCache.get(tabId);
  if (cached?.key === key) {
    if (Date.now() <= cached.expiresAt) {
      return cached;
    }
    screenAnalysisCache.delete(tabId);
  }

  const sessionCache = await readSessionValue<Record<string, ScreenAnswerCacheEntry>>(STORAGE_KEYS.screenAnswerCache).catch(() => undefined);
  const sessionEntry = sessionCache?.[String(tabId)];
  if (!sessionEntry || sessionEntry.key !== key) {
    return null;
  }

  if (Date.now() > sessionEntry.expiresAt) {
    delete sessionCache[String(tabId)];
    await writeSessionValue(STORAGE_KEYS.screenAnswerCache, sessionCache).catch(() => undefined);
    return null;
  }

  const hydrated: ScreenAnalysisCacheEntry = {
    key: sessionEntry.key,
    pageUrl: sessionEntry.pageUrl,
    pageSignature: sessionEntry.pageSignature,
    analysis: sessionEntry.analysis,
    renderPayload: sessionEntry.renderPayload,
    createdAt: sessionEntry.createdAt,
    expiresAt: sessionEntry.expiresAt
  };
  screenAnalysisCache.set(tabId, hydrated);
  return hydrated;
}

async function setCachedScreenAnalysis(tabId: number, entry: ScreenAnalysisCacheEntry) {
  screenAnalysisCache.set(tabId, entry);
  const current = (await readSessionValue<Record<string, ScreenAnswerCacheEntry>>(STORAGE_KEYS.screenAnswerCache).catch(() => undefined)) ?? {};
  current[String(tabId)] = {
    tabId,
    key: entry.key,
    pageUrl: entry.pageUrl,
    pageSignature: entry.pageSignature,
    analysis: entry.analysis,
    renderPayload: entry.renderPayload,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt
  };
  await writeSessionValue(STORAGE_KEYS.screenAnswerCache, current).catch(() => undefined);
}

async function clearCachedScreenAnalysis(tabId: number) {
  screenAnalysisCache.delete(tabId);
  const current = await readSessionValue<Record<string, ScreenAnswerCacheEntry>>(STORAGE_KEYS.screenAnswerCache).catch(() => undefined);
  if (!current?.[String(tabId)]) {
    return;
  }
  delete current[String(tabId)];
  await writeSessionValue(STORAGE_KEYS.screenAnswerCache, current).catch(() => undefined);
}

async function readPreScanContext(tabId: number, pageUrl: string, settings: Pick<CanvySettings, 'debugMode'>, requestId: string) {
  const entry = await readSessionValue<ScreenPreScanCacheEntry>(STORAGE_KEYS.screenPreScanContext).catch(() => undefined);
  if (!entry || entry.url !== pageUrl || Date.now() > entry.expiresAt) {
    return null;
  }

  if (entry.tabId !== undefined && entry.tabId !== tabId) {
    return null;
  }

  logScreenTiming(settings, 'prescan-cache-hit', {
    requestId,
    tabId,
    cacheAgeMs: Date.now() - entry.createdAt,
    visibleTextHash: entry.visibleTextHash,
    contextQuestions: entry.context.questionCandidates.length,
    structuredQuestions: entry.context.structuredExtraction?.questions.length ?? 0
  });
  return entry;
}

async function writePreScanContext(tabId: number, context: ScreenTextContext, pageSignature: string, reason: string) {
  const entry: ScreenPreScanCacheEntry = {
    tabId,
    url: context.pageUrl,
    pageTitle: context.pageTitle,
    pageSignature,
    visibleTextHash: context.visibleTextHash ?? context.questionContext?.visibleTextHash ?? hashStringSample(context.visibleText),
    context,
    createdAt: Date.now(),
    expiresAt: Date.now() + SCREEN_PRESCAN_CACHE_TTL_MS,
    reason
  };
  await writeSessionValue(STORAGE_KEYS.screenPreScanContext, entry).catch(() => undefined);
}

async function persistActiveScreenScan(tabId: number, requestId: string, pageUrl: string, pageSignature?: string) {
  const scans = (await readSessionValue<Record<string, { requestId: string; pageUrl: string; pageSignature?: string; startedAt: number; expiresAt: number }>>(
    STORAGE_KEYS.activeScreenScans
  ).catch(() => undefined)) ?? {};
  scans[String(tabId)] = {
    requestId,
    pageUrl,
    pageSignature,
    startedAt: Date.now(),
    expiresAt: Date.now() + ACTIVE_SCREEN_SCAN_TTL_MS
  };
  await writeSessionValue(STORAGE_KEYS.activeScreenScans, scans).catch(() => undefined);
}

async function clearActiveScreenScan(tabId: number, requestId?: string) {
  const scans = await readSessionValue<Record<string, { requestId: string; expiresAt: number }>>(STORAGE_KEYS.activeScreenScans).catch(
    () => undefined
  );
  const key = String(tabId);
  if (!scans?.[key] || (requestId && scans[key].requestId !== requestId)) {
    return;
  }
  delete scans[key];
  await writeSessionValue(STORAGE_KEYS.activeScreenScans, scans).catch(() => undefined);
}

function isLatestScreenRequest(tabId: number, requestId: string) {
  return activeScreenRequests.get(tabId) === requestId;
}

function beginScreenRequest(tabId: number, requestId: string, pageUrl = '', pageSignature?: string) {
  screenAnalysisControllers.get(tabId)?.abort();
  const controller = new AbortController();
  screenAnalysisControllers.set(tabId, controller);
  activeScreenRequests.set(tabId, requestId);
  if (pageUrl) {
    void persistActiveScreenScan(tabId, requestId, pageUrl, pageSignature);
  }
  return controller;
}

function finishScreenRequest(tabId: number, requestId: string) {
  if (isLatestScreenRequest(tabId, requestId)) {
    screenAnalysisControllers.delete(tabId);
  }
  void clearActiveScreenScan(tabId, requestId);
}

async function appendRequestDiagnostic(event: RequestDiagnosticEvent) {
  const state = await getExtensionState();
  const existing = state.session.requestDiagnostics ?? [];
  await saveSession({
    requestDiagnostics: [...existing, event].slice(-DIAGNOSTIC_EVENT_LIMIT)
  });
}

function traceBackgroundEvent(tag: string, payload: Record<string, unknown> = {}) {
  logTrace(tag, {
    context: 'service_worker',
    ...payload
  });
}

function traceBackgroundError(tag: string, payload: Record<string, unknown> = {}) {
  logTraceError(tag, {
    context: 'service_worker',
    ...payload
  });
}

function recordRequestDiagnostic(
  tag: string,
  message: string,
  meta: Partial<RequestDiagnosticEvent> & { context?: string; source?: string; method?: string; url?: string; status?: number } = {}
) {
  const event = createRequestDiagnostic(tag, message, meta);
  void appendRequestDiagnostic(event).catch((error) => {
    console.warn('[Mako IQ background] Could not persist request diagnostic.', {
      tag,
      detail: getErrorMessage(error)
    });
  });
}

async function logResolvedApiBaseUrl(reason: string) {
  if (hasLoggedResolvedApiBase) {
    return;
  }

  const settings = await getSettings();
  const resolution = resolveApiBaseUrl(settings.apiBaseUrl, settings.apiBaseUrlSource);
  const extensionOrigin = new URL(chrome.runtime.getURL('')).origin;
  hasLoggedResolvedApiBase = true;
  traceBackgroundEvent('config:api-base', {
    reason,
    resolvedApiBaseUrl: resolution.value,
    source: resolution.source,
    mode: resolution.mode,
    envKey: resolution.envKey ?? 'unset',
    isLoopback: resolution.isLoopback,
    extensionOrigin
  });
  recordRequestDiagnostic('config:api-base', 'Resolved API base URL.', {
    context: 'service_worker',
    source: reason,
    url: resolution.value,
    detail: `source=${resolution.source} mode=${resolution.mode} envKey=${resolution.envKey ?? 'unset'} extensionOrigin=${extensionOrigin}`
  });
}

async function readLaunchConfiguration(reason: string): Promise<LaunchConfigurationStatus> {
  const manifestPopupPath = normalizeExtensionPath(
    chrome.runtime.getManifest().action?.default_popup,
    DEFAULT_ACTION_POPUP_PATH
  );
  const [popupPath, panelBehavior, launcherWindowState] = await Promise.all([
    chrome.action.getPopup({}).catch(() => manifestPopupPath),
    chrome.sidePanel.getPanelBehavior().catch(() => ({ openPanelOnActionClick: false })),
    getLauncherWindowState().catch(() => null)
  ]);

  return {
    popupPath: normalizeExtensionPath(popupPath, manifestPopupPath),
    launcherPath: DEFAULT_LAUNCHER_PATH,
    sidePanelPath: DEFAULT_SIDEPANEL_PATH,
    openPanelOnActionClick: Boolean(panelBehavior?.openPanelOnActionClick),
    launcherWindowId: typeof launcherWindowState?.windowId === 'number' ? launcherWindowState.windowId : undefined,
    verifiedAt: new Date().toISOString(),
    reason
  };
}

async function ensureLauncherWindowLaunchState(reason: string) {
  const warnings: string[] = [];

  try {
    await chrome.action.setPopup({ popup: DEFAULT_ACTION_POPUP_PATH });
  } catch (error) {
    const detail = getErrorMessage(error);
    warnings.push(`setPopup=${detail}`);
    traceBackgroundError('launch:config:error', {
      reason,
      step: 'setPopup',
      detail
    });
  }

  try {
    await chrome.sidePanel.setOptions({
      path: DEFAULT_SIDEPANEL_PATH,
      enabled: true
    });
  } catch (error) {
    const detail = getErrorMessage(error);
    warnings.push(`setOptions=${detail}`);
    traceBackgroundError('launch:config:error', {
      reason,
      step: 'setOptions',
      detail
    });
  }

  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    const detail = getErrorMessage(error);
    warnings.push(`setPanelBehavior=${detail}`);
    traceBackgroundError('launch:config:error', {
      reason,
      step: 'setPanelBehavior',
      detail
    });
  }

  const configuration = await readLaunchConfiguration(reason);

  traceBackgroundEvent('launch:config', {
    reason,
    popupPath: configuration.popupPath,
    launcherPath: configuration.launcherPath,
    sidePanelPath: configuration.sidePanelPath,
    openPanelOnActionClick: configuration.openPanelOnActionClick,
    launcherWindowId: configuration.launcherWindowId,
    warnings
  });
  recordRequestDiagnostic('launch:config', 'Verified workspace-first action behavior.', {
    context: 'service_worker',
    source: reason,
    detail: `popup=${configuration.popupPath || 'none'} launcher=${configuration.launcherPath} sidePanel=${configuration.sidePanelPath} openPanelOnActionClick=${String(configuration.openPanelOnActionClick)}${
      warnings.length ? ` warnings=${warnings.join('; ')}` : ''
    }`
  });

  return configuration;
}

async function getLastFocusedBrowserWindow(preferredWindowId?: number) {
  if (typeof preferredWindowId === 'number') {
    try {
      const preferredWindow = await chrome.windows.get(preferredWindowId);
      if (preferredWindow.type === 'normal') {
        return preferredWindow;
      }
    } catch {
      // Ignore stale preferred window IDs and fall back to the last focused browser window.
    }
  }

  try {
    return await chrome.windows.getLastFocused({
      populate: true,
      windowTypes: ['normal']
    });
  } catch {
    const windows = await chrome.windows.getAll({
      populate: true,
      windowTypes: ['normal']
    });
    return windows.find((window) => window.focused) ?? windows[0];
  }
}

async function getStoredLauncherWindow(): Promise<chrome.windows.Window | null> {
  const launcherState = await getLauncherWindowState();
  if (typeof launcherState?.windowId !== 'number') {
    return null;
  }

  try {
    const existing = await chrome.windows.get(launcherState.windowId, { populate: true });
    const launcherUrl = chrome.runtime.getURL(DEFAULT_LAUNCHER_PATH);
    const hasLauncherTab = existing.tabs?.some((tab) => tab.url === launcherUrl);
    if (existing.type === 'popup' && hasLauncherTab) {
      return existing;
    }
  } catch {
    // Ignore stale launcher window ids and clear them below.
  }

  await clearLauncherWindowState({ preserveBounds: true });
  return null;
}

async function persistLauncherWindowBounds(
  windowOrState: chrome.windows.Window | Partial<LauncherWindowState>,
  options: { windowId?: number; pageWindowId?: number; lastFocusedAt?: string } = {}
) {
  const bounds = normalizeLauncherWindowBounds(windowOrState);
  if (!bounds) {
    return null;
  }

  return saveLauncherWindowState({
    ...bounds,
    windowId: options.windowId,
    pageWindowId: options.pageWindowId,
    lastFocusedAt: options.lastFocusedAt
  });
}

async function createOrFocusLauncherWindow(
  requestId: string,
  source: string,
  preferredWindowId?: number
) {
  const existingWindow = await getStoredLauncherWindow();
  if (existingWindow?.id) {
    await chrome.windows.update(existingWindow.id, {
      focused: true,
      state: 'normal'
    });
    await saveLauncherWindowState({
      windowId: existingWindow.id,
      pageWindowId: preferredWindowId,
      lastFocusedAt: new Date().toISOString()
    });
    traceBackgroundEvent('launcher:focus', {
      requestId,
      source,
      launcherWindowId: existingWindow.id
    });
    recordRequestDiagnostic('launcher:focus', 'Focused the existing launcher window.', {
      context: 'service_worker',
      requestId,
      source,
      detail: `windowId=${existingWindow.id}`
    });
    return existingWindow;
  }

  const anchorWindow = await getLastFocusedBrowserWindow(preferredWindowId);
  const launcherState = await getLauncherWindowState();
  const storedBounds = normalizeLauncherWindowBounds(launcherState);
  const bounds = clampLauncherWindowBounds(storedBounds ?? buildDefaultLauncherBounds(anchorWindow), anchorWindow);
  const launcherWindow = await chrome.windows.create({
    url: chrome.runtime.getURL(DEFAULT_LAUNCHER_PATH),
    type: 'popup',
    focused: true,
    left: bounds.left,
    top: bounds.top,
    width: bounds.width,
    height: bounds.height
  });

  await persistLauncherWindowBounds(launcherWindow, {
    windowId: launcherWindow.id,
    pageWindowId: anchorWindow?.id ?? preferredWindowId,
    lastFocusedAt: new Date().toISOString()
  });
  traceBackgroundEvent('launcher:open', {
    requestId,
    source,
    launcherWindowId: launcherWindow.id,
    left: bounds.left,
    top: bounds.top,
    width: bounds.width,
    height: bounds.height
  });
  recordRequestDiagnostic('launcher:open', 'Opened the launcher window.', {
    context: 'service_worker',
    requestId,
    source,
    detail: `windowId=${launcherWindow.id ?? 'unknown'} left=${bounds.left} top=${bounds.top} width=${bounds.width} height=${bounds.height}`
  });

  return launcherWindow;
}

async function openLauncherPopup(requestId: string, source: string, windowId?: number) {
  if (typeof chrome.action.openPopup === 'function') {
    await chrome.action.openPopup(typeof windowId === 'number' ? { windowId } : undefined);
    recordRequestDiagnostic('popup:open', 'Opened the action popup.', {
      context: 'service_worker',
      requestId,
      source,
      detail: `windowId=${typeof windowId === 'number' ? windowId : 'active'}`
    });
    return;
  }

  await createOrFocusLauncherWindow(requestId, `${source}-fallback-window`, windowId);
}

async function syncLauncherWindowBounds(window: chrome.windows.Window) {
  if (!window.id) {
    return;
  }

  const launcherState = await getLauncherWindowState();
  if (launcherState?.windowId !== window.id) {
    return;
  }

  const persisted = await persistLauncherWindowBounds(window, {
    windowId: window.id,
    pageWindowId: launcherState?.pageWindowId,
    lastFocusedAt: new Date().toISOString()
  });

  if (persisted) {
    traceBackgroundEvent('launcher:bounds', {
      launcherWindowId: window.id,
      left: persisted.left,
      top: persisted.top,
      width: persisted.width,
      height: persisted.height
    });
  }
}

async function clearLauncherWindowHandle(windowId: number) {
  const launcherState = await getLauncherWindowState();
  if (launcherState?.windowId !== windowId) {
    return;
  }

  await clearLauncherWindowState({ preserveBounds: true });
  traceBackgroundEvent('launcher:closed', {
    launcherWindowId: windowId
  });
}

async function closeLauncherWindow(requestId: string, source: string) {
  const launcherState = await getLauncherWindowState();
  if (typeof launcherState?.windowId !== 'number') {
    return {
      ok: true,
      requestId,
      message: 'Launcher window was already closed.'
    };
  }

  await chrome.windows.remove(launcherState.windowId);
  await clearLauncherWindowHandle(launcherState.windowId);
  recordRequestDiagnostic('launcher:close', 'Closed the launcher window.', {
    context: 'service_worker',
    requestId,
    source,
    detail: `windowId=${launcherState.windowId}`
  });

  return {
    ok: true,
    requestId,
    message: 'Launcher window closed.'
  };
}

async function inspectLauncherWindow(requestId: string, source: string) {
  const launcherState = await getLauncherWindowState();
  if (typeof launcherState?.windowId !== 'number') {
    return {
      ok: true,
      requestId,
      source,
      stored: launcherState,
      current: null
    };
  }

  try {
    const current = await chrome.windows.get(launcherState.windowId, { populate: true });
    return {
      ok: true,
      requestId,
      source,
      stored: launcherState,
      current: {
        windowId: current.id,
        left: current.left,
        top: current.top,
        width: current.width,
        height: current.height,
        tabUrl: current.tabs?.[0]?.url ?? '',
        tabCount: current.tabs?.length ?? 0
      }
    };
  } catch (error) {
    return {
      ok: false,
      requestId,
      source,
      stored: launcherState,
      error: getErrorMessage(error)
    };
  }
}

async function updateLauncherWindowBounds(
  requestId: string,
  source: string,
  bounds: Partial<LauncherWindowBounds>
) {
  const launcherState = await getLauncherWindowState();
  if (typeof launcherState?.windowId !== 'number') {
    return {
      ok: false,
      requestId,
      source,
      error: 'Launcher window is not open.'
    };
  }

  const updates: chrome.windows.UpdateInfo = {
    state: 'normal'
  };

  if (typeof bounds.left === 'number') {
    updates.left = Math.round(bounds.left);
  }
  if (typeof bounds.top === 'number') {
    updates.top = Math.round(bounds.top);
  }
  if (typeof bounds.width === 'number') {
    updates.width = Math.round(bounds.width);
  }
  if (typeof bounds.height === 'number') {
    updates.height = Math.round(bounds.height);
  }

  const updated = await chrome.windows.update(launcherState.windowId, updates);
  await sleep(250);
  const stored = await getLauncherWindowState();

  return {
    ok: true,
    requestId,
    source,
    bounds,
    updated: {
      windowId: updated.id,
      left: updated.left,
      top: updated.top,
      width: updated.width,
      height: updated.height
    },
    stored
  };
}

function createOverlayStatus(
  state: OverlayStatus['state'],
  message: string,
  options: {
    reason?: OverlayFailureReason;
    requestId?: string;
    source?: string;
    tabId?: number;
    actionId?: WorkflowActionId | null;
  } = {}
): OverlayStatus {
  return {
    state,
    message,
    reason: options.reason,
    requestId: options.requestId,
    source: options.source,
    tabId: options.tabId,
    actionId: options.actionId,
    updatedAt: new Date().toISOString()
  };
}

function mapOverlaySendFailure(reason: OpenCanvyFailureReason): OverlayFailureReason {
  switch (reason) {
    case 'no_active_tab':
      return 'no_active_tab';
    case 'unsupported_page':
      return 'unsupported_page';
    case 'attach_failed':
    case 'content_unavailable':
      return 'content_script_not_attached';
    default:
      return 'message_passing_failed';
  }
}

function createBackendConnectionStatus(
  state: BackendConnectionStatus['state'],
  lastError?: string
): BackendConnectionStatus {
  return {
    state,
    checkedAt: new Date().toISOString(),
    lastError: lastError?.trim() || undefined
  };
}

async function updateBackendConnectionWithToken(
  state: BackendConnectionStatus['state'],
  authToken: string | undefined,
  lastError?: string
) {
  const backendConnection = createBackendConnectionStatus(state, lastError);
  await saveSettings({ backendConnection, authToken });
  await saveSession({ backendConnection });
  return backendConnection;
}

async function updateBackendConnection(state: BackendConnectionStatus['state'], lastError?: string) {
  const backendConnection = createBackendConnectionStatus(state, lastError);
  await saveSettings({ backendConnection });
  await saveSession({ backendConnection });
  return backendConnection;
}

function withInflightGuard<T>(key: string, run: () => Promise<T>) {
  const existing = inflightOperations.get(key);
  if (existing) {
    return existing as Promise<T>;
  }

  const pending = run().finally(() => {
    if (inflightOperations.get(key) === pending) {
      inflightOperations.delete(key);
    }
  });

  inflightOperations.set(key, pending);
  return pending;
}

function buildAnalysisControllerKey(tabId?: number) {
  return `analysis:${tabId ?? 'none'}`;
}

function isCurrentAnalysisRequest(controllerKey: string, requestId: string) {
  return activeAnalysisRequests.get(controllerKey) === requestId;
}

function createTimingPatch(current: AnalysisTimingMetrics | undefined, patch: Partial<AnalysisTimingMetrics>): AnalysisTimingMetrics {
  const startedAt = current?.startedAt ?? patch.startedAt ?? new Date().toISOString();
  return {
    ...current,
    ...patch,
    startedAt,
    updatedAt: new Date().toISOString()
  };
}

async function persistAnalysisRun(snapshot: AnalysisRunSnapshot | undefined, options: { statusMessage?: string; error?: string } = {}) {
  const result = snapshot?.phase === 'completed' ? snapshot.result : undefined;
  await saveSession({
    analysisRun: snapshot,
    lastAnalysis: result,
    pageState: {
      analysis: result,
      uiStatus: options.statusMessage
        ? {
            lifecycle:
              snapshot?.phase === 'error'
                ? 'error'
                : snapshot?.phase === 'cancelled'
                  ? 'idle'
                  : snapshot?.phase === 'completed'
                    ? 'ready'
                    : 'analyzing',
            message: options.statusMessage,
            lastAction: 'analyze'
          }
        : undefined,
      errors: {
        analysis: options.error
      },
      timestamps: {
        analyzedAt: result?.generatedAt
      }
    }
  });
}

function mapAnalysisApiError(error: unknown) {
  if (error instanceof AnalysisApiError) {
    return error.message;
  }

  if (error instanceof CanvyApiError) {
    return error.message;
  }

  return getErrorMessage(error);
}

function mapApiErrorMessage(error: unknown) {
  if (error instanceof CanvyApiError) {
    return error.message;
  }

  return getErrorMessage(error);
}

async function createApiClient() {
  const { settings } = await getExtensionState();
  await logResolvedApiBaseUrl('create-api-client');
  let refreshedToken = settings.authToken?.trim() || '';
  const client = createCanvyApiClient({
    baseUrl: settings.apiBaseUrl,
    apiBaseUrlSource: settings.apiBaseUrlSource,
    authToken: settings.authToken,
    onAuthToken(token) {
      refreshedToken = token;
    }
  });

  return {
    client,
    async flushTokenAndHealth(state: BackendConnectionStatus['state'], lastError?: string) {
      await updateBackendConnectionWithToken(state, refreshedToken || undefined, lastError);
    }
  };
}

function createUnavailableCanvasSummary(canvasContext?: CanvasContext | null): CanvasApiSummary {
  return {
    source: 'unavailable',
    currentUserName: undefined,
    courseName: canvasContext?.courseName,
    upcomingAssignments: []
  };
}

function buildToneProfileSamples(scan?: ScanPagePayload, scannedPages: ScanPagePayload[] = []) {
  const samples = [scan, ...scannedPages]
    .filter((item): item is ScanPagePayload => Boolean(item))
    .filter((item) => item.readableText.trim().length >= 80);

  return samples.slice(0, 1);
}

function extractHostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return 'website';
  }
}

function createContentFingerprint(parts: string[]) {
  let hash = 0;
  const source = parts.join('\n');

  for (let index = 0; index < source.length; index += 1) {
    hash = (hash << 5) - hash + source.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash).toString(36);
}

function buildPageContextFromScan(
  page: Pick<
    ScanPagePayload,
    'pageTitle' | 'url' | 'pageType' | 'headings' | 'contentBlocks' | 'questionCandidates' | 'readableText' | 'scannedAt' | 'extractionNotes'
  >
): PageContextSummary {
  const previewText = page.readableText.slice(0, 1600);
  const priorityText = [
    page.headings.join('\n'),
    page.questionCandidates.map((candidate) => candidate.question).join('\n'),
    page.contentBlocks.slice(0, 12).join('\n\n'),
    page.readableText.slice(0, 2400)
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 2400) || previewText;

  return {
    title: page.pageTitle,
    url: page.url,
    domain: extractHostname(page.url),
    pageType: page.pageType ?? 'generic',
    headings: page.headings,
    contentBlocks: page.contentBlocks.slice(0, 24),
    questionCandidates: page.questionCandidates.slice(0, 10),
    previewText,
    priorityText,
    textLength: page.readableText.length,
    contentFingerprint: createContentFingerprint([page.pageTitle, page.url, page.headings.join('|'), priorityText]),
    extractionNotes: page.extractionNotes ?? [],
    capturedAt: page.scannedAt
  };
}

function countReadableWords(value: string) {
  const matches = value.match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*/g);
  return matches?.length ?? 0;
}

function hasSentenceLikeReadableText(value: string) {
  const text = value.trim();
  if (!text) {
    return false;
  }

  if (/[.!?]/.test(text)) {
    return true;
  }

  return text.split(/\n+/).some((line) => line.trim().length >= 48);
}

function hasMeaningfulDomStructure(page: ScanPagePayload) {
  return (
    page.headings.some((heading) => heading.trim().length >= 4) ||
    page.detectedSections.some((section) => section.trim().length >= 24) ||
    page.domSignals.length > 0
  );
}

function isPlaceholderVisionText(value: string) {
  return /image-based scan placeholder/i.test(value) || /configured ai provider is needed for ocr fallback/i.test(value);
}

function looksLikePlaceholderVisionPayload(payload: Partial<ScanPagePayload>) {
  return (
    isPlaceholderVisionText(payload.readableText ?? '') ||
    (payload.extractionNotes ?? []).some((note) => /mock placeholder/i.test(note))
  );
}

function shouldUseVisionFallback(page: ScanPagePayload) {
  const text = page.readableText.trim();
  const wordCount = countReadableWords(text);
  const hasExtractionWarning = page.errors.some((error) => /limited|unavailable|could not extract/i.test(error));

  if (!text) {
    return true;
  }

  if (text.length < LOW_TEXT_FALLBACK_THRESHOLD || wordCount < LOW_WORD_COUNT_FALLBACK_THRESHOLD) {
    return true;
  }

  if (!hasExtractionWarning) {
    return false;
  }

  const hasStructure = hasMeaningfulDomStructure(page);
  const hasSentenceLikeText = hasSentenceLikeReadableText(text);
  const meaningfulDomText = text.length >= MEANINGFUL_DOM_TEXT_THRESHOLD || wordCount >= MEANINGFUL_DOM_WORD_THRESHOLD;

  return !(hasStructure && hasSentenceLikeText && meaningfulDomText);
}

function shouldPreferVisionScan(payload: Partial<ScanPagePayload>, fallbackPage: ScanPagePayload) {
  if (looksLikePlaceholderVisionPayload(payload)) {
    return false;
  }

  const visionText = payload.readableText?.trim() ?? '';
  if (!visionText) {
    return false;
  }

  const fallbackText = fallbackPage.readableText.trim();
  if (isPlaceholderVisionText(fallbackText)) {
    return true;
  }

  const visionWordCount = countReadableWords(visionText);
  const fallbackWordCount = countReadableWords(fallbackText);
  const visionStructureScore = (payload.headings?.length ?? 0) + (payload.detectedSections?.length ?? 0);
  const fallbackStructureScore = fallbackPage.headings.length + fallbackPage.detectedSections.length;

  if (visionText.length >= fallbackText.length + OCR_TEXT_IMPROVEMENT_THRESHOLD) {
    return true;
  }

  if (visionWordCount >= fallbackWordCount + OCR_WORD_IMPROVEMENT_THRESHOLD) {
    return true;
  }

  return visionStructureScore > fallbackStructureScore && (visionText.length >= fallbackText.length || visionWordCount >= fallbackWordCount);
}

function normalizeVisionScanPayload(
  payload: Partial<ScanPagePayload>,
  fallbackPage: ScanPagePayload,
  assistantMode: SidebarMode,
  canvasContext: CanvasContext | null
): ScanPagePayload {
  const url = payload.url ?? fallbackPage.url;
  const pageTitle = payload.title ?? payload.pageTitle ?? fallbackPage.pageTitle;
  const pageType = payload.pageType ?? fallbackPage.pageType ?? (assistantMode === 'canvas' ? 'canvas' : 'generic');
  const readableText = payload.readableText?.trim() || fallbackPage.readableText;
  const headings = payload.headings?.length ? payload.headings : fallbackPage.headings;
  const contentBlocks = payload.contentBlocks?.length ? payload.contentBlocks : fallbackPage.contentBlocks;
  const questionCandidates = payload.questionCandidates?.length ? payload.questionCandidates : fallbackPage.questionCandidates;
  const scannedAt = payload.scannedAt || new Date().toISOString();
  const context = buildPageContextFromScan({
    pageTitle,
    url,
    pageType,
    headings,
    contentBlocks,
    questionCandidates,
    readableText,
    scannedAt,
    extractionNotes: payload.extractionNotes ?? fallbackPage.extractionNotes
  });
  const analysis = buildPageAnalysis(assistantMode, context, canvasContext);

  return {
    pageTitle,
    title: pageTitle,
    url,
    hostname: extractHostname(url),
    mode: assistantMode,
    readableText,
    keyText: context.previewText,
    headings,
    contentBlocks,
    questionCandidates,
    detectedSections: payload.detectedSections?.length
      ? payload.detectedSections
      : Array.from(new Set([...headings, ...analysis.keyTopics])).slice(0, 8),
    sourceType: payload.sourceType === 'tone_sample' ? 'tone_sample' : fallbackPage.sourceType,
    scanSource: fallbackPage.scanSource,
    pageType,
    sourceMode: payload.sourceMode ?? 'image_ocr',
    urlSignals: fallbackPage.urlSignals,
    domSignals: fallbackPage.domSignals,
    summary: analysis.pageSummary,
    keyTopics: analysis.keyTopics,
    importantDetails: analysis.importantDetails,
    suggestedNextActions: analysis.suggestedNextActions,
    canvasEnhancedRelevant: analysis.canvasEnhancedAvailable,
    canvasDetails: canvasContext
      ? {
          courseName: canvasContext.courseName,
          pageKind: canvasContext.pageKind,
          courseId: canvasContext.courseId,
          assignmentId: canvasContext.assignmentId,
          dueAtText: canvasContext.dueAtText
        }
      : fallbackPage.canvasDetails,
    extractionNotes: [
      ...(payload.extractionNotes ?? []),
      'OCR fallback was used because DOM extraction returned limited readable text.'
    ],
    errors: (payload.errors ?? []).filter(Boolean),
    scannedAt
  };
}

function formatAnalysisModeLabel(mode: AnalysisMode) {
  switch (mode) {
    case 'quick_summary':
      return 'Quick summary';
    case 'send_to_doc':
      return 'Send to doc';
    default:
      return mode.charAt(0).toUpperCase() + mode.slice(1);
  }
}

function mapTaskToAnalysisMode(task: CanvyTaskKind, actionId?: WorkflowActionId | null): AnalysisMode {
  if (actionId === 'extract_key_points' || actionId === 'extract_notes') {
    return 'quick_summary';
  }

  if (actionId === 'save_as_context') {
    return 'send_to_doc';
  }

  switch (task) {
    case 'summarize_reading':
      return 'quick_summary';
    case 'explain_page':
    case 'discussion_post':
    case 'quiz_assist':
      return 'answer';
    case 'build_draft':
      return 'send_to_doc';
    default:
      return 'summary';
  }
}

function buildAnalysisSourceText(
  pageContext: PageContextSummary | null,
  latestScan?: ScanPagePayload,
  canvasContext?: CanvasContext | null
) {
  if (!pageContext) {
    return '';
  }

  const questionBlocks = pageContext.questionCandidates.slice(0, 8).map((candidate, index) =>
    [
      `Question ${index + 1} (${candidate.id})`,
      candidate.sectionLabel ? `Section: ${candidate.sectionLabel}` : '',
      candidate.question,
      candidate.answerChoices.length ? `Choices: ${candidate.answerChoices.join(' | ')}` : '',
      candidate.nearbyText.length ? `Nearby: ${candidate.nearbyText.join(' | ')}` : ''
    ]
      .filter(Boolean)
      .join('\n')
  );

  const canvasBlocks = canvasContext
    ? [
        canvasContext.title ? `Canvas title: ${canvasContext.title}` : '',
        canvasContext.promptText ? `Canvas prompt: ${canvasContext.promptText}` : '',
        canvasContext.teacherInstructions.slice(0, 3).join(' | ')
      ].filter(Boolean)
    : [];

  return [
    pageContext.headings.slice(0, 8).join('\n'),
    questionBlocks.join('\n\n'),
    pageContext.contentBlocks.slice(0, 16).join('\n\n'),
    latestScan?.importantDetails.slice(0, 6).join('\n'),
    canvasBlocks.join('\n')
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 7_000);
}

async function captureVisibleScreenshotBase64(windowId?: number) {
  if (!windowId || windowId === chrome.windows.WINDOW_ID_NONE) {
    return null;
  }

  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    const [, base64 = ''] = dataUrl.split(',', 2);
    return base64 || null;
  } catch (error) {
    logDebug('Screenshot capture skipped for analysis request.', {
      detail: getErrorMessage(error),
      windowId
    });
    return null;
  }
}

async function captureVisibleScreenshotDataUrl(windowId?: number) {
  if (!windowId || windowId === chrome.windows.WINDOW_ID_NONE) {
    throw new Error('No browser window is available for screen capture.');
  }

  try {
    return await chrome.tabs.captureVisibleTab(windowId, {
      format: 'jpeg',
      quality: SCREEN_CAPTURE_QUALITY
    });
  } catch {
    return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  }
}

function createFallbackViewport(): ScreenViewport {
  return {
    width: 1440,
    height: 900,
    devicePixelRatio: 1
  };
}

function truncateText(value: string, maxLength: number) {
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }

  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}...` : text;
}

function buildAnalysisTitle(output: StructuredAnalysisOutput) {
  const primaryQuestion = output.questions.find((question) => question.answered) ?? output.questions[0];

  if (output.resultState === 'success' && primaryQuestion) {
    return truncateText(primaryQuestion.question, 120) || 'Answered question';
  }

  if (output.resultState === 'no_questions') {
    return 'No questions detected';
  }

  if (output.resultState === 'insufficient_context') {
    return 'More context needed';
  }

  return 'AI output suppressed';
}

function buildAnalysisText(output: StructuredAnalysisOutput) {
  const primaryQuestion = output.questions.find((question) => question.answered) ?? output.questions[0];
  if (primaryQuestion?.answered) {
    return primaryQuestion.answer;
  }

  return output.message;
}

function buildAnalysisBullets(output: StructuredAnalysisOutput) {
  const primaryQuestion = output.questions.find((question) => question.answered) ?? output.questions[0];
  if (!primaryQuestion) {
    return [];
  }

  return [primaryQuestion.context, ...primaryQuestion.evidence].filter(Boolean).slice(0, 4);
}

function buildAnalysisActions(output: StructuredAnalysisOutput) {
  switch (output.resultState) {
    case 'success':
      return output.validation.answeredQuestionCount > 1
        ? [`${output.validation.answeredQuestionCount} mapped answers are available. Switch questions in the card or page overlay.`]
        : ['Review the short context under the answer before using it.'];
    case 'no_questions':
      return ['The page overlay stayed hidden because no real question blocks were found.'];
    case 'insufficient_context':
      return ['Try rescanning the page or capturing a clearer view so the full prompt is visible.'];
    default:
      return ['The page overlay stayed hidden because the AI output did not pass validation.'];
  }
}

function deriveOverlaySuppressedReason(output: StructuredAnalysisOutput): OverlayFailureReason | undefined {
  if (output.aiTaggedSuccessfully && output.validation.answeredQuestionCount > 0) {
    return undefined;
  }

  if (output.validation.echoGuardHit) {
    return 'echo_guard';
  }

  if (output.validation.answeredQuestionCount < 1) {
    if (output.resultState === 'no_questions') {
      return 'no_questions';
    }

    if (output.resultState === 'insufficient_context') {
      return 'insufficient_context';
    }

    return 'no_answered_questions';
  }

  if (output.resultState === 'no_questions') {
    return 'no_questions';
  }

  if (output.resultState === 'insufficient_context') {
    return 'insufficient_context';
  }

  return 'invalid_ai_output';
}

function createStructuredPageAnalysis(input: {
  mode: AnalysisMode;
  assistantMode: SidebarMode;
  pageContext: PageContextSummary;
  meta?: {
    requestId?: string;
    cacheStatus?: AnalysisCacheStatus;
    timings?: AnalysisTimingMetrics;
  };
  output: StructuredAnalysisOutput;
}): PageAnalysisResult {
  const title = buildAnalysisTitle(input.output);
  const text = buildAnalysisText(input.output);
  const bullets = buildAnalysisBullets(input.output);
  const actions = buildAnalysisActions(input.output);
  const detailLines = [
    `Mode: ${formatAnalysisModeLabel(input.mode)}`,
    `Extraction: ${input.output.extraction_mode}`,
    `AI tag: ${input.output.ai_tag}`,
    `Result: ${input.output.resultState}`
  ].filter(Boolean);
  const overlaySuppressedReason = deriveOverlaySuppressedReason(input.output);
  const overlayEligible = input.output.aiTaggedSuccessfully && !overlaySuppressedReason;

  return {
    resultState: input.output.resultState,
    aiTag: input.output.ai_tag,
    aiTaggedSuccessfully: input.output.aiTaggedSuccessfully,
    extractionMode: input.output.extraction_mode,
    questions: input.output.questions,
    candidateQuestionCount: input.output.validation.candidateQuestionCount,
    answeredQuestionCount: input.output.validation.answeredQuestionCount,
    overlayEligible,
    overlaySuppressedReason,
    validation: input.output.validation,
    message: input.output.message,
    title,
    text,
    bullets,
    chart: null,
    actions,
    sourceTitle: input.pageContext.title,
    sourceUrl: input.pageContext.url,
    assistantMode: input.assistantMode,
    mode: input.mode,
    pageSummary: input.output.message,
    keyTopics: bullets,
    importantDetails: detailLines,
    suggestedNextActions: actions,
    likelyUseCase: title,
    canvasEnhancedAvailable: input.assistantMode === 'canvas',
    extractedPreview: input.pageContext.previewText,
    generatedAt: new Date().toISOString(),
    requestId: input.meta?.requestId,
    timings: input.meta?.timings,
    cacheStatus: input.meta?.cacheStatus
  };
}

function mapPageAnalysisToTaskOutput(analysis: PageAnalysisResult): TaskOutput {
  return {
    summary: analysis.title,
    checklist: analysis.bullets,
    proposedStructure: analysis.actions,
    draft: analysis.text,
    explanation: analysis.message || analysis.actions.join(' | ') || analysis.text,
    reviewAreas: []
  };
}

function mapAnalysisToWorkflowShell(
  workflowState: WorkflowState,
  task: CanvyTaskKind,
  analysis: PageAnalysisResult
): WorkflowState['outputShell'] {
  const now = new Date().toISOString();
  const prompt = workflowState.promptExtraction?.promptText ?? workflowState.sourceTitle;
  const notes = [...analysis.bullets, ...analysis.actions].filter(Boolean);
  const keyPoints = analysis.bullets.length ? analysis.bullets : analysis.actions;

  if (task === 'discussion_post') {
    return {
      type: 'discussion_post',
      actionId: workflowState.currentAction ?? 'draft_response',
      title: analysis.title,
      intro: analysis.text,
      prompt,
      draftResponse: analysis.text,
      notes: notes.join(' | ') || 'Review the page context and adjust the response before using it.',
      chart: analysis.chart,
      actions: analysis.actions,
      updatedAt: now
    };
  }

  if (task === 'quiz_assist') {
    return {
      type: 'quiz',
      actionId: workflowState.currentAction ?? 'prepare_quiz_support',
      title: analysis.title,
      intro: analysis.text,
      questionSupport: prompt,
      answer: analysis.text,
      explanation: notes.join(' | ') || 'Review the concept explanation and study the related page context.',
      chart: analysis.chart,
      actions: analysis.actions,
      updatedAt: now
    };
  }

  if (workflowState.currentWorkflow === 'resource') {
    return {
      type: 'resource',
      actionId: workflowState.currentAction ?? 'summarize_resource',
      title: analysis.title,
      intro: analysis.text,
      summary: analysis.text,
      keyPoints: keyPoints.slice(0, 6),
      suggestedUse: analysis.actions[0] ?? 'Keep this page as supporting context for later work.',
      chart: analysis.chart,
      actions: analysis.actions,
      updatedAt: now
    };
  }

  if (workflowState.currentWorkflow === 'file_assignment' || task === 'analyze_assignment' || task === 'build_draft') {
    return {
      type: 'file_assignment',
      actionId: workflowState.currentAction ?? 'start_assignment_help',
      title: analysis.title,
      intro: analysis.text,
      task: prompt,
      draftAnswer: analysis.text,
      explanation: notes.join(' | ') || 'Use the page context and instructions to refine the assignment plan.',
      chart: analysis.chart,
      actions: analysis.actions,
      updatedAt: now
    };
  }

  return {
    type: 'general',
    actionId: workflowState.currentAction ?? 'summarize_page',
    title: analysis.title,
    intro: analysis.text,
    summary: analysis.text,
    keyPoints: keyPoints.slice(0, 6),
    suggestedNextStep: analysis.actions[0] ?? 'Use the analysis to decide what to do next on this page.',
    chart: analysis.chart,
    actions: analysis.actions,
    updatedAt: now
  };
}

async function requestBackendAnalysis(input: {
  requestId: string;
  source: string;
  tab?: chrome.tabs.Tab;
  assistantMode: SidebarMode;
  pageContext: PageContextSummary;
  canvasContext: CanvasContext | null;
  latestScan?: ScanPagePayload;
  mode: AnalysisMode;
  instruction: string;
}) {
  const startedAt = Date.now();
  const state = await getExtensionState();
  const { settings } = state;
  await logResolvedApiBaseUrl('request-backend-analysis');
  const pageText = buildAnalysisSourceText(input.pageContext, input.latestScan, input.canvasContext);
  const shouldCaptureScreenshot =
    Boolean(input.tab?.windowId) &&
    (
      input.pageContext.questionCandidates.length === 0 ||
      pageText.length < 260 ||
      Boolean(input.latestScan && shouldUseVisionFallback(input.latestScan))
    );
  const screenshotBase64 = shouldCaptureScreenshot ? await captureVisibleScreenshotBase64(input.tab?.windowId) : null;
  const serializationMs = Math.max(0, Date.now() - startedAt);
  const cacheLookupStartedAt = Date.now();
  const cacheKey = buildAnalysisCacheKey(input.pageContext, input.mode, input.instruction, input.latestScan, input.canvasContext);
  const { cache, hit } = getCachedAnalysis(state.session.analysisCache, cacheKey);
  const cacheMs = Math.max(0, Date.now() - cacheLookupStartedAt);
  const controllerKey = buildAnalysisControllerKey(input.tab?.id);
  const activeController = activeAnalysisControllers.get(controllerKey);

  if (activeController && activeController.signal.aborted === false) {
    activeController.abort();
  }

  activeAnalysisRequests.set(controllerKey, input.requestId);

  let snapshot: AnalysisRunSnapshot = createAnalysisRunSnapshot({
    requestId: input.requestId,
    pageContext: input.pageContext,
    tabId: input.tab?.id,
    mode: input.mode,
    instruction: input.instruction,
    phase: hit ? 'cache_hit' : 'collecting_context',
    statusLabel: hit ? `Using cached analysis for ${input.pageContext.title}...` : `Preparing ${input.pageContext.title} for local AI...`,
    cacheKey,
    cacheStatus: hit ? 'hit' : 'miss',
    timings: {
      serializationMs,
      cacheMs
    }
  });
  let snapshotWrites = persistAnalysisRun(snapshot, { statusMessage: snapshot.statusLabel });

  const queueSnapshot = (nextSnapshot: AnalysisRunSnapshot, options: { statusMessage?: string; error?: string } = {}) => {
    snapshot = nextSnapshot;
    const snapshotToPersist = nextSnapshot;
    snapshotWrites = snapshotWrites.then(() => {
      if (!isCurrentAnalysisRequest(controllerKey, input.requestId)) {
        return;
      }

      return persistAnalysisRun(snapshotToPersist, options);
    });
    return snapshotWrites;
  };

  if (hit) {
    const now = new Date().toISOString();
    const cachedAnalysis: PageAnalysisResult = {
      ...hit.analysis,
      requestId: input.requestId,
      cacheStatus: 'hit',
      timings: createTimingPatch(hit.analysis.timings, {
        startedAt: snapshot.startedAt,
        cacheMs,
        serializationMs,
        completedAt: now,
        totalMs: Math.max(0, Date.now() - startedAt)
      })
    };
    const finalized = finalizeAnalysisRunSnapshot(snapshot, cachedAnalysis, `Using cached analysis for ${input.pageContext.title}.`, {
      cacheStatus: 'hit',
      timings: cachedAnalysis.timings
    });
    await queueSnapshot(finalized, { statusMessage: finalized.statusLabel });
    if (!isCurrentAnalysisRequest(controllerKey, input.requestId)) {
      throw new AnalysisApiError('cancelled', 'A newer analysis request replaced this scan.');
    }
    await saveSession({
      analysisCache: upsertAnalysisCache(cache, {
        ...hit,
        analysis: cachedAnalysis,
        lastUsedAt: now
      })
    });

    logDebug('Resolved analysis request from cache.', {
      requestId: input.requestId,
      source: input.source,
      mode: input.mode,
      pageTitle: input.pageContext.title,
      cacheKey
    });

    return cachedAnalysis;
  }

  const controller = new AbortController();
  activeAnalysisControllers.set(controllerKey, controller);

  logDebug('Sending backend analysis request.', {
    requestId: input.requestId,
    source: input.source,
    mode: input.mode,
    pageTitle: input.pageContext.title,
    pageTextLength: pageText.length,
    candidateQuestionCount: input.pageContext.questionCandidates.length,
    serializationMs,
    cacheMs,
    hasScreenshot: Boolean(screenshotBase64)
  });

  snapshot = updateAnalysisRunSnapshot(snapshot, {
    phase: 'requesting_backend',
    statusLabel: `Sending ${input.pageContext.title} to local AI...`,
    cacheStatus: 'miss',
    timings: {
      serializationMs,
      cacheMs
    }
  });
  await queueSnapshot(snapshot, { statusMessage: snapshot.statusLabel });

  try {
    const payload = {
      mode: input.mode,
      instruction: input.instruction,
      page: {
        url: input.pageContext.url,
        title: input.pageContext.title,
        text: pageText,
        headings: input.pageContext.headings,
        blocks: input.pageContext.contentBlocks,
        questionCandidates: input.pageContext.questionCandidates,
        extractionNotes: [
          ...(input.pageContext.extractionNotes ?? []),
          ...(input.latestScan?.extractionNotes ?? [])
        ]
      },
      screenshotBase64
    };

    let response;
    try {
      response = await streamAnalysisWithBackend(settings.apiBaseUrl, payload, undefined, {
        signal: controller.signal,
        requestId: input.requestId,
        source: input.source,
        apiBaseUrlSource: settings.apiBaseUrlSource,
        onEvent(event) {
          if (event.type === 'status') {
            const nextSnapshot = updateAnalysisRunSnapshot(snapshot, {
              phase: event.phase,
              statusLabel: event.message,
              cacheStatus: event.cacheStatus ?? snapshot.cacheStatus,
              timings: createTimingPatch(snapshot.timings, event.timings ?? {})
            });
            void queueSnapshot(nextSnapshot, { statusMessage: nextSnapshot.statusLabel });

            logDebug('Analysis stream status update.', {
              requestId: input.requestId,
              source: input.source,
              phase: event.phase,
              message: event.message,
              timings: event.timings
            });
            return;
          }

          if (event.type === 'delta') {
            const preview = extractPartialStructuredPreview(event.accumulatedText);
            const nextSnapshot = updateAnalysisRunSnapshot(snapshot, {
              phase: 'streaming',
              statusLabel: 'Local AI is preparing a response...',
              partialTitle: preview.partialTitle ?? snapshot.partialTitle,
              partialText: preview.partialText || snapshot.partialText
            });
            void queueSnapshot(nextSnapshot, { statusMessage: nextSnapshot.statusLabel });
            return;
          }

          if (event.type === 'complete') {
            logDebug('Analysis stream completed.', {
              requestId: input.requestId,
              source: input.source,
              mode: event.mode,
              cacheStatus: event.meta?.cacheStatus ?? 'miss',
              timings: event.meta?.timings
            });
          }
        }
      });
    } catch (error) {
      const canFallbackToJson =
        error instanceof AnalysisApiError &&
        (error.status === 404 || error.code === 'invalid_response' || error.code === 'invalid_json');

      if (!canFallbackToJson) {
        throw error;
      }

      logDebug('Falling back to non-stream analysis request.', {
        requestId: input.requestId,
        source: input.source,
        detail: error.message
      });

      response = await analyzeWithBackend(settings.apiBaseUrl, payload, undefined, {
        signal: controller.signal,
        requestId: input.requestId,
        source: input.source,
        apiBaseUrlSource: settings.apiBaseUrlSource
      });
    }

    const analysis = createStructuredPageAnalysis({
      mode: response.mode,
      assistantMode: input.assistantMode,
      pageContext: input.pageContext,
      meta: {
        requestId: response.meta?.requestId ?? input.requestId,
        timings: createTimingPatch(response.meta?.timings, {
          serializationMs,
          cacheMs,
          totalMs: response.meta?.timings?.totalMs ?? Math.max(0, Date.now() - startedAt)
        }),
        cacheStatus: response.meta?.cacheStatus ?? 'miss'
      },
      output: response.output
    });

    logDebug('Structured analysis normalized.', {
      requestId: input.requestId,
      source: input.source,
      resultState: analysis.resultState,
      aiTag: analysis.aiTag,
      extractionMode: analysis.extractionMode,
      candidateQuestionCount: analysis.candidateQuestionCount,
      answeredQuestionCount: analysis.answeredQuestionCount,
      echoGuardHit: analysis.validation.echoGuardHit,
      overlayEligible: analysis.overlayEligible
    });

    const finalized = finalizeAnalysisRunSnapshot(snapshot, analysis, `Analysis ready for ${input.pageContext.title}.`, {
      cacheStatus: analysis.cacheStatus ?? 'miss',
      timings: analysis.timings
    });
    await queueSnapshot(finalized, { statusMessage: finalized.statusLabel });
    if (!isCurrentAnalysisRequest(controllerKey, input.requestId)) {
      throw new AnalysisApiError('cancelled', 'A newer analysis request replaced this scan.');
    }
    await saveSession({
      analysisCache: upsertAnalysisCache(cache, {
        key: cacheKey,
        pageUrl: input.pageContext.url,
        pageTitle: input.pageContext.title,
        mode: input.mode,
        instruction: input.instruction,
        fingerprint: input.pageContext.contentFingerprint,
        analysis,
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString()
      })
    });

    return analysis;
  } catch (error) {
    const detail = controller.signal.aborted ? 'The analysis request was cancelled.' : mapAnalysisApiError(error);
    if (error instanceof AnalysisApiError || error instanceof CanvyApiError) {
      traceBackgroundError('sw:request:error', {
        requestId: input.requestId,
        source: input.source,
        category: error.category ?? error.code,
        status: error.status,
        url: error.url ?? settings.apiBaseUrl,
        method: error.method ?? 'POST',
        detail: error.detail ?? error.message,
        originalMessage: error.originalMessage ?? error.message
      });
      recordRequestDiagnostic('sw:request:error', error.message, {
        requestId: input.requestId,
        context: error.context ?? 'service_worker.analysis',
        source: input.source,
        method: error.method ?? 'POST',
        url: error.url ?? settings.apiBaseUrl,
        status: error.status,
        category: error.category ?? undefined,
        detail: error.detail ?? error.originalMessage ?? error.message
      });
    }
    const failedSnapshot = failAnalysisRunSnapshot(snapshot, detail, controller.signal.aborted ? 'cancelled' : 'error');
    await queueSnapshot(failedSnapshot, {
      statusMessage: failedSnapshot.statusLabel,
      error: controller.signal.aborted ? undefined : detail
    });
    throw error instanceof Error ? error : new Error(detail);
  } finally {
    if (activeAnalysisControllers.get(controllerKey) === controller) {
      activeAnalysisControllers.delete(controllerKey);
    }

  }
}

async function resolveActivePanelTarget(requestId: string, source: string, preferredWindowId?: number) {
  logDebug('Resolving active panel target.', { requestId, source, preferredWindowId });

  if (typeof preferredWindowId === 'number') {
    try {
      const preferredWindow = await chrome.windows.get(preferredWindowId, {
        populate: true
      });
      const activeTabFromPreferredWindow = preferredWindow.tabs?.find((tab) => tab.active && !isExtensionPageUrl(tab.url));

      if (preferredWindow.id && preferredWindow.type === 'normal') {
        logDebug('Resolved active browser window from preferred window id.', {
          requestId,
          source,
          windowId: preferredWindow.id,
          tabId: activeTabFromPreferredWindow?.id,
          currentUrl: activeTabFromPreferredWindow?.url ?? '',
          pageTitle: activeTabFromPreferredWindow?.title ?? 'Current page'
        });

        return {
          windowId: preferredWindow.id,
          tab: activeTabFromPreferredWindow
        };
      }
    } catch (error) {
      console.warn(`[Mako IQ background][${requestId}] Could not resolve the preferred page window.`, {
        source,
        preferredWindowId,
        detail: getErrorMessage(error)
      });
    }
  }

  const launcherState = await getLauncherWindowState();
  if (typeof launcherState?.pageWindowId === 'number') {
    try {
      const storedWindow = await chrome.windows.get(launcherState.pageWindowId, {
        populate: true
      });
      const activeTabFromStoredWindow = storedWindow.tabs?.find((tab) => tab.active && !isExtensionPageUrl(tab.url));

      if (storedWindow.id && storedWindow.type === 'normal') {
        logDebug('Resolved active browser window from launcher state.', {
          requestId,
          source,
          windowId: storedWindow.id,
          tabId: activeTabFromStoredWindow?.id,
          currentUrl: activeTabFromStoredWindow?.url ?? '',
          pageTitle: activeTabFromStoredWindow?.title ?? 'Current page'
        });

        return {
          windowId: storedWindow.id,
          tab: activeTabFromStoredWindow
        };
      }
    } catch (error) {
      console.warn(`[Mako IQ background][${requestId}] Could not resolve the launcher page window.`, {
        source,
        windowId: launcherState.pageWindowId,
        detail: getErrorMessage(error)
      });
    }
  }

  try {
    const focusedWindow = await chrome.windows.getLastFocused({
      populate: true,
      windowTypes: ['normal']
    });
    const activeTabFromWindow = focusedWindow.tabs?.find((tab) => tab.active && !isExtensionPageUrl(tab.url));

    if (focusedWindow.id) {
      logDebug('Active window found.', {
        requestId,
        source,
        windowId: focusedWindow.id,
        tabId: activeTabFromWindow?.id,
        currentUrl: activeTabFromWindow?.url ?? '',
        pageTitle: activeTabFromWindow?.title ?? 'Current page'
      });

      return {
        windowId: focusedWindow.id,
        tab: activeTabFromWindow
      };
    }
  } catch (error) {
    console.warn(`[Mako IQ background][${requestId}] Could not resolve the last focused browser window.`, {
      source,
      detail: getErrorMessage(error)
    });
  }

  const fallbackTabs = await chrome.tabs.query({ active: true });
  const fallbackTab = fallbackTabs.find((tab) => !isExtensionPageUrl(tab.url));
  if (fallbackTab?.windowId) {
    logDebug('Active tab found via fallback query.', {
      requestId,
      source,
      windowId: fallbackTab.windowId,
      tabId: fallbackTab.id,
      currentUrl: fallbackTab.url ?? '',
      pageTitle: fallbackTab.title ?? 'Current page'
    });

    return {
      windowId: fallbackTab.windowId,
      tab: fallbackTab
    };
  }

  logDebug('No active tab or window could be resolved.', { requestId, source });
  return null;
}

function buildOpenCanvyMessage(
  kind: 'open' | 'analyze',
  _assistantMode: SidebarMode | 'unsupported',
  isSupportedLaunchPage: boolean
) {
  if (kind === 'analyze') {
    if (!isSupportedLaunchPage) {
      return 'This page is hard to scan.';
    }

    return 'Screen analysis started.';
  }

  if (!isSupportedLaunchPage) {
    return 'Workspace opened. Page-specific tools are limited on this tab.';
  }

  return 'Workspace opened.';
}

function workflowLabel(workflowType: WorkflowState['workflowType']) {
  switch (workflowType) {
    case 'file_assignment':
      return 'assignment';
    case 'discussion_post':
      return 'discussion';
    case 'quiz':
      return 'quiz support';
    case 'resource':
      return 'resource';
    default:
      return 'page-aware';
  }
}

async function getShortcutHint() {
  try {
    const commands = await chrome.commands.getAll();
    const command = commands.find((item) => item.name === 'open-mako-iq' || item.name === 'open-canvy');
    return command?.shortcut || 'Not assigned';
  } catch (error) {
    console.warn('[Mako IQ background] Could not read command shortcuts.', {
      detail: getErrorMessage(error)
    });
    return DEFAULT_SHORTCUT_HINT;
  }
}

function normalizeStoredAnalysis(analysis: PageAnalysisResult | undefined) {
  if (!analysis?.sourceUrl || !('pageSummary' in analysis)) {
    return undefined;
  }

  return analysis;
}

function buildFallbackPageContext(tab: chrome.tabs.Tab, mode: SidebarMode): PageContextSummary | null {
  if (!tab.url) {
    return null;
  }

  const launchSupport = getLaunchSupport(tab.url);
  const previewText =
    mode === 'canvas'
      ? 'Mako IQ can use this page as lightweight screen context while richer extraction loads.'
      : 'Mako IQ can still use the current tab title and URL as a lightweight page context fallback while richer extraction loads.';
  const contentFingerprint = createContentFingerprint([tab.title ?? 'Current page', tab.url, previewText]);

  try {
    const parsed = new URL(tab.url);
    return {
      title: tab.title ?? 'Current page',
      url: tab.url,
      domain: parsed.hostname.replace(/^www\./i, ''),
      pageType: launchSupport.pageType,
      headings: [],
      contentBlocks: [previewText],
      questionCandidates: [],
      previewText,
      priorityText: previewText,
      textLength: previewText.length,
      contentFingerprint,
      extractionNotes: ['Fallback page context was used because richer extraction was unavailable.'],
      capturedAt: new Date().toISOString()
    };
  } catch {
    return {
      title: tab.title ?? 'Current page',
      url: tab.url,
      domain: 'website',
      pageType: launchSupport.pageType,
      headings: [],
      contentBlocks: [previewText],
      questionCandidates: [],
      previewText,
      priorityText: previewText,
      textLength: previewText.length,
      contentFingerprint,
      extractionNotes: ['Fallback page context was used because richer extraction was unavailable.'],
      capturedAt: new Date().toISOString()
    };
  }
}

function buildWorkflowState(
  requestId: string,
  currentUrl: string,
  currentTitle: string,
  assistantMode: SidebarMode,
  pageContext: PageContextSummary | null,
  canvasContext: CanvasContext | null,
  latestScan?: ScanPagePayload,
  analysis?: PageAnalysisResult,
  previousWorkflowState?: WorkflowState
) {
  logDebug('Classifier started.', {
    requestId,
    currentUrl,
    assistantMode,
    hasPageContext: Boolean(pageContext),
    hasCanvasContext: Boolean(canvasContext),
    hasScan: Boolean(latestScan)
  });

  const classification = classifyTaskType({
    assistantMode,
    pageContext,
    latestScan,
    canvasContext,
    currentUrl,
    currentTitle
  });
  const workflowRoute = routeWorkflow(classification);
  const workflowState = deriveWorkflowState({
    classification,
    workflowRoute,
    latestScan,
    pageContext,
    analysis,
    previous: previousWorkflowState
  });

  logDebug('Classifier result.', {
    requestId,
    taskType: classification.taskType,
    confidence: classification.confidence,
    platform: classification.platform,
    reasons: classification.reasons
  });
  logDebug('Workflow route selected.', {
    requestId,
    route: workflowRoute.route,
    statusLevel: workflowRoute.statusLevel
  });
  logDebug('Workflow type chosen.', {
    requestId,
    workflowType: workflowState.workflowType,
    recommendedAction: workflowState.recommendedAction
  });
  logDebug('Prompt extraction result.', {
    requestId,
    promptType: workflowState.promptExtraction?.promptType ?? 'unknown',
    source: workflowState.promptExtraction?.source ?? 'none',
    confidence: workflowState.promptExtraction?.confidence ?? 0
  });

  return {
    classification,
    workflowRoute,
    workflowState
  };
}

function buildIdleContextMessage(_assistantMode: SidebarMode, pageTitle: string) {
  return `Page context refreshed for ${pageTitle}.`;
}

function buildReadyMessage(_assistantMode: SidebarMode, pageTitle: string) {
  return `Answer ready for ${pageTitle}.`;
}

async function sendToTab<T>(
  tabId: number,
  message: unknown,
  timeoutMs = PANEL_OPEN_TIMEOUT_MS
): Promise<{ ok: true; response: T } | { ok: false; reason: OpenCanvyFailureReason; detail?: string }> {
  let timeoutId: number | undefined;

  try {
    const result = await Promise.race([
      chrome.tabs
        .sendMessage(tabId, message)
        .then((response) => ({ kind: 'response' as const, response }))
        .catch((error: unknown) => ({ kind: 'error' as const, error })),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timeoutId = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
      })
    ]);

    if (result.kind === 'timeout') {
      return { ok: false, reason: 'open_failed', detail: 'Timed out waiting for tab response.' };
    }

    if (result.kind === 'error') {
      const detail = getErrorMessage(result.error);
      return {
        ok: false,
        reason: isContentUnavailableError(detail) ? 'content_unavailable' : 'open_failed',
        detail
      };
    }

    return { ok: true, response: result.response as T };
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

async function waitForTabReady(tabId: number, requestId: string, timeoutMs = TAB_READY_TIMEOUT_MS) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') {
      return true;
    }
  } catch (error) {
    console.warn(`[Canvy background][${requestId}] Could not inspect tab readiness.`, {
      tabId,
      detail: getErrorMessage(error)
    });
    return false;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutId: number | undefined;

    const finish = (result: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      resolve(result);
    };

    const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        finish(true);
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    timeoutId = setTimeout(() => finish(false), timeoutMs);
  });
}

async function attachContentScript(tabId: number, currentUrl: string, requestId: string) {
  try {
    logDebug('Attempting content-script injection.', { requestId, tabId, currentUrl });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
    return true;
  } catch (error) {
    console.warn(`[Canvy background][${requestId}] Content script injection failed.`, {
      tabId,
      currentUrl,
      detail: getErrorMessage(error)
    });
    return false;
  }
}

async function pingTab(tabId: number, requestId: string) {
  return sendToTab<PingResponse>(tabId, { type: 'CANVY_PING', requestId }, ATTACH_PING_TIMEOUT_MS);
}

async function ensureTabAttachment(tabId: number, currentUrl: string, requestId: string) {
  const launchSupport = getLaunchSupport(currentUrl);
  if (!launchSupport.isSupported) {
    return {
      ok: false as const,
      reason: 'unsupported_page' as OpenCanvyFailureReason,
      attachStatus: 'unsupported' as AttachStatus
    };
  }

  await waitForTabReady(tabId, requestId);

  const firstPing = await pingTab(tabId, requestId);
  if (firstPing.ok) {
    return { ok: true as const, attachStatus: 'ready' as AttachStatus };
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const attached = await attachContentScript(tabId, currentUrl, requestId);
    if (!attached) {
      continue;
    }

    await waitForTabReady(tabId, requestId, 1200);

    for (const delay of ATTACH_RETRY_DELAYS_MS) {
      await sleep(delay);
      const ping = await pingTab(tabId, requestId);
      if (ping.ok) {
        return { ok: true as const, attachStatus: 'attached_after_injection' as AttachStatus };
      }
    }
  }

  return {
    ok: false as const,
    reason: 'attach_failed' as OpenCanvyFailureReason,
    attachStatus: 'attach_failed' as AttachStatus
  };
}

async function extractActivePageContext(tab: chrome.tabs.Tab, requestId: string) {
  if (!tab.id || !tab.url) {
    return null;
  }

  const ensured = await ensureTabAttachment(tab.id, tab.url, requestId);
  if (!ensured.ok) {
    logDebug('Page-context extraction unavailable.', {
      requestId,
      tabId: tab.id,
      reason: ensured.reason,
      attachStatus: ensured.attachStatus
    });
    return null;
  }

  const response = await sendToTab<PageContextSummary>(tab.id, { type: 'CANVY_EXTRACT_PAGE_CONTEXT', requestId }, 1200);
  if (!response.ok) {
    logDebug('Page-context extraction failed after attachment.', {
      requestId,
      tabId: tab.id,
      reason: response.reason,
      detail: response.detail
    });
    return null;
  }

  logDebug('Page-context extracted.', {
    requestId,
    tabId: tab.id,
    title: response.response.title,
    pageType: response.response.pageType
  });

  return response.response;
}

async function extractActiveCanvasContext(tab: chrome.tabs.Tab, requestId: string) {
  if (!tab.id || !tab.url) {
    return null;
  }

  const ensured = await ensureTabAttachment(tab.id, tab.url, requestId);
  if (!ensured.ok) {
    logDebug('Canvas extraction unavailable.', {
      requestId,
      tabId: tab.id,
      reason: ensured.reason,
      attachStatus: ensured.attachStatus
    });
    return null;
  }

  const response = await sendToTab<CanvasContext | null>(tab.id, { type: 'CANVY_EXTRACT_CONTEXT', requestId }, 1200);
  if (!response.ok) {
    logDebug('Canvas extraction failed after attachment.', {
      requestId,
      tabId: tab.id,
      reason: response.reason,
      detail: response.detail
    });
    return null;
  }

  logDebug('Canvas context extracted.', {
    requestId,
    tabId: tab.id,
    pageKind: response.response?.pageKind ?? 'none'
  });

  return response.response;
}

async function getActiveTab() {
  const target = await resolveActivePanelTarget(createRequestId(), 'state-sync');
  return target?.tab;
}

async function syncPageBootstrap(tab?: chrome.tabs.Tab, requestId = createRequestId()) {
  const activeTab = tab ?? (await getActiveTab());
  const state = await getExtensionState();
  const currentPageState = state.session.pageState;

  if (!activeTab?.windowId) {
    logDebug('No active tab window found while syncing page bootstrap.', { requestId });
    return {
      assistantMode: state.session.assistantMode ?? 'general',
      pageContext: state.session.pageContext ?? null,
      canvasContext: state.session.context ?? null,
      canvasApiSummary: state.session.canvasApiSummary
    };
  }

  logDebug('Syncing page bootstrap.', {
    requestId,
    tabId: activeTab.id,
    windowId: activeTab.windowId,
    currentUrl: activeTab.url ?? '',
    title: activeTab.title ?? 'Current page'
  });

  if (!activeTab.id || !activeTab.url) {
    const cleared = await saveSession({
      assistantMode: 'general',
      pageState: {
        currentPage: {
          assistantMode: 'general',
          platform: 'unknown'
        },
        pageContext: undefined,
        scan: undefined,
        classification: undefined,
        workflowRoute: undefined,
        analysis: undefined,
        uiStatus: {
          lifecycle: 'idle',
          message: 'Open a browser tab to start page-aware scanning.',
          lastAction: 'bootstrap'
        },
        timestamps: {
          pageCapturedAt: undefined,
          scannedAt: undefined,
          analyzedAt: undefined,
          classifiedAt: undefined,
          routedAt: undefined,
          staleAt: undefined
        },
        errors: {
          pageContext: undefined,
          scan: undefined,
          analysis: undefined,
          classification: undefined
        }
      },
      pageContext: undefined,
      context: undefined,
      canvasApiSummary: undefined,
      workflowState: undefined,
      latestClassification: undefined,
      latestWorkflowRoute: undefined,
      lastAnalysis: undefined,
      activeTask: undefined
    });

    return {
      assistantMode: cleared.assistantMode ?? 'general',
      pageContext: cleared.pageContext ?? null,
      canvasContext: cleared.context ?? null,
      canvasApiSummary: cleared.canvasApiSummary
    };
  }

  const launchSupport = getLaunchSupport(activeTab.url);
  if (!launchSupport.isSupported) {
    const cleared = await saveSession({
      assistantMode: 'general',
      pageState: {
        currentPage: {
          url: activeTab.url,
          title: activeTab.title ?? 'Current page',
          assistantMode: 'general',
          platform: 'unknown',
          pageType: launchSupport.pageType
        },
        pageContext: undefined,
        scan: undefined,
        classification: undefined,
        workflowRoute: undefined,
        analysis: undefined,
        uiStatus: {
          lifecycle: 'idle',
          message: launchSupport.message,
          lastAction: 'bootstrap'
        },
        timestamps: {
          pageCapturedAt: undefined,
          scannedAt: undefined,
          analyzedAt: undefined,
          classifiedAt: undefined,
          routedAt: undefined,
          staleAt: undefined
        },
        errors: {
          pageContext: undefined,
          scan: undefined,
          analysis: undefined,
          classification: undefined
        }
      },
      pageContext: undefined,
      context: undefined,
      canvasApiSummary: undefined,
      workflowState: undefined,
      latestClassification: undefined,
      latestWorkflowRoute: undefined,
      lastAnalysis: undefined,
      activeTask: undefined
    });

    logDebug('Current tab is unsupported for page extraction.', {
      requestId,
      tabId: activeTab.id,
      currentUrl: activeTab.url
    });

    return {
      assistantMode: cleared.assistantMode ?? 'general',
      pageContext: cleared.pageContext ?? null,
      canvasContext: cleared.context ?? null,
      canvasApiSummary: cleared.canvasApiSummary
    };
  }

  const assistantMode = detectAssistantMode(activeTab.url);
  const pageContext = (await extractActivePageContext(activeTab, requestId)) ?? buildFallbackPageContext(activeTab, assistantMode);
  const canvasContext = assistantMode === 'canvas' ? await extractActiveCanvasContext(activeTab, requestId) : null;
  let canvasApiSummary: CanvasApiSummary | undefined;
  if (canvasContext) {
    const { client, flushTokenAndHealth } = await createApiClient();
    try {
      canvasApiSummary = await client.fetchCanvasContext({
        sourceUrl: canvasContext.sourceUrl || activeTab.url,
        courseId: canvasContext.courseId,
        assignmentId: canvasContext.assignmentId
      }, {
        requestId,
        source: 'canvas-context',
        routeLabel: 'Canvas context route'
      });
      await flushTokenAndHealth('connected');
    } catch (error) {
      canvasApiSummary = createUnavailableCanvasSummary(canvasContext);
      await flushTokenAndHealth('degraded', mapApiErrorMessage(error));
      logDebug('Canvas API summary unavailable; using empty fallback summary.', {
        requestId,
        detail: mapApiErrorMessage(error)
      });
    }
  }
  const currentPageUrl = pageContext?.url ?? activeTab.url;
  const previousPageUrl = currentPageState.currentPage.url ?? state.session.pageContext?.url;
  const didPageChange = previousPageUrl !== currentPageUrl || state.session.assistantMode !== assistantMode;
  const existingAnalysis = didPageChange ? undefined : normalizeStoredAnalysis(currentPageState.analysis ?? state.session.lastAnalysis);
  const latestScanMatchesPage = currentPageState.scan?.url === currentPageUrl || state.session.latestScan?.url === currentPageUrl;
  const currentLatestScan = latestScanMatchesPage ? currentPageState.scan ?? state.session.latestScan : undefined;
  const previousUiStatus = currentPageState.uiStatus;
  const previousErrors = currentPageState.errors;
  const previousLifecycle = didPageChange ? undefined : previousUiStatus.lifecycle;
  const previousErrorMessage =
    previousErrors.analysis ?? previousErrors.scan ?? previousErrors.pageContext ?? previousErrors.classification;
  const workflowState = buildWorkflowState(
    requestId,
    currentPageUrl,
    activeTab.title ?? pageContext?.title ?? 'Current page',
    assistantMode,
    pageContext,
    canvasContext,
    currentLatestScan,
    existingAnalysis,
    didPageChange ? undefined : state.session.workflowState
  );
  const shouldPreserveTransientState =
    previousLifecycle === 'scanning' || previousLifecycle === 'analyzing' || previousLifecycle === 'error';
  const lifecycle = existingAnalysis
    ? 'ready'
    : currentLatestScan
      ? 'scanned'
      : shouldPreserveTransientState
        ? previousLifecycle
        : 'idle';
  const lifecycleMessage = existingAnalysis
    ? buildReadyMessage(assistantMode, pageContext?.title ?? activeTab.title ?? 'this page')
    : currentLatestScan
      ? `Scan captured for ${pageContext?.title ?? activeTab.title ?? 'this page'}.`
      : previousLifecycle === 'analyzing'
        ? previousUiStatus.message || `Analyzing ${pageContext?.title ?? activeTab.title ?? 'the current page'}...`
        : previousLifecycle === 'scanning'
          ? previousUiStatus.message || `Scanning ${pageContext?.title ?? activeTab.title ?? 'the current page'}...`
          : previousLifecycle === 'error' && previousErrorMessage
            ? previousErrorMessage
            : didPageChange && (currentPageState.scan || currentPageState.analysis)
              ? `The page changed. Context refreshed for ${pageContext?.title ?? activeTab.title ?? 'this page'}, but no current scan is available yet.`
              : buildIdleContextMessage(assistantMode, pageContext?.title ?? activeTab.title ?? 'this page');
  const preservedErrors =
    !didPageChange && previousLifecycle === 'error'
      ? {
          pageContext: previousErrors.pageContext,
          scan: previousErrors.scan,
          analysis: previousErrors.analysis,
          classification: previousErrors.classification
        }
      : {
          pageContext: undefined,
          scan: undefined,
          analysis: undefined,
          classification: undefined
        };

  await saveSession({
    assistantMode,
    pageState: {
      currentPage: {
        tabId: activeTab.id,
        url: currentPageUrl,
        title: pageContext?.title ?? activeTab.title ?? 'Current page',
        domain: pageContext?.domain,
        pageType: pageContext?.pageType,
        assistantMode,
        platform: workflowState.classification.platform
      },
      pageContext: pageContext ?? undefined,
      scan: currentLatestScan,
      classification: workflowState.classification,
      workflowRoute: workflowState.workflowRoute,
      analysis: existingAnalysis,
      uiStatus: {
        lifecycle,
        message: lifecycleMessage,
        lastAction: 'bootstrap'
      },
      timestamps: {
        pageCapturedAt: pageContext?.capturedAt,
        scannedAt: currentLatestScan?.scannedAt ?? currentPageState.timestamps.scannedAt,
        analyzedAt: existingAnalysis?.generatedAt ?? currentPageState.timestamps.analyzedAt,
        classifiedAt: workflowState.classification.classifiedAt,
        routedAt: workflowState.workflowRoute.routedAt,
        staleAt: undefined
      },
      errors: preservedErrors
    },
    pageContext: pageContext ?? undefined,
    context: canvasContext ?? undefined,
    canvasApiSummary,
    workflowState: workflowState.workflowState,
    latestClassification: workflowState.classification,
    latestWorkflowRoute: workflowState.workflowRoute,
    lastAnalysis: existingAnalysis,
    activeTask: didPageChange ? undefined : state.session.activeTask,
    latestScan: currentLatestScan,
    scanStatus: lifecycle,
    scanError: undefined
  });
  logDebug('Normalized page state written.', {
    requestId,
    lifecycle,
    currentPageUrl,
    hasScan: Boolean(currentLatestScan),
    taskType: workflowState.classification.taskType
  });

  return {
    assistantMode,
    pageContext,
    canvasContext,
    canvasApiSummary
  };
}

async function getPopupStatus(): Promise<PopupStatus> {
  const tab = await getActiveTab();
  const { settings } = await getExtensionState();
  const currentUrl = tab?.url ?? '';
  const launchSupport = getLaunchSupport(currentUrl);
  const shortcutHint = await getShortcutHint();

  return {
    isCanvasPage: launchSupport.assistantMode === 'canvas',
    isConfigured: settings.configured,
    canScan: launchSupport.isSupported,
    isSupportedLaunchPage: launchSupport.isSupported,
    assistantMode: launchSupport.assistantMode,
    statusLabel: launchSupport.statusLabel,
    launchSupportMessage: launchSupport.message,
    shortcutHint,
    pageType: launchSupport.pageType,
    attachStatus: launchSupport.isSupported ? 'ready' : 'unsupported',
    pageTitle: tab?.title ?? 'Current page',
    currentUrl,
    windowId: tab?.windowId
  };
}

async function openWorkspaceWindow(
  windowId: number,
  requestId: string,
  source: string,
  tab?: chrome.tabs.Tab
): Promise<OpenCanvyResult> {
  const currentUrl = tab?.url ?? '';
  const pageTitle = tab?.title ?? 'Current page';
  const launchSupport = getLaunchSupport(currentUrl);

  logDebug('Attempting workspace open.', {
    requestId,
    source,
    windowId,
    tabId: tab?.id,
    currentUrl,
    pageTitle,
    assistantMode: launchSupport.assistantMode
  });

  try {
    await chrome.sidePanel.open({ windowId });
    logDebug('Workspace opened successfully.', {
      requestId,
      source,
      windowId,
      tabId: tab?.id,
      currentUrl
    });
    return {
      ok: true,
      requestId,
      mode:
        launchSupport.assistantMode === 'canvas'
          ? 'canvas'
          : launchSupport.assistantMode === 'general'
            ? 'general'
            : undefined,
      pageTitle,
      currentUrl,
      message: buildOpenCanvyMessage('open', launchSupport.assistantMode, launchSupport.isSupported)
    };
  } catch (error) {
    console.error(`[Canvy background][${requestId}] Workspace open failed.`, {
      source,
      windowId,
      tabId: tab?.id,
      detail: getErrorMessage(error)
    });
    return {
      ok: false,
      requestId,
      reason: 'open_failed',
      pageTitle,
      currentUrl,
      message: 'Mako IQ could not open the Chrome side panel in this window.'
    };
  }
}

function buildScanSuccessMessage(page: ScanPagePayload) {
  return `Scan complete. Mako IQ captured page context from ${page.pageTitle}.`;
}

async function runActivePageScan(
  requestId: string,
  source: string,
  sourceType: ScanPagePayload['sourceType'] = 'reference'
): Promise<ScanResponse> {
  const target = await resolveActivePanelTarget(requestId, source);
  if (!target?.tab?.id || !target.tab.url) {
    const message = 'Open a browser tab and try screen analysis again.';
    await setScanState('error', message);
    return {
      ok: false,
      message
    };
  }

  const launchSupport = getLaunchSupport(target.tab.url);
  logDebug('Scan requested.', {
    requestId,
    source,
    tabId: target.tab.id,
    windowId: target.tab.windowId,
    currentUrl: target.tab.url,
    supported: launchSupport.isSupported,
    assistantMode: launchSupport.assistantMode
  });

  if (!launchSupport.isSupported) {
    await setScanState('error', launchSupport.message);
    return {
      ok: false,
      message: launchSupport.message,
      attachStatus: 'unsupported'
    };
  }

  const bootstrap = await syncPageBootstrap(target.tab, requestId);
  await savePageState({
    uiStatus: {
      lifecycle: 'scanning',
      message: `Scanning ${bootstrap.pageContext?.title ?? target.tab.title ?? 'the current page'}...`,
      lastAction: 'scan'
    },
    errors: {
      scan: undefined,
      analysis: undefined
    }
  });

  const ensured = await ensureTabAttachment(target.tab.id, target.tab.url, requestId);
  if (!ensured.ok) {
    const message =
      ensured.reason === 'attach_failed'
        ? 'Mako IQ could not attach to this tab to scan it. Reload the page and try again.'
        : 'Mako IQ could not reach readable page content for this scan.';

    logDebug('Scan aborted before extraction.', {
      requestId,
      tabId: target.tab.id,
      reason: ensured.reason,
      attachStatus: ensured.attachStatus
    });

    await setScanState('error', message);
    return {
      ok: false,
      message,
      attachStatus: ensured.attachStatus
    };
  }

  traceBackgroundEvent('scan:start', {
    requestId,
    source: sourceType,
    tabId: target.tab.id,
    currentUrl: target.tab.url ?? ''
  });
  recordRequestDiagnostic('scan:start', 'Page scan started.', {
    requestId,
    context: 'service_worker.scan',
    source: sourceType,
    url: target.tab.url ?? '',
    detail: `tabId=${target.tab.id}`
  });

  logDebug('Content extraction started.', {
    requestId,
    tabId: target.tab.id,
    sourceType
  });

  const scanResponse = await sendToTab<ScanPagePayload>(
    target.tab.id,
    { type: 'CANVY_SCAN_PAGE', requestId, sourceType },
    2200
  );

  if (!scanResponse.ok) {
    const message =
      scanResponse.reason === 'content_unavailable'
        ? 'Mako IQ could not reach the page content script for this scan. Reload the tab and try again.'
        : 'Mako IQ could not finish scanning this page.';

    logDebug('Content extraction failed.', {
      requestId,
      tabId: target.tab.id,
      reason: scanResponse.reason,
      detail: scanResponse.detail
    });

    await setScanState('error', message);
    return {
      ok: false,
      message,
      attachStatus: ensured.attachStatus
    };
  }

  const localPage = scanResponse.response;
  let page = localPage;
  let backendWarning: string | undefined;

  logDebug('Content extraction completed.', {
    requestId,
    tabId: target.tab.id,
    pageType: page.pageType,
    mode: page.mode,
    textLength: page.readableText.length,
    canvasDetected: page.mode === 'canvas'
  });
  traceBackgroundEvent('scan:extracted', {
    requestId,
    tabId: target.tab.id,
    pageType: page.pageType,
    mode: page.mode,
    textLength: page.readableText.length
  });
  recordRequestDiagnostic('scan:extracted', 'Page content extracted.', {
    requestId,
    context: 'service_worker.scan',
    source: sourceType,
    url: page.url,
    detail: `mode=${page.mode} textLength=${page.readableText.length}`
  });

  const { client, flushTokenAndHealth } = await createApiClient();

  if (shouldUseVisionFallback(localPage) && target.tab.windowId && target.tab.windowId !== chrome.windows.WINDOW_ID_NONE) {
    try {
      const imageDataUrl = await chrome.tabs.captureVisibleTab(target.tab.windowId, { format: 'png' });
      const visionPayload: ImageScanRequest = {
        title: localPage.pageTitle,
        url: localPage.url,
        imageDataUrl,
        sourceType,
        pageType: localPage.pageType ?? 'generic'
      };
      const visionResponse = await client.scanPageFromImage(visionPayload, {
        requestId,
        source: 'scan-vision-fallback',
        routeLabel: 'Vision scan route'
      });
      if (shouldPreferVisionScan(visionResponse.page, localPage)) {
        page = normalizeVisionScanPayload(visionResponse.page, localPage, bootstrap.assistantMode, bootstrap.canvasContext);
        logDebug('OCR fallback scan completed and replaced DOM scan.', {
          requestId,
          mode: page.mode,
          sourceMode: page.sourceMode,
          textLength: page.readableText.length
        });
      } else {
        logDebug('OCR fallback returned no meaningful improvement; keeping DOM scan.', {
          requestId,
          domTextLength: localPage.readableText.length,
          ocrTextLength: visionResponse.page.readableText?.trim().length ?? 0
        });
      }
      await flushTokenAndHealth('connected');
    } catch (error) {
      backendWarning = `OCR fallback unavailable: ${mapApiErrorMessage(error)}`;
      await flushTokenAndHealth('degraded', mapApiErrorMessage(error));
      logDebug('OCR fallback failed; continuing with DOM scan.', {
        requestId,
        detail: mapApiErrorMessage(error)
      });
    }
  }

  try {
    await client.persistScanPage(page, {
      requestId,
      source: 'scan-sync',
      routeLabel: 'Scan page route'
    });
    await flushTokenAndHealth('connected');
  } catch (error) {
    backendWarning = backendWarning
      ? `${backendWarning} Backend scan sync unavailable: ${mapApiErrorMessage(error)}`
      : `Backend scan sync unavailable: ${mapApiErrorMessage(error)}`;
    await flushTokenAndHealth('degraded', mapApiErrorMessage(error));
    logDebug('Scan sync to backend failed; keeping local scan state.', {
      requestId,
      detail: mapApiErrorMessage(error)
    });
  }

  await saveLatestScan(page);
  logDebug('Storage write completed for scan result.', {
    requestId,
    tabId: target.tab.id,
    scannedAt: page.scannedAt
  });
  await savePageState({
    uiStatus: {
      lifecycle: 'analyzing',
      message: `Classifying ${page.pageTitle}...`,
      lastAction: 'scan'
    }
  });

  const stateBeforeWorkflow = await getExtensionState();
  const workflowState = buildWorkflowState(
    requestId,
    page.url,
    page.pageTitle,
    bootstrap.assistantMode,
    bootstrap.pageContext,
    bootstrap.canvasContext,
    page,
    undefined,
    stateBeforeWorkflow.session.workflowState
  );
  await saveWorkflowState(workflowState.classification, workflowState.workflowRoute);
  await persistWorkflowState(workflowState.workflowState);
  logDebug('Automatic workflow recompute completed after scan.', {
    requestId,
    workflowType: workflowState.workflowState.currentWorkflow,
    promptDetected: Boolean(workflowState.workflowState.promptExtraction?.promptText),
    actionId: workflowState.workflowState.currentAction
  });

  const state = await getExtensionState();
  await saveSession({
    assistantMode: bootstrap.assistantMode,
    pageState: {
      currentPage: {
        tabId: target.tab.id,
        url: page.url,
        title: page.pageTitle,
        domain: page.hostname,
        pageType: page.pageType,
        assistantMode: bootstrap.assistantMode,
        platform: workflowState.classification.platform
      },
      pageContext: bootstrap.pageContext ?? undefined,
      scan: page,
      classification: workflowState.classification,
      workflowRoute: workflowState.workflowRoute,
      analysis: undefined,
      uiStatus: {
        lifecycle: 'ready',
        message: buildScanSuccessMessage(page),
        lastAction: 'scan'
      },
      timestamps: {
        pageCapturedAt: bootstrap.pageContext?.capturedAt,
        scannedAt: page.scannedAt,
        analyzedAt: undefined,
        classifiedAt: workflowState.classification.classifiedAt,
        routedAt: workflowState.workflowRoute.routedAt,
        staleAt: undefined
      },
      errors: {
        scan: undefined,
        analysis: undefined,
        classification: undefined
      }
    },
    pageContext: bootstrap.pageContext ?? undefined,
    context: bootstrap.canvasContext ?? undefined,
    canvasApiSummary: bootstrap.canvasApiSummary,
    workflowState: workflowState.workflowState,
    latestClassification: workflowState.classification,
    latestWorkflowRoute: workflowState.workflowRoute,
    lastAnalysis: undefined,
    messages: [
      ...state.session.messages,
      createMessage(
        'assistant',
        'status',
        backendWarning ? `${buildScanSuccessMessage(page)} ${backendWarning}` : buildScanSuccessMessage(page)
      )
    ]
  });
  logDebug('Normalized scan state written.', {
    requestId,
    lifecycle: 'ready',
    url: page.url,
    taskType: workflowState.classification.taskType,
    route: workflowState.workflowRoute.route
  });

  return {
    ok: true,
    page,
    message: backendWarning ? `${buildScanSuccessMessage(page)} ${backendWarning}` : buildScanSuccessMessage(page),
    attachStatus: ensured.attachStatus
  };
}

async function runActivePageAnalysis(requestId: string, source: string, instruction = ''): Promise<{
  ok: boolean;
  analysis: PageAnalysisResult | null;
  mode: SidebarMode;
  pageSupported: boolean;
  error?: string;
}> {
  const tab = await getActiveTab();
  const launchSupport = getLaunchSupport(tab?.url ?? '');
  const analysisRequestKey = buildAnalysisControllerKey(tab?.id);
  activeAnalysisRequests.set(analysisRequestKey, requestId);
  let bootstrap = await syncPageBootstrap(tab, requestId);
  let state = await getExtensionState();
  const mode: SidebarMode = bootstrap.assistantMode;
  let pageState = state.session.pageState;

  if (launchSupport.isSupported && !hasFreshScan(pageState)) {
    const scanResponse = await runActivePageScan(requestId, `${source}-ensure-scan`);
    if (!scanResponse.ok) {
      if (isCurrentAnalysisRequest(analysisRequestKey, requestId)) {
        activeAnalysisRequests.delete(analysisRequestKey);
      }
      return {
        ok: false,
        analysis: null,
        mode,
        pageSupported: launchSupport.isSupported,
        error: scanResponse.message
      };
    }

    bootstrap = await syncPageBootstrap(tab, requestId);
    state = await getExtensionState();
    pageState = state.session.pageState;
  }

  const pageContext = bootstrap.pageContext ?? (tab ? buildFallbackPageContext(tab, mode) : null);
  const analysisTask =
    state.session.workflowState?.currentActionTask ??
    state.session.workflowState?.selectedTask ??
    (mode === 'canvas' ? 'analyze_assignment' : 'summarize_reading');
  const analysisMode = source.startsWith('popup') ? 'quick_summary' : mapTaskToAnalysisMode(analysisTask, state.session.workflowState?.currentAction);
  const trimmedInstruction = instruction.trim();

  logDebug('Analysis action requested.', {
    requestId,
    source,
    tabId: tab?.id,
    windowId: tab?.windowId,
    currentUrl: tab?.url ?? '',
    supported: launchSupport.isSupported,
    assistantMode: launchSupport.assistantMode,
    analysisMode
  });

  await savePageState({
    analysis: undefined,
    uiStatus: {
      lifecycle: 'analyzing',
      message: `Analyzing ${pageContext?.title ?? tab?.title ?? 'the current page'}...`,
      lastAction: 'analyze'
    },
    errors: {
      analysis: undefined
    }
  });

  if (!launchSupport.isSupported || !pageContext) {
    const errorMessage = launchSupport.isSupported
      ? 'Mako IQ could not extract readable page context from the current tab.'
      : 'This browser page does not expose readable page context.';

    await saveSession({
      assistantMode: mode,
      pageState: {
        currentPage: {
          tabId: tab?.id,
          url: pageContext?.url ?? tab?.url,
          title: pageContext?.title ?? tab?.title ?? 'Current page',
          domain: pageContext?.domain,
          pageType: pageContext?.pageType,
          assistantMode: mode,
          platform: state.session.pageState.classification?.platform ?? (mode === 'canvas' ? 'canvas' : 'general_web')
        },
        pageContext: bootstrap.pageContext ?? undefined,
        scan: state.session.pageState.scan,
        classification: state.session.pageState.classification,
        workflowRoute: state.session.pageState.workflowRoute,
        analysis: undefined,
        uiStatus: {
          lifecycle: 'error',
          message: errorMessage,
          lastAction: 'analyze'
        },
        timestamps: {
          pageCapturedAt: bootstrap.pageContext?.capturedAt,
          scannedAt: state.session.pageState.scan?.scannedAt,
          analyzedAt: undefined,
          classifiedAt: state.session.pageState.classification?.classifiedAt,
          routedAt: state.session.pageState.workflowRoute?.routedAt,
          staleAt: undefined
        },
        errors: {
          analysis: errorMessage,
          scan: undefined,
          classification: undefined
        }
      },
      pageContext: bootstrap.pageContext ?? undefined,
      context: bootstrap.canvasContext ?? undefined,
      canvasApiSummary: bootstrap.canvasApiSummary,
      lastAnalysis: undefined,
      messages: [...state.session.messages, createMessage('assistant', 'status', errorMessage)]
    });

    if (isCurrentAnalysisRequest(analysisRequestKey, requestId)) {
      activeAnalysisRequests.delete(analysisRequestKey);
    }

    return {
      ok: false,
      analysis: null,
      mode,
      pageSupported: launchSupport.isSupported,
      error: errorMessage
    };
  }

  try {
    const analysis = await requestBackendAnalysis({
      requestId,
      source,
      tab,
      assistantMode: mode,
      pageContext,
      canvasContext: bootstrap.canvasContext,
      latestScan: state.session.pageState.scan,
      mode: analysisMode,
      instruction: trimmedInstruction
    });
    await updateBackendConnection('connected');

    const derivedWorkflowState =
      state.session.pageState.classification && state.session.pageState.workflowRoute
        ? deriveWorkflowState({
            classification: state.session.pageState.classification,
            workflowRoute: state.session.pageState.workflowRoute,
            latestScan: state.session.pageState.scan,
            pageContext: bootstrap.pageContext,
            analysis,
            previous: state.session.workflowState
          })
        : state.session.workflowState;

    const workflowExperience = derivedWorkflowState
      ? {
          ...derivedWorkflowState,
          outputShell: mapAnalysisToWorkflowShell(derivedWorkflowState, analysisTask, analysis),
          pageAnalysis: analysis,
          updatedAt: new Date().toISOString(),
          lastUpdatedAt: Date.now()
        }
      : state.session.workflowState
        ? {
            ...state.session.workflowState,
            pageAnalysis: analysis,
            updatedAt: new Date().toISOString(),
            lastUpdatedAt: Date.now()
          }
        : state.session.workflowState;

    if (workflowExperience?.outputShell) {
      await persistWorkflowState(workflowExperience);
    }

    const overlayStatus =
      workflowExperience?.outputShell && tab?.id
        ? await showWorkflowOverlayOnActivePage(
            workflowExperience,
            requestId,
            source,
            state.session.pageState.currentPage.tabId,
            state.session.pageState.currentPage.url
          )
        : state.session.overlayStatus;

    const nextMessages = [
      createMessage(
        'assistant',
        'status',
        'Live screen analysis is ready.'
      ),
      ...(trimmedInstruction ? [createMessage('user', 'user', trimmedInstruction)] : []),
      createMessage('assistant', 'explanation', analysis.text)
    ];

    if (!isCurrentAnalysisRequest(analysisRequestKey, requestId)) {
      return {
        ok: false,
        analysis: null,
        mode,
        pageSupported: launchSupport.isSupported,
        error: 'A newer scan replaced this result.'
      };
    }

    await saveSession({
      assistantMode: mode,
      pageState: {
        currentPage: {
          tabId: tab?.id,
          url: pageContext.url,
          title: pageContext.title,
          domain: pageContext.domain,
          pageType: pageContext.pageType,
          assistantMode: mode,
          platform: state.session.pageState.classification?.platform ?? (mode === 'canvas' ? 'canvas' : 'general_web')
        },
        pageContext: bootstrap.pageContext ?? undefined,
        scan: state.session.pageState.scan,
        classification: state.session.pageState.classification,
        workflowRoute: state.session.pageState.workflowRoute,
        analysis,
        uiStatus: {
          lifecycle: 'ready',
          message: buildReadyMessage(mode, analysis.sourceTitle),
          lastAction: 'analyze'
        },
        timestamps: {
          pageCapturedAt: bootstrap.pageContext?.capturedAt,
          scannedAt: state.session.pageState.scan?.scannedAt,
          analyzedAt: analysis.generatedAt,
          classifiedAt: state.session.pageState.classification?.classifiedAt,
          routedAt: state.session.pageState.workflowRoute?.routedAt,
          staleAt: undefined
        },
        errors: {
          analysis: undefined,
          scan: undefined,
          classification: undefined
        }
      },
      pageContext: bootstrap.pageContext ?? undefined,
      context: bootstrap.canvasContext ?? undefined,
      canvasApiSummary: bootstrap.canvasApiSummary,
      workflowState: workflowExperience,
      overlayStatus,
      activeTask: analysisTask,
      lastAnalysis: analysis,
      lastOutput: mapPageAnalysisToTaskOutput(analysis),
      messages: [...state.session.messages, ...nextMessages]
    });

    logDebug('Normalized analysis state written.', {
      requestId,
      lifecycle: 'ready',
      sourceUrl: pageContext.url,
      hasAnalysis: true,
      analysisMode
    });

    if (isCurrentAnalysisRequest(analysisRequestKey, requestId)) {
      activeAnalysisRequests.delete(analysisRequestKey);
    }

    return {
      ok: true,
      analysis,
      mode,
      pageSupported: launchSupport.isSupported
    };
  } catch (error) {
    const detail = mapAnalysisApiError(error);
    const errorMessage = detail || 'Mako IQ could not complete the AI analysis request.';
    if (!(error instanceof AnalysisApiError && error.code === 'cancelled')) {
      await updateBackendConnection('degraded', errorMessage);
    }

    if (!isCurrentAnalysisRequest(analysisRequestKey, requestId)) {
      return {
        ok: false,
        analysis: null,
        mode,
        pageSupported: launchSupport.isSupported,
        error: 'A newer scan replaced this result.'
      };
    }

    await saveSession({
      assistantMode: mode,
      pageState: {
        currentPage: {
          tabId: tab?.id,
          url: pageContext.url,
          title: pageContext.title,
          domain: pageContext.domain,
          pageType: pageContext.pageType,
          assistantMode: mode,
          platform: state.session.pageState.classification?.platform ?? (mode === 'canvas' ? 'canvas' : 'general_web')
        },
        pageContext: bootstrap.pageContext ?? undefined,
        scan: state.session.pageState.scan,
        classification: state.session.pageState.classification,
        workflowRoute: state.session.pageState.workflowRoute,
        analysis: undefined,
        uiStatus: {
          lifecycle: 'error',
          message: errorMessage,
          lastAction: 'analyze'
        },
        timestamps: {
          pageCapturedAt: bootstrap.pageContext?.capturedAt,
          scannedAt: state.session.pageState.scan?.scannedAt,
          analyzedAt: undefined,
          classifiedAt: state.session.pageState.classification?.classifiedAt,
          routedAt: state.session.pageState.workflowRoute?.routedAt,
          staleAt: undefined
        },
        errors: {
          analysis: errorMessage,
          scan: undefined,
          classification: undefined
        }
      },
      pageContext: bootstrap.pageContext ?? undefined,
      context: bootstrap.canvasContext ?? undefined,
      canvasApiSummary: bootstrap.canvasApiSummary,
      lastAnalysis: undefined,
      messages: [...state.session.messages, createMessage('assistant', 'status', errorMessage)]
    });

    logDebug('Live analysis request failed.', {
      requestId,
      detail: errorMessage,
      analysisMode
    });

    if (isCurrentAnalysisRequest(analysisRequestKey, requestId)) {
      activeAnalysisRequests.delete(analysisRequestKey);
    }

    return {
      ok: false,
      analysis: null,
      mode,
      pageSupported: launchSupport.isSupported,
      error: errorMessage
    };
  }
}

async function cancelActiveAnalysis(requestId = createRequestId()) {
  const tab = await getActiveTab();
  const controllerKey = buildAnalysisControllerKey(tab?.id);
  const activeController = activeAnalysisControllers.get(controllerKey);

  if (!activeController || activeController.signal.aborted) {
    return {
      ok: false,
      requestId,
      message: 'There is no active analysis request to cancel.'
    };
  }

  activeController.abort();
  activeAnalysisControllers.delete(controllerKey);

  const state = await getExtensionState();
  if (state.session.analysisRun) {
    const cancelledSnapshot = failAnalysisRunSnapshot(state.session.analysisRun, 'The analysis request was cancelled.', 'cancelled');
    await persistAnalysisRun(cancelledSnapshot, {
      statusMessage: 'Analysis cancelled.',
      error: undefined
    });
  }

  return {
    ok: true,
    requestId,
    message: 'The active analysis request was cancelled.'
  };
}

async function refreshActivePageContext(requestId: string, source: string): Promise<BootstrapPayload> {
  logDebug('Refresh page context triggered.', {
    requestId,
    source
  });

  const bootstrap = await getBootstrap(requestId);
  const latest = await getExtensionState();
  const pageTitle = bootstrap.pageContext?.title ?? latest.session.pageState.currentPage.title ?? 'this page';

  await savePageState({
    uiStatus: {
      lifecycle: latest.session.pageState.scan ? 'scanned' : 'idle',
      message: latest.session.pageState.scan
        ? `Page context refreshed for ${pageTitle}. Existing scan results remain available.`
        : buildIdleContextMessage(bootstrap.assistantMode, pageTitle),
      lastAction: 'refresh'
    }
  });

  const refreshed = await getExtensionState();

  return {
    settings: refreshed.settings,
    session: refreshed.session,
    assistantMode: bootstrap.assistantMode,
    pageContext: bootstrap.pageContext,
    context: bootstrap.context
  };
}

async function resolveOverlayTargetTab(requestId: string, source: string, preferredTabId?: number, preferredUrl?: string) {
  if (preferredTabId) {
    try {
      const tab = await chrome.tabs.get(preferredTabId);
      if (tab.url && (!preferredUrl || tab.url === preferredUrl)) {
        logDebug('Overlay target tab resolved from stored page state.', {
          requestId,
          source,
          tabId: tab.id,
          currentUrl: tab.url
        });
        return tab;
      }
    } catch (error) {
      console.warn(`[Canvy background][${requestId}] Stored overlay tab could not be restored.`, {
        source,
        preferredTabId,
        detail: getErrorMessage(error)
      });
    }
  }

  const tab = await getActiveTab();
  if (tab?.id) {
    logDebug('Overlay target tab resolved from active tab fallback.', {
      requestId,
      source,
      tabId: tab.id,
      currentUrl: tab.url ?? ''
    });
  }
  return tab;
}

async function sendWorkflowOverlayMessage(
  tabId: number,
  requestId: string,
  workflowState: WorkflowState,
  source: string
) {
  logDebug('Sending overlay message to content script.', {
    requestId,
    source,
    tabId,
    overlayPayloadType: workflowState.outputShell?.type ?? 'none',
    actionId: workflowState.currentAction
  });

  return sendToTab<OverlayUpdateResponse>(
    tabId,
    {
      type: 'CANVY_SHOW_WORKFLOW_OVERLAY',
      requestId,
      workflowState
    },
    1600
  );
}

async function showWorkflowOverlayOnActivePage(
  workflowState: WorkflowState,
  requestId: string,
  source: string,
  preferredTabId?: number,
  preferredUrl?: string
): Promise<OverlayStatus> {
  const tab = await resolveOverlayTargetTab(requestId, source, preferredTabId, preferredUrl);
  if (!tab?.id || !tab.url) {
    const overlayStatus = createOverlayStatus('error', 'Mako IQ could not find an active page tab for the overlay.', {
      reason: 'no_active_tab',
      requestId,
      source,
      actionId: workflowState.currentAction
    });
    logDebug('Workflow overlay skipped because no active tab was available.', {
      ...overlayStatus
    });
    return overlayStatus;
  }

  const ensured = await ensureTabAttachment(tab.id, tab.url, requestId);
  if (!ensured.ok) {
    const overlayStatus = createOverlayStatus(
      'error',
      ensured.reason === 'unsupported_page'
        ? 'This page does not support the Mako IQ overlay.'
        : 'Mako IQ could not attach the content script needed to show the overlay.',
      {
        reason: ensured.reason === 'unsupported_page' ? 'unsupported_page' : 'content_script_not_attached',
        requestId,
        source,
        tabId: tab.id,
        actionId: workflowState.currentAction
      }
    );
    logDebug('Workflow overlay skipped because content attachment failed.', {
      ...overlayStatus,
      attachStatus: ensured.attachStatus
    });
    return overlayStatus;
  }

  let response = await sendWorkflowOverlayMessage(tab.id, requestId, workflowState, source);
  if (!response.ok) {
    logDebug('Overlay message send failed on first attempt.', {
      requestId,
      source,
      tabId: tab.id,
      reason: response.reason,
      detail: response.detail
    });
    const retryAttachment = await ensureTabAttachment(tab.id, tab.url, requestId);
    if (retryAttachment.ok) {
      response = await sendWorkflowOverlayMessage(tab.id, requestId, workflowState, `${source}-retry`);
    }
  }

  if (!response.ok) {
    const overlayStatus = createOverlayStatus('error', 'Mako IQ could not deliver the overlay message to the page.', {
      reason: mapOverlaySendFailure(response.reason),
      requestId,
      source,
      tabId: tab.id,
      actionId: workflowState.currentAction
    });
    logDebug('Workflow overlay render failed.', {
      ...overlayStatus,
      detail: response.detail
    });
    return overlayStatus;
  }

  if (!response.response.ok) {
    const overlayStatus = createOverlayStatus('error', response.response.message, {
      reason: response.response.reason ?? 'unknown',
      requestId,
      source,
      tabId: tab.id,
      actionId: workflowState.currentAction
    });
    logDebug('Content script reported overlay failure.', {
      ...overlayStatus,
      hostState: response.response.hostState
    });
    return overlayStatus;
  }

  const overlayStatus = createOverlayStatus('shown', response.response.message, {
    requestId,
    source,
    tabId: tab.id,
    actionId: workflowState.currentAction
  });
  logDebug('Workflow overlay rendered on active page.', {
    ...overlayStatus,
    workflowType: workflowState.currentWorkflow,
    hostState: response.response.hostState
  });
  return overlayStatus;
}

async function readViewportFromTab(tabId: number, requestId: string) {
  const response = await sendToTab<ScreenViewport>(tabId, { type: 'SCREEN_GET_VIEWPORT', requestId }, 1200);
  if (!response.ok) {
    logDebug('Viewport read failed for screen analysis.', {
      requestId,
      tabId,
      reason: response.reason,
      detail: response.detail
    });
    return createFallbackViewport();
  }

  return response.response;
}

async function readScreenTextContextFromTab(tabId: number, requestId: string): Promise<ScreenTextContext | undefined> {
  const response = await sendToTab<ScreenTextContext>(
    tabId,
    { type: 'SCREEN_EXTRACT_COMPACT_CONTEXT', requestId },
    SCREEN_CONTEXT_TIMEOUT_MS
  );
  if (!response.ok) {
    logDebug('Compact screen context read failed.', {
      requestId,
      tabId,
      reason: response.reason,
      detail: response.detail
    });
    return undefined;
  }

  return response.response;
}

async function readScreenPageSignatureFromTab(tabId: number, requestId: string) {
  const response = await sendToTab<{ ok: boolean; pageSignature?: string; url?: string }>(
    tabId,
    { type: 'SCREEN_GET_PAGE_SIGNATURE', requestId },
    650
  );

  if (!response.ok || !response.response.ok) {
    return undefined;
  }

  return {
    pageSignature: response.response.pageSignature ?? '',
    url: response.response.url ?? ''
  };
}

function clearScreenAnalysisRuntimeState(tabId: number, requestId: string, reason: string) {
  const controller = screenAnalysisControllers.get(tabId);
  if (controller && !controller.signal.aborted) {
    controller.abort();
  }

  screenAnalysisControllers.delete(tabId);
  void clearCachedScreenAnalysis(tabId);
  void removeSessionValue(STORAGE_KEYS.screenPreScanContext);
  lastScreenRequestStartedAt.delete(tabId);
  activeScreenRequests.set(tabId, requestId);

  traceBackgroundEvent('screen:context-cleared', {
    requestId,
    tabId,
    reason
  });
}

async function isScreenScanStillCurrent(options: {
  tabId: number;
  requestId: string;
  controller: AbortController;
  pageUrl: string;
  pageSignature?: string;
}) {
  if (!isLatestScreenRequest(options.tabId, options.requestId) || options.controller.signal.aborted) {
    return false;
  }

  const [tab, signature] = await Promise.all([
    chrome.tabs.get(options.tabId).catch(() => undefined),
    readScreenPageSignatureFromTab(options.tabId, `${options.requestId}-signature-check`).catch(() => undefined)
  ]);

  if (!tab?.url || tab.url !== options.pageUrl) {
    return false;
  }

  if (options.pageSignature && (!signature?.pageSignature || signature.pageSignature !== options.pageSignature)) {
    return false;
  }

  return true;
}

async function setMakoUiHiddenForScreenScan(
  tabId: number,
  requestId: string,
  hidden: boolean,
  settings?: Pick<CanvySettings, 'debugMode'>
) {
  const response = await sendToTab<{ ok: boolean; hidden?: boolean; message?: string }>(
    tabId,
    {
      type: 'SCREEN_SET_MAKO_UI_HIDDEN',
      requestId,
      hidden
    },
    900
  );

  if (!response.ok || !response.response.ok) {
    logScreenTiming(settings, hidden ? 'hide-ui-failed' : 'restore-ui-failed', {
      requestId,
      tabId,
      reason: response.ok ? response.response.message : response.reason,
      detail: response.ok ? undefined : response.detail
    });
    return false;
  }

  logScreenTiming(settings, hidden ? 'ui-hidden' : 'ui-restored', {
    requestId,
    tabId
  });
  return true;
}

async function captureOptimizedVisibleScreenForAnalysis(options: {
  tabId: number;
  windowId: number;
  requestId: string;
  settings: Pick<CanvySettings, 'debugMode'>;
  timing: ScreenAnalysisTiming;
}) {
  const hidden = await setMakoUiHiddenForScreenScan(options.tabId, options.requestId, true, options.settings);
  try {
    const captureStartedAt = Date.now();
    logScreenTiming(options.settings, 'capture-started', { requestId: options.requestId, tabId: options.tabId });
    const rawImage = await captureVisibleScreenshotDataUrl(options.windowId);
    const screenshotCaptureMs = Date.now() - captureStartedAt;
    options.timing.captureMs = screenshotCaptureMs;
    options.timing.screenshotCaptureMs = screenshotCaptureMs;
    logScreenTiming(options.settings, 'capture-finished', {
      requestId: options.requestId,
      tabId: options.tabId,
      screenshot_capture_ms: screenshotCaptureMs,
      rawBytes: estimateDataUrlBytes(rawImage)
    });

    const preprocessStartedAt = Date.now();
    const optimized = await optimizeScreenshotDataUrl(rawImage);
    options.timing.preprocessMs = Date.now() - preprocessStartedAt;
    return optimized;
  } finally {
    if (hidden) {
      await setMakoUiHiddenForScreenScan(options.tabId, options.requestId, false, options.settings);
    }
  }
}

async function sendScreenBubbleRenderMessage(
  tabId: number,
  requestId: string,
  payload: ScreenBubbleRenderPayload
) {
  return sendToTab<OverlayUpdateResponse>(
    tabId,
    {
      type: 'RENDER_ANSWER_BUBBLES',
      requestId,
      payload
    },
    1800
  );
}

async function sendScreenScanStatusMessage(
  tabId: number,
  requestId: string,
  status: 'idle' | 'scanning' | 'thinking' | 'success' | 'partial' | 'error',
  message: string
) {
  return sendToTab<OverlayUpdateResponse>(
    tabId,
    {
      type: 'RENDER_SCREEN_SCAN_STATUS',
      requestId,
      status,
      message
    },
    700
  );
}

function clearQuizModeRuntimeState(tabId: number, requestId: string, reason: string, clearCache = false) {
  const controller = quizModeControllers.get(tabId);
  if (controller && !controller.signal.aborted) {
    controller.abort();
  }

  quizModeControllers.delete(tabId);
  activeQuizRequests.set(tabId, requestId);
  activeQuizQuestionHashes.delete(tabId);
  if (clearCache) {
    quizModeCache.delete(tabId);
  }

  traceBackgroundEvent('quiz:context-cleared', {
    requestId,
    tabId,
    reason,
    clearCache
  });
}

function beginQuizRequest(tabId: number, requestId: string, questionHash: string) {
  const existing = quizModeControllers.get(tabId);
  if (existing && !existing.signal.aborted) {
    existing.abort();
  }

  const controller = new AbortController();
  quizModeControllers.set(tabId, controller);
  activeQuizRequests.set(tabId, requestId);
  activeQuizQuestionHashes.set(tabId, questionHash);
  return controller;
}

function isLatestQuizRequest(tabId: number, requestId: string) {
  return activeQuizRequests.get(tabId) === requestId;
}

function isLatestQuizQuestion(tabId: number, questionHash: string) {
  return activeQuizQuestionHashes.get(tabId) === questionHash;
}

function finishQuizRequest(tabId: number, requestId: string) {
  if (isLatestQuizRequest(tabId, requestId)) {
    quizModeControllers.delete(tabId);
  }
}

function mapQuizApiFailReason(error: unknown): QuizFailReason {
  if (error instanceof AnalysisApiError) {
    if (error.code === 'timeout') {
      return 'AI_TIMEOUT';
    }
    if (error.code === 'invalid_json' || /AI_JSON_PARSE_ERROR/i.test(`${error.message} ${error.detail ?? ''} ${error.originalMessage ?? ''}`)) {
      return 'AI_JSON_PARSE_ERROR';
    }
    if (error.status && error.status >= 400 && error.status < 500) {
      return 'BACKEND_4XX';
    }
    if (error.status && error.status >= 500) {
      return 'BACKEND_5XX';
    }
    if (error.code === 'network_error') {
      return 'BACKEND_UNREACHABLE';
    }
  }

  const detail = getErrorMessage(error);
  if (/AI_JSON_PARSE_ERROR/i.test(detail)) {
    return 'AI_JSON_PARSE_ERROR';
  }
  if (/timed out|timeout/i.test(detail)) {
    return 'AI_TIMEOUT';
  }
  if (/permission|activeTab|Cannot access|chrome-extension/i.test(detail)) {
    return 'PERMISSION_MISSING';
  }

  return 'BACKEND_UNREACHABLE';
}

function shouldUseQuizScreenshotFallback(extraction: QuizQuestionExtraction) {
  const text = extraction.questionText;
  return (
    extraction.needsScreenshot ||
    extraction.confidence < 0.65 ||
    extraction.hasCanvas ||
    (extraction.hasSvg && text.length < 120) ||
    (extraction.hasImages && text.length < 120) ||
    (/\b(shown in the image|graph|diagram|figure|table|chart|image below|picture)\b/i.test(text) &&
      (extraction.hasImages || extraction.hasCanvas || extraction.hasSvg)) ||
    ((extraction.questionType === 'multiple_choice' || extraction.questionType === 'multi_select') && extraction.answerChoices.length === 0)
  );
}

function quizScreenshotReason(extraction: QuizQuestionExtraction) {
  if (extraction.needsScreenshot) {
    return 'extractor_requested_screenshot';
  }
  if (extraction.confidence < 0.65) {
    return 'low_confidence';
  }
  if (extraction.hasCanvas || extraction.hasSvg) {
    return 'visual_surface';
  }
  if (extraction.hasImages && extraction.questionText.length < 120) {
    return 'image_heavy_question';
  }
  if (extraction.answerChoices.length === 0 && (extraction.questionType === 'multiple_choice' || extraction.questionType === 'multi_select')) {
    return 'missing_choices';
  }
  return 'not_used';
}

function buildQuizAnalyzePayload(
  requestId: string,
  extraction: QuizQuestionExtraction,
  screenshot?: {
    included: true;
    mimeType: 'image/jpeg' | 'image/png';
    base64: string;
  }
): QuizAnalyzeRequestPayload {
  return {
    mode: 'quiz-prefetch',
    requestId,
    questionHash: extraction.questionHash,
    pageUrl: extraction.pageUrl,
    pageTitle: extraction.pageTitle,
    question: {
      questionText: extraction.questionText,
      instructions:
        extraction.instructions ||
        (extraction.questionType === 'multi_select'
          ? 'Select all that apply.'
          : extraction.questionType === 'multiple_choice' || extraction.questionType === 'dropdown'
            ? 'Select one answer.'
            : ''),
      answerChoices: extraction.answerChoices.map((choice) => ({
        id: choice.id,
        index: choice.index,
        label: choice.label,
        text: choice.text,
        inputType: choice.inputType,
        selected: choice.selected,
        disabled: choice.disabled
      })),
      questionType: extraction.questionType
    },
    extraction: {
      confidence: extraction.confidence,
      method: screenshot ? 'hybrid' : extraction.method,
      needsScreenshot: extraction.needsScreenshot,
      debugReasons: extraction.debug.reasons
    },
    screenshot: screenshot
      ? {
          included: true,
          mimeType: screenshot.mimeType,
          data: screenshot.base64
        }
      : {
          included: false
        }
  };
}

function logQuizPayloadBeforeAI(requestId: string, extraction: QuizQuestionExtraction, payload: QuizAnalyzeRequestPayload) {
  console.info('[MakoIQ Extract] payloadBeforeAI', {
    requestId,
    questionHash: extraction.questionHash,
    pageUrl: extraction.pageUrl,
    questionTextLength: extraction.questionText.length,
    answerChoiceCount: extraction.answerChoices.length,
    extractionConfidence: extraction.confidence,
    needsScreenshot: extraction.needsScreenshot,
    payload: {
      mode: payload.mode,
      questionHash: payload.questionHash,
      pageUrl: payload.pageUrl,
      question: {
        questionText: payload.question.questionText,
        questionType: payload.question.questionType,
        instructions: payload.question.instructions,
        answerChoices: payload.question.answerChoices.map((choice) => ({
          index: choice.index,
          label: choice.label,
          text: choice.text
        }))
      },
      extraction: payload.extraction
    }
  });
}

function answerMatchesProvidedChoice(answer: QuizAnalyzeResponse, extraction: QuizQuestionExtraction) {
  if (answer.status !== 'answered') {
    return false;
  }

  if (extraction.answerChoices.length === 0) {
    return Boolean(answer.answer.trim());
  }

  const answerIndex = answer.answerIndex ?? answer.answerIndexes[0];
  const byIndex = Number.isInteger(answerIndex)
    ? extraction.answerChoices.find((choice) => choice.index === answerIndex)
    : undefined;
  if (byIndex) {
    return true;
  }

  if (answer.answerLabel) {
    return extraction.answerChoices.some((choice) => choice.label.toLowerCase() === answer.answerLabel?.toLowerCase());
  }

  const answerText = answer.answer.trim().toLowerCase();
  return Boolean(
    answerText &&
      extraction.answerChoices.some((choice) => {
        const choiceText = choice.text.trim().toLowerCase();
        return choiceText === answerText || choiceText.includes(answerText) || answerText.includes(choiceText);
      })
  );
}

function computeQuizDisplayConfidence(options: {
  extractionConfidence: number;
  modelConfidence: number;
  status: QuizAnalyzeResponse['status'];
  validChoice: boolean;
}) {
  const extractionConfidence = normalizeConfidence(options.extractionConfidence, 0);
  const modelConfidence = normalizeConfidence(options.modelConfidence, 0);

  if (options.status !== 'answered') {
    return Math.min(modelConfidence, extractionConfidence);
  }

  if (extractionConfidence < 0.65) {
    return Math.min(modelConfidence, extractionConfidence);
  }

  if (options.validChoice && extractionConfidence >= 0.85 && modelConfidence >= 0.45) {
    return Math.max(modelConfidence, 0.7);
  }

  return Math.min(Math.max(modelConfidence, 0), 1);
}

function splitDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:(image\/(?:png|jpe?g));base64,(.+)$/i);
  return {
    mimeType: (match?.[1]?.toLowerCase().replace('image/jpg', 'image/jpeg') as 'image/jpeg' | 'image/png' | undefined) ?? 'image/jpeg',
    base64: match?.[2] ?? ''
  };
}

function hasUsableQuizBbox(bbox: QuizBoundingBox) {
  return Number.isFinite(bbox.x) && Number.isFinite(bbox.y) && bbox.width > 20 && bbox.height > 20;
}

async function cropQuizScreenshotDataUrl(
  dataUrl: string,
  bbox: QuizBoundingBox,
  viewport: ScreenViewport
): Promise<OptimizedScreenshot> {
  if (!hasUsableQuizBbox(bbox) || typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
    return optimizeScreenshotDataUrl(dataUrl);
  }

  let bitmap: ImageBitmap | null = null;

  try {
    const sourceBlob = await fetch(dataUrl).then((response) => response.blob());
    bitmap = await createImageBitmap(sourceBlob);
    const scaleX = bitmap.width / Math.max(1, viewport.width);
    const scaleY = bitmap.height / Math.max(1, viewport.height);
    const margin = 32;
    const sx = Math.max(0, Math.round((bbox.x - margin) * scaleX));
    const sy = Math.max(0, Math.round((bbox.y - margin) * scaleY));
    const sw = Math.min(bitmap.width - sx, Math.round((bbox.width + margin * 2) * scaleX));
    const sh = Math.min(bitmap.height - sy, Math.round((bbox.height + margin * 2) * scaleY));

    if (sw <= 32 || sh <= 32) {
      return optimizeScreenshotDataUrl(dataUrl);
    }

    const canvas = new OffscreenCanvas(sw, sh);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) {
      return optimizeScreenshotDataUrl(dataUrl);
    }

    context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    const blob = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: SCREEN_UPLOAD_QUALITY
    });
    const cropped = await blobToDataUrl(blob);
    return {
      dataUrl: cropped,
      meta: {
        format: 'jpeg',
        source: 'screenshot',
        originalWidth: bitmap.width,
        originalHeight: bitmap.height,
        width: sw,
        height: sh,
        quality: SCREEN_UPLOAD_QUALITY,
        originalBytes: estimateDataUrlBytes(dataUrl),
        bytes: estimateDataUrlBytes(cropped),
        resized: true
      }
    };
  } catch (error) {
    traceBackgroundError('quiz:screenshot-crop:error', {
      detail: getErrorMessage(error)
    });
    return optimizeScreenshotDataUrl(dataUrl);
  } finally {
    bitmap?.close();
  }
}

async function captureQuizScreenshotFallback(options: {
  tabId: number;
  windowId: number;
  requestId: string;
  extraction: QuizQuestionExtraction;
  settings: Pick<CanvySettings, 'debugMode'>;
}) {
  const reason = quizScreenshotReason(options.extraction);
  logScreenTiming(options.settings, 'quiz-screenshot-fallback-started', {
    requestId: options.requestId,
    tabId: options.tabId,
    reason,
    bbox: options.extraction.bbox
  });

  const hidden = await setMakoUiHiddenForScreenScan(options.tabId, options.requestId, true, options.settings);
  try {
    const rawImage = await captureVisibleScreenshotDataUrl(options.windowId);
    const optimized = await cropQuizScreenshotDataUrl(rawImage, options.extraction.bbox, options.extraction.viewport);
    const { mimeType, base64 } = splitDataUrl(optimized.dataUrl);
    logScreenTiming(options.settings, 'quiz-screenshot-fallback-finished', {
      requestId: options.requestId,
      tabId: options.tabId,
      reason,
      screenshot_fallback_used: true,
      imageMeta: optimized.meta
    });
    return {
      included: true as const,
      mimeType,
      base64,
      meta: optimized.meta,
      reason
    };
  } finally {
    if (hidden) {
      await setMakoUiHiddenForScreenScan(options.tabId, options.requestId, false, options.settings);
    }
  }
}

function normalizeQuizBboxToScreen(bbox: QuizBoundingBox, viewport: ScreenViewport) {
  const width = Math.max(1, viewport.width);
  const height = Math.max(1, viewport.height);
  const clamp = (value: number) => Math.min(Math.max(value, 0), 1);
  return {
    x: clamp(bbox.x / width),
    y: clamp(bbox.y / height),
    width: clamp(bbox.width / width),
    height: clamp(bbox.height / height)
  };
}

function createQuizScreenAnalysisPayload(
  requestId: string,
  extraction: QuizQuestionExtraction,
  answer: QuizAnalyzeResponse,
  confidence: {
    extractionConfidence: number;
    modelConfidence: number;
    displayConfidence: number;
    validChoice: boolean;
  }
): ScreenBubbleRenderPayload {
  console.info('[MakoIQ Answer] rawPayload', {
    requestId,
    questionHash: extraction.questionHash,
    answerLabel: answer.answerLabel,
    answerIndex: answer.answerIndex,
    answerIndexes: answer.answerIndexes,
    answer: answer.answer,
    confidence: answer.confidence,
    displayConfidence: confidence.displayConfidence
  });

  const normalizedAnswer = normalizeAnswerPayload({
    status: answer.status,
    questionHash: extraction.questionHash,
    answer: answer.answer,
    answerLabel: answer.answerLabel,
    answerIndexes: answer.answerIndex === null ? answer.answerIndexes : [answer.answerIndex],
    confidence: confidence.displayConfidence,
    explanation: answer.explanation,
    evidence: answer.evidence,
    shouldDisplay: answer.shouldDisplay,
    choices: extraction.answerChoices
  });
  const answerChoice =
    normalizedAnswer.answerLabel && normalizedAnswer.answerText
      ? `${normalizedAnswer.answerLabel}. ${normalizedAnswer.answerText}`
      : null;
  const shouldDisplay =
    normalizedAnswer.shouldDisplay &&
    answer.status === 'answered' &&
    Boolean(normalizedAnswer.answerText) &&
    confidence.validChoice &&
    normalizedAnswer.confidence >= 0.45;
  const shouldRenderReviewCard =
    answer.status === 'needs_more_context' ||
    (answer.status === 'answered' && (!shouldDisplay || normalizedAnswer.confidence < 0.45));
  const itemType: ScreenAnalysisItemType =
    extraction.questionType === 'multiple_choice' || extraction.questionType === 'multi_select'
      ? 'multiple_choice'
      : extraction.questionType === 'short_answer'
        ? 'short_answer'
        : 'general_question';

  console.info('[MakoIQ Answer] normalizedPayload', {
    requestId,
    questionHash: extraction.questionHash,
    confidence: normalizedAnswer.confidence,
    normalizedAnswerLabel: normalizedAnswer.answerLabel,
    normalizedAnswerText: normalizedAnswer.answerText,
    displayMode: normalizedAnswer.displayMode,
    shouldDisplay
  });

  console.info('[MakoIQ Confidence] extraction/model/display', {
    requestId,
    questionHash: extraction.questionHash,
    extractionConfidence: confidence.extractionConfidence,
    modelConfidence: confidence.modelConfidence,
    displayConfidence: confidence.displayConfidence,
    validChoice: confidence.validChoice,
    failReason:
      extraction.confidence < 0.65
        ? 'LOW_CONFIDENCE_EXTRACTION'
        : answer.status === 'needs_more_context'
          ? 'NEEDS_MORE_CONTEXT'
          : normalizedAnswer.confidence < 0.45
            ? 'LOW_MODEL_CONFIDENCE'
            : undefined
  });

  if (shouldRenderReviewCard) {
    console.info('[MakoIQ QuizMode] lowConfidence', {
      requestId,
      questionHash: extraction.questionHash,
      confidence: normalizedAnswer.confidence,
      normalizedAnswerLabel: normalizedAnswer.answerLabel,
      normalizedAnswerText: normalizedAnswer.answerText
    });
  }

  const item =
    shouldDisplay || shouldRenderReviewCard
      ? {
          id: extraction.questionHash,
          type: itemType,
          question: extraction.questionText,
          answer: shouldDisplay ? answerChoice ?? normalizedAnswer.answerText : normalizedAnswer.answerText,
          answerChoice: shouldDisplay ? answerChoice : null,
          explanation:
            normalizedAnswer.explanation ||
            (shouldRenderReviewCard ? 'I could not verify this answer confidently.' : ''),
          confidence: normalizedAnswer.confidence,
          bbox: normalizeQuizBboxToScreen(extraction.bbox, extraction.viewport),
          anchor: extraction.anchor,
          needsMoreContext: shouldRenderReviewCard || normalizedAnswer.displayMode === 'lower-confidence'
        }
      : null;

  return {
    analysis: {
      ok: true,
      analysisId: requestId,
      summary:
        answer.status === 'answered'
          ? 'Quiz Mode prefetch completed.'
          : answer.status === 'needs_more_context'
            ? 'Quiz Mode needs more visible context for this question.'
            : 'No question detected.',
      items: item ? [item] : [],
      warnings: shouldDisplay
        ? []
        : [
            shouldRetryLowConfidence(normalizedAnswer.confidence)
              ? 'LOW_CONFIDENCE'
              : answer.status === 'needs_more_context'
                ? 'NEEDS_MORE_CONTEXT'
                : 'NO_QUESTIONS_DETECTED'
          ]
    },
    pageUrl: extraction.pageUrl,
    pageTitle: extraction.pageTitle,
    viewport: extraction.viewport,
    capturedAt: new Date().toISOString(),
    scanId: requestId
  };
}

function getCachedQuizAnswer(tabId: number, extraction: QuizQuestionExtraction) {
  const cached = quizModeCache.get(tabId);
  if (!cached || cached.questionHash !== extraction.questionHash || cached.url !== extraction.pageUrl) {
    return null;
  }

  if (Date.now() > cached.expiresAt) {
    quizModeCache.delete(tabId);
    return null;
  }

  return cached;
}

async function renderQuizAnswerPayload(tabId: number, requestId: string, payload: ScreenBubbleRenderPayload) {
  const renderStartedAt = Date.now();
  const response = await sendScreenBubbleRenderMessage(tabId, requestId, payload);
  traceBackgroundEvent('quiz:render-finished', {
    requestId,
    tabId,
    quiz_render_ms: Date.now() - renderStartedAt,
    rendered: response.ok ? response.response.visible : false
  });
  return response;
}

async function handleQuizContextChanged(message: any, sender: chrome.runtime.MessageSender): Promise<QuizPrefetchResponse> {
  const requestId = typeof message.requestId === 'string' ? message.requestId : createRequestId();
  const tabId = sender.tab?.id;
  if (tabId) {
    clearQuizModeRuntimeState(tabId, requestId, typeof message.reason === 'string' ? message.reason : 'context_changed', Boolean(message.clearCache));
  }

  return {
    ok: true,
    requestId,
    status: 'stale',
    message: 'Quiz Mode context changed.'
  };
}

async function prefetchQuizAnswerAction(
  message: QuizPrefetchRequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<QuizPrefetchResponse> {
  const requestId = typeof message.requestId === 'string' ? message.requestId : createRequestId();
  const tabId = sender.tab?.id;
  const windowId = sender.tab?.windowId;
  const extraction = message.extraction;
  const startedAt = Number.isFinite(message.startedAt) ? Number(message.startedAt) : Date.now();

  if (!tabId || !windowId || !extraction?.found || !extraction.questionHash) {
    return {
      ok: false,
      requestId,
      status: 'no_question',
      message: 'Quiz Mode did not find a question to prefetch.',
      failReason: !tabId || !windowId ? 'PERMISSION_MISSING' : 'NO_QUESTION_FOUND'
    };
  }

  if (message.questionHash && message.questionHash !== extraction.questionHash) {
    return {
      ok: false,
      requestId,
      status: 'stale',
      message: 'This Quiz Mode prefetch had a mismatched question hash.',
      questionHash: extraction.questionHash,
      failReason: 'STALE_RESPONSE'
    };
  }

  const { settings } = await getExtensionState();
  if (!settings.quizModeEnabled) {
    clearQuizModeRuntimeState(tabId, requestId, 'quiz_mode_disabled', true);
    return {
      ok: false,
      requestId,
      status: 'disabled',
      message: 'Quiz Mode is off.',
      failReason: 'PERMISSION_MISSING'
    };
  }

  const controller = beginQuizRequest(tabId, requestId, extraction.questionHash);
  const cached = getCachedQuizAnswer(tabId, extraction);
  if (cached) {
    const cachedCanRender = cached.renderPayload.analysis.items.length > 0;
    const response =
      cachedCanRender
        ? await renderQuizAnswerPayload(tabId, requestId, {
            ...cached.renderPayload,
            capturedAt: new Date().toISOString(),
            scanId: requestId
          })
        : undefined;
    finishQuizRequest(tabId, requestId);
    if (!cachedCanRender) {
      return {
        ok: false,
        requestId,
        status: 'needs_more_context',
        message: 'I could not verify this answer confidently. Tap Rescan.',
        rendered: false,
        questionHash: extraction.questionHash,
        usedScreenshot: false,
        failReason: 'LOW_CONFIDENCE_EXTRACTION'
      };
    }

    return {
      ok: response ? (response.ok ? response.response.ok : true) : true,
      requestId,
      status: 'cached',
      message: response
        ? response.ok
          ? response.response.message
          : 'Cached Quiz Mode answer is ready.'
        : 'Cached Quiz Mode result is still current.',
      rendered: response?.ok ? response.response.visible : false,
      questionHash: extraction.questionHash,
      usedScreenshot: false
    };
  }

  try {
    let screenshot:
      | {
          included: true;
          mimeType: 'image/jpeg' | 'image/png';
          base64: string;
          meta: ScreenImageMetadata;
          reason: string;
        }
      | undefined;

    if (shouldUseQuizScreenshotFallback(extraction)) {
      screenshot = await captureQuizScreenshotFallback({
        tabId,
        windowId,
        requestId,
        extraction,
        settings
      });
    }

    if (!isLatestQuizQuestion(tabId, extraction.questionHash) || controller.signal.aborted) {
      return {
        ok: false,
        requestId,
        status: 'stale',
        message: 'This Quiz Mode prefetch was replaced by a newer question.',
        questionHash: extraction.questionHash,
        usedScreenshot: Boolean(screenshot),
        failReason: 'STALE_RESPONSE'
      };
    }

    await logResolvedApiBaseUrl('quiz-prefetch');
    const aiStartedAt = Date.now();
    const quizPayload = buildQuizAnalyzePayload(requestId, extraction, screenshot);
    logQuizPayloadBeforeAI(requestId, extraction, quizPayload);
    let answer = await analyzeQuizWithBackend(settings.apiBaseUrl, quizPayload, undefined, {
      requestId,
      source: 'quiz-prefetch',
      apiBaseUrlSource: settings.apiBaseUrlSource,
      signal: controller.signal
    });
    let validChoice = answerMatchesProvidedChoice(answer, extraction);
    let modelConfidence = normalizeConfidence(answer.confidence, 0);
    if (answer.status === 'answered' && validChoice && modelConfidence < 0.45) {
      traceBackgroundEvent('quiz:low-confidence-retry', {
        requestId,
        tabId,
        questionHash: extraction.questionHash,
        modelConfidence
      });
      const retryAnswer = await analyzeQuizWithBackend(settings.apiBaseUrl, quizPayload, undefined, {
        requestId,
        source: 'quiz-prefetch-low-confidence-retry',
        apiBaseUrlSource: settings.apiBaseUrlSource,
        signal: controller.signal
      });
      const retryValidChoice = answerMatchesProvidedChoice(retryAnswer, extraction);
      const retryConfidence = normalizeConfidence(retryAnswer.confidence, 0);
      if (
        retryAnswer.status !== 'answered' ||
        retryConfidence >= modelConfidence ||
        (retryValidChoice && !validChoice)
      ) {
        answer = retryAnswer;
        validChoice = retryValidChoice;
        modelConfidence = retryConfidence;
      }
    }
    const displayConfidence = computeQuizDisplayConfidence({
      extractionConfidence: extraction.confidence,
      modelConfidence,
      status: answer.status,
      validChoice
    });
    traceBackgroundEvent('quiz:ai-response', {
      requestId,
      tabId,
      elapsedMs: Date.now() - startedAt,
      quiz_ai_ms: Date.now() - aiStartedAt,
      status: answer.status,
      confidence: answer.confidence,
      displayConfidence,
      screenshot_fallback_used: Boolean(screenshot),
      screenshot_reason: screenshot?.reason
    });

    if (!isLatestQuizQuestion(tabId, extraction.questionHash) || controller.signal.aborted) {
      return {
        ok: false,
        requestId,
        status: 'stale',
        message: 'This Quiz Mode answer arrived after the question changed.',
        questionHash: extraction.questionHash,
        usedScreenshot: Boolean(screenshot),
        failReason: 'STALE_RESPONSE'
      };
    }

    await updateBackendConnection('connected');
    const displayAnswer = {
      ...answer,
      confidence: displayConfidence,
      shouldDisplay: answer.shouldDisplay && answer.status === 'answered' && validChoice && displayConfidence >= 0.45
    };
    const renderPayload = createQuizScreenAnalysisPayload(requestId, extraction, displayAnswer, {
      extractionConfidence: extraction.confidence,
      modelConfidence,
      displayConfidence,
      validChoice
    });
    let renderResponse: Awaited<ReturnType<typeof renderQuizAnswerPayload>> | undefined;
    const lowConfidenceAnswer = answer.status === 'answered' && renderPayload.analysis.warnings.includes('LOW_CONFIDENCE');
    const unrenderableAnswer = answer.status === 'answered' && renderPayload.analysis.items.length === 0;
    if (renderPayload.analysis.items.length > 0) {
      renderResponse = await renderQuizAnswerPayload(tabId, requestId, renderPayload);
    }

    quizModeCache.set(tabId, {
      url: extraction.pageUrl,
      questionHash: extraction.questionHash,
      extractedQuestion: extraction,
      aiAnswer: displayAnswer,
      renderPayload,
      createdAt: Date.now(),
      expiresAt: Date.now() + QUIZ_MODE_CACHE_TTL_MS
    });
    finishQuizRequest(tabId, requestId);

    return {
      ok: true,
      requestId,
      status: unrenderableAnswer ? 'needs_more_context' : answer.status,
      message:
        lowConfidenceAnswer
          ? 'I could not verify this answer confidently. Tap Rescan.'
          : unrenderableAnswer
            ? 'Mako IQ could not format a reliable answer. Tap Rescan.'
          : answer.status === 'answered'
          ? renderResponse?.ok
            ? renderResponse.response.message
            : 'Quiz Mode answer is ready.'
          : answer.status === 'needs_more_context'
            ? 'Quiz Mode needs more visible context for this question.'
            : 'No question detected.',
      rendered: renderResponse?.ok ? renderResponse.response.visible : false,
      questionHash: extraction.questionHash,
      usedScreenshot: Boolean(screenshot),
      failReason:
        unrenderableAnswer
          ? 'LOW_CONFIDENCE_EXTRACTION'
          : answer.status === 'answered'
          ? undefined
          : answer.status === 'no_question'
            ? 'NO_QUESTION_FOUND'
            : answer.status === 'needs_more_context'
              ? 'LOW_CONFIDENCE_EXTRACTION'
              : 'BACKEND_5XX'
    };
  } catch (error) {
    if (!isLatestQuizQuestion(tabId, extraction.questionHash) || controller.signal.aborted) {
      return {
        ok: false,
        requestId,
        status: 'stale',
        message: 'This Quiz Mode prefetch was cancelled.',
        questionHash: extraction.questionHash,
        failReason: 'STALE_RESPONSE'
      };
    }

    const detail = mapAnalysisApiError(error);
    const failReason = mapQuizApiFailReason(error);
    traceBackgroundError('quiz:prefetch-failed', {
      requestId,
      tabId,
      questionHash: extraction.questionHash,
      failReason,
      elapsedMs: Date.now() - startedAt,
      detail
    });
    await updateBackendConnection('degraded', detail);
    finishQuizRequest(tabId, requestId);
    return {
      ok: false,
      requestId,
      status: 'error',
      message: 'Quiz Mode could not prefetch an answer.',
      error: detail,
      questionHash: extraction.questionHash,
      failReason
    };
  }
}

async function openAssistantPanelAction(
  requestId: string,
  source: string,
  autoScan = false
): Promise<ScreenAnalyzeActionResponse> {
  const target = await resolveActivePanelTarget(requestId, source);
  const tab = target?.tab;
  const currentUrl = tab?.url ?? '';

  if (!tab?.id || !currentUrl) {
    return {
      ok: false,
      requestId,
      message: 'Open a browser tab before opening the Mako IQ assistant.',
      error: 'NO_ACTIVE_TAB'
    };
  }

  const launchSupport = getLaunchSupport(currentUrl);
  if (!launchSupport.isSupported) {
    return {
      ok: false,
      requestId,
      message: launchSupport.message,
      error: 'UNSUPPORTED_PAGE'
    };
  }

  const ensured = await ensureTabAttachment(tab.id, currentUrl, requestId);
  if (!ensured.ok) {
    return {
      ok: false,
      requestId,
      message:
        ensured.reason === 'unsupported_page'
          ? 'This page does not support the Mako IQ assistant.'
          : 'Mako IQ could not attach the assistant to this tab. Reload the page and try again.',
      error: ensured.reason
    };
  }

  let response = await sendToTab<OverlayUpdateResponse>(
    tab.id,
    {
      type: 'SHOW_MAKO_ASSISTANT_PANEL',
      requestId,
      autoScan
    },
    1600
  );

  if (!response.ok) {
    const retryAttachment = await ensureTabAttachment(tab.id, currentUrl, requestId);
    if (retryAttachment.ok) {
      response = await sendToTab<OverlayUpdateResponse>(
        tab.id,
        {
          type: 'SHOW_MAKO_ASSISTANT_PANEL',
          requestId: `${requestId}-retry`,
          autoScan
        },
        1600
      );
    }
  }

  if (!response.ok) {
    return {
      ok: false,
      requestId,
      message: 'Mako IQ could not open the assistant on this page.',
      error: response.detail ?? response.reason
    };
  }

  return {
    ok: response.response.ok,
    requestId,
    message: response.response.message,
    rendered: response.response.visible
  };
}

async function captureAndAnalyzeVisibleScreen(
  requestId: string,
  source: string
): Promise<ScreenAnalyzeActionResponse> {
  const totalStartedAt = Date.now();
  const target = await resolveActivePanelTarget(requestId, source);
  const tab = target?.tab;
  const currentUrl = tab?.url ?? '';

  if (!target?.windowId || !tab?.id || !currentUrl) {
    return {
      ok: false,
      requestId,
      message: 'Couldn\u2019t capture this screen. Try refreshing the page or granting permissions.',
      error: 'NO_ACTIVE_TAB'
    };
  }

  const launchSupport = getLaunchSupport(currentUrl);
  if (!launchSupport.isSupported) {
    return {
      ok: false,
      requestId,
      message: 'Couldn\u2019t capture this screen. Try refreshing the page or granting permissions.',
      error: 'UNSUPPORTED_PAGE'
    };
  }

  const state = await getExtensionState();
  const { settings } = state;
  const startedRecentlyAt = lastScreenRequestStartedAt.get(tab.id) ?? 0;
  if (Date.now() - startedRecentlyAt < 250 && screenAnalysisControllers.has(tab.id)) {
    return {
      ok: false,
      requestId,
      message: 'A scan is already starting.',
      error: 'DUPLICATE_SCREEN_ANALYSIS'
    };
  }
  lastScreenRequestStartedAt.set(tab.id, Date.now());
  const controller = beginScreenRequest(tab.id, requestId, currentUrl);
  const timing: ScreenAnalysisTiming = {};
  logScreenTiming(settings, 'request-received', {
    requestId,
    source,
    tabId: tab.id,
    windowId: target.windowId
  });

  const ensured = await ensureTabAttachment(tab.id, currentUrl, requestId);
  if (!ensured.ok) {
    finishScreenRequest(tab.id, requestId);
    return {
      ok: false,
      requestId,
      message: 'Couldn\u2019t capture this screen. Try refreshing the page or granting permissions.',
      error: ensured.reason
    };
  }

  void sendScreenScanStatusMessage(tab.id, requestId, 'scanning', 'Scanning page...').catch((error) => {
    logDebug('Could not render immediate scan status.', {
      requestId,
      tabId: tab.id,
      detail: getErrorMessage(error)
    });
  });

  let optimized: OptimizedScreenshot;
  let viewport: ScreenViewport;
  let textContext: ScreenTextContext | undefined;
  let scanPageSignature = '';
  let cacheHit = false;
  let extractionMode: 'dom' | 'screenshot' | 'mixed' = 'screenshot';
  try {
    const extractionStartedAt = Date.now();
    const preScan = await readPreScanContext(tab.id, currentUrl, settings, requestId);
    if (preScan) {
      textContext = preScan.context;
      viewport = preScan.context.viewport;
      scanPageSignature = preScan.pageSignature;
      cacheHit = true;
      timing.domExtractMs = 0;
      timing.extensionMessageMs = Date.now() - extractionStartedAt;
    } else {
      logScreenTiming(settings, 'content-extraction-started', { requestId, tabId: tab.id });
      const contextMessageStartedAt = Date.now();
      textContext = await readScreenTextContextFromTab(tab.id, requestId);
      timing.extensionMessageMs = Date.now() - contextMessageStartedAt;
      viewport = textContext?.viewport ?? (await readViewportFromTab(tab.id, requestId));
      scanPageSignature = textContext?.pageSignature ?? '';
      timing.domExtractMs = Date.now() - extractionStartedAt;
      if (textContext) {
        await writePreScanContext(tab.id, textContext, scanPageSignature, 'manual-scan');
      }
    }
    const extractionMs = Date.now() - extractionStartedAt;
    logScreenTiming(settings, 'content-extraction-finished', {
      requestId,
      tabId: tab.id,
      dom_extract_ms: timing.domExtractMs ?? extractionMs,
      extension_message_ms: timing.extensionMessageMs,
      cache_hit: cacheHit,
      contextChars: textContext?.visibleText.length ?? 0,
      visibleTextHash: textContext?.visibleTextHash ?? textContext?.questionContext?.visibleTextHash,
      contextQuestions: textContext?.questionCandidates.length ?? 0,
      structuredQuestions: textContext?.structuredExtraction?.questions.length ?? 0,
      structuredConfidence: textContext?.structuredExtraction?.extraction.confidence,
      pageSignature: scanPageSignature ? hashStringSample(scanPageSignature) : undefined
    });

    if (textContext && hasFastDomQuestionContext(textContext)) {
      optimized = createDomContextPlaceholderScreenshot();
      timing.captureMs = 0;
      timing.screenshotCaptureMs = 0;
      timing.preprocessMs = 0;
      extractionMode = 'dom';
      logScreenTiming(settings, 'fast-dom-context-selected', {
        requestId,
        tabId: tab.id,
        dom_extract_ms: timing.domExtractMs ?? extractionMs,
        extension_message_ms: timing.extensionMessageMs,
        contextChars: textContext.visibleText.length,
        contextQuestions: textContext.questionCandidates.length,
        extractionMs: textContext.structuredExtraction?.extraction.extractionMs
      });
    } else {
      if (!hasAnyUsableScreenContext(textContext)) {
        logScreenTiming(settings, 'low-dom-context-using-screenshot', {
          requestId,
          tabId: tab.id,
          contextChars: textContext?.visibleText.length ?? 0,
          contextQuestions: textContext?.questionCandidates.length ?? 0
        });
      }

      optimized = await captureOptimizedVisibleScreenForAnalysis({
        tabId: tab.id,
        windowId: target.windowId,
        requestId,
        settings,
        timing
      });
      extractionMode = textContext ? 'mixed' : 'screenshot';
    }
    timing.extractionMode = extractionMode;
    timing.cacheHit = cacheHit;
    void persistActiveScreenScan(tab.id, requestId, currentUrl, scanPageSignature);

    logScreenTiming(settings, 'preprocess-finished', {
      requestId,
      tabId: tab.id,
      preprocess_ms: timing.preprocessMs,
      screenshot_capture_ms: timing.screenshotCaptureMs,
      imageMeta: optimized.meta,
      contextChars: textContext?.visibleText.length ?? 0,
      contextQuestions: textContext?.questionCandidates.length ?? 0
    });
    void sendScreenScanStatusMessage(tab.id, requestId, 'thinking', 'Thinking...').catch(() => undefined);
  } catch (error) {
    const detail = getErrorMessage(error);
    traceBackgroundError('screen:capture:error', {
      requestId,
      source,
      tabId: tab.id,
      detail
    });
    finishScreenRequest(tab.id, requestId);
    void sendScreenScanStatusMessage(tab.id, requestId, 'error', 'I could not scan this screen. Try refreshing the page and scanning again.').catch(
      () => undefined
    );
    return {
      ok: false,
      requestId,
      message: 'Couldn\u2019t capture this screen. Try refreshing the page or granting permissions.',
      error: detail,
      timing: {
        ...timing,
        totalMs: Date.now() - totalStartedAt
      }
    };
  }

  if (!isLatestScreenRequest(tab.id, requestId) || controller.signal.aborted) {
    return {
      ok: false,
      requestId,
      message: 'This scan was replaced by a newer scan.',
      error: 'STALE_SCREEN_ANALYSIS',
      timing: {
        ...timing,
        totalMs: Date.now() - totalStartedAt
      }
    };
  }

  if (
    !(await isScreenScanStillCurrent({
      tabId: tab.id,
      requestId,
      controller,
      pageUrl: currentUrl,
      pageSignature: scanPageSignature
    }))
  ) {
    finishScreenRequest(tab.id, requestId);
    return {
      ok: false,
      requestId,
      message: 'The page changed before this scan finished. Scan the current question again.',
      error: 'STALE_SCREEN_ANALYSIS',
      timing: {
        ...timing,
        totalMs: Date.now() - totalStartedAt
      }
    };
  }

  await logResolvedApiBaseUrl('screen-analysis');

  await saveSession({
    pageState: {
      uiStatus: {
        lifecycle: 'analyzing',
        message: 'Analyzing the visible screen...',
        lastAction: 'analyze'
      },
      errors: {
        analysis: undefined
      }
    }
  });

  const imageFingerprint =
    optimized.meta.source === 'dom_context'
      ? `dom:${textContext?.visibleTextHash ?? textContext?.questionContext?.visibleTextHash ?? hashStringSample(textContext?.visibleText ?? '')}`
      : hashStringSample(optimized.dataUrl);
  const contextFingerprint = hashStringSample(
    [
      textContext?.selectedText ?? '',
      textContext?.questionContext ? JSON.stringify(textContext.questionContext) : textContext?.visibleText ?? '',
      JSON.stringify(textContext?.questionCandidates ?? [])
    ].join('\n')
  );
  const cacheKey = createScreenCacheKey({
    pageUrl: currentUrl,
    viewport,
    imageFingerprint,
    contextFingerprint,
    pageSignature: scanPageSignature
  });
  const cached = await getCachedScreenAnalysis(tab.id, cacheKey);
  if (cached) {
    timing.cacheHit = true;
    logScreenTiming(settings, 'cache-hit', {
      requestId,
      tabId: tab.id,
      scan_total_ms: Date.now() - totalStartedAt,
      cache_hit: true,
      cacheAgeMs: Date.now() - cached.createdAt,
      extraction_mode: extractionMode,
      input_chars: textContext?.questionContext ? JSON.stringify(textContext.questionContext).length : textContext?.visibleText.length ?? 0
    });

    if (
      !(await isScreenScanStillCurrent({
        tabId: tab.id,
        requestId,
        controller,
        pageUrl: currentUrl,
        pageSignature: scanPageSignature
      }))
    ) {
      finishScreenRequest(tab.id, requestId);
      return {
        ok: false,
        requestId,
        message: 'The page changed before this cached scan could render. Scan the current question again.',
        error: 'STALE_SCREEN_ANALYSIS',
        timing: {
          ...timing,
          totalMs: Date.now() - totalStartedAt
        }
      };
    }

    const renderStartedAt = Date.now();
    const renderPayload: ScreenBubbleRenderPayload = {
      ...cached.renderPayload,
      pageUrl: currentUrl,
      pageTitle: tab.title ?? 'Current page',
      viewport,
      capturedAt: new Date().toISOString(),
      scanId: requestId,
      pageSignature: scanPageSignature
    };
    let cachedRenderResponse = await sendScreenBubbleRenderMessage(tab.id, requestId, renderPayload);
    if (!cachedRenderResponse.ok) {
      const retryAttachment = await ensureTabAttachment(tab.id, currentUrl, requestId);
      if (retryAttachment.ok) {
        cachedRenderResponse = await sendScreenBubbleRenderMessage(tab.id, `${requestId}-retry`, renderPayload);
      }
    }

    timing.renderMs = Date.now() - renderStartedAt;
    timing.overlayRenderMs = timing.renderMs;
    timing.uploadMs = 0;
    timing.totalMs = Date.now() - totalStartedAt;
    timing.scanTotalMs = timing.totalMs;
    finishScreenRequest(tab.id, requestId);

    return {
      ok: cachedRenderResponse.ok ? cachedRenderResponse.response.ok : true,
      requestId,
      message: cachedRenderResponse.ok ? cachedRenderResponse.response.message : 'Answer bubbles refreshed from the latest matching scan.',
      analysis: {
        ...cached.analysis,
        timing
      },
      rendered: cachedRenderResponse.ok ? cachedRenderResponse.response.visible : false,
      timing
    };
  }

  let analysis;
  try {
    const uploadStartedAt = Date.now();
    logScreenTiming(settings, 'backend-request-started', {
      requestId,
      tabId: tab.id,
      imageBytes: optimized.meta.bytes,
      mode: 'find_questions_and_answer',
      cache_hit: false,
      extraction_mode: extractionMode,
      input_chars: textContext?.questionContext ? JSON.stringify(textContext.questionContext).length : textContext?.visibleText.length ?? 0
    });
    analysis = await analyzeScreenshotWithBackend(settings.apiBaseUrl, {
      image: optimized.dataUrl,
      pageUrl: currentUrl,
      pageTitle: tab.title ?? 'Current page',
      viewport,
      mode: 'find_questions_and_answer',
      textContext,
      imageMeta: optimized.meta,
      debug: settings.debugMode
    }, undefined, {
      requestId,
      source,
      apiBaseUrlSource: settings.apiBaseUrlSource,
      signal: controller.signal
    });
    timing.uploadMs = Date.now() - uploadStartedAt;
    timing.backendRequestMs = timing.uploadMs;
    Object.assign(timing, analysis.timing ?? {}, {
      captureMs: timing.captureMs,
      preprocessMs: timing.preprocessMs,
      uploadMs: timing.uploadMs,
      backendRequestMs: timing.backendRequestMs,
      domExtractMs: timing.domExtractMs,
      screenshotCaptureMs: timing.screenshotCaptureMs,
      extensionMessageMs: timing.extensionMessageMs,
      cacheHit: false,
      extractionMode: extractionMode
    });
    logScreenTiming(settings, 'backend-response-received', {
      requestId,
      tabId: tab.id,
      backend_request_ms: timing.uploadMs,
      ai_response_ms: analysis.timing?.aiResponseMs ?? analysis.timing?.aiMs,
      ai_parse_ms: analysis.timing?.parseMs,
      prompt_build_ms: analysis.timing?.promptBuildMs,
      model_used: analysis.timing?.modelUsed,
      input_chars: analysis.timing?.inputChars,
      output_chars: analysis.timing?.outputChars,
      itemCount: analysis.ok ? analysis.items.length : 0
    });
  } catch (error) {
    if (!isLatestScreenRequest(tab.id, requestId) || controller.signal.aborted) {
      return {
        ok: false,
        requestId,
        message: 'This scan was replaced by a newer scan.',
        error: 'STALE_SCREEN_ANALYSIS',
        timing: {
          ...timing,
          totalMs: Date.now() - totalStartedAt
        }
      };
    }

    const detail = mapAnalysisApiError(error);
    await updateBackendConnection('degraded', detail);
    await saveSession({
      pageState: {
        uiStatus: {
          lifecycle: 'error',
          message: 'Mako IQ could not reach the AI service.',
          lastAction: 'analyze'
        },
        errors: {
          analysis: detail
        }
      }
    });
    void sendScreenScanStatusMessage(
      tab.id,
      requestId,
      'error',
      detail.includes('timed out')
        ? 'The AI request timed out. Try scanning again or select the question text.'
        : 'The backend is not reachable. Check the server URL/API config.'
    ).catch(() => undefined);
    finishScreenRequest(tab.id, requestId);
    return {
      ok: false,
      requestId,
      message: 'Mako IQ could not reach the AI service.',
      error: detail,
      timing: {
        ...timing,
        totalMs: Date.now() - totalStartedAt
      }
    };
  }

  if (!isLatestScreenRequest(tab.id, requestId) || controller.signal.aborted) {
    return {
      ok: false,
      requestId,
      message: 'This scan was replaced by a newer scan.',
      error: 'STALE_SCREEN_ANALYSIS',
      timing: {
        ...timing,
        totalMs: Date.now() - totalStartedAt
      }
    };
  }

  if (
    !(await isScreenScanStillCurrent({
      tabId: tab.id,
      requestId,
      controller,
      pageUrl: currentUrl,
      pageSignature: scanPageSignature
    }))
  ) {
    finishScreenRequest(tab.id, requestId);
    return {
      ok: false,
      requestId,
      message: 'The page changed before the answer returned. Scan the current question again.',
      error: 'STALE_SCREEN_ANALYSIS',
      timing: {
        ...timing,
        totalMs: Date.now() - totalStartedAt
      }
    };
  }

  if (shouldRetryScreenAnalysisWithScreenshot(analysis, optimized)) {
    logScreenTiming(settings, 'ai-requested-screenshot-fallback', {
      requestId,
      tabId: tab.id,
      itemCount: analysis.ok ? analysis.items.length : 0,
      extraction_mode: extractionMode,
      confidence: analysis.ok ? analysis.items[0]?.confidence : undefined
    });
    void sendScreenScanStatusMessage(tab.id, requestId, 'scanning', 'Checking visual context...').catch(() => undefined);

    try {
      optimized = await captureOptimizedVisibleScreenForAnalysis({
        tabId: tab.id,
        windowId: target.windowId,
        requestId,
        settings,
        timing
      });
      extractionMode = 'mixed';
      timing.extractionMode = extractionMode;

      const fallbackBackendStartedAt = Date.now();
      const fallbackAnalysis = await analyzeScreenshotWithBackend(settings.apiBaseUrl, {
        image: optimized.dataUrl,
        pageUrl: currentUrl,
        pageTitle: tab.title ?? 'Current page',
        viewport,
        mode: 'find_questions_and_answer',
        textContext,
        imageMeta: optimized.meta,
        debug: settings.debugMode
      }, undefined, {
        requestId: `${requestId}-screenshot-fallback`,
        source: `${source}:screenshot-fallback`,
        apiBaseUrlSource: settings.apiBaseUrlSource,
        signal: controller.signal
      });
      const fallbackBackendMs = Date.now() - fallbackBackendStartedAt;
      timing.backendRequestMs = (timing.backendRequestMs ?? 0) + fallbackBackendMs;
      timing.uploadMs = timing.backendRequestMs;
      Object.assign(timing, fallbackAnalysis.timing ?? {}, {
        captureMs: timing.captureMs,
        preprocessMs: timing.preprocessMs,
        uploadMs: timing.uploadMs,
        backendRequestMs: timing.backendRequestMs,
        domExtractMs: timing.domExtractMs,
        screenshotCaptureMs: timing.screenshotCaptureMs,
        extensionMessageMs: timing.extensionMessageMs,
        cacheHit: false,
        extractionMode
      });
      analysis = fallbackAnalysis;
      logScreenTiming(settings, 'screenshot-fallback-response-received', {
        requestId,
        tabId: tab.id,
        backend_request_ms: fallbackBackendMs,
        ai_response_ms: fallbackAnalysis.timing?.aiResponseMs ?? fallbackAnalysis.timing?.aiMs,
        ai_parse_ms: fallbackAnalysis.timing?.parseMs,
        itemCount: fallbackAnalysis.ok ? fallbackAnalysis.items.length : 0
      });
    } catch (error) {
      traceBackgroundError('screen:screenshot-fallback-failed', {
        requestId,
        tabId: tab.id,
        detail: getErrorMessage(error)
      });
    }
  }

  if (!analysis.ok) {
    await updateBackendConnection('degraded', analysis.message);
    await saveSession({
      pageState: {
        uiStatus: {
          lifecycle: 'error',
          message: analysis.message,
          lastAction: 'analyze'
        },
        errors: {
          analysis: analysis.message
        }
      }
    });
    void sendScreenScanStatusMessage(
      tab.id,
      requestId,
      'error',
      analysis.message || 'I could not clearly detect a question. Highlight the question and scan again.'
    ).catch(() => undefined);
    finishScreenRequest(tab.id, requestId);
    return {
      ok: false,
      requestId,
      message: analysis.message,
      analysis,
      timing: {
        ...timing,
        ...analysis.timing,
        totalMs: Date.now() - totalStartedAt
      }
    };
  }

  await updateBackendConnection('connected');

  const renderPayload: ScreenBubbleRenderPayload = {
    analysis,
    pageUrl: currentUrl,
    pageTitle: tab.title ?? 'Current page',
    viewport,
    capturedAt: new Date().toISOString(),
    scanId: requestId,
    pageSignature: scanPageSignature
  };
  const renderStartedAt = Date.now();
  logScreenTiming(settings, 'content-render-started', {
    requestId,
    tabId: tab.id,
    itemCount: analysis.items.length
  });
  let renderResponse = await sendScreenBubbleRenderMessage(tab.id, requestId, renderPayload);
  if (!renderResponse.ok) {
    const retryAttachment = await ensureTabAttachment(tab.id, currentUrl, requestId);
    if (retryAttachment.ok) {
      renderResponse = await sendScreenBubbleRenderMessage(tab.id, `${requestId}-retry`, renderPayload);
    }
  }
  timing.renderMs = Date.now() - renderStartedAt;
  timing.overlayRenderMs = timing.renderMs;
  timing.totalMs = Date.now() - totalStartedAt;
  timing.scanTotalMs = timing.totalMs;
  timing.extractionMode = extractionMode;
  timing.cacheHit = false;
  logScreenTiming(settings, 'bubbles-rendered', {
    requestId,
    tabId: tab.id,
    overlay_render_ms: timing.renderMs,
    scan_total_ms: timing.totalMs,
    dom_extract_ms: timing.domExtractMs,
    screenshot_capture_ms: timing.screenshotCaptureMs,
    prompt_build_ms: timing.promptBuildMs,
    extension_message_ms: timing.extensionMessageMs,
    backend_request_ms: timing.backendRequestMs ?? timing.uploadMs,
    ai_response_ms: timing.aiResponseMs ?? timing.aiMs,
    ai_parse_ms: timing.parseMs,
    cache_hit: false,
    extraction_mode: extractionMode,
    model_used: timing.modelUsed,
    input_chars: timing.inputChars,
    output_chars: timing.outputChars,
    rendered: renderResponse.ok ? renderResponse.response.visible : false
  });

  const rendered = renderResponse.ok ? renderResponse.response.ok : false;
  const message = rendered
    ? renderResponse.ok
      ? renderResponse.response.message
      : 'Screen analysis finished.'
    : analysis.items.length
      ? 'Screen analysis finished, but Mako IQ could not render answer bubbles on this page.'
      : analysis.warnings.includes('RESTRICTED_ASSESSMENT')
        ? 'Mako IQ can help explain concepts or make study notes, but it will not provide live answers for restricted assessments.'
        : 'No clear questions found on this screen.';

  await saveSession({
    pageState: {
      currentPage: {
        tabId: tab.id,
        url: currentUrl,
        title: tab.title ?? 'Current page',
        domain: extractHostname(currentUrl),
        pageType: launchSupport.pageType,
        assistantMode: launchSupport.assistantMode === 'canvas' ? 'canvas' : 'general',
        platform: launchSupport.assistantMode === 'canvas' ? 'canvas' : 'general_web'
      },
      uiStatus: {
        lifecycle: 'ready',
        message,
        lastAction: 'analyze'
      },
      timestamps: {
        analyzedAt: new Date().toISOString()
      },
      errors: {
        analysis: rendered ? undefined : message
      }
    },
    messages: [
      ...state.session.messages,
      createMessage('assistant', 'status', message)
    ]
  });

  await setCachedScreenAnalysis(tab.id, {
    key: cacheKey,
    pageUrl: currentUrl,
    pageSignature: scanPageSignature,
    analysis,
    renderPayload,
    createdAt: Date.now(),
    expiresAt: Date.now() + SCREEN_DUPLICATE_CACHE_TTL_MS
  });
  finishScreenRequest(tab.id, requestId);

  return {
    ok: rendered || !analysis.items.length,
    requestId,
    message,
    analysis: {
      ...analysis,
      timing
    },
    rendered,
    timing
  };
}

async function clearAnswerBubblesAction(requestId: string): Promise<ScreenAnalyzeActionResponse> {
  const target = await resolveActivePanelTarget(requestId, 'clear-answer-bubbles');
  const tab = target?.tab;
  if (!tab?.id || !tab.url) {
    return {
      ok: false,
      requestId,
      message: 'No active page was available to clear.',
      error: 'NO_ACTIVE_TAB'
    };
  }

  await clearCachedScreenAnalysis(tab.id);
  const response = await sendToTab<OverlayUpdateResponse>(tab.id, { type: 'CLEAR_ANSWER_BUBBLES', requestId }, 1200);
  if (!response.ok) {
    return {
      ok: false,
      requestId,
      message: 'Mako IQ could not clear bubbles on this page.',
      error: response.detail ?? response.reason
    };
  }

  return {
    ok: response.response.ok,
    requestId,
    message: response.response.message,
    rendered: response.response.visible
  };
}

async function cancelScreenAnalysisAction(requestId: string): Promise<ScreenAnalyzeActionResponse> {
  const target = await resolveActivePanelTarget(requestId, 'cancel-screen-analysis');
  const tabId = target?.tab?.id;
  if (!tabId) {
    return {
      ok: false,
      requestId,
      message: 'No active screen scan was available to cancel.',
      error: 'NO_ACTIVE_TAB'
    };
  }

  const controller = screenAnalysisControllers.get(tabId);
  if (!controller || controller.signal.aborted) {
    return {
      ok: true,
      requestId,
      message: 'No active screen scan was running.'
    };
  }

  controller.abort();
  screenAnalysisControllers.delete(tabId);
  activeScreenRequests.set(tabId, requestId);

  return {
    ok: true,
    requestId,
    message: 'Screen scan cancelled.'
  };
}

async function handleScreenPageContextChanged(message: any, sender: chrome.runtime.MessageSender): Promise<ScreenAnalyzeActionResponse> {
  const requestId = typeof message.requestId === 'string' ? message.requestId : createRequestId();
  const tabId = sender.tab?.id;
  if (!tabId) {
    return {
      ok: true,
      requestId,
      message: 'Stale screen context cleared.'
    };
  }

  const reason = typeof message.reason === 'string' ? message.reason : 'page_context_changed';
  clearScreenAnalysisRuntimeState(tabId, requestId, reason);

  if (sender.tab?.active) {
    await saveSession({
      latestScan: undefined,
      lastAnalysis: undefined,
      pageState: {
        scan: undefined,
        analysis: undefined,
        uiStatus: {
          lifecycle: 'idle',
          message: 'Page changed. Scan again for fresh answer context.',
          lastAction: 'page_change'
        },
        errors: {
          scan: undefined,
          analysis: undefined
        }
      }
    });
  }

  return {
    ok: true,
    requestId,
    message: 'Stale screen context cleared.'
  };
}

async function askBubbleFollowUp(message: any): Promise<ScreenFollowUpResponse> {
  const { settings } = await getExtensionState();
  try {
    const response = await askScreenFollowUpWithBackend(settings.apiBaseUrl, {
      analysisId: typeof message.analysisId === 'string' ? message.analysisId : '',
      itemId: typeof message.itemId === 'string' ? message.itemId : '',
      question: typeof message.question === 'string' ? message.question : '',
      originalQuestion: typeof message.originalQuestion === 'string' ? message.originalQuestion : '',
      originalAnswer: typeof message.originalAnswer === 'string' ? message.originalAnswer : ''
    }, undefined, {
      requestId: typeof message.requestId === 'string' ? message.requestId : createRequestId(),
      source: 'bubble-follow-up',
      apiBaseUrlSource: settings.apiBaseUrlSource
    });
    if (response.ok) {
      await updateBackendConnection('connected');
    } else {
      await updateBackendConnection('degraded', response.message);
    }
    return response;
  } catch (error) {
    const detail = mapAnalysisApiError(error);
    await updateBackendConnection('degraded', detail);
    return {
      ok: false,
      error: 'SCREEN_FOLLOWUP_FAILED',
      message: 'Mako IQ could not answer this follow-up.'
    };
  }
}

function buildOverlayTestWorkflowState(state: Awaited<ReturnType<typeof getExtensionState>>): WorkflowState {
  const existingWorkflow = state.session.workflowState;
  if (existingWorkflow?.outputShell) {
    return existingWorkflow;
  }

  const pageTitle = state.session.pageState.currentPage.title ?? state.session.pageContext?.title ?? 'Current page';
  const pageUrl = state.session.pageState.currentPage.url ?? state.session.pageContext?.url ?? '';

  return {
    currentWorkflow: 'general',
    classification: {
      workflowType: 'general',
      confidence: 0.8,
      reasons: ['This is a debug overlay test payload.'],
      recommendedActions: ['summarize_page'],
      detectedSignals: ['overlay_test']
    },
    promptExtraction: {
      promptText: 'Overlay test payload from the Mako IQ background pipeline.',
      promptType: 'unknown',
      source: 'none',
      confidence: 0.4
    },
    latestScanId: null,
    currentAction: 'summarize_page',
    currentActionLabel: 'Show Overlay Test',
    currentActionTask: 'summarize_reading',
    lastUpdatedAt: Date.now(),
    workflowType: 'general',
    confidence: 0.8,
    reasons: ['This test bypasses workflow generation and exercises the page overlay path directly.'],
    recommendedAction: 'Use this to verify the overlay pipeline independently of deeper workflow logic.',
    assistantPrompt: 'Overlay test',
    extraInstructions: '',
    selectedTask: 'summarize_reading',
    actionCards: [],
    outputShell: {
      type: 'general',
      actionId: 'summarize_page',
      title: 'Overlay test output',
      intro: 'This is a known-good Mako IQ overlay test payload.',
      summary: 'If you can read this on the page, the content-script overlay renderer is alive and reachable.',
      keyPoints: ['Single overlay root', 'Transparent HUD visible', 'Background-to-content messaging works'],
      suggestedNextStep: 'Trigger a real workflow action next and confirm the overlay updates in place.',
      updatedAt: new Date().toISOString()
    },
    pageAnalysis: null,
    sourceTitle: pageTitle,
    sourceUrl: pageUrl,
    updatedAt: new Date().toISOString()
  };
}

async function showOverlayTest(requestId: string) {
  const state = await getExtensionState();
  const workflowState = buildOverlayTestWorkflowState(state);
  const overlayStatus = await showWorkflowOverlayOnActivePage(
    workflowState,
    requestId,
    'overlay-test',
    state.session.pageState.currentPage.tabId,
    state.session.pageState.currentPage.url
  );

  await saveSession({
    overlayStatus
  });

  return {
    ok: overlayStatus.state === 'shown',
    message:
      overlayStatus.state === 'shown'
        ? 'Overlay test rendered on the current page.'
        : `Overlay test failed: ${overlayStatus.message}`
  };
}

async function pushOverlayToActiveTab(workflowState: WorkflowState | undefined, requestId: string, source: string) {
  if (!workflowState?.outputShell) {
    const message = 'Overlay failed: no output payload was provided.';
    logDebug('tabs.sendMessage failure', {
      requestId,
      source,
      reason: 'no_output_payload'
    });
    await saveSession({
      overlayStatus: createOverlayStatus('error', message, {
        reason: 'no_output_payload',
        requestId,
        source,
        actionId: workflowState?.currentAction
      })
    });
    return {
      ok: false,
      message,
      reason: 'no_output_payload'
    };
  }

  const state = await getExtensionState();
  const preferredTabId = state.session.pageState.currentPage.tabId;
  const preferredUrl = state.session.pageState.currentPage.url;

  const resolvedTab = await resolveOverlayTargetTab(requestId, source, preferredTabId, preferredUrl);
  logDebug('Resolved active tab', {
    requestId,
    source,
    tabId: resolvedTab?.id,
    currentUrl: resolvedTab?.url ?? ''
  });

  logDebug('Sending overlay payload', {
    requestId,
    source,
    overlayPayloadType: workflowState.outputShell.type,
    actionId: workflowState.currentAction
  });
  logDebug('Overlay payload type', {
    requestId,
    source,
    overlayPayloadType: workflowState.outputShell.type
  });

  const overlayStatus = await showWorkflowOverlayOnActivePage(
    workflowState,
    requestId,
    source,
    preferredTabId,
    preferredUrl
  );

  await saveSession({
    overlayStatus
  });

  if (overlayStatus.state === 'shown') {
    logDebug('tabs.sendMessage success', {
      requestId,
      source,
      tabId: overlayStatus.tabId,
      actionId: overlayStatus.actionId
    });
    return {
      ok: true,
      message: 'Overlay shown on the current page.'
    };
  }

  logDebug('tabs.sendMessage failure', {
    requestId,
    source,
    tabId: overlayStatus.tabId,
    actionId: overlayStatus.actionId,
    reason: overlayStatus.reason ?? 'unknown',
    message: overlayStatus.message
  });
  return {
    ok: false,
    message: `Overlay failed: ${overlayStatus.message}`,
    reason: overlayStatus.reason ?? 'unknown'
  };
}

function getTabDomain(url?: string) {
  if (!url) {
    return undefined;
  }

  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return undefined;
  }
}

async function markActivePageStale(tab: chrome.tabs.Tab | undefined, source: string) {
  if (!tab?.url || isExtensionPageUrl(tab.url)) {
    return;
  }

  const state = await getExtensionState();
  const currentPage = state.session.pageState.currentPage;
  if (!currentPage.url || currentPage.url === tab.url) {
    return;
  }

  logDebug('Active page changed.', {
    source,
    previousUrl: currentPage.url,
    nextUrl: tab.url,
    previousTitle: currentPage.title,
    nextTitle: tab.title ?? 'Current page'
  });

  const launchSupport = getLaunchSupport(tab.url);
  const nextAssistantMode = launchSupport.assistantMode === 'canvas' ? 'canvas' : 'general';
  const controllerKey = buildAnalysisControllerKey(currentPage.tabId);
  const activeController = activeAnalysisControllers.get(controllerKey);
  if (activeController && !activeController.signal.aborted) {
    activeController.abort();
    activeAnalysisControllers.delete(controllerKey);
  }
  const staleState = createStalePageState(
    state.session.pageState,
    {
      tabId: tab.id,
      url: tab.url,
      title: tab.title ?? 'Current page',
      domain: getTabDomain(tab.url),
      pageType: launchSupport.pageType,
      assistantMode: nextAssistantMode,
      platform: nextAssistantMode === 'canvas' ? 'canvas' : launchSupport.isSupported ? 'general_web' : 'unknown'
    },
    launchSupport.isSupported
      ? 'Results are stale because the active page changed. Refresh context or scan this page to sync Mako IQ again.'
      : launchSupport.message
  );

  await saveSession({
    assistantMode: nextAssistantMode,
    pageState: staleState,
    pageContext: undefined,
    context: undefined,
    canvasApiSummary: undefined,
    workflowState: undefined,
    analysisRun: undefined,
    latestScan: undefined,
    latestClassification: undefined,
    latestWorkflowRoute: undefined,
    lastAnalysis: undefined,
    activeTask: undefined,
    scanStatus: 'stale',
    scanError: undefined
  });
  logDebug('Stale state detected and written.', {
    source,
    nextUrl: tab.url,
    nextTitle: tab.title ?? 'Current page'
  });
}

async function openSidebarAction(requestId = createRequestId(), source = 'popup-open', preferredWindowId?: number) {
  const target = await resolveActivePanelTarget(requestId, source, preferredWindowId);
  if (!target?.windowId) {
    return {
      ok: false,
      requestId,
      reason: 'no_active_tab' as OpenCanvyFailureReason,
      message: 'Could not find the current browser window.'
    };
  }

  const openResult = await openWorkspaceWindow(target.windowId, requestId, source, target.tab);
  if (!openResult.ok) {
    return openResult;
  }

  if (target.tab) {
    void syncPageBootstrap(target.tab, requestId).catch((error) => {
      console.warn(`[Canvy background][${requestId}] Bootstrap sync failed after side panel open.`, {
        source,
        detail: getErrorMessage(error)
      });
    });
  }

  return openResult;
}

async function analyzePageAction(requestId = createRequestId(), source = 'popup-analyze') {
  const target = await resolveActivePanelTarget(requestId, source);
  if (!target?.tab) {
    return {
      ok: false,
      requestId,
      reason: 'no_active_tab' as OpenCanvyFailureReason,
      message: 'Open a browser tab and try again.'
    };
  }

  const analysisResult = await runActivePageAnalysis(requestId, source);

  return {
    ok: analysisResult.ok,
    requestId,
    pageTitle: target.tab.title ?? 'Current page',
    currentUrl: target.tab.url ?? '',
    mode: analysisResult.mode,
    message: analysisResult.ok
      ? buildOpenCanvyMessage('analyze', analysisResult.mode, analysisResult.pageSupported)
      : `${buildOpenCanvyMessage('analyze', analysisResult.mode, analysisResult.pageSupported)} ${analysisResult.error ?? ''}`.trim()
  };
}

async function startPopupAnalysisAction(requestId = createRequestId(), instruction = '') {
  const target = await resolveActivePanelTarget(requestId, 'popup-analyze');
  if (!target?.tab?.url) {
    return {
      ok: false,
      requestId,
      message: 'Open a browser tab and try again.',
      analysisRun: null,
      error: 'No active page tab was found.'
    };
  }

  const launchSupport = getLaunchSupport(target.tab.url);
  if (!launchSupport.isSupported) {
    return {
      ok: false,
      requestId,
      message: launchSupport.message,
      analysisRun: null,
      error: launchSupport.message
    };
  }

  void runActivePageAnalysis(requestId, 'popup-analyze', instruction).catch((error) => {
    logDebug('Popup analysis task failed after kickoff.', {
      requestId,
      detail: getErrorMessage(error)
    });
  });

  return {
    ok: true,
    requestId,
    message: 'Scan started.',
    analysisRun: null
  };
}

async function getBootstrap(requestId = createRequestId()): Promise<BootstrapPayload> {
  await logResolvedApiBaseUrl('get-bootstrap');
  const bootstrap = await syncPageBootstrap(undefined, requestId);
  const latest = await getExtensionState();

  return {
    settings: latest.settings,
    session: latest.session,
    assistantMode: bootstrap.assistantMode,
    pageContext: bootstrap.pageContext,
    context: bootstrap.canvasContext
  };
}

async function reconnectBackend(): Promise<ReconnectBackendResponse> {
  await logResolvedApiBaseUrl('reconnect-backend');

  try {
    const { client } = await createApiClient();
    await client.checkHealth({
      requestId: createRequestId(),
      source: 'reconnect-backend',
      routeLabel: 'Health route'
    });

    const backendConnection = createBackendConnectionStatus('connected');
    await updateBackendConnection('connected');
    return {
      ok: true,
      message: 'Mako IQ backend connection is active.',
      backendConnection
    };
  } catch (error) {
    const detail = mapApiErrorMessage(error);
    const backendConnection = createBackendConnectionStatus('offline', detail);
    await updateBackendConnection('offline', detail);
    return {
      ok: false,
      message: `Mako IQ could not reconnect to the backend: ${detail}`,
      backendConnection
    };
  }
}

async function completeConfigure(): Promise<ConfigureResponse> {
  const state = await getExtensionState();
  const samples = buildToneProfileSamples(state.session.pageState.scan, state.session.scannedPages);

  if (!samples.length) {
    return {
      ok: false,
      message: 'Scan a page first so Mako IQ can analyze at least one writing sample before configuration.'
    };
  }

  const { client, flushTokenAndHealth } = await createApiClient();

  try {
    const response = await client.generateToneProfile({
      consentGranted: true,
      samples
    }, {
      requestId: createRequestId(),
      source: 'tone-profile',
      routeLabel: 'Tone profile route'
    });
    await flushTokenAndHealth('connected');

    await saveSettings({
      configured: true,
      toneConsentGranted: true,
      toneProfile: response.toneProfile
    });

    await saveSession({
      messages: [
        ...state.session.messages,
        createMessage(
          'assistant',
          'status',
          "You're using Mako IQ. I've analyzed your sample and can now personalize workflow output."
        ),
        createMessage('assistant', 'status', response.message)
      ]
    });

    return {
      ok: true,
      message: response.message,
      toneProfile: response.toneProfile
    };
  } catch (error) {
    const detail = mapApiErrorMessage(error);
    await flushTokenAndHealth('degraded', detail);
    return {
      ok: false,
      message: `Mako IQ could not complete setup right now: ${detail}`
    };
  }
}

async function startWorkflowAction(task: CanvyTaskKind, extraInstructions: string, assignmentId?: string, actionId?: string) {
  const requestId = createRequestId();
  const activeTab = await getActiveTab();
  const inflightKey = `workflow:${activeTab?.id ?? 'none'}:${task}:${actionId ?? 'default'}`;

  return withInflightGuard(inflightKey, async () => {
    const bootstrap = await getBootstrap(requestId);
    const summary = bootstrap.context
      ? bootstrap.session.canvasApiSummary ?? createUnavailableCanvasSummary(bootstrap.context)
      : undefined;
    const selectedAssignment =
      summary?.upcomingAssignments.find((assignment) => assignment.id === assignmentId) ?? summary?.upcomingAssignments[0];
    const derivedWorkflowState =
      bootstrap.session.workflowState ??
      (bootstrap.session.pageState.classification && bootstrap.session.pageState.workflowRoute
        ? deriveWorkflowState({
            classification: bootstrap.session.pageState.classification,
            workflowRoute: bootstrap.session.pageState.workflowRoute,
            latestScan: bootstrap.session.pageState.scan,
            pageContext: bootstrap.pageContext,
            analysis: bootstrap.session.pageState.analysis,
            previous: bootstrap.session.workflowState
          })
        : undefined);

    if (!derivedWorkflowState) {
      return {
        ok: false,
        message: 'Analyze Screen or refresh page context first so Mako IQ can choose the right workflow.'
      };
    }

    const trimmedInstructions = extraInstructions.trim();
    const pendingWorkflowState = {
      ...runWorkflowAction({
        workflowState: derivedWorkflowState,
        task,
        actionId: actionId as WorkflowActionId | undefined,
        taskClassification: bootstrap.session.pageState.classification,
        workflowRoute: bootstrap.session.pageState.workflowRoute,
        latestScan: bootstrap.session.pageState.scan,
        pageContext: bootstrap.pageContext,
        analysis: bootstrap.session.pageState.analysis,
        extraInstructions
      }),
      outputShell: bootstrap.session.workflowState?.outputShell ?? null,
      pageAnalysis: bootstrap.session.workflowState?.pageAnalysis ?? bootstrap.session.pageState.analysis ?? null,
      updatedAt: new Date().toISOString(),
      lastUpdatedAt: Date.now()
    };
    const analysisMode = mapTaskToAnalysisMode(task, pendingWorkflowState.currentAction);
    const pageContext = bootstrap.pageContext ?? (activeTab ? buildFallbackPageContext(activeTab, bootstrap.assistantMode) : null);
    const existingAnalysis = bootstrap.session.pageState.analysis;
    const canReuseExistingAnalysis =
      Boolean(existingAnalysis) &&
      existingAnalysis?.sourceUrl === pageContext?.url &&
      existingAnalysis?.mode === analysisMode &&
      !trimmedInstructions;

    if (!pageContext) {
      const errorMessage = 'Mako IQ could not find page context for this workflow action.';
      await saveSession({
        pageState: {
          uiStatus: {
            lifecycle: 'error',
            message: errorMessage,
            lastAction: 'analyze'
          },
          errors: {
            analysis: errorMessage
          }
        },
        messages: [...bootstrap.session.messages, createMessage('assistant', 'status', errorMessage)]
      });
      return {
        ok: false,
        message: errorMessage
      };
    }

    await saveSession({
      assistantMode: bootstrap.assistantMode,
      pageContext: bootstrap.pageContext ?? undefined,
      context: bootstrap.context ?? undefined,
      canvasApiSummary: summary,
      workflowState: pendingWorkflowState,
      activeTask: task,
      pageState: {
        uiStatus: {
          lifecycle: 'analyzing',
          message: `Generating ${workflowLabel(pendingWorkflowState.workflowType)} output for ${pageContext.title}...`,
          lastAction: 'analyze'
        },
        errors: {
          analysis: undefined
        }
      }
    });

    logDebug('Workspace action triggered.', {
      workflowType: pendingWorkflowState.workflowType,
      task,
      actionId: pendingWorkflowState.currentAction,
      analysisMode,
      hasInstructions: Boolean(trimmedInstructions)
    });

    try {
      const analysis = canReuseExistingAnalysis
        ? existingAnalysis
        : await requestBackendAnalysis({
            requestId,
            source: 'workflow-action',
            tab: activeTab ?? undefined,
            assistantMode: bootstrap.assistantMode,
            pageContext,
            canvasContext: bootstrap.context,
            latestScan: bootstrap.session.pageState.scan,
            mode: analysisMode,
            instruction: trimmedInstructions
          });

      if (canReuseExistingAnalysis) {
        logDebug('Reused existing analysis for workflow action.', {
          requestId,
          task,
          actionId: pendingWorkflowState.currentAction,
          analysisMode
        });
      } else {
        await updateBackendConnection('connected');
      }

      const finalWorkflowState = {
        ...pendingWorkflowState,
        outputShell: mapAnalysisToWorkflowShell(pendingWorkflowState, task, analysis),
        pageAnalysis: analysis,
        updatedAt: new Date().toISOString(),
        lastUpdatedAt: Date.now()
      };
      await persistWorkflowState(finalWorkflowState);

      const targetLabel =
        selectedAssignment?.title ??
        finalWorkflowState.sourceTitle ??
        (bootstrap.assistantMode === 'canvas' ? bootstrap.context?.title : bootstrap.pageContext?.title) ??
        'this page';
      const overlayStatus = await showWorkflowOverlayOnActivePage(
        finalWorkflowState,
        requestId,
        'workflow-action',
        bootstrap.session.pageState.currentPage.tabId,
        bootstrap.session.pageState.currentPage.url
      );
      const nextMessages = [
        ...(trimmedInstructions ? [createMessage('user', 'user', trimmedInstructions)] : []),
        createMessage('assistant', 'status', `${workflowLabel(finalWorkflowState.workflowType)} workflow ready for ${targetLabel}.`),
        createMessage('assistant', 'explanation', analysis.text)
      ];

      await saveSession({
        assistantMode: bootstrap.assistantMode,
        pageContext: bootstrap.pageContext ?? undefined,
        context: bootstrap.context ?? undefined,
        canvasApiSummary: summary,
        workflowState: finalWorkflowState,
        overlayStatus,
        activeTask: task,
        lastAnalysis: analysis,
        lastOutput: mapPageAnalysisToTaskOutput(analysis),
        pageState: {
          analysis,
          uiStatus: {
            lifecycle: 'ready',
            message: buildReadyMessage(bootstrap.assistantMode, pageContext.title),
            lastAction: 'analyze'
          },
          timestamps: {
            analyzedAt: analysis.generatedAt
          },
          errors: {
            analysis: undefined
          }
        },
        messages: [...bootstrap.session.messages, ...nextMessages]
      });

      return {
        ok: overlayStatus.state !== 'error',
        message:
          overlayStatus.state === 'shown'
            ? 'Workflow updated and the page overlay was shown.'
            : overlayStatus.state === 'hidden'
              ? `Workflow updated. The page overlay stayed hidden: ${overlayStatus.message}`
            : `Workflow updated, but the page overlay failed: ${overlayStatus.message}`
      };
    } catch (error) {
      const detail = mapAnalysisApiError(error);
      const errorMessage = detail || 'Mako IQ could not generate workflow output for this page.';
      if (!(error instanceof AnalysisApiError && error.code === 'cancelled')) {
        await updateBackendConnection('degraded', errorMessage);
      }

      await saveSession({
        assistantMode: bootstrap.assistantMode,
        pageContext: bootstrap.pageContext ?? undefined,
        context: bootstrap.context ?? undefined,
        canvasApiSummary: summary,
        workflowState: pendingWorkflowState,
        activeTask: task,
        pageState: {
          uiStatus: {
            lifecycle: 'error',
            message: errorMessage,
            lastAction: 'analyze'
          },
          errors: {
            analysis: errorMessage
          }
        },
        messages: [
          ...bootstrap.session.messages,
          ...(trimmedInstructions ? [createMessage('user', 'user', trimmedInstructions)] : []),
          createMessage('assistant', 'status', errorMessage)
        ]
      });

      logDebug('Live workflow generation failed.', {
        requestId,
        task,
        detail: errorMessage
      });

      return {
        ok: false,
        message: errorMessage
      };
    }
  });
}

void ensureLauncherWindowLaunchState('worker-boot').catch((error) => {
  console.warn('[Mako IQ background] Could not verify launcher-window action behavior at worker boot.', {
    detail: getErrorMessage(error)
  });
});

chrome.runtime.onInstalled.addListener(async () => {
  await migrateLegacyStorageKeys();
  const stored = await chrome.storage.local.get([STORAGE_KEYS.settings, STORAGE_KEYS.session]);
  const apiBaseResolution = resolveApiBaseUrl((stored[STORAGE_KEYS.settings] as { apiBaseUrl?: string } | undefined)?.apiBaseUrl);
  if (!stored[STORAGE_KEYS.settings]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: createDefaultSettings(apiBaseResolution.value, apiBaseResolution.source) });
  }
  if (!stored[STORAGE_KEYS.session]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.session]: createDefaultSession() });
  }
  await ensureLauncherWindowLaunchState('onInstalled');
  hasLoggedResolvedApiBase = false;
  await logResolvedApiBaseUrl('onInstalled');
});

chrome.runtime.onStartup.addListener(() => {
  void ensureLauncherWindowLaunchState('onStartup').catch((error) => {
    console.warn('[Mako IQ background] Could not verify launcher-window action behavior on startup.', {
      detail: getErrorMessage(error)
    });
  });
});

chrome.commands.onCommand.addListener((command) => {
  logDebug('Command received.', { command });
  if (command === 'open-mako-iq' || command === 'open-canvy') {
    void openLauncherPopup(createRequestId(), 'command').catch((error) => {
      console.warn('[Mako IQ background] Could not open the launcher popup from a command.', {
        detail: getErrorMessage(error)
      });
    });
  }
});

chrome.action.onClicked.addListener((tab) => {
  void openSidebarAction(createRequestId(), 'action-click', tab.windowId).catch((error) => {
    console.warn('[Mako IQ background] Could not open the workspace sidebar from the toolbar action.', {
      detail: getErrorMessage(error)
    });
  });
});

async function notifyQuizNavigationChanged(details: chrome.webNavigation.WebNavigationFramedCallbackDetails, reason: string) {
  if (details.frameId !== 0 || !details.tabId || details.tabId < 0) {
    return;
  }

  const settings = await getSettings().catch(() => null);
  const requestId = createRequestId();
  const cached = quizModeCache.get(details.tabId);
  if (cached) {
    try {
      const previousOrigin = new URL(cached.url).origin;
      const nextOrigin = new URL(details.url).origin;
      if (previousOrigin !== nextOrigin || cached.url !== details.url) {
        quizModeCache.delete(details.tabId);
      }
    } catch {
      quizModeCache.delete(details.tabId);
    }
  }

  clearQuizModeRuntimeState(details.tabId, requestId, reason, false);

  if (!settings?.quizModeEnabled) {
    return;
  }

  await sendToTab<OverlayUpdateResponse>(
    details.tabId,
    {
      type: 'QUIZ_NAVIGATION_CHANGED',
      requestId,
      url: details.url,
      tabId: details.tabId,
      timestamp: Date.now()
    },
    500
  ).catch(() => undefined);
}

chrome.webNavigation.onCommitted.addListener((details) => {
  void notifyQuizNavigationChanged(details, 'web_navigation_committed');
});

chrome.webNavigation.onCompleted.addListener((details) => {
  void notifyQuizNavigationChanged(details, 'web_navigation_completed');
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  void notifyQuizNavigationChanged(details, 'web_navigation_history_state');
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void chrome.tabs
    .get(tabId)
    .then((tab) => markActivePageStale(tab, 'tab-activated'))
    .catch((error) => {
      console.warn('[Mako IQ background] Could not inspect activated tab.', {
        tabId,
        detail: getErrorMessage(error)
      });
    });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab.active) {
    return;
  }

  if (changeInfo.url) {
    const requestId = createRequestId();
    clearScreenAnalysisRuntimeState(tabId, requestId, 'tab_url_updated');
    clearQuizModeRuntimeState(tabId, requestId, 'tab_url_updated', true);
    void sendToTab<OverlayUpdateResponse>(tabId, { type: 'CLEAR_ANSWER_BUBBLES', requestId }, 500).catch(() => undefined);
  }

  if (changeInfo.url || changeInfo.status === 'complete') {
    void markActivePageStale(tab, 'tab-updated').catch((error) => {
      console.warn('[Mako IQ background] Could not mark updated tab as stale.', {
        tabId,
        detail: getErrorMessage(error)
      });
    });
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    return;
  }

  void chrome.tabs
    .query({ active: true, windowId })
    .then(([tab]) => markActivePageStale(tab, 'window-focus-changed'))
    .catch((error) => {
      console.warn('[Mako IQ background] Could not inspect focused window tab.', {
        windowId,
        detail: getErrorMessage(error)
      });
    });
});

chrome.windows.onBoundsChanged.addListener((window) => {
  void syncLauncherWindowBounds(window).catch((error) => {
    console.warn('[Mako IQ background] Could not persist launcher window bounds.', {
      windowId: window.id,
      detail: getErrorMessage(error)
    });
  });
});

chrome.windows.onRemoved.addListener((windowId) => {
  void clearLauncherWindowHandle(windowId).catch((error) => {
    console.warn('[Mako IQ background] Could not clear the launcher window handle.', {
      windowId,
      detail: getErrorMessage(error)
    });
  });
});

chrome.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
  traceBackgroundEvent('msg:received', {
    type: message?.type ?? 'unknown',
    requestId: typeof message?.requestId === 'string' ? message.requestId : undefined
  });

  if (message?.type === 'GET_POPUP_STATUS') {
    void getPopupStatus().then(sendResponse);
    return true;
  }

  if (message?.type === 'OPEN_ASSISTANT_PANEL' || message?.type === 'OPEN_ASSISTANT_PANEL_AND_SCAN') {
    void openAssistantPanelAction(
      typeof message.requestId === 'string' ? message.requestId : createRequestId(),
      'assistant-panel-open',
      message?.type === 'OPEN_ASSISTANT_PANEL_AND_SCAN' || Boolean(message.autoScan)
    )
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          ok: false,
          requestId: typeof message.requestId === 'string' ? message.requestId : 'assistant-panel-open',
          message: 'Mako IQ could not open the assistant on this page.',
          error: getErrorMessage(error)
        } satisfies ScreenAnalyzeActionResponse)
      );
    return true;
  }

  if (message?.type === 'CAPTURE_VISIBLE_SCREEN' || message?.type === 'ANALYZE_SCREENSHOT_REQUEST') {
    void captureAndAnalyzeVisibleScreen(
      typeof message.requestId === 'string' ? message.requestId : createRequestId(),
      typeof message.source === 'string' ? message.source : 'popup-screen-analysis'
    )
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          ok: false,
          requestId: typeof message.requestId === 'string' ? message.requestId : 'screen-analysis',
          message: 'Mako IQ could not reach the AI service.',
          error: getErrorMessage(error)
        } satisfies ScreenAnalyzeActionResponse)
      );
    return true;
  }

  if (message?.type === 'CLEAR_ANSWER_BUBBLES') {
    void clearAnswerBubblesAction(typeof message.requestId === 'string' ? message.requestId : createRequestId())
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          ok: false,
          requestId: typeof message.requestId === 'string' ? message.requestId : 'clear-answer-bubbles',
          message: 'Mako IQ could not clear bubbles on this page.',
          error: getErrorMessage(error)
        } satisfies ScreenAnalyzeActionResponse)
      );
    return true;
  }

  if (message?.type === 'CANCEL_SCREEN_ANALYSIS') {
    void cancelScreenAnalysisAction(typeof message.requestId === 'string' ? message.requestId : createRequestId())
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          ok: false,
          requestId: typeof message.requestId === 'string' ? message.requestId : 'cancel-screen-analysis',
          message: 'Mako IQ could not cancel the screen scan.',
          error: getErrorMessage(error)
        } satisfies ScreenAnalyzeActionResponse)
      );
    return true;
  }

  if (message?.type === 'SCREEN_PAGE_CONTEXT_CHANGED') {
    void handleScreenPageContextChanged(message, sender).then(sendResponse);
    return true;
  }

  if (message?.type === 'QUIZ_CONTEXT_CHANGED') {
    void handleQuizContextChanged(message, sender).then(sendResponse);
    return true;
  }

  if (message?.type === 'QUIZ_PREFETCH_ANSWER') {
    void prefetchQuizAnswerAction(message as QuizPrefetchRequestMessage, sender).then(sendResponse);
    return true;
  }

  if (message?.type === 'ASK_BUBBLE_FOLLOWUP') {
    void askBubbleFollowUp(message).then(sendResponse);
    return true;
  }

  if (message?.type === 'CANVY_GET_LAUNCH_CONFIGURATION') {
    void readLaunchConfiguration(typeof message.requestId === 'string' ? message.requestId : 'runtime-message').then(sendResponse);
    return true;
  }

  if (message?.type === 'CANVY_DEBUG_OPEN_LAUNCHER_WINDOW') {
    void createOrFocusLauncherWindow(
      typeof message.requestId === 'string' ? message.requestId : createRequestId(),
      'runtime-debug-open-launcher',
      typeof message.windowId === 'number' ? message.windowId : undefined
    )
      .then((window) =>
        sendResponse({
          ok: true,
          windowId: window.id,
          width: window.width,
          height: window.height,
          left: window.left,
          top: window.top
        })
      )
      .catch((error) =>
        sendResponse({
          ok: false,
          error: getErrorMessage(error)
        })
      );
    return true;
  }

  if (message?.type === 'CANVY_DEBUG_CLOSE_LAUNCHER_WINDOW') {
    void closeLauncherWindow(
      typeof message.requestId === 'string' ? message.requestId : createRequestId(),
      'runtime-debug-close-launcher'
    )
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          ok: false,
          error: getErrorMessage(error)
        })
      );
    return true;
  }

  if (message?.type === 'CANVY_DEBUG_GET_LAUNCHER_WINDOW') {
    void inspectLauncherWindow(
      typeof message.requestId === 'string' ? message.requestId : createRequestId(),
      'runtime-debug-get-launcher'
    )
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          ok: false,
          error: getErrorMessage(error)
        })
      );
    return true;
  }

  if (message?.type === 'CANVY_DEBUG_UPDATE_LAUNCHER_WINDOW') {
    void updateLauncherWindowBounds(
      typeof message.requestId === 'string' ? message.requestId : createRequestId(),
      'runtime-debug-update-launcher',
      message.bounds ?? {}
    )
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          ok: false,
          error: getErrorMessage(error)
        })
      );
    return true;
  }

  if (message?.type === 'OPEN_SIDEPANEL' || message?.type === 'OPEN_CANVY') {
    void openSidebarAction(typeof message.requestId === 'string' ? message.requestId : createRequestId(), 'popup-open')
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          ok: false,
          requestId: typeof message.requestId === 'string' ? message.requestId : 'open-sidepanel',
          reason: 'open_failed',
          message: 'Mako IQ could not open the Chrome side panel in this window.',
          error: getErrorMessage(error)
        })
      );
    return true;
  }

  if (message?.type === 'ANALYZE_PAGE') {
    void analyzePageAction(typeof message.requestId === 'string' ? message.requestId : createRequestId(), 'popup-analyze').then(sendResponse);
    return true;
  }

  if (message?.type === 'CANVY_START_ANALYSIS_RUN') {
    void startPopupAnalysisAction(
      typeof message.requestId === 'string' ? message.requestId : createRequestId(),
      typeof message.instruction === 'string' ? message.instruction : ''
    ).then(sendResponse);
    return true;
  }

  if (message?.type === 'CANVY_ANALYZE_ACTIVE_PAGE') {
    void runActivePageAnalysis(
      typeof message.requestId === 'string' ? message.requestId : createRequestId(),
      'sidepanel-analyze',
      typeof message.instruction === 'string' ? message.instruction : ''
    ).then(sendResponse);
    return true;
  }

  if (message?.type === 'CANVY_CANCEL_ANALYSIS') {
    void cancelActiveAnalysis(typeof message.requestId === 'string' ? message.requestId : createRequestId()).then(sendResponse);
    return true;
  }

  if (message?.type === 'CANVY_REFRESH_ACTIVE_PAGE_CONTEXT') {
    void refreshActivePageContext(typeof message.requestId === 'string' ? message.requestId : createRequestId(), 'sidepanel-refresh').then(sendResponse);
    return true;
  }

  if (message?.type === 'CANVY_SCAN_ACTIVE_PAGE') {
    void runActivePageScan(
      typeof message.requestId === 'string' ? message.requestId : createRequestId(),
      'scan-active-page',
      message.sourceType === 'tone_sample' ? 'tone_sample' : 'reference'
    ).then(sendResponse);
    return true;
  }

  if (message?.type === 'CANVY_GET_BOOTSTRAP') {
    void getBootstrap(typeof message.requestId === 'string' ? message.requestId : createRequestId()).then(sendResponse);
    return true;
  }

  if (message?.type === 'CANVY_COMPLETE_CONFIGURE') {
    void completeConfigure().then(sendResponse);
    return true;
  }

  if (message?.type === 'CANVY_RECONNECT_BACKEND') {
    void reconnectBackend().then(sendResponse);
    return true;
  }

  if (message?.type === 'CANVY_START_WORKFLOW_ACTION' || message?.type === 'CANVY_START_MOCK_HELPER') {
    void startWorkflowAction(
      message.task as CanvyTaskKind,
      typeof message.extraInstructions === 'string' ? message.extraInstructions : '',
      typeof message.assignmentId === 'string' ? message.assignmentId : undefined,
      typeof message.actionId === 'string' ? message.actionId : undefined
    ).then(sendResponse);
    return true;
  }

  if (message?.type === 'CANVY_SHOW_OVERLAY_TEST') {
    void showOverlayTest(typeof message.requestId === 'string' ? message.requestId : createRequestId()).then(sendResponse);
    return true;
  }

  if (message?.type === 'CANVY_PUSH_OVERLAY_TO_ACTIVE_TAB') {
    void pushOverlayToActiveTab(
      message.workflowState as WorkflowState | undefined,
      typeof message.requestId === 'string' ? message.requestId : createRequestId(),
      typeof message.source === 'string' ? message.source : 'manual-overlay-push'
    ).then(sendResponse);
    return true;
  }

  if (message?.type === 'CANVY_SAVE_SETTINGS') {
    void saveSettings(message.payload ?? {}).then((settings) => {
      if (settings.quizModeEnabled === false) {
        for (const tabId of Array.from(quizModeControllers.keys())) {
          clearQuizModeRuntimeState(tabId, createRequestId(), 'quiz_mode_disabled', true);
        }
      }
      sendResponse(settings);
    });
    return true;
  }

  return false;
});
