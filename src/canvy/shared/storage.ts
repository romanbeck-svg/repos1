import { createDefaultSession, createDefaultSettings, LEGACY_STORAGE_KEYS, STORAGE_KEYS } from './constants';
import { resolveApiBaseUrl } from './config';
import { mergePageState, normalizeSessionState } from '../state/pageState';
import type {
  AssignmentSessionState,
  CanvySettings,
  ExtensionState,
  LauncherWindowState,
  PageStatePatch,
  ScanPagePayload,
  ScanStatus,
  TaskClassification,
  WorkflowState,
  WorkflowRoute
} from './types';

type SessionPatch = Partial<Omit<AssignmentSessionState, 'pageState'>> & {
  pageState?: PageStatePatch;
};

export async function migrateLegacyStorageKeys() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.settings,
    STORAGE_KEYS.session,
    LEGACY_STORAGE_KEYS.settings,
    LEGACY_STORAGE_KEYS.session
  ]);

  const nextEntries: Record<string, unknown> = {};

  if (!stored[STORAGE_KEYS.settings] && stored[LEGACY_STORAGE_KEYS.settings]) {
    nextEntries[STORAGE_KEYS.settings] = stored[LEGACY_STORAGE_KEYS.settings];
  }

  if (!stored[STORAGE_KEYS.session] && stored[LEGACY_STORAGE_KEYS.session]) {
    nextEntries[STORAGE_KEYS.session] = stored[LEGACY_STORAGE_KEYS.session];
  }

  if (Object.keys(nextEntries).length) {
    await chrome.storage.local.set(nextEntries);
  }
}

export async function getSettings(): Promise<CanvySettings> {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.settings, LEGACY_STORAGE_KEYS.settings]);
  const storedSettings =
    (stored[STORAGE_KEYS.settings] as Partial<CanvySettings> | undefined) ??
    (stored[LEGACY_STORAGE_KEYS.settings] as Partial<CanvySettings> | undefined);
  const resolution = resolveApiBaseUrl(storedSettings?.apiBaseUrl, storedSettings?.apiBaseUrlSource);
  const next = {
    ...createDefaultSettings(resolution.value, resolution.source),
    ...storedSettings,
    apiBaseUrl: resolution.value,
    apiBaseUrlSource: resolution.source
  };
  if (!stored[STORAGE_KEYS.settings] && storedSettings) {
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
  }
  return next;
}

export async function saveSettings(settings: Partial<CanvySettings>) {
  const current = await getSettings();
  const didSetApiBaseUrl = Object.prototype.hasOwnProperty.call(settings, 'apiBaseUrl');
  const requestedSource = didSetApiBaseUrl ? 'storage' : settings.apiBaseUrlSource ?? current.apiBaseUrlSource;
  const resolution = resolveApiBaseUrl(settings.apiBaseUrl ?? current.apiBaseUrl, requestedSource);
  const merged = {
    ...current,
    ...settings
  };
  merged.apiBaseUrl = resolution.value;
  merged.apiBaseUrlSource = resolution.source;
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: merged });
  return merged;
}

export async function getSession(): Promise<AssignmentSessionState> {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.session, LEGACY_STORAGE_KEYS.session]);
  const session =
    (stored[STORAGE_KEYS.session] as AssignmentSessionState | undefined) ??
    (stored[LEGACY_STORAGE_KEYS.session] as AssignmentSessionState | undefined);
  if (!session?.id) {
    const next = createDefaultSession();
    await chrome.storage.local.set({ [STORAGE_KEYS.session]: next });
    return next;
  }

  const hydrated = normalizeSessionState({
    ...createDefaultSession(),
    ...session,
    analysisCache: session.analysisCache ?? [],
    messages: session.messages ?? [],
    scannedPages: session.scannedPages ?? []
  });

  if (!stored[STORAGE_KEYS.session] && session) {
    await chrome.storage.local.set({ [STORAGE_KEYS.session]: hydrated });
  }

  return hydrated;
}

export async function getLauncherWindowState(): Promise<LauncherWindowState | null> {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.launcherWindow]);
  return (stored[STORAGE_KEYS.launcherWindow] as LauncherWindowState | undefined) ?? null;
}

export async function saveLauncherWindowState(partial: Partial<LauncherWindowState>) {
  const current = await getLauncherWindowState();
  const merged = {
    ...(current ?? {}),
    ...partial
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.launcherWindow]: merged });
  return merged as LauncherWindowState;
}

export async function clearLauncherWindowState(partial?: { preserveBounds?: boolean }) {
  if (!partial?.preserveBounds) {
    await chrome.storage.local.remove(STORAGE_KEYS.launcherWindow);
    return null;
  }

  const current = await getLauncherWindowState();
  if (!current) {
    return null;
  }

  const { left, top, width, height } = current;
  const next: LauncherWindowState = { left, top, width, height };
  await chrome.storage.local.set({ [STORAGE_KEYS.launcherWindow]: next });
  return next;
}

export async function saveSession(partial: SessionPatch) {
  const current = await getSession();
  const merged: AssignmentSessionState = normalizeSessionState({
    ...current,
    ...partial,
    pageState: partial.pageState ? mergePageState(current.pageState, partial.pageState) : current.pageState,
    updatedAt: new Date().toISOString()
  });
  await chrome.storage.local.set({ [STORAGE_KEYS.session]: merged });
  return merged;
}

export async function pushSessionMessages(...messages: AssignmentSessionState['messages']) {
  const session = await getSession();
  return saveSession({
    messages: [...session.messages, ...messages]
  });
}

export async function resetSession(context?: AssignmentSessionState['context']) {
  const next = createDefaultSession();
  if (context) {
    next.context = context;
  }
  const normalized = normalizeSessionState(next);
  await chrome.storage.local.set({ [STORAGE_KEYS.session]: normalized });
  return normalized;
}

export async function getExtensionState(): Promise<ExtensionState> {
  const [settings, session] = await Promise.all([getSettings(), getSession()]);
  return { settings, session };
}

export async function setScanState(scanStatus: ScanStatus, scanError?: string) {
  return saveSession({
    pageState: {
      uiStatus: {
        lifecycle: scanStatus,
        message:
          scanError ||
          (scanStatus === 'idle'
            ? 'No page scan yet.'
            : scanStatus === 'ready'
              ? 'Results are ready.'
              : 'Mako IQ is working on the current page.')
      },
      errors: {
        scan: scanError
      }
    }
  });
}

export async function saveLatestScan(page: ScanPagePayload) {
  const session = await getSession();
  return saveSession({
    pageState: {
      scan: page,
      timestamps: {
        scannedAt: page.scannedAt
      },
      uiStatus: {
        lifecycle: 'scanned',
        message: `Scan captured from ${page.pageTitle}.`,
        lastAction: 'scan'
      },
      errors: {
        scan: undefined
      }
    },
    scannedPages: [page, ...session.scannedPages.filter((existing) => existing.scannedAt !== page.scannedAt)].slice(0, 10)
  });
}

export async function saveWorkflowState(classification: TaskClassification, workflowRoute: WorkflowRoute) {
  return saveSession({
    pageState: {
      classification,
      workflowRoute,
      timestamps: {
        classifiedAt: classification.classifiedAt,
        routedAt: workflowRoute.routedAt
      },
      errors: {
        classification: undefined
      }
    }
  });
}

export async function saveWorkflowExperienceState(workflowState: WorkflowState) {
  return saveSession({
    workflowState
  });
}

export async function savePageState(pageState: PageStatePatch) {
  return saveSession({
    pageState
  });
}
