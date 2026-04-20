import { createMessage, createDefaultSession, createDefaultSettings, STORAGE_KEYS } from '../shared/constants';
import { resolveApiBaseUrl } from '../shared/config';
import { createCanvyApiClient, CanvyApiError } from '../shared/apiClient';
import { AnalysisApiError, analyzeWithBackend, streamAnalysisWithBackend } from '../services/api';
import { buildPageAnalysis } from '../shared/analysis';
import {
  buildAnalysisCacheKey,
  buildPrioritizedAnalysisText,
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
  AnalysisChart,
  AnalysisMode,
  AnalysisRunSnapshot,
  AnalysisTimingMetrics,
  RequestDiagnosticEvent,
  AttachStatus,
  BackendConnectionStatus,
  BootstrapPayload,
  CanvasContext,
  CanvasApiSummary,
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
  ScanPagePayload,
  ScanResponse,
  SidebarMode,
  TaskOutput,
  WorkflowActionId,
  WorkflowState
} from '../shared/types';

const DEFAULT_SHORTCUT_HINT = 'Ctrl+Shift+Y';
const DEFAULT_ACTION_POPUP_PATH = '';
const DEFAULT_LAUNCHER_PATH = 'launcher.html';
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
const inflightOperations = new Map<string, Promise<unknown>>();
const activeAnalysisControllers = new Map<string, AbortController>();
const activeAnalysisRequests = new Map<string, string>();
let hasLoggedResolvedApiBase = false;

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

