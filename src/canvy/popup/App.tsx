import { useEffect, useState } from 'react';
import '../shared/app.css';
import { AnalysisResultCard } from '../shared/components/AnalysisResultCard';
import { ActionTile, AppShell, GlassButton, GlassSurface, InlineNotice, MotionProvider, PromptComposer, SectionHeader, StatusPill } from '../shared/components/ui';
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

function getBackendTone(state: string): 'success' | 'warning' | 'danger' | 'accent' {
  switch (state) {
    case 'connected':
      return 'success';
    case 'degraded':
      return 'warning';
    case 'offline':
      return 'danger';
    default:
      return 'accent';
  }
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

function getNoticeTone(value: string) {
  if (/offline|could not|unable|failed|limited|unavailable|no page/i.test(value)) {
    return 'warning' as const;
  }

  return 'success' as const;
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
        : status?.launchSupportMessage || 'Page-aware tools are limited on this tab.') ??
    'Ready';
  const submitDisabled = busy || isRunning || !instructions.trim() || !isSupportedLaunchPage;
  const emptyTitle = isSupportedLaunchPage ? 'Ask about this page' : 'Workspace still available';
  const emptyBody = isSupportedLaunchPage
    ? 'Use the launcher for a fast answer, then move into the workspace when you need more room.'
    : 'This tab is restricted, so page extraction is limited. The workspace can still open normally.';

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
      setNotice(getUiErrorMessage(error, 'Could not cancel the analysis.'));
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
      await chrome.sidePanel.setOptions({
        path: WORKSPACE_PANEL_PATH,
        enabled: true
      });
      await chrome.sidePanel.open({ windowId: currentWindowId });

      setNotice(
        isSupportedLaunchPage
          ? 'Workspace opened.'
          : 'Workspace opened. Page-specific tools are limited on this tab.'
      );
    } catch (error) {
      setNotice(getUiErrorMessage(error, 'Workspace could not open.'));
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
    <MotionProvider>
      <AppShell surface="popup" aria-label="Mako IQ launcher">
        <div className="mako-shell mako-shell--popup">
          <GlassSurface tone="hero">
            <div className="mako-brand-row">
              <div className="mako-brand-mark">
                <span className="mako-brand-mark__dot" aria-hidden="true" />
                <div className="mako-brand-copy">
                  <p className="mako-eyebrow">Mako IQ launcher</p>
                  <h1 className="mako-brand-title">Answer this page fast</h1>
                  <p className="mako-brand-caption">Toolbar click opens here first. Use the workspace only when you want depth.</p>
                </div>
              </div>
              <StatusPill label={formatBackendLabel(backendState)} tone={getBackendTone(backendState)} />
            </div>

            <div className="mako-context-card">
              <div className="mako-context-card__row">
                <p className="mako-context-card__title">{trimText(pageTitle, 96)}</p>
                {pageHost ? <StatusPill label={pageHost} tone="neutral" /> : null}
              </div>
              <p className="mako-context-card__note">{trimText(launcherStatus, 140)}</p>
              <div className="mako-actions-row">
                <GlassButton variant="primary" size="md" onClick={() => void handleOpenWorkspace()} disabled={busy}>
                  Open workspace
                </GlassButton>
                <GlassButton variant="ghost" size="sm" onClick={handleOpenSettings} disabled={busy}>
                  Settings
                </GlassButton>
              </div>
            </div>
          </GlassSurface>

          <GlassSurface tone="elevated">
            <SectionHeader
              eyebrow="Ask"
              title="Ask about this page"
              description={isSupportedLaunchPage ? 'Fast page-aware answer with a real submit action.' : 'Open a standard webpage to ask page-specific questions.'}
            />

            <PromptComposer
              id="mako-launcher-question"
              label="Question"
              rows={4}
              value={instructions}
              onChange={setInstructions}
              onSubmit={handleQuestionSubmit}
              submitLabel={isRunning ? 'Working...' : 'Submit'}
              disabled={submitDisabled}
              placeholder={isSupportedLaunchPage ? 'What matters here? What should I act on?' : 'Page extraction is limited on this tab.'}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  handleQuestionSubmit();
                }
              }}
              footer={
                <>
                  <span>{isSupportedLaunchPage ? 'Shift+Enter for a new line.' : 'Workspace still works on restricted pages.'}</span>
                  <GlassButton variant="ghost" size="sm" onClick={() => void refreshStatus()} disabled={busy || isRunning}>
                    Refresh
                  </GlassButton>
                </>
              }
            />
          </GlassSurface>

          <div className="mako-popup-actions" aria-label="Launcher actions">
            <ActionTile
              title={isRunning ? 'Scanning...' : 'Summarize page'}
              copy="Get the concise answer first."
              kicker="Fast answer"
              tone="accent"
              onClick={() => void startAnalysis('Summarize this page in the clearest possible way.')}
              disabled={busy || !isSupportedLaunchPage || isRunning}
            />
            <ActionTile
              title="Pull key takeaways"
              copy="Turn the page into notes worth keeping."
              kicker="Notes"
              onClick={() => void startAnalysis('Extract the most important takeaways and action items from this page.')}
              disabled={busy || !isSupportedLaunchPage || isRunning}
            />
            <ActionTile
              title="What should I do next?"
              copy="Focus on next steps instead of summary."
              kicker="Actions"
              onClick={() => void startAnalysis('What are the next actions or decisions I should make from this page?')}
              disabled={busy || !isSupportedLaunchPage || isRunning}
            />
            <ActionTile
              title="Open full workspace"
              copy="Move into the side panel for deeper work."
              kicker="Workspace"
              onClick={() => void handleOpenWorkspace()}
              disabled={busy}
            />
          </div>

          {notice ? <InlineNotice tone={getNoticeTone(notice)}>{notice}</InlineNotice> : null}

          <AnalysisResultCard
            analysis={analysis}
            analysisRun={analysisRun}
            compact
            onCancel={isRunning ? () => void handleCancel() : null}
            emptyTitle={emptyTitle}
            emptyBody={emptyBody}
          />
        </div>
      </AppShell>
    </MotionProvider>
  );
}
