import { useEffect, useMemo, useState } from 'react';
import '../shared/app.css';
import {
  AppIcon,
  AppShell,
  GlassButton,
  GlassIconButton,
  GlassPanel,
  GlassToolbar,
  GhostButton,
  Icon,
  InlineNotice,
  MotionProvider,
  SectionHeader,
  StatusPill,
  ToggleRow,
  WorkspaceShell
} from '../shared/components/ui';
import { STORAGE_KEYS } from '../shared/constants';
import { sendRuntimeMessage } from '../shared/runtime';
import type { BootstrapPayload, PopupStatus, ScreenAnalyzeActionResponse } from '../shared/types';

const WORKSPACE_PANEL_PATH = 'sidepanel.html';

function createRequestId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
}

function trimText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1).trimEnd()}...` : value;
}

function extractHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function getUiErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function getNoticeTone(value: string) {
  if (/offline|could not|couldn|unable|failed|limited|unavailable|no clear|restricted/i.test(value)) {
    return 'warning' as const;
  }

  return 'success' as const;
}

export function App() {
  const [status, setStatus] = useState<PopupStatus | null>(null);
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<'open_assistant' | 'scan' | 'clear' | 'workspace' | 'quiz_mode' | null>(null);

  useEffect(() => {
    let mounted = true;

    if (chrome.sidePanel?.setOptions) {
      void chrome.sidePanel
        .setOptions({
          path: WORKSPACE_PANEL_PATH,
          enabled: true
        })
        .catch((error) => {
          console.warn('[Mako IQ launcher] Could not preconfigure side panel.', error);
        });
    }

    async function hydrate() {
      try {
        const [nextStatus, nextBootstrap] = await Promise.all([
          sendRuntimeMessage<PopupStatus>({ type: 'GET_POPUP_STATUS' }),
          sendRuntimeMessage<BootstrapPayload>({
            type: 'CANVY_GET_BOOTSTRAP',
            requestId: 'launcher-opened'
          })
        ]);

        if (!mounted) {
          return;
        }

        setStatus(nextStatus);
        setBootstrap(nextBootstrap);
      } catch (error) {
        if (!mounted) {
          return;
        }

        console.error('[Mako IQ launcher] Failed to inspect launcher state.', error);
        setNotice('Could not inspect the current screen.');
      }
    }

    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: chrome.storage.AreaName
    ) => {
      if (areaName !== 'local') {
        return;
      }

      const sessionChange = changes[STORAGE_KEYS.session];
      const settingsChange = changes[STORAGE_KEYS.settings];

      if (!sessionChange && !settingsChange) {
        return;
      }

      setBootstrap((current) => {
        if (!current) {
          return current;
        }

        return {
          ...current,
          settings: (settingsChange?.newValue ?? current.settings) as BootstrapPayload['settings'],
          session: (sessionChange?.newValue ?? current.session) as BootstrapPayload['session']
        };
      });
    };

    void hydrate();
    chrome.storage.onChanged.addListener(onStorageChanged);

    return () => {
      mounted = false;
      chrome.storage.onChanged.removeListener(onStorageChanged);
    };
  }, []);

  const backendState = bootstrap?.settings.backendConnection?.state ?? 'unknown';
  const pageTitle = status?.pageTitle ?? 'Current page';
  const pageUrl = status?.currentUrl ?? '';
  const pageHost = extractHost(pageUrl);
  const motionEnabled = bootstrap?.settings.motionEnabled ?? true;
  const quizModeEnabled = bootstrap?.settings.quizModeEnabled ?? false;
  const statusPill = useMemo(() => {
    if (busy) {
      return {
        label: 'Analyzing',
        tone: 'accent' as const
      };
    }

    if (backendState === 'offline' || backendState === 'degraded') {
      return {
        label: 'AI Offline',
        tone: 'warning' as const
      };
    }

    return {
      label: 'Ready',
      tone: 'success' as const
    };
  }, [backendState, busy]);

  async function refreshStatus() {
    const nextStatus = await sendRuntimeMessage<PopupStatus>({ type: 'GET_POPUP_STATUS' });
    setStatus(nextStatus);
  }

  async function handleOpenAssistant(autoScan = false) {
    setBusy(true);
    setBusyAction(autoScan ? 'scan' : 'open_assistant');
    setNotice(autoScan ? 'Scanning page...' : 'Opening assistant...');

    try {
      const response = await sendRuntimeMessage<ScreenAnalyzeActionResponse>({
        type: autoScan ? 'OPEN_ASSISTANT_PANEL_AND_SCAN' : 'OPEN_ASSISTANT_PANEL',
        requestId: createRequestId(),
        autoScan
      });

      if (!response.ok) {
        setNotice(response.error ?? response.message ?? 'Mako IQ could not open the assistant.');
        return;
      }

      setNotice(response.message || 'Assistant opened.');
      await refreshStatus();
    } catch (error) {
      setNotice(getUiErrorMessage(error, 'Mako IQ could not open the assistant on this page.'));
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }

  async function handleClearBubbles() {
    setBusy(true);
    setBusyAction('clear');
    setNotice('');

    try {
      const response = await sendRuntimeMessage<ScreenAnalyzeActionResponse>({
        type: 'CLEAR_ANSWER_BUBBLES',
        requestId: createRequestId()
      });
      setNotice(response.message);
    } catch (error) {
      setNotice(getUiErrorMessage(error, 'Mako IQ could not clear bubbles on this page.'));
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }

  async function handleOpenWorkspace() {
    setBusy(true);
    setBusyAction('workspace');
    setNotice('');

    const fallbackToAssistant = async (detail?: string) => {
      console.warn('[Mako IQ launcher] Workspace open failed; opening assistant fallback.', {
        detail
      });
      setNotice("Couldn't open workspace. Opening assistant panel instead.");

      try {
        const response = await sendRuntimeMessage<ScreenAnalyzeActionResponse>({
          type: 'OPEN_ASSISTANT_PANEL',
          requestId: createRequestId()
        });

        if (!response.ok) {
          setNotice(
            `Couldn't open workspace. Opening assistant panel instead. ${response.error ?? response.message ?? ''}`.trim()
          );
        }
      } catch (error) {
        setNotice(getUiErrorMessage(error, "Couldn't open workspace. Opening assistant panel instead."));
      }
    };

    try {
      if (!chrome.sidePanel?.open) {
        await fallbackToAssistant('chrome.sidePanel.open is unavailable');
        return;
      }

      const currentWindowId = status?.windowId;
      if (typeof currentWindowId !== 'number') {
        await fallbackToAssistant('No active browser window id was available at click time.');
        return;
      }

      await chrome.sidePanel.open({ windowId: currentWindowId });
      setNotice('Workspace opened.');
    } catch (error) {
      const detail = getUiErrorMessage(error, 'Chrome blocked the side panel request.');
      await fallbackToAssistant(detail);
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }

  async function handleToggleQuizMode(checked: boolean) {
    setBusy(true);
    setBusyAction('quiz_mode');
    setNotice(checked ? 'Turning on Quiz Mode...' : 'Turning off Quiz Mode...');

    try {
      const settings = await sendRuntimeMessage<BootstrapPayload['settings']>({
        type: 'CANVY_SAVE_SETTINGS',
        payload: {
          quizModeEnabled: checked
        }
      });
      setBootstrap((current) => (current ? { ...current, settings } : current));
      setNotice(
        checked
          ? 'Quiz Mode is watching this page for question changes.'
          : 'Quiz Mode is off. Manual Scan Page still works.'
      );
    } catch (error) {
      setNotice(getUiErrorMessage(error, 'Could not update Quiz Mode.'));
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }

  function handleOpenSettings() {
    void chrome.runtime.openOptionsPage();
  }

  return (
    <MotionProvider>
      <AppShell
        surface="popup"
        animated={motionEnabled}
        className={motionEnabled ? undefined : 'mako-app--no-motion'}
        aria-label="Mako IQ screen assistant"
      >
        <WorkspaceShell surface="popup" className="mako-launcher-shell">
          <GlassToolbar className="mako-launcher-toolbar">
            <div className="mako-brand-row">
              <div className="mako-brand-mark">
                <AppIcon size={36} />
                <div className="mako-brand-copy">
                  <p className="mako-eyebrow">Mako IQ</p>
                  <h1 className="mako-brand-title mako-brand-title--launcher">Floating Popup</h1>
                  <p className="mako-brand-caption">Open the compact Screen Assistant or jump back to the Workspace sidebar.</p>
                </div>
              </div>

              <div className="mako-chip-row">
                <StatusPill label={statusPill.label} tone={statusPill.tone} />
              </div>
            </div>
          </GlassToolbar>

          <GlassPanel tone="hero" className="mako-launcher-hero">
            <SectionHeader
              eyebrow="Ask about screen"
              title="Open the floating Screen Assistant"
              description="Launch the draggable compact popup in this tab, then scan or rescan without coming back here."
              meta={pageHost ? <StatusPill label={pageHost} tone="neutral" icon={<Icon name="page" size={14} />} /> : undefined}
            />

            <GlassButton
              variant="primary"
              size="lg"
              leadingIcon={<Icon name="scan" size={16} />}
              onClick={() => void handleOpenAssistant()}
              disabled={busy}
              loading={busyAction === 'open_assistant'}
            >
              {busyAction === 'open_assistant' ? 'Opening...' : 'Open Floating Popup'}
            </GlassButton>

            <div className="mako-launcher-actions mako-launcher-actions--secondary" aria-label="Screen assistant actions">
              <button
                type="button"
                className="mako-quick-action mako-quick-action--primary"
                onClick={() => void handleOpenAssistant(true)}
                disabled={busy}
              >
                <span className="mako-quick-action__icon">
                  <Icon name="scan" size={16} />
                </span>
                <span className="mako-quick-action__copy">
                  <strong>Open Popup + Scan</strong>
                  <span>{busyAction === 'scan' ? 'Scanning...' : 'Launch panel and analyze'}</span>
                </span>
              </button>

              <button
                type="button"
                className="mako-quick-action"
                onClick={() => void handleClearBubbles()}
                disabled={busy}
              >
                <span className="mako-quick-action__icon">
                  <Icon name="close" size={16} />
                </span>
                <span className="mako-quick-action__copy">
                  <strong>Clear Bubbles</strong>
                  <span>Remove screen answers</span>
                </span>
              </button>

              <button
                type="button"
                className="mako-quick-action"
                onClick={() => void handleOpenWorkspace()}
                disabled={busy}
              >
                <span className="mako-quick-action__icon">
                  <Icon name="workspace" size={16} />
                </span>
                <span className="mako-quick-action__copy">
                  <strong>Open Workspace</strong>
                  <span>Open the sidebar</span>
                </span>
              </button>
            </div>

            <div className="mako-mini-grid mako-mini-grid--compact" aria-label="Current screen summary">
              <div className="mako-mini-card mako-mini-card--compact">
                <span className="mako-eyebrow">Screen Context</span>
                <strong>{trimText(pageTitle, 72) || 'Current tab'}</strong>
              </div>
              <div className="mako-mini-card mako-mini-card--compact">
                <span className="mako-eyebrow">Output</span>
                <strong>Answer Bubbles</strong>
              </div>
              <div className="mako-mini-card mako-mini-card--compact">
                <span className="mako-eyebrow">Mode</span>
                <strong>Questions</strong>
              </div>
            </div>

            <ToggleRow
              title="Quiz Mode"
              description="Quiz Mode needs access to this page to detect questions and show study assistance."
              checked={quizModeEnabled}
              onChange={(checked) => void handleToggleQuizMode(checked)}
            />
          </GlassPanel>

          {notice ? <InlineNotice tone={getNoticeTone(notice)}>{notice}</InlineNotice> : null}

          <div className="mako-chip-row">
            <GhostButton
              size="sm"
              leadingIcon={<Icon name="refresh" size={14} />}
              onClick={() => void refreshStatus()}
              disabled={busy}
            >
              Refresh
            </GhostButton>
            <GlassIconButton
              icon={<Icon name="settings" size={15} />}
              label="Open settings"
              onClick={handleOpenSettings}
              disabled={busy}
            />
          </div>
        </WorkspaceShell>
      </AppShell>
    </MotionProvider>
  );
}
