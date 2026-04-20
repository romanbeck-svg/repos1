import { useEffect, useMemo, useState } from 'react';
import { applyAutofillSuggestions, connectGoogleAccount, createCalendarEventForTask, createGoogleDocFromDraft, disconnectGoogleAccount, getPageContext, openTaskWorkspace, runWorkflow, updateProviderMode } from '../shared/browser';
import { deleteTask, getLatestRun, getState, getTaskSummary, toggleTask, updateDefaultIntent, updateWorkspaceTargetView } from '../shared/storage';
import type { AppState, ProviderMode, WorkflowIntent, WorkspaceSurface, WorkspaceTargetView } from '../shared/types';

type AppProps = {
  surface: Exclude<WorkspaceSurface, 'none'>;
};

const intents: Array<{ value: WorkflowIntent; label: string }> = [
  { value: 'what_should_i_do', label: 'What should I do?' },
  { value: 'quick_summary', label: 'Quick summary' },
  { value: 'answer', label: 'Give me an answer' },
  { value: 'send_to_doc', label: 'Send to doc' },
  { value: 'extract_tasks', label: 'Task extraction' },
  { value: 'page_understanding', label: 'Page understanding' },
  { value: 'autofill_suggestions', label: 'Auto form fill suggestions' }
];

function normalizeView(input?: string | null): WorkspaceTargetView {
  return input === 'tasks' || input === 'google' || input === 'history' ? input : 'home';
}

