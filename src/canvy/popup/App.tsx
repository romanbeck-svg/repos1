import { useEffect, useState } from 'react';
import '../shared/app.css';
import { AnalysisResultCard } from '../shared/components/AnalysisResultCard';
import { STORAGE_KEYS } from '../shared/constants';
import { sendRuntimeMessage } from '../shared/runtime';
import type {
  BootstrapPayload,
  CancelAnalysisResponse,
  PopupStatus,
  StartAnalysisResponse
} from '../shared/types';

const WORKSPACE_PANEL_PATH = 'sidepanel.html';

function createRequestId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
}

function trimText(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1).trimEnd()}...` : value;
}

function formatBackendLabel(state: string) {
  switch (state) {
    case 'connected':
      return 'Ready';
    case 'degraded':
      return 'Retrying';
    case 'offline':
      return 'Offline';
    default:
      return 'Checking';
  }
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

function isWarningNotice(value: string) {
  return /could not|unable|offline|limited|failed|unavailable|no page/i.test(value);
}

export function App() {
  const [status, setStatus] = useState<PopupStatus | null>(null);
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [instructions, setInstructions] = useState('');

  useEffect(() => {
    let mounted = true;

    async function hydrate() {
      try {
        const [nextStatus, nextBootstrap] = await Promise.all([
          sendRuntimeMessage<PopupStatus>({ type: 'GET_POPUP_STATUS' }),
          sendRuntimeMessage<BootstrapPayload>({ type: 'CANVY_GET_BOOTSTRAP', requestId: 'launcher-opened' })
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

        console.error('[Mako IQ launcher] Failed to bootstrap launcher state.', error);
        setNotice('Could not inspect the current page.');
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

        const nextSession = (sessionChange?.newValue ?? current.session) as BootstrapPayload['session'];
        const nextSettings = (settingsChange?.newValue ?? current.settings) as BootstrapPayload['settings'];

        return {
          ...current,
          settings: nextSettings,
          session: nextSession,
          assistantMode: nextSession.assistantMode ?? current.assistantMode,
          pageContext: nextSession.pageContext ?? current.pageContext,
          context: nextSession.context ?? current.context
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

  const pageState = bootstrap?.session.pageState;
  const analysisRun = bootstrap?.session.analysisRun ?? null;
  const analysis = pageState?.analysis ?? bootstrap?.session.lastAnalysis ?? null;
  const backendState = bootstrap?.settings.backendConnection?.state ?? 'unknown';
  const currentPage = pageState?.currentPage;
  const pageTitle = currentPage?.title ?? status?.pageTitle ?? 'Current page';
  const pageUrl = currentPage?.url ?? status?.currentUrl ?? '';
  const pageHost = extractHost(pageUrl);
  const isSupportedLaunchPage = status?.isSupportedLaunchPage ?? false;
  const isRunning = Boolean(
    analysisRun &&
      analysisRun.phase !== 'completed' &&
      analysisRun.phase !== 'error' &&
      analysisRun.phase !== 'cancelled'
  );
  const launcherStatus =
    pageState?.errors.analysis ??
    pageState?.uiStatus.message ??
    (isRunning
      ? analysisRun?.statusLabel
      : isSupportedLaunchPage
        ? pageHost
          ? `Ready for ${pageHost}`
          : 'Ready for this page'
        : status?.launchSupportMessage || 'Page tools are limited on this tab.') ??
    'Ready';
  const submitDisabled = busy || isRunning || !instructions.trim() || !isSupportedLaunchPage;
  const emptyTitle = isSupportedLaunchPage ? 'No answer yet' : 'Workspace is ready';
  const emptyBody = isSupportedLaunchPage
    ? 'Ask a specific question or run a quick page analysis to see a concise answer here.'
    : 'This tab does not expose page tools, but the launcher and workspace are still available.';

  async function refreshStatus() {
    setBusy(true);
    setNotice('');

    try {
      const [nextStatus, nextBootstrap] = await Promise.all([
        sendRuntimeMessage<PopupStatus>({ type: 'GET_POPUP_STATUS' }),
        sendRuntimeMessage<BootstrapPayload>({ type: 'CANVY_REFRESH_ACTIVE_PAGE_CONTEXT', requestId: 'launcher-refresh' })
      ]);

      setStatus(nextStatus);
      setBootstrap(nextBootstrap);
    } catch (error) {
      const message = getUiErrorMessage(error, 'Could not refresh this page.');
      console.error('[Mako IQ][ui:error]', { surface: 'launcher', action: 'refresh', detail: message });
      setNotice(message);
    } finally {
      setBusy(false);
    }
  }

  async function startAnalysis(instruction: string) {
    setBusy(true);
    setNotice('');

    try {
      const response = await sendRuntimeMessage<StartAnalysisResponse>({
        type: 'CANVY_START_ANALYSIS_RUN',
        requestId: createRequestId(),
        instruction
      });

      if (!response.ok) {
        setNotice(response.error ?? response.message ?? 'Could not start the analysis.');
      }
    } catch (error) {
      const message = getUiErrorMessage(error, 'Could not start the analysis.');
      console.error('[Mako IQ][ui:error]', { surface: 'launcher', action: 'analyze', detail: message });
      setNotice(message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    setBusy(true);

    try {
      const response = await sendRuntimeMessage<CancelAnalysisResponse>({
        type: 'CANVY_CANCEL_ANALYSIS',
        requestId: createRequestId()
      });
      setNotice(response.message);
    } catch (error) {
      const message = getUiErrorMessage(error, 'Could not cancel the analysis.');
      console.error('[Mako IQ][ui:error]', { surface: 'launcher', action: 'cancel', detail: message });
      setNotice(message);
    } finally {
      setBusy(false);
    }
  }

  async function resolvePageWindowId() {
    if (typeof status?.windowId === 'number') {
      return status.windowId;
    }

    const nextStatus = await sendRuntimeMessage<PopupStatus>({ type: 'GET_POPUP_STATUS' });
    setStatus(nextStatus);

    if (typeof nextStatus.windowId !== 'number') {
      throw new Error('Could not find the current browser window.');
    }

    return nextStatus.windowId;
  }

  async function handleOpenWorkspace() {
    setBusy(true);
    setNotice('');

    try {
      const currentWindowId = await resolvePageWindowId();

      console.info('[Mako IQ][workspace:open:start]', {
        surface: 'launcher',
        windowId: currentWindowId,
        currentUrl: pageUrl,
        supported: isSupportedLaunchPage
      });

      await chrome.sidePanel.setOptions({
        path: WORKSPACE_PANEL_PATH,
        enabled: true
      });
      await chrome.sidePanel.open({ windowId: currentWindowId });

      const openedMessage = isSupportedLaunchPage
        ? 'Workspace opened.'
        : 'Workspace opened. Page-specific tools are limited on this tab.';
      console.info('[Mako IQ][workspace:open:ok]', {
        surface: 'launcher',
        windowId: currentWindowId,
        currentUrl: pageUrl,
        supported: isSupportedLaunchPage
      });
      setNotice(openedMessage);
    } catch (error) {
      const message = getUiErrorMessage(error, 'Workspace could not open.');
      console.error('[Mako IQ][workspace:open:error]', {
        surface: 'launcher',
        currentUrl: pageUrl,
        detail: message
      });
      console.error('[Mako IQ][ui:error]', { surface: 'launcher', action: 'open-workspace', detail: message });
      setNotice(message);
    } finally {
      setBusy(false);
    }
  }

  function handleOpenSettings() {
    void chrome.runtime.openOptionsPage();
  }

  function handleQuestionSubmit() {
    if (submitDisabled) {
      if (!instructions.trim()) {
        setNotice('Add a question first.');
      }
      return;
    }

    void startAnalysis(instructions.trim());
  }

  return (
    <main className="canvy-popup-page" aria-label="Mako IQ launcher window">
      <section className="canvy-popup-shell canvy-popup-shell-window">
        <header className="canvy-popup-header">
          <div className="canvy-popup-brand-block">
            <div className="canvy-popup-brand-mark">Mako IQ</div>
            <h1>Ask about this page</h1>
            <p className="canvy-popup-subtitle">Movable page launcher with quick analysis and workspace handoff.</p>
          </div>
          <span className={`canvy-popup-badge canvy-popup-badge-${backendState}`}>{formatBackendLabel(backendState)}</span>
        </header>

        <section className="canvy-popup-status-card" aria-label="Current page">
          <p className="canvy-popup-status-title">{trimText(pageTitle, 96)}</p>
          <p className="canvy-popup-status-note">{trimText(launcherStatus, 140)}</p>
        </section>

        <section className="canvy-popup-ask-card">
          <label className="canvy-popup-field" htmlFor="mako-launcher-question">
            <span className="canvy-popup-field-label">Ask about this page</span>
            <textarea
              id="mako-launcher-question"
              className="canvy-popup-input canvy-popup-input-large"
              rows={4}
              placeholder={
                isSupportedLaunchPage
                  ? 'Ask something specific about this page...'
                  : 'Open a normal webpage to ask page-specific questions.'
              }
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  handleQuestionSubmit();
                }
              }}
            />
          </label>
          <button
            className="canvy-popup-submit"
            type="button"
            onClick={handleQuestionSubmit}
            disabled={submitDisabled}
          >
            {isRunning ? 'Working...' : 'Submit'}
          </button>
        </section>

        <div className="canvy-popup-action-grid" aria-label="Launcher actions">
          <button
            className="canvy-popup-action canvy-popup-action-primary"
            type="button"
            onClick={() => void startAnalysis('')}
            disabled={busy || !isSupportedLaunchPage || isRunning}
          >
            <span className="canvy-popup-action-title">{isRunning ? 'Scanning...' : 'Analyze This Page'}</span>
            <span className="canvy-popup-action-copy">Concise answer from the current page.</span>
          </button>
          <button className="canvy-popup-action" type="button" onClick={() => void handleOpenWorkspace()} disabled={busy}>
            <span className="canvy-popup-action-title">Open Workspace</span>
            <span className="canvy-popup-action-copy">Move into the persistent side panel.</span>
          </button>
          <button className="canvy-popup-action" type="button" onClick={handleOpenSettings} disabled={busy}>
            <span className="canvy-popup-action-title">Settings</span>
            <span className="canvy-popup-action-copy">API, motion, and connection controls.</span>
          </button>
        </div>

        {notice ? (
          <div className={isWarningNotice(notice) ? 'canvy-popup-notice canvy-popup-notice-warning' : 'canvy-popup-notice'}>
            {notice}
          </div>
        ) : null}

        <AnalysisResultCard
          analysis={analysis}
          analysisRun={analysisRun}
          compact
          onCancel={isRunning ? () => void handleCancel() : null}
          emptyTitle={emptyTitle}
          emptyBody={emptyBody}
        />

        <footer className="canvy-popup-footer">
          <div className="canvy-popup-footer-actions">
            <button className="canvy-popup-link" type="button" onClick={() => void refreshStatus()} disabled={busy || isRunning}>
              Refresh
            </button>
            {isRunning ? (
              <button className="canvy-popup-link" type="button" onClick={() => void handleCancel()} disabled={busy}>
                Cancel
              </button>
            ) : null}
          </div>
          {pageHost ? <span className="canvy-popup-footer-meta">{trimText(pageHost, 40)}</span> : null}
        </footer>
      </section>
    </main>
  );
}
