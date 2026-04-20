import { useEffect, useMemo, useState } from 'react';
import '../shared/app.css';
import '../content/sidebar.css';
import './panel.css';
import { AnalysisResultCard } from '../shared/components/AnalysisResultCard';
import { STORAGE_KEYS } from '../shared/constants';
import { CollapsibleSection } from './components/CollapsibleSection';
import { sendRuntimeMessage } from '../shared/runtime';
import { getWorkflowActionCards } from '../shared/workflow/buildWorkflowState';
import type {
  ActivePageAnalysisResponse,
  AnalysisChart,
  BootstrapPayload,
  CancelAnalysisResponse,
  CanvyTaskKind,
  PopupStatus,
  ReconnectBackendResponse,
  ScanResponse,
  WorkflowActionId
} from '../shared/types';

interface WorkflowActionResponse {
  ok: boolean;
  message: string;
}

function createRequestId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
}

function trimText(value: string | undefined, maxLength: number) {
  const source = (value ?? '').trim();
  if (!source) {
    return '';
  }

  return source.length > maxLength ? `${source.slice(0, maxLength).trimEnd()}...` : source;
}

function formatTimestamp(value?: string) {
  if (!value) {
    return 'Not available';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function formatBackendLabel(state?: string) {
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

function formatChartSummary(chart: AnalysisChart | null | undefined) {
  if (!chart) {
    return '';
  }

  return [
    `${chart.type.toUpperCase()} | ${chart.title}`,
    chart.labels.length ? `Labels: ${chart.labels.join(', ')}` : '',
    ...chart.datasets.map((dataset) => `${dataset.label}: ${dataset.data.join(', ')}`)
  ]
    .filter(Boolean)
    .join(' | ');
}

function getUiErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function App() {
  const [status, setStatus] = useState<PopupStatus | null>(null);
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [panelState, setPanelState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [selectedActionId, setSelectedActionId] = useState<WorkflowActionId | null>(null);
  const [selectedTask, setSelectedTask] = useState<CanvyTaskKind>('explain_page');
  const [selectedAssignmentId, setSelectedAssignmentId] = useState('');

  async function refresh(reason: string, mode: 'bootstrap' | 'refresh' = 'bootstrap') {
    setPanelState((current) => (current === 'ready' ? 'ready' : 'loading'));

    try {
      const [nextStatus, nextBootstrap] = await Promise.all([
        sendRuntimeMessage<PopupStatus>({ type: 'GET_POPUP_STATUS' }),
        sendRuntimeMessage<BootstrapPayload>({
          type: mode === 'refresh' ? 'CANVY_REFRESH_ACTIVE_PAGE_CONTEXT' : 'CANVY_GET_BOOTSTRAP',
          requestId: reason
        })
      ]);

      setStatus(nextStatus);
      setBootstrap(nextBootstrap);
      setSelectedActionId(nextBootstrap.session.workflowState?.currentAction ?? null);
      setSelectedTask(nextBootstrap.session.workflowState?.selectedTask ?? (nextStatus.assistantMode === 'canvas' ? 'analyze_assignment' : 'explain_page'));
      setPanelState('ready');
    } catch (error) {
      const message = getUiErrorMessage(error, 'Could not load the current page.');
      console.error('[Mako IQ][ui:error]', { surface: 'sidepanel', action: 'refresh-state', detail: message });
      setPanelState('error');
      setNotice(message);
    }
  }

  useEffect(() => {
    void refresh('panel-opened');

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

    const onActivated = () => {
      void refresh('tab-activated');
    };
    const onUpdated = (_tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (tab.active && changeInfo.status === 'complete') {
        void refresh('tab-updated');
      }
    };
    const onFocusChanged = () => {
      void refresh('window-focus-changed');
    };

    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.windows.onFocusChanged.addListener(onFocusChanged);
    chrome.storage.onChanged.addListener(onStorageChanged);

    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.windows.onFocusChanged.removeListener(onFocusChanged);
      chrome.storage.onChanged.removeListener(onStorageChanged);
    };
  }, []);

  useEffect(() => {
    if (!selectedAssignmentId && bootstrap?.session.canvasApiSummary?.upcomingAssignments.length) {
      setSelectedAssignmentId(bootstrap.session.canvasApiSummary.upcomingAssignments[0].id);
    }
  }, [bootstrap?.session.canvasApiSummary, selectedAssignmentId]);

  useEffect(() => {
    const persistedWorkflow = bootstrap?.session.workflowState;
    if (!persistedWorkflow) {
      return;
    }

    setSelectedActionId(persistedWorkflow.currentAction ?? null);

    const nextTask = persistedWorkflow.selectedTask ?? persistedWorkflow.currentActionTask ?? persistedWorkflow.actionCards[0]?.task;
    if (nextTask) {
      setSelectedTask(nextTask);
    }

    if (persistedWorkflow.extraInstructions && persistedWorkflow.extraInstructions !== instructions) {
      setInstructions(persistedWorkflow.extraInstructions);
    }
  }, [bootstrap?.session.workflowState, instructions]);

  const assistantMode = status?.assistantMode === 'canvas' ? 'canvas' : 'general';
  const isUnsupported = Boolean(status && !status.isSupportedLaunchPage);
  const pageState = bootstrap?.session.pageState;
  const analysis = pageState?.analysis ?? bootstrap?.session.lastAnalysis ?? null;
  const analysisRun = bootstrap?.session.analysisRun ?? null;
  const isRunning = Boolean(
    analysisRun &&
      analysisRun.phase !== 'completed' &&
      analysisRun.phase !== 'error' &&
      analysisRun.phase !== 'cancelled'
  );
  const workflowState = bootstrap?.session.workflowState ?? null;
  const actions = workflowState?.actionCards?.length ? workflowState.actionCards : getWorkflowActionCards(workflowState?.currentWorkflow ?? 'general');
  const selectedWorkflowAction =
    actions.find((action) => action.id === selectedActionId) ??
    actions.find((action) => action.task === selectedTask) ??
    actions[0];
  const assignments = bootstrap?.session.canvasApiSummary?.upcomingAssignments ?? [];
  const selectedAssignment = useMemo(
    () => assignments.find((assignment) => assignment.id === selectedAssignmentId) ?? assignments[0],
    [assignments, selectedAssignmentId]
  );
  const backendConnection = bootstrap?.settings.backendConnection ?? bootstrap?.session.backendConnection;
  const backendState = backendConnection?.state ?? 'unknown';
  const motionEnabled = bootstrap?.settings.motionEnabled ?? true;
  const debugMode = bootstrap?.settings.debugMode ?? false;
  const pageTitle = status?.pageTitle ?? pageState?.currentPage.title ?? 'Current page';
  const pageUrl = pageState?.currentPage.url ?? status?.currentUrl ?? '';
  const pagePreview =
    analysis?.extractedPreview ??
    bootstrap?.pageContext?.previewText ??
    pageState?.scan?.readableText ??
    '';
  const chartSummary = formatChartSummary(analysis?.chart ?? null);
  const answerStatus =
    pageState?.errors.analysis ??
    (isRunning
      ? analysisRun?.statusLabel
      : analysis
        ? 'Answer ready'
        : isUnsupported
          ? pageState?.uiStatus.message || 'Workspace opened. Page-specific tools are limited on this tab.'
          : 'Scan the page or ask a quick question.');
  const surfaceLabel =
    assistantMode === 'canvas' ? 'Canvas' : isUnsupported ? 'Limited' : 'Web';
  const supportedDetails = pageState?.errors.analysis ?? pageState?.errors.scan ?? '';
  const lastUpdated = pageState?.timestamps.lastUpdatedAt ?? bootstrap?.session.updatedAt;

  async function handleAnalyzeCurrentPage() {
    setBusy(true);
    setNotice('');

    try {
      const response = await sendRuntimeMessage<ActivePageAnalysisResponse>({
        type: 'CANVY_ANALYZE_ACTIVE_PAGE',
        requestId: createRequestId(),
        instruction: instructions.trim()
      });

      setNotice(response.ok ? '' : response.error ?? 'Could not scan this page.');
    } catch (error) {
      const message = getUiErrorMessage(error, 'Could not scan this page.');
      console.error('[Mako IQ][ui:error]', { surface: 'sidepanel', action: 'analyze', detail: message });
      setNotice(message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRefreshContext() {
    setBusy(true);
    setNotice('');

    try {
      const nextBootstrap = await sendRuntimeMessage<BootstrapPayload>({
        type: 'CANVY_REFRESH_ACTIVE_PAGE_CONTEXT',
        requestId: createRequestId()
      });
      setBootstrap(nextBootstrap);

      const nextStatus = await sendRuntimeMessage<PopupStatus>({ type: 'GET_POPUP_STATUS' });
      setStatus(nextStatus);
    } catch (error) {
      const message = getUiErrorMessage(error, 'Could not refresh this page.');
      console.error('[Mako IQ][ui:error]', { surface: 'sidepanel', action: 'refresh-context', detail: message });
      setNotice(message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCapturePage() {
    setBusy(true);
    setNotice('');

    try {
      const response = await sendRuntimeMessage<ScanResponse>({
        type: 'CANVY_SCAN_ACTIVE_PAGE',
        requestId: createRequestId(),
        sourceType: 'reference'
      });
      setNotice(response.ok ? 'Page context updated.' : response.message);
      await refresh('scan-refresh');
    } catch (error) {
      const message = getUiErrorMessage(error, 'Could not update page context.');
      console.error('[Mako IQ][ui:error]', { surface: 'sidepanel', action: 'scan', detail: message });
      setNotice(message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRunWorkflowAction(actionId: WorkflowActionId, task: CanvyTaskKind) {
    setBusy(true);
    setNotice('');

    try {
      const response = await sendRuntimeMessage<WorkflowActionResponse>({
        type: 'CANVY_START_WORKFLOW_ACTION',
        task,
        actionId,
        assignmentId: selectedAssignment?.id,
        extraInstructions: instructions.trim()
      });

      setSelectedActionId(actionId);
      setSelectedTask(task);
      setNotice(response.message);
      await refresh('workflow-action');
    } catch (error) {
      const message = getUiErrorMessage(error, 'Could not run this action.');
      console.error('[Mako IQ][ui:error]', { surface: 'sidepanel', action: 'workflow-action', detail: message });
      setNotice(message);
    } finally {
      setBusy(false);
    }
  }

  async function handleCancelAnalysis() {
    setBusy(true);

    try {
      const response = await sendRuntimeMessage<CancelAnalysisResponse>({
        type: 'CANVY_CANCEL_ANALYSIS',
        requestId: createRequestId()
      });
      setNotice(response.message);
    } catch (error) {
      const message = getUiErrorMessage(error, 'Could not cancel the scan.');
      console.error('[Mako IQ][ui:error]', { surface: 'sidepanel', action: 'cancel', detail: message });
      setNotice(message);
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdateSetting(patch: Partial<BootstrapPayload['settings']>) {
    setBusy(true);

    try {
      await sendRuntimeMessage({ type: 'CANVY_SAVE_SETTINGS', payload: patch });
      await refresh('settings-update');
    } catch (error) {
      const message = getUiErrorMessage(error, 'Could not save settings.');
      console.error('[Mako IQ][ui:error]', { surface: 'sidepanel', action: 'save-settings', detail: message });
      setNotice(message);
    } finally {
      setBusy(false);
    }
  }

  async function handleReconnectBackend() {
    setBusy(true);

    try {
      const response = await sendRuntimeMessage<ReconnectBackendResponse>({ type: 'CANVY_RECONNECT_BACKEND' });
      setNotice(response.message);
      await refresh('backend-reconnect');
    } catch (error) {
      const message = getUiErrorMessage(error, 'Could not reconnect to the backend.');
      console.error('[Mako IQ][ui:error]', { surface: 'sidepanel', action: 'reconnect-backend', detail: message });
      setNotice(message);
    } finally {
      setBusy(false);
    }
  }

  function handleOpenOptions() {
    void chrome.runtime.openOptionsPage();
  }

  if (panelState === 'loading' && !bootstrap) {
    return (
      <main className={`canvy-panel-page ${motionEnabled ? '' : 'canvy-panel-page-no-motion'}`}>
        <aside className="canvy-shell canvy-panel-shell" aria-label="Mako IQ sidebar">
          <header className="canvy-header canvy-panel-workspace-header">
            <div>
              <div className="canvy-brand-mark">Mako IQ</div>
              <h2>Loading current page</h2>
              <p>Preparing the sidebar workspace.</p>
            </div>
          </header>
          <section className="canvy-card">
            <div className="canvy-loading-bar" />
          </section>
        </aside>
      </main>
    );
  }

  return (
    <main className={`canvy-panel-page ${motionEnabled ? '' : 'canvy-panel-page-no-motion'}`}>
      <aside className="canvy-shell canvy-panel-shell" aria-label="Mako IQ sidebar">
        <header className="canvy-header canvy-panel-workspace-header">
          <div>
            <div className="canvy-brand-mark">Mako IQ</div>
            <h2>{trimText(pageTitle, 92) || 'Current page'}</h2>
            <p>{trimText(answerStatus, 150)}</p>
          </div>
          <div className="canvy-panel-header-actions">
            <span className={`canvy-status-pill ${assistantMode === 'canvas' ? 'canvy-status-pill-canvas' : 'canvy-status-pill-general'}`}>
              {surfaceLabel}
            </span>
            <span className="canvy-status-pill canvy-panel-backend-pill">{formatBackendLabel(backendState)}</span>
          </div>
        </header>

        {notice ? <div className={notice.toLowerCase().includes('could not') ? 'canvy-inline-warning' : 'canvy-banner'}>{notice}</div> : null}
        {!notice && supportedDetails ? <div className="canvy-inline-warning">{supportedDetails}</div> : null}

        <section className="canvy-card canvy-panel-composer-card">
          <div className="canvy-card-head">
            <div>
              <div className="canvy-eyebrow">Quick actions</div>
              <h3>Ask or scan</h3>
            </div>
            <button className="canvy-secondary" type="button" onClick={() => void handleRefreshContext()} disabled={busy || isRunning}>
              Refresh
            </button>
          </div>

          <textarea
            className="canvy-textarea canvy-panel-question-box"
            rows={3}
            placeholder="Ask a quick question about this page"
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
          />

          <div className="canvy-action-row canvy-panel-primary-actions">
            <button
              className="canvy-primary canvy-panel-main-button"
              type="button"
              onClick={() => void handleAnalyzeCurrentPage()}
              disabled={busy || !status?.isSupportedLaunchPage || isRunning}
            >
              {isRunning ? 'Scanning...' : instructions.trim() ? 'Ask page' : 'Scan page'}
            </button>
            {isRunning ? (
              <button className="canvy-secondary" type="button" onClick={() => void handleCancelAnalysis()} disabled={busy}>
                Cancel
              </button>
            ) : null}
          </div>

          {actions.length ? (
            <div className="canvy-panel-workflow-row">
              {actions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className={`canvy-workflow-action canvy-panel-workflow-action ${action.id === selectedWorkflowAction?.id ? 'canvy-workflow-action-active' : ''}`}
                  onClick={() => void handleRunWorkflowAction(action.id, action.task)}
                  disabled={busy}
                  aria-describedby={`workflow-action-${action.id}-hint`}
                >
                  <span className="canvy-panel-action-label">{action.label}</span>
                  <span className="canvy-panel-action-info" aria-hidden="true">
                    i
                  </span>
                  <span
                    className="canvy-panel-action-tooltip"
                    id={`workflow-action-${action.id}-hint`}
                    role="tooltip"
                  >
                    {action.description}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </section>

        <AnalysisResultCard
          analysis={analysis}
          analysisRun={analysisRun}
          onCancel={isRunning ? () => void handleCancelAnalysis() : null}
          emptyTitle="Ready"
          emptyBody={isUnsupported ? 'Workspace opened. Page-specific tools are limited on this tab.' : 'Scan the page or ask a short question.'}
        />

        <div className="canvy-panel-accordion-stack">
          <CollapsibleSection title="Page details" subtitle={trimText(pageUrl.replace(/^https?:\/\//i, ''), 54) || 'Current tab'}>
            <div className="canvy-panel-mini-grid">
              <div className="canvy-panel-mini-card">
                <span className="canvy-eyebrow">Updated</span>
                <strong>{formatTimestamp(lastUpdated)}</strong>
              </div>
              <div className="canvy-panel-mini-card">
                <span className="canvy-eyebrow">Mode</span>
                <strong>{surfaceLabel}</strong>
              </div>
            </div>
            {pagePreview ? <div className="canvy-copy-block canvy-panel-detail-copy">{trimText(pagePreview, 1200)}</div> : <p className="canvy-muted">No readable preview is available yet.</p>}
          </CollapsibleSection>

          <CollapsibleSection title="Supporting details" subtitle="Optional context and follow-up">
            {analysis?.actions.length ? (
              <>
                <div className="canvy-eyebrow">Next step</div>
                <p className="canvy-muted canvy-panel-detail-copy">{analysis.actions[0]}</p>
              </>
            ) : null}
            {workflowState?.promptExtraction?.promptText ? (
              <>
                <div className="canvy-eyebrow">Detected prompt</div>
                <div className="canvy-copy-block canvy-panel-detail-copy">{trimText(workflowState.promptExtraction.promptText, 500)}</div>
              </>
            ) : null}
            {chartSummary ? (
              <>
                <div className="canvy-eyebrow">Chart</div>
                <div className="canvy-copy-block canvy-panel-detail-copy">{chartSummary}</div>
              </>
            ) : null}
            {!analysis?.actions.length && !workflowState?.promptExtraction?.promptText && !chartSummary ? (
              <p className="canvy-muted">The answer above is the main workspace output. Extra details will appear here only when they add value.</p>
            ) : null}
          </CollapsibleSection>

          {assignments.length ? (
            <CollapsibleSection title="Canvas items" subtitle={`${assignments.length} item(s)`}>
              <div className="canvy-assignment-list">
                {assignments.map((assignment) => (
                  <button
                    key={assignment.id}
                    type="button"
                    className={`canvy-assignment-card ${assignment.id === selectedAssignment?.id ? 'canvy-assignment-card-selected' : ''}`}
                    onClick={() => setSelectedAssignmentId(assignment.id)}
                  >
                    <strong>{assignment.title}</strong>
                    <span>{trimText([assignment.courseName, assignment.dueAt].filter(Boolean).join(' | '), 90) || 'Canvas item'}</span>
                  </button>
                ))}
              </div>
            </CollapsibleSection>
          ) : null}

          <CollapsibleSection title="Utilities" subtitle={`${formatBackendLabel(backendState)} backend`}>
            <div className="canvy-panel-settings-list">
              <label className="canvy-panel-toggle">
                <span>Motion</span>
                <input
                  type="checkbox"
                  checked={motionEnabled}
                  onChange={(event) => void handleUpdateSetting({ motionEnabled: event.target.checked })}
                />
              </label>
              <label className="canvy-panel-toggle">
                <span>Debug mode</span>
                <input
                  type="checkbox"
                  checked={debugMode}
                  onChange={(event) => void handleUpdateSetting({ debugMode: event.target.checked })}
                />
              </label>
            </div>

            <div className="canvy-action-row">
              <button className="canvy-secondary" type="button" onClick={() => void handleCapturePage()} disabled={busy}>
                Capture page
              </button>
              <button className="canvy-secondary" type="button" onClick={() => void handleReconnectBackend()} disabled={busy}>
                Reconnect
              </button>
              <button className="canvy-secondary" type="button" onClick={handleOpenOptions}>
                Settings
              </button>
            </div>

            {backendConnection?.lastError ? <div className="canvy-inline-warning">{backendConnection.lastError}</div> : null}
          </CollapsibleSection>
        </div>
      </aside>
    </main>
  );
}
