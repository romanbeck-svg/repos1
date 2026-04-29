import { useEffect, useState } from 'react';
import '../shared/app.css';
import { AnalysisResultCard } from '../shared/components/AnalysisResultCard';
import {
  ActionTile,
  AppIcon,
  AppShell,
  FollowUpComposer,
  GhostButton,
  GlassButton,
  GlassPanel,
  GlassToolbar,
  Icon,
  InlineNotice,
  MotionProvider,
  SectionHeader,
  SkeletonSurface,
  StatTile,
  StatusPill,
  SuggestedNotesCard,
  ToggleRow,
  WorkspaceActionGroup,
  WorkspaceShell
} from '../shared/components/ui';
import { STORAGE_KEYS } from '../shared/constants';
import { usePersistentDraft } from '../shared/hooks/usePersistentDraft';
import { sendRuntimeMessage } from '../shared/runtime';
import { getWorkflowActionCards } from '../shared/workflow/buildWorkflowState';
import type {
  ActivePageAnalysisResponse,
  AnalysisChart,
  BootstrapPayload,
  CancelAnalysisResponse,
  PopupStatus,
  ReconnectBackendResponse,
  ScanResponse,
  ScreenAnalyzeActionResponse,
  WorkflowActionId
} from '../shared/types';

const WORKSPACE_DRAFT_KEY = 'makoiq.workspaceDraft';

interface WorkflowActionResponse {
  ok: boolean;
  message: string;
}

function createRequestId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
}

function trimText(value: string | undefined, maxLength: number) {
  const source = (value ?? '').trim();
  if (!source) {
    return '';
  }

  return source.length > maxLength ? `${source.slice(0, maxLength).trimEnd()}...` : source;
}

function extractHost(url: string | undefined) {
  try {
    return new URL(url ?? '').hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
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
      return 'Backend ready';
    case 'degraded':
      return 'Backend retrying';
    case 'offline':
      return 'Backend offline';
    default:
      return 'Checking backend';
  }
}