function extractWindowBounds(window: chrome.windows.Window): LauncherWindowBounds | null {
  return normalizeLauncherWindowBounds(window);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logDebug(event: string, payload: Record<string, unknown> = {}) {
  console.info(`[Mako IQ background] ${event}`, payload);
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

  const stored = await chrome.storage.local.get([STORAGE_KEYS.settings]);
  const storedSettings = stored[STORAGE_KEYS.settings] as { apiBaseUrl?: string } | undefined;
  const resolution = resolveApiBaseUrl(storedSettings?.apiBaseUrl);
  hasLoggedResolvedApiBase = true;
  traceBackgroundEvent('config:api-base', {
    reason,
    resolvedApiBaseUrl: resolution.value,
    source: resolution.source,
    mode: resolution.mode,
    envKey: resolution.envKey ?? 'unset',
    isLoopback: resolution.isLoopback
  });
  recordRequestDiagnostic('config:api-base', 'Resolved API base URL.', {
    context: 'service_worker',
    source: reason,
    url: resolution.value,
    detail: `source=${resolution.source} mode=${resolution.mode} envKey=${resolution.envKey ?? 'unset'}`
  });
}

async function readLaunchConfiguration(reason: string): Promise<LaunchConfigurationStatus> {
  const [popupPath, panelBehavior, launcherWindowState] = await Promise.all([
    chrome.action.getPopup({}).catch(() => DEFAULT_ACTION_POPUP_PATH),
    chrome.sidePanel.getPanelBehavior().catch(() => ({ openPanelOnActionClick: false })),
    getLauncherWindowState().catch(() => null)
  ]);

  return {
    popupPath: normalizeExtensionPath(popupPath, DEFAULT_ACTION_POPUP_PATH),
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
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
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
  recordRequestDiagnostic('launch:config', 'Verified launcher-window action behavior.', {
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

function buildPageContextFromScan(page: Pick<ScanPagePayload, 'pageTitle' | 'url' | 'pageType' | 'headings' | 'readableText' | 'scannedAt'>): PageContextSummary {
  const previewText = page.readableText.slice(0, 1600);
  const priorityText = [page.headings.join('\n'), page.readableText.slice(0, 2400)].filter(Boolean).join('\n\n').slice(0, 2400) || previewText;

  return {
    title: page.pageTitle,
    url: page.url,
    domain: extractHostname(page.url),
    pageType: page.pageType ?? 'generic',
    headings: page.headings,
    previewText,
    priorityText,
    textLength: page.readableText.length,
    contentFingerprint: createContentFingerprint([page.pageTitle, page.url, page.headings.join('|'), priorityText]),
    extractionNotes: [],
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
  const scannedAt = payload.scannedAt || new Date().toISOString();
  const context = buildPageContextFromScan({
    pageTitle,
    url,
    pageType,
    headings,
    readableText,
    scannedAt
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
  return buildPrioritizedAnalysisText(pageContext, latestScan, canvasContext);
}

function formatChartSummary(chart: AnalysisChart | null) {
  if (!chart) {
    return '';
  }

  const datasetLines = chart.datasets.map((dataset) => `${dataset.label}: ${dataset.data.join(', ')}`);
  return [
    `${chart.type.toUpperCase()} | ${chart.title}`,
    chart.labels.length ? `Labels: ${chart.labels.join(', ')}` : '',
    ...datasetLines
  ]
    .filter(Boolean)
    .join(' | ');
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

function createStructuredPageAnalysis(input: {
  mode: AnalysisMode;
  assistantMode: SidebarMode;
  pageContext: PageContextSummary;
  meta?: {
    requestId?: string;
    cacheStatus?: AnalysisCacheStatus;
    timings?: AnalysisTimingMetrics;
  };
  output: {
    title: string;
    text: string;
    bullets: string[];
    chart: AnalysisChart | null;
    actions: string[];
  };
}): PageAnalysisResult {
  const detailLines = [
    `Mode: ${formatAnalysisModeLabel(input.mode)}`,
    ...(input.output.chart ? [formatChartSummary(input.output.chart)] : [])
  ].filter(Boolean);

  return {
    title: input.output.title,
    text: input.output.text,
    bullets: input.output.bullets,
    chart: input.output.chart,
    actions: input.output.actions,
    sourceTitle: input.pageContext.title,
    sourceUrl: input.pageContext.url,
    assistantMode: input.assistantMode,
    mode: input.mode,
    pageSummary: input.output.text,
    keyTopics: input.output.bullets,
    importantDetails: detailLines,
    suggestedNextActions: input.output.actions,
    likelyUseCase: input.output.title,
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
    explanation: formatChartSummary(analysis.chart) || analysis.actions.join(' | ') || analysis.text,
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
  const screenshotBase64 = null;
  const pageText = buildAnalysisSourceText(input.pageContext, input.latestScan, input.canvasContext);
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
    statusLabel: hit ? `Using cached analysis for ${input.pageContext.title}...` : `Preparing ${input.pageContext.title} for Kimi...`,
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
    serializationMs,
    cacheMs,
    hasScreenshot: Boolean(screenshotBase64)
  });

  snapshot = updateAnalysisRunSnapshot(snapshot, {
    phase: 'requesting_backend',
    statusLabel: `Sending ${input.pageContext.title} to Kimi...`,
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
        text: pageText
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
              statusLabel: 'Kimi is streaming a response...',
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

async function resolveActivePanelTarget(requestId: string, source: string) {
  logDebug('Resolving active panel target.', { requestId, source });

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
  assistantMode: SidebarMode | 'unsupported',
  isSupportedLaunchPage: boolean
) {
  if (kind === 'analyze') {
    if (!isSupportedLaunchPage) {
      return 'This page is hard to scan.';
    }

    return assistantMode === 'canvas' ? 'Canvas scan started.' : 'Scan started.';
  }

  if (!isSupportedLaunchPage) {
    return 'Workspace opened. Page-specific tools are limited on this tab.';
  }

  return assistantMode === 'canvas' ? 'Workspace opened in Canvas mode.' : 'Workspace opened.';
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

function describeAnalysisTarget(mode: SidebarMode, pageContext: PageContextSummary | null, canvasContext: CanvasContext | null) {
  if (mode === 'canvas') {
    return canvasContext?.title || pageContext?.title || 'this Canvas page';
  }

  return pageContext?.title || 'this page';
}

function buildFallbackPageContext(tab: chrome.tabs.Tab, mode: SidebarMode): PageContextSummary | null {
  if (!tab.url) {
    return null;
  }

  const launchSupport = getLaunchSupport(tab.url);
  const previewText =
    mode === 'canvas'
      ? 'Canvas page detected. Mako IQ will use this page as the starting point for Canvas-enhanced workflows.'
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

function buildIdleContextMessage(assistantMode: SidebarMode, pageTitle: string) {
  return assistantMode === 'canvas'
    ? `Canvas context refreshed for ${pageTitle}.`
    : `Page context refreshed for ${pageTitle}.`;
}

function buildReadyMessage(assistantMode: SidebarMode, pageTitle: string) {
  return assistantMode === 'canvas'
    ? `Answer ready for ${pageTitle}.`
    : `Answer ready for ${pageTitle}.`;
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
  return page.mode === 'canvas'
    ? `Scan complete. Canvas-enhanced context was captured from ${page.pageTitle}.`
    : `Scan complete. Mako IQ captured page context from ${page.pageTitle}.`;
}

async function runActivePageScan(
  requestId: string,
  source: string,
  sourceType: ScanPagePayload['sourceType'] = 'reference'
): Promise<ScanResponse> {
  const target = await resolveActivePanelTarget(requestId, source);
  if (!target?.tab?.id || !target.tab.url) {
    const message = 'Open a browser tab and try Scan Page again.';
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
        mode === 'canvas' ? 'Canvas page detected. Live AI analysis is ready.' : 'Live AI page analysis is ready.'
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

async function openSidebarAction(requestId = createRequestId(), source = 'popup-open') {
  const target = await resolveActivePanelTarget(requestId, source);
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
  const { settings } = await getExtensionState();
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
        message: 'Run Scan Page or Refresh Page Context first so Mako IQ can choose the right workflow.'
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
        ok: overlayStatus.state === 'shown',
        message:
          overlayStatus.state === 'shown'
            ? bootstrap.assistantMode === 'canvas'
              ? 'Canvas-enhanced workflow updated and the page overlay was shown.'
              : 'Workflow updated and the page overlay was shown.'
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
    void createOrFocusLauncherWindow(createRequestId(), 'command').catch((error) => {
      console.warn('[Mako IQ background] Could not open the launcher window from a command.', {
        detail: getErrorMessage(error)
      });
    });
  }
});

chrome.action.onClicked.addListener((tab) => {
  void createOrFocusLauncherWindow(createRequestId(), 'action-click', tab.windowId).catch((error) => {
    console.warn('[Mako IQ background] Could not open the launcher window from the toolbar action.', {
      detail: getErrorMessage(error)
    });
  });
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

chrome.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
  traceBackgroundEvent('msg:received', {
    type: message?.type ?? 'unknown',
    requestId: typeof message?.requestId === 'string' ? message.requestId : undefined
  });

  if (message?.type === 'GET_POPUP_STATUS') {
    void getPopupStatus().then(sendResponse);
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
    void openSidebarAction(typeof message.requestId === 'string' ? message.requestId : createRequestId(), 'popup-open').then(sendResponse);
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
    void saveSettings(message.payload ?? {}).then(sendResponse);
    return true;
  }

  return false;
});
