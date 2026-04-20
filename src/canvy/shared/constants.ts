import { DEFAULT_API_BASE_URL } from './config';
import type { ApiBaseUrlSource, AssignmentSessionState, CanvySettings, OverlayUiState, PageStateSnapshot, SessionMessage } from './types';

export const STORAGE_KEYS = {
  settings: 'makoiq.settings',
  session: 'makoiq.session',
  launcherWindow: 'makoiq.launcherWindow',
  overlayUi: 'makoiq.overlayUi'
} as const;

export const LEGACY_STORAGE_KEYS = {
  settings: 'canvy.settings',
  session: 'canvy.session'
} as const;

export const CANVY_ACCENT = '#2d7ff9';

export function createMessage(
  role: SessionMessage['role'],
  kind: SessionMessage['kind'],
  text: string
): SessionMessage {
  return {
    id: crypto.randomUUID(),
    role,
    kind,
    text,
    createdAt: new Date().toISOString()
  };
}

export function createDefaultSettings(apiBaseUrl = DEFAULT_API_BASE_URL, apiBaseUrlSource: ApiBaseUrlSource = 'default'): CanvySettings {
  const now = new Date().toISOString();
  return {
    apiBaseUrl,
    apiBaseUrlSource,
    configured: false,
    toneConsentGranted: false,
    backendConnection: {
      state: 'unknown',
      checkedAt: now
    },
    debugMode: false,
    motionEnabled: true
  };
}

export function createDefaultOverlayUiState(): OverlayUiState {
  return {
    left: 24,
    top: 24,
    width: 392,
    height: 396,
    collapsed: false
  };
}

export function createDefaultPageState(): PageStateSnapshot {
  const now = new Date().toISOString();

  return {
    currentPage: {
      assistantMode: 'general',
      platform: 'unknown'
    },
    uiStatus: {
      lifecycle: 'idle',
      message: 'No page scan yet.',
      lastAction: 'bootstrap'
    },
    timestamps: {
      lastUpdatedAt: now
    },
    errors: {}
  };
}

export function createDefaultSession(): AssignmentSessionState {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    assistantMode: 'general',
    backendConnection: {
      state: 'unknown',
      checkedAt: now
    },
    overlayStatus: {
      state: 'idle',
      message: 'Overlay has not been shown yet.',
      updatedAt: now
    },
    analysisCache: [],
    analysisRun: undefined,
    requestDiagnostics: [],
    pageState: createDefaultPageState(),
    scanStatus: 'idle',
    scannedPages: [],
    messages: [
      createMessage(
        'assistant',
        'status',
        "You're using Mako IQ. Scan the current page here, or open the sidebar when you need more room."
      )
    ],
    lastAnalysis: undefined,
    updatedAt: now
  };
}