function getBackendTone(state?: string): 'success' | 'warning' | 'danger' | 'accent' {
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

function getNoticeTone(message: string): 'warning' | 'success' {
  return /offline|could not|unable|failed|limited|unavailable|error/i.test(message)
    ? 'warning'
    : 'success';
}

function formatChartSummary(chart: AnalysisChart | null | undefined) {
  if (!chart) {
    return '';
  }

  return [
    `${chart.type.toUpperCase()} chart: ${chart.title}`,
    chart.labels.length ? `Labels: ${chart.labels.join(', ')}` : '',
    ...chart.datasets.map((dataset) => `${dataset.label}: ${dataset.data.join(', ')}`)
  ]
    .filter(Boolean)
    .join(' | ');
}

function getUiErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function buildWorkspaceNotes(
  notes: {
    analysisActions?: string[];
    suggestedNextActions?: string[];
    importantDetails?: string[];
    promptText?: string | null;
    chartSummary?: string;
  }
) {
  const items = new Set<string>();

  notes.analysisActions?.forEach((item) => items.add(item.trim()));
  notes.suggestedNextActions?.forEach((item) => items.add(item.trim()));
  notes.importantDetails?.forEach((item) => items.add(item.trim()));

  if (notes.promptText) {
    items.add(`Detected prompt: ${trimText(notes.promptText, 180)}`);
  }

  if (notes.chartSummary) {
    items.add(notes.chartSummary);
  }

  return Array.from(items).filter(Boolean).slice(0, 5);
}

export function App() {
  const [status, setStatus] = useState<PopupStatus | null>(null);
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [panelState, setPanelState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<'analyze' | 'scan_answers' | 'context' | 'open_popup' | null>(null);
  const [instructions, setInstructions] = usePersistentDraft(WORKSPACE_DRAFT_KEY);
  const [selectedActionId, setSelectedActionId] = useState<WorkflowActionId | null>(null);
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
      setPanelState('ready');
    } catch (error) {
      const message = getUiErrorMessage(error, 'Could not load the current page.');
      console.error('[Mako IQ][ui:error]', {
        surface: 'sidepanel',
        action: 'refresh-state',
        detail: message
      });
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

    if (
      persistedWorkflow.extraInstructions &&
      persistedWorkflow.extraInstructions !== instructions &&
      !instructions.trim()
    ) {
      setInstructions(persistedWorkflow.extraInstructions);
    }
  }, [bootstrap?.session.workflowState, instructions, setInstructions]);

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
  const actions = workflowState?.actionCards?.length
    ? workflowState.actionCards
    : getWorkflowActionCards(workflowState?.currentWorkflow ?? 'general');
  const selectedWorkflowAction =
    actions.find((action) => action.id === selectedActionId) ?? actions[0];
  const assignments = bootstrap?.session.canvasApiSummary?.upcomingAssignments ?? [];
  const showLegacyCanvasTargets = false;
  const selectedAssignment =
    assignments.find((assignment) => assignment.id === selectedAssignmentId) ?? assignments[0];
  const backendConnection = bootstrap?.settings.backendConnection ?? bootstrap?.session.backendConnection;
  const backendState = backendConnection?.state ?? 'unknown';
  const motionEnabled = bootstrap?.settings.motionEnabled ?? true;
  const debugMode = bootstrap?.settings.debugMode ?? false;
  const quizModeEnabled = bootstrap?.settings.quizModeEnabled ?? false;
  const pageTitle = status?.pageTitle ?? pageState?.currentPage.title ?? 'Current page';
  const pageUrl = pageState?.currentPage.url ?? status?.currentUrl ?? '';
  const pageHost = extractHost(pageUrl);
  const pagePreview =
    analysis?.extractedPreview ?? bootstrap?.pageContext?.previewText ?? pageState?.scan?.readableText ?? '';
  const chartSummary = formatChartSummary(analysis?.chart ?? null);
  const answerStatus =
    pageState?.errors.analysis ??
    (isRunning
      ? analysisRun?.statusLabel
      : analysis
        ? analysis.resultState === 'success'
          ? 'Recommended answer is ready.'
          : analysis.message
        : isUnsupported
          ? pageState?.uiStatus.message || 'This tab is limited for screen-aware answers.'
          : 'Run a focused action or ask a follow-up.') ?? 'Ready';
  const surfaceLabel =
    isUnsupported ? 'Limited page' : 'Screen mode';
  const supportedDetails = pageState?.errors.analysis ?? pageState?.errors.scan ?? '';
  const lastUpdated = pageState?.timestamps.lastUpdatedAt ?? bootstrap?.session.updatedAt;
  const composerDisabled = busy || !status?.isSupportedLaunchPage || isRunning;
  const supportingNotes = buildWorkspaceNotes({
    analysisActions: analysis?.actions,
    suggestedNextActions: analysis?.suggestedNextActions,
    importantDetails: analysis?.importantDetails,
    promptText: workflowState?.promptExtraction?.promptText,
    chartSummary
  });

  async function handleAnalyzeCurrentPage(instructionOverride?: string) {
    setBusy(true);
    setBusyAction('analyze');
    setNotice('');

    try {
      const payloadInstruction = (instructionOverride ?? instructions).trim();
      const response = await sendRuntimeMessage<ActivePageAnalysisResponse>({
        type: 'CANVY_ANALYZE_ACTIVE_PAGE',
        requestId: createRequestId(),
        instruction: payloadInstruction
      });

      setNotice(response.ok ? '' : response.error ?? 'Could not scan this page.');
      if (response.ok && !instructionOverride) {
        setInstructions('');
      }
    } catch (error) {
      const message = getUiErrorMessage(error, 'Could not scan this page.');
      console.error('[Mako IQ][ui:error]', {
        surface: 'sidepanel',
        action: 'analyze',
        detail: message
      });
      setNotice(message);
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }

  async function handleRefreshContext() {
    setBusy(true);
    setBusyAction('context');
    setNotice('');

    try {
      const nextBootstrap = await sendRuntimeMessage<BootstrapPayload>({
        type: 'CANVY_REFRESH_ACTIVE_PAGE_CONTEXT',
        requestId: createRequestId()
      });
      setBootstrap(nextBootstrap);

      const nextStatus = await sendRuntimeMessage<PopupStatus>({ type: 'GET_POPUP_STATUS' });
      setStatus(nextStatus);
      setNotice('Context updated.');
    } catch (error) {
      const message = getUiErrorMessage(error, 'Could not refresh this page.');
      console.error('[Mako IQ][ui:error]', {
        surface: 'sidepanel',
        action: 'refresh-context',
        detail: message
      });
      setNotice(message);
    } finally {
      setBusy(false);
      setBusyAction(null);
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
      setNotice(response.ok ? 'Page scan updated.' : response.message);
      await refresh('scan-refresh');
    } catch (error) {
      const message = getUiErrorMessage(error, 'Could not update page context.');
      console.error('[Mako IQ][ui:error]', {
        surface: 'sidepanel',
        action: 'scan',
        detail: message
      });
      setNotice(message);
    } finally {
      setBusy(false);
    }
  }

  async function handleOpenFloatingPopup(autoScan = false) {
    setBusy(true);
    setBusyAction('open_popup');
    setNotice(autoScan ? 'Opening floating popup and scanning...' : 'Opening floating popup...');

    try {
      const response = await sendRuntimeMessage<ScreenAnalyzeActionResponse>({
        type: autoScan ? 'OPEN_ASSISTANT_PANEL_AND_SCAN' : 'OPEN_ASSISTANT_PANEL',
        requestId: createRequestId(),
        autoScan
      });
      setNotice(response.ok ? 'Floating popup opened.' : response.error ?? response.message ?? 'Could not open the floating popup.');
    } catch (error) {
      const message = getUiErrorMessage(error, 'Could not open the floating popup on this page.');
      console.error('[Mako IQ][ui:error]', {
        surface: 'sidepanel',
        action: 'open-floating-popup',
        detail: message
      });
      setNotice(message);
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }

  async function handleShowAnswers() {
    setBusy(true);
    setBusyAction('scan_answers');
    setNotice('Scanning page...');

    try {
      const response = await sendRuntimeMessage<ScreenAnalyzeActionResponse>({
        type: 'CAPTURE_VISIBLE_SCREEN',
        requestId: createRequestId()
      });
      setNotice(response.message || (response.ok ? 'Answer bubbles are ready.' : 'Could not show answer bubbles.'));
    } catch (error) {
      const message = getUiErrorMessage(error, 'Could not show answer bubbles on this page.');
      console.error('[Mako IQ][ui:error]', {
        surface: 'sidepanel',
        action: 'show-answers',
        detail: message
      });
      setNotice(message);
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }

  async function handleRunWorkflowAction(actionId: WorkflowActionId, task: string) {
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
      setNotice(response.message);
      await refresh('workflow-action');
    } catch (error) {
      const message = getUiErrorMessage(error, 'Could not run this action.');
      console.error('[Mako IQ][ui:error]', {
        surface: 'sidepanel',
        action: 'workflow-action',
        detail: message
      });
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
      console.error('[Mako IQ][ui:error]', {
        surface: 'sidepanel',
        action: 'cancel',
        detail: message
      });
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
      console.error('[Mako IQ][ui:error]', {
        surface: 'sidepanel',
        action: 'save-settings',
        detail: message
      });
      setNotice(message);
    } finally {
      setBusy(false);
    }
  }

  async function handleReconnectBackend() {
    setBusy(true);

    try {
      const response = await sendRuntimeMessage<ReconnectBackendResponse>({
        type: 'CANVY_RECONNECT_BACKEND'
      });
      setNotice(response.message);
      await refresh('backend-reconnect');
    } catch (error) {
      const message = getUiErrorMessage(error, 'Could not reconnect to the backend.');
      console.error('[Mako IQ][ui:error]', {
        surface: 'sidepanel',
        action: 'reconnect-backend',
        detail: message
      });
      setNotice(message);
    } finally {
      setBusy(false);
    }
  }

  function handleOpenOptions() {
    void chrome.runtime.openOptionsPage();
  }

  function scrollToContext() {
    document.getElementById('mako-context-section')?.scrollIntoView({
      behavior: motionEnabled ? 'smooth' : 'auto',
      block: 'start'
    });
  }

  if (panelState === 'loading' && !bootstrap) {
    return (
      <MotionProvider>
        <AppShell surface="panel" aria-label="Mako IQ workspace">
          <WorkspaceShell surface="panel">
            <GlassToolbar className="mako-toolbar--compact">
              <div className="mako-brand-row">
                <div className="mako-brand-mark">
                  <AppIcon size={38} />
                  <div className="mako-brand-copy">
                    <p className="mako-eyebrow">Mako IQ workspace</p>
                    <h1 className="mako-brand-title mako-brand-title--workspace">Loading the page</h1>
                    <p className="mako-brand-caption">Preparing the workspace.</p>
                  </div>
                </div>
              </div>
            </GlassToolbar>
            <SkeletonSurface label="Loading Mako IQ workspace" />
          </WorkspaceShell>
        </AppShell>
      </MotionProvider>
    );
  }

  return (
    <MotionProvider>
      <AppShell
        surface="panel"
        animated={motionEnabled}
        className={motionEnabled ? undefined : 'mako-app--no-motion'}
        aria-label="Mako IQ workspace"
      >
        <WorkspaceShell surface="panel" className="mako-workspace-shell">
          <GlassToolbar className="mako-workspace-toolbar mako-toolbar--compact">
            <div className="mako-brand-row">
              <div className="mako-brand-mark">
                <AppIcon size={38} />
                <div className="mako-brand-copy">
                  <p className="mako-eyebrow">Mako IQ workspace</p>
                  <h1 className="mako-brand-title mako-brand-title--workspace">
                    {trimText(pageTitle, 84) || 'Current page'}
                  </h1>
                  <p className="mako-brand-caption">{trimText(answerStatus, 132)}</p>
                </div>
              </div>

              <div className="mako-chip-row">
                <StatusPill
                  label={surfaceLabel}
                  tone={assistantMode === 'canvas' ? 'accent' : isUnsupported ? 'warning' : 'neutral'}
                />
                {pageHost ? <StatusPill label={pageHost} tone="neutral" /> : null}
                <StatusPill
                  label={isRunning ? 'Working' : isUnsupported ? 'Limited' : 'Ready'}
                  tone={isRunning ? 'accent' : isUnsupported ? 'warning' : 'success'}
                />
                <StatusPill label={formatBackendLabel(backendState)} tone={getBackendTone(backendState)} />
              </div>
            </div>
          </GlassToolbar>

          {notice ? <InlineNotice tone={getNoticeTone(notice)}>{notice}</InlineNotice> : null}
          {!notice && supportedDetails ? <InlineNotice tone="warning">{supportedDetails}</InlineNotice> : null}

          <GlassPanel tone="elevated" className="mako-workspace-actions-panel">
            <SectionHeader
              eyebrow="Actions"
              title="Workspace tools"
              description={
                isUnsupported
                  ? 'The workspace is available, but screen-aware actions are limited on this protected tab.'
                  : 'Analyze the page, find questions, show answer bubbles, or open the compact floating popup.'
              }
              meta={
                selectedWorkflowAction ? (
                  <StatusPill
                    label={selectedWorkflowAction.label}
                    tone="accent"
                    icon={<Icon name="spark" size={14} />}
                  />
                ) : undefined
              }
            />

            <div className="mako-workspace-action-grid" aria-label="Primary workspace actions">
              <GlassButton
                variant="primary"
                size="lg"
                className="mako-workspace-action mako-workspace-action--primary"
                leadingIcon={<Icon name="spark" size={16} />}
                onClick={() => void handleAnalyzeCurrentPage()}
                disabled={busy || isRunning || isUnsupported}
                loading={isRunning || busyAction === 'analyze'}
              >
                {isRunning || busyAction === 'analyze' ? 'Analyzing...' : 'Analyze Page'}
              </GlassButton>
              <GlassButton
                variant="secondary"
                className="mako-workspace-action"
                leadingIcon={<Icon name="question" size={16} />}
                onClick={() =>
                  void handleAnalyzeCurrentPage(
                    'Find the visible questions, prompts, or tasks on this page and explain what each one is asking.'
                  )
                }
                disabled={busy || isRunning || isUnsupported}
              >
                Find Questions
              </GlassButton>
              <GlassButton
                variant="secondary"
                className="mako-workspace-action"
                leadingIcon={<Icon name="scan" size={16} />}
                onClick={() => void handleShowAnswers()}
                disabled={busy || isRunning || isUnsupported}
                loading={busyAction === 'scan_answers'}
              >
                {busyAction === 'scan_answers' ? 'Scanning...' : 'Show Answers'}
              </GlassButton>
              <GlassButton
                variant="secondary"
                className="mako-workspace-action"
                leadingIcon={<Icon name="notes" size={16} />}
                onClick={() =>
                  void handleAnalyzeCurrentPage('Summarize this page in clear student-friendly language.')
                }
                disabled={busy || isRunning || isUnsupported}
              >
                Summarize Page
              </GlassButton>
              <GlassButton
                variant="secondary"
                className="mako-workspace-action"
                leadingIcon={<Icon name="next" size={16} />}
                onClick={() =>
                  void handleAnalyzeCurrentPage(
                    'Tell me the next steps, decisions, or actions I should take from this page.'
                  )
                }
                disabled={busy || isRunning || isUnsupported}
              >
                Next Steps
              </GlassButton>
              <GlassButton
                variant="secondary"
                className="mako-workspace-action"
                leadingIcon={<Icon name="scan" size={16} />}
                onClick={() => void handleOpenFloatingPopup()}
                disabled={busy}
              >
                Open Floating Popup
              </GlassButton>
            </div>

            <div className="mako-workspace-utility-row" aria-label="Workspace utility actions">
              <GhostButton
                size="sm"
                leadingIcon={<Icon name="refresh" size={14} />}
                onClick={() => void handleRefreshContext()}
                disabled={busy || isRunning}
              >
                Refresh Context
              </GhostButton>
              <GhostButton
                size="sm"
                leadingIcon={<Icon name="scan" size={14} />}
                onClick={() => void handleCapturePage()}
                disabled={busy}
              >
                Refresh Page Text
              </GhostButton>
              <GhostButton
                size="sm"
                leadingIcon={<Icon name="page" size={14} />}
                onClick={scrollToContext}
                disabled={busy}
              >
                Open Context
              </GhostButton>
              <GhostButton
                size="sm"
                leadingIcon={<Icon name="quiz" size={14} />}
                onClick={() =>
                  void handleAnalyzeCurrentPage(
                    'Turn this page into a short study quiz with concise model answers.'
                  )
                }
                disabled={busy || isRunning || isUnsupported}
              >
                Quiz Me
              </GhostButton>
            </div>

            <div className="mako-toggle-list">
              <ToggleRow
                title="Quiz Mode"
                description="Watch this page for question changes and prefetch study suggestions in the answer bubble overlay."
                checked={quizModeEnabled}
                onChange={(checked) => void handleUpdateSetting({ quizModeEnabled: checked })}
              />
            </div>
          </GlassPanel>

          <div className="mako-panel-layout">
            <div className="mako-panel-main">
              <AnalysisResultCard
                analysis={analysis}
                analysisRun={analysisRun}
                onCancel={isRunning ? () => void handleCancelAnalysis() : null}
                emptyTitle="Recommended answer"
                emptyBody={
                  isUnsupported
                    ? 'The workspace is ready, but screen context is limited on this tab.'
                    : 'Run an action above, ask a question, or use the workflow path on the right.'
                }
              />

              <SuggestedNotesCard
                notes={supportingNotes}
                description="Only the supporting detail that improves the recommendation."
              />

              <GlassPanel tone="elevated" className="mako-composer-panel">
                <SectionHeader
                  eyebrow="Follow-up"
                  title="Ask another question"
                  description={
                    isUnsupported
                      ? 'This tab is limited for screen-aware analysis, but the workspace is still available.'
                      : 'Ask directly, or leave the field blank and run a fresh analysis.'
                  }
                />

                <FollowUpComposer
                  id="mako-workspace-question"
                  label="Ask about this screen"
                  multiline
                  rows={5}
                  value={instructions}
                  onChange={setInstructions}
                  onSubmit={() => void handleAnalyzeCurrentPage()}
                  submitLabel={isRunning ? 'Working...' : instructions.trim() ? 'Submit' : 'Ask About Screen'}
                  disabled={composerDisabled}
                  loading={busy || isRunning}
                  placeholder={
                    isUnsupported
                      ? 'Open a standard webpage to use screen-aware answers.'
                      : 'What should I understand, remember, or do next?'
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      if (!composerDisabled) {
                        void handleAnalyzeCurrentPage();
                      }
                    }
                  }}
                  footer={
                    <>
                      <span>
                        {isUnsupported
                          ? 'Use Refresh or Scan when you switch back to a supported page.'
                          : 'Shift+Enter adds a new line.'}
                      </span>
                      <div className="mako-chip-row">
                        {isRunning ? (
                          <GhostButton size="sm" onClick={() => void handleCancelAnalysis()} disabled={busy}>
                            Cancel
                          </GhostButton>
                        ) : null}
                      </div>
                    </>
                  }
                />
              </GlassPanel>

              <GlassPanel tone="soft" className="mako-workspace-info-panel">
                <div className="mako-stat-grid mako-stat-grid--compact">
                  <StatTile label="Page" value={trimText(pageTitle, 44) || 'Current page'} />
                  <StatTile label="Updated" value={formatTimestamp(lastUpdated)} />
                  <StatTile label="Focus" value={selectedWorkflowAction?.label ?? 'Ask a follow-up'} />
                  <StatTile label="Mode" value={surfaceLabel} />
                </div>
              </GlassPanel>

              <GlassPanel tone="quiet" id="mako-context-section">
                <SectionHeader
                  eyebrow="Context"
                  title="What Mako IQ is holding onto"
                  description={
                    pageHost ? `${pageHost} | ${trimText(pageUrl.replace(/^https?:\/\//i, ''), 96)}` : 'Current tab'
                  }
                />

                <div className="mako-mini-grid">
                  <div className="mako-mini-card">
                    <span className="mako-eyebrow">Last updated</span>
                    <strong>{formatTimestamp(lastUpdated)}</strong>
                  </div>
                  <div className="mako-mini-card">
                    <span className="mako-eyebrow">Current mode</span>
                    <strong>{surfaceLabel}</strong>
                  </div>
                </div>

                {pagePreview ? (
                  <div className="mako-panel-copy-block">{trimText(pagePreview, 1600)}</div>
                ) : (
                  <p className="mako-muted">
                    Readable page context will appear here once Mako IQ has something worth keeping.
                  </p>
                )}
              </GlassPanel>
            </div>

            <div className="mako-panel-rail">
              <WorkspaceActionGroup
                title="Workflow path"
                description="Run the workflow-specific move that best matches the page."
                meta={selectedWorkflowAction ? <StatusPill label={selectedWorkflowAction.label} tone="accent" /> : undefined}
              >
                {actions.map((action) => (
                  <ActionTile
                    key={action.id}
                    title={action.label}
                    copy={action.description}
                    kicker={action.id === selectedWorkflowAction?.id ? 'Selected' : 'Workflow'}
                    icon={<Icon name={action.id === selectedWorkflowAction?.id ? 'spark' : 'arrow-right'} size={16} />}
                    tone={action.id === selectedWorkflowAction?.id ? 'accent' : 'default'}
                    active={action.id === selectedWorkflowAction?.id}
                    onClick={() => void handleRunWorkflowAction(action.id, action.task)}
                    disabled={busy}
                  />
                ))}
              </WorkspaceActionGroup>

              {showLegacyCanvasTargets && assignments.length ? (
                <GlassPanel tone="soft">
                  <SectionHeader
                    eyebrow="Legacy targets"
                    title="Saved page targets"
                    description="Choose a saved target for the next workflow action."
                    meta={<StatusPill label={`${assignments.length} item${assignments.length === 1 ? '' : 's'}`} tone="accent" />}
                  />

                  <div className="mako-assignment-list">
                    {assignments.map((assignment) => (
                      <button
                        key={assignment.id}
                        type="button"
                        className={`mako-assignment-card ${assignment.id === selectedAssignment?.id ? 'mako-assignment-card--selected' : ''}`}
                        onClick={() => setSelectedAssignmentId(assignment.id)}
                      >
                        <strong>{assignment.title}</strong>
                        <span className="mako-assignment-card__meta">
                          {trimText([assignment.courseName, assignment.dueAt].filter(Boolean).join(' | '), 96) ||
                            'Saved item'}
                        </span>
                      </button>
                    ))}
                  </div>
                </GlassPanel>
              ) : null}

              <GlassPanel tone="soft">
                <details className="mako-disclosure">
                  <summary className="mako-disclosure__summary">
                    <span>
                      <span className="mako-eyebrow">Settings</span>
                      <strong>Workspace controls</strong>
                    </span>
                    <StatusPill label="Secondary" tone="neutral" />
                  </summary>

                  <div className="mako-disclosure__content">
                    <div className="mako-chip-row">
                      <GlassButton
                        variant="secondary"
                        onClick={() => void handleReconnectBackend()}
                        disabled={busy}
                        leadingIcon={<Icon name="refresh" size={14} />}
                      >
                        Reconnect backend
                      </GlassButton>
                      <GhostButton onClick={handleOpenOptions} leadingIcon={<Icon name="settings" size={14} />}>
                        Settings
                      </GhostButton>
                    </div>

                    <div className="mako-toggle-list">
                      <ToggleRow
                        title="Quiz Mode"
                        description="Quiz Mode needs access to this page to detect questions and show study assistance."
                        checked={quizModeEnabled}
                        onChange={(checked) => void handleUpdateSetting({ quizModeEnabled: checked })}
                      />
                      <ToggleRow
                        title="Motion"
                        description="Keep the glass transitions active across popup, workspace, and overlay."
                        checked={motionEnabled}
                        onChange={(checked) => void handleUpdateSetting({ motionEnabled: checked })}
                      />
                      <ToggleRow
                        title="Debug mode"
                        description="Expose deeper diagnostics when you need to troubleshoot."
                        checked={debugMode}
                        onChange={(checked) => void handleUpdateSetting({ debugMode: checked })}
                      />
                    </div>

                    {backendConnection?.lastError ? (
                      <InlineNotice tone="warning">{backendConnection.lastError}</InlineNotice>
                    ) : null}
                  </div>
                </details>
              </GlassPanel>
            </div>
          </div>
        </WorkspaceShell>
      </AppShell>
    </MotionProvider>
  );
}