export function App({ surface }: AppProps) {
  const [state, setState] = useState<AppState | null>(null);
  const [view, setView] = useState<WorkspaceTargetView>('home');
  const [status, setStatus] = useState(surface === 'page' ? 'Opened Walt in a full page view.' : '');
  const [running, setRunning] = useState(false);
  const [pageLabel, setPageLabel] = useState('Current page');

  const refresh = async () => {
    const [nextState, pageContext] = await Promise.all([getState(), getPageContext()]);
    setState(nextState);
    setPageLabel(pageContext.title || 'Current page');
  };

  useEffect(() => {
    const queryTarget = normalizeView(new URLSearchParams(window.location.search).get('view'));
    setView(queryTarget);
    void refresh();
  }, []);

  const navigate = async (target: WorkspaceTargetView) => {
    setView(target);
    await updateWorkspaceTargetView(target);
    await chrome.storage.local.set({ 'walt-workspace-target-view': target });
  };

  const run = async (useScreenshot: boolean) => {
    if (!state) {
      return;
    }
    setRunning(true);
    const result = await runWorkflow({
      intent: state.settings.defaultIntent,
      useScreenshot
    });
    setStatus(result.message);
    setRunning(false);
    await refresh();
  };

  const taskSummary = useMemo(() => {
    if (!state) {
      return { active: [], done: [] };
    }
    return getTaskSummary(state);
  }, [state]);

  const latestRun = state ? getLatestRun(state) : null;

  if (!state) {
    return (
      <div className="workspace-shell workspace-shell-single">
        <main className="workspace-main">
          <section className="hero-card stack">
            <span className="label">Walt</span>
            <h1 className="headline">Loading workspace...</h1>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="workspace-shell workspace-shell-single">
      <main className="workspace-main">
        <section className="panel-card stack workspace-map-card">
          <div className="section-header">
            <div className="stack stack-tight">
              <span className="label">Walt</span>
              <h1 className="headline headline-small">Mode selector and workspace map</h1>
              <p className="subtle">Use the map to jump around, then scroll through the active section.</p>
            </div>
            <span className="badge">{state.settings.providerMode}</span>
          </div>

          <nav className="workspace-map">
            <button className={view === 'home' ? 'nav-button active' : 'nav-button'} type="button" onClick={() => void navigate('home')}><span className="nav-icon">D</span><span>Dashboard</span></button>
            <button className={view === 'tasks' ? 'nav-button active' : 'nav-button'} type="button" onClick={() => void navigate('tasks')}><span className="nav-icon">T</span><span>Tasks</span></button>
            <button className={view === 'google' ? 'nav-button active' : 'nav-button'} type="button" onClick={() => void navigate('google')}><span className="nav-icon">G</span><span>Google</span></button>
            <button className={view === 'history' ? 'nav-button active' : 'nav-button'} type="button" onClick={() => void navigate('history')}><span className="nav-icon">H</span><span>History</span></button>
          </nav>
        </section>

        <section className="hero-card stack hero-card-compact">
          <div className="row spread">
            <div className="stack stack-tight">
              <span className="label">{view === 'home' ? 'Dashboard' : view === 'tasks' ? 'Tasks' : view === 'google' ? 'Google' : 'History'}</span>
              <h2 className="headline headline-medium">
                {view === 'home'
                  ? 'Local-first browser workflows.'
                  : view === 'tasks'
                    ? 'Review and manage extracted work.'
                    : view === 'google'
                      ? 'Connect Walt to Docs, Gmail, and Calendar.'
                      : 'Recent runs and outputs.'}
              </h2>
              <p className="subtle">{pageLabel}</p>
            </div>
            <span className="badge">{surface}</span>
          </div>
          <p className="subtle status-line">{status || 'No OpenAI key or ChatGPT session is used in this build.'}</p>
        </section>

        {view === 'home' ? (
          <div className="workspace-grid">
            <section className="panel-card stack workspace-span-full">
              <div className="section-header">
                <div>
                  <div className="label">Command palette</div>
                  <h3 className="section-title">Choose a mode and run the current workflow</h3>
                </div>
                <button className="ghost-button" type="button" onClick={() => void openTaskWorkspace('home')}>
                  Re-open side panel
                </button>
              </div>

              <div className="two-up">
                <select
                  className="select-input"
                  value={state.settings.providerMode}
                  onChange={async (event) => {
                    const nextMode = event.target.value as ProviderMode;
                    await updateProviderMode(nextMode);
                    setStatus(`Walt switched to ${nextMode} mode.`);
                    await refresh();
                  }}
                >
                  <option value="local">Local AI mode</option>
                  <option value="google">Google-connected mode</option>
                  <option value="backend">Future backend mode (stub)</option>
                </select>
                <select
                  className="select-input"
                  value={state.settings.defaultIntent}
                  onChange={async (event) => {
                    const nextIntent = event.target.value as WorkflowIntent;
                    await updateDefaultIntent(nextIntent);
                    setStatus(`Default workflow changed to ${intents.find((intent) => intent.value === nextIntent)?.label}.`);
                    await refresh();
                  }}
                >
                  {intents.map((intent) => (
                    <option key={intent.value} value={intent.value}>{intent.label}</option>
                  ))}
                </select>
              </div>

              <div className="task-actions">
                <button className="primary-button" type="button" disabled={running} onClick={() => void run(false)}>
                  Run on current page
                </button>
                <button className="secondary-button" type="button" disabled={running} onClick={() => void run(true)}>
                  Capture screenshot and route
                </button>
                <button className="ghost-button" type="button" onClick={async () => {
                  const applied = await applyAutofillSuggestions();
                  setStatus(applied ? 'Applied the last stored autofill suggestions.' : 'No stored autofill suggestions were available.');
                }}>
                  Apply last autofill suggestions
                </button>
              </div>
            </section>

            <section className="panel-card stack">
              <div className="label">Current workflow</div>
              <strong>{intents.find((intent) => intent.value === state.settings.defaultIntent)?.label}</strong>
              <p className="subtle">Provider: {state.settings.providerMode}</p>
              <p className="subtle">Google: {state.google.connected ? `connected as ${state.google.email ?? 'account'}` : 'not connected'}</p>
            </section>

            <section className="panel-card stack">
              <div className="label">Latest result</div>
              {latestRun ? (
                <>
                  <strong>{latestRun.result.title}</strong>
                  <p className="subtle">{latestRun.result.summary}</p>
                  <div className="mini-list">
                    {latestRun.result.bullets.slice(0, 3).map((bullet, index) => (
                      <article key={`${latestRun.id}-${index}`} className="mini-item compact-item">{bullet}</article>
                    ))}
                  </div>
                </>
              ) : (
                <p className="subtle">Run a workflow to populate Walt’s result history.</p>
              )}
            </section>

            <section className="panel-card stack">
              <div className="label">Task snapshot</div>
              <strong>{taskSummary.active.length} active tasks</strong>
              <p className="subtle">{taskSummary.done.length} completed tasks</p>
            </section>
          </div>
        ) : null}

        {view === 'tasks' ? (
          <div className="workspace-grid">
            <section className="panel-card stack workspace-span-full">
              <div className="section-header">
                <div>
                  <div className="label">Active tasks</div>
                  <h3 className="section-title">Extracted and manual work</h3>
                </div>
                <span className="badge">{taskSummary.active.length}</span>
              </div>
              <div className="mini-list">
                {taskSummary.active.map((task) => (
                  <article key={task.id} className="mini-item stack">
                    <div className="row spread">
                      <strong>{task.title}</strong>
                      <span className="badge">active</span>
                    </div>
                    <p className="subtle">{task.notes || 'No notes yet.'}</p>
                    <div className="task-actions">
                      <button className="secondary-button" type="button" onClick={async () => {
                        await toggleTask(task.id);
                        setStatus(`Marked "${task.title}" complete.`);
                        await refresh();
                      }}>
                        Complete
                      </button>
                      <button className="ghost-button" type="button" onClick={async () => {
                        const result = await createCalendarEventForTask(task.id);
                        setStatus(result.message);
                      }}>
                        Create calendar event
                      </button>
                      <button className="danger-button" type="button" onClick={async () => {
                        await deleteTask(task.id);
                        setStatus(`Deleted "${task.title}".`);
                        await refresh();
                      }}>
                        Delete
                      </button>
                    </div>
                  </article>
                ))}
                {!taskSummary.active.length ? <p className="subtle">Run “Task extraction” to create tasks from the current page or screenshot.</p> : null}
              </div>
            </section>

            <section className="panel-card stack workspace-span-full">
              <div className="label">Completed</div>
              <div className="mini-list">
                {taskSummary.done.slice(0, 10).map((task) => (
                  <article key={task.id} className="mini-item compact-item">{task.title}</article>
                ))}
                {!taskSummary.done.length ? <p className="subtle">Completed tasks will appear here.</p> : null}
              </div>
            </section>
          </div>
        ) : null}

        {view === 'google' ? (
          <div className="workspace-grid">
            <section className="panel-card stack workspace-span-full">
              <div className="section-header">
                <div>
                  <div className="label">Google connection</div>
                  <h3 className="section-title">{state.google.connected ? (state.google.email ?? 'Connected account') : 'Not connected yet'}</h3>
                </div>
                <span className="badge">{state.google.connected ? 'ready' : 'setup'}</span>
              </div>
              <p className="subtle">Google mode uses chrome.identity and OAuth scopes for Docs, Gmail drafts, and Calendar actions. It does not reuse any ChatGPT session.</p>
              <div className="task-actions">
                {state.google.connected ? (
                  <button className="ghost-button" type="button" onClick={async () => {
                    const result = await disconnectGoogleAccount();
                    setStatus(result.message);
                    await refresh();
                  }}>
                    Disconnect Google
                  </button>
                ) : (
                  <button className="primary-button" type="button" onClick={async () => {
                    const result = await connectGoogleAccount();
                    setStatus(result.message);
                    await refresh();
                  }}>
                    Connect Google
                  </button>
                )}
              </div>
            </section>

            <section className="panel-card stack workspace-span-full">
              <div className="section-header">
                <div>
                  <div className="label">Docs queue</div>
                  <h3 className="section-title">Drafts ready for Google Docs</h3>
                </div>
                <span className="badge">{state.docsQueue.length}</span>
              </div>
              <div className="mini-list">
                {state.docsQueue.map((draft) => (
                  <article key={draft.id} className="mini-item stack">
                    <strong>{draft.title}</strong>
                    <p className="subtle">{draft.content.slice(0, 160)}{draft.content.length > 160 ? '...' : ''}</p>
                    <div className="task-actions">
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={!state.google.connected}
                        onClick={async () => {
                          const result = await createGoogleDocFromDraft(draft.id);
                          setStatus(result.message);
                          await refresh();
                        }}
                      >
                        Send to Google Doc
                      </button>
                      {draft.googleDocUrl ? (
                        <a className="ghost-button" href={draft.googleDocUrl} target="_blank" rel="noreferrer">
                          Open doc
                        </a>
                      ) : null}
                    </div>
                  </article>
                ))}
                {!state.docsQueue.length ? <p className="subtle">Use the “Send to doc” workflow to queue doc drafts here.</p> : null}
              </div>
            </section>
          </div>
        ) : null}

        {view === 'history' ? (
          <div className="workspace-grid">
            <section className="panel-card stack workspace-span-full">
              <div className="section-header">
                <div>
                  <div className="label">Recent runs</div>
                  <h3 className="section-title">Workflow history</h3>
                </div>
                <span className="badge">{state.workflowHistory.length}</span>
              </div>
              <div className="mini-list">
                {state.workflowHistory.map((run) => (
                  <article key={run.id} className="mini-item stack">
                    <div className="row spread">
                      <strong>{run.result.title}</strong>
                      <span className="badge">{run.providerMode}</span>
                    </div>
                    <p className="subtle">{run.result.summary}</p>
                    <pre className="summary-pre">{run.result.bullets.join('\n')}</pre>
                  </article>
                ))}
                {!state.workflowHistory.length ? <p className="subtle">Runs from screenshot and page workflows will appear here.</p> : null}
              </div>
            </section>
          </div>
        ) : null}
      </main>
    </div>
  );
}
