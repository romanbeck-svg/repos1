import { useEffect, useMemo, useState } from 'react';
import { connectGoogleAccount, createGmailDraftFromLatestRun, disconnectGoogleAccount, getPageContext, openTaskWorkspace, runWorkflow, updateProviderMode } from '../shared/browser';
import { getState, getTaskSummary, updateDefaultIntent } from '../shared/storage';
import type { AppState, ProviderMode, WorkflowIntent } from '../shared/types';

const intents: Array<{ value: WorkflowIntent; label: string }> = [
  { value: 'what_should_i_do', label: 'What should I do?' },
  { value: 'quick_summary', label: 'Quick summary' },
  { value: 'answer', label: 'Give me an answer' },
  { value: 'send_to_doc', label: 'Send to doc' },
  { value: 'extract_tasks', label: 'Task extraction' },
  { value: 'page_understanding', label: 'Page understanding' },
  { value: 'autofill_suggestions', label: 'Auto form fill suggestions' }
];

const modes: Array<{ value: ProviderMode; label: string }> = [
  { value: 'local', label: 'Local AI' },
  { value: 'google', label: 'Google-connected' },
  { value: 'backend', label: 'Backend stub' }
];

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [status, setStatus] = useState('');
  const [running, setRunning] = useState(false);
  const [pageTitle, setPageTitle] = useState('Loading current page...');

  const refresh = async () => {
    const [nextState, pageContext] = await Promise.all([getState(), getPageContext()]);
    setState(nextState);
    setPageTitle(pageContext.title || 'Current page');
  };

  useEffect(() => {
    void refresh();
  }, []);

  const taskSummary = useMemo(() => {
    if (!state) {
      return { active: [], done: [] };
    }
    return getTaskSummary(state);
  }, [state]);

  const run = async (useScreenshot: boolean) => {
    if (!state) {
      return;
    }

    if (useScreenshot) {
      void runWorkflow({
        intent: state.settings.defaultIntent,
        useScreenshot: true
      });
      window.close();
      return;
    }

    setRunning(true);
    const result = await runWorkflow({
      intent: state.settings.defaultIntent,
      useScreenshot: false
    });
    setStatus(result.message);
    setRunning(false);
    await refresh();
  };

  if (!state) {
    return (
      <div className="app-shell app-shell-compact launcher-shell">
        <section className="hero-card stack hero-card-compact">
          <span className="label">Walt</span>
          <strong className="topbar-title">Loading popup...</strong>
        </section>
      </div>
    );
  }

  return (
    <div className="app-shell app-shell-compact launcher-shell">
      <section className="hero-card stack hero-card-compact launcher-hero">
        <div className="stack stack-tight">
          <span className="label">Walt</span>
          <strong className="topbar-title">Open dashboard</strong>
          <p className="subtle">Jump straight into Walt’s side panel workspace.</p>
        </div>
        <button className="primary-button" type="button" onClick={async () => {
          const result = await openTaskWorkspace('home');
          setStatus(result.message);
          if (result.ok) {
            window.close();
          }
        }}>
          Open dashboard
        </button>
      </section>

      <section className="panel-card stack">
        <div className="section-header">
          <div>
            <div className="label">Command palette</div>
            <h3 className="section-title">{pageTitle}</h3>
          </div>
          <span className="badge">{state.settings.providerMode}</span>
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
            {modes.map((mode) => (
              <option key={mode.value} value={mode.value}>{mode.label}</option>
            ))}
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
            Run on page
          </button>
          <button className="secondary-button" type="button" disabled={running} onClick={() => void run(true)}>
            Capture screenshot
          </button>
          <button className="ghost-button" type="button" onClick={async () => {
            const result = await openTaskWorkspace('history');
            setStatus(result.message);
            if (result.ok) {
              window.close();
            }
          }}>
            Open history
          </button>
        </div>
      </section>

      <section className="panel-card stack">
        <div className="section-header">
          <div>
            <div className="label">Google mode</div>
            <h3 className="section-title">{state.google.connected ? (state.google.email ?? 'Connected') : 'Not connected'}</h3>
          </div>
          <span className="badge">{state.google.connected ? 'ready' : 'optional'}</span>
        </div>
        <p className="subtle">Use Google-connected mode for Docs, Gmail, and Calendar routing.</p>
        <div className="task-actions">
          {state.google.connected ? (
            <>
              <button className="secondary-button" type="button" onClick={async () => {
                const result = await createGmailDraftFromLatestRun();
                setStatus(result.message);
              }}>
                Draft Gmail helper
              </button>
              <button className="ghost-button" type="button" onClick={async () => {
                const result = await disconnectGoogleAccount();
                setStatus(result.message);
                await refresh();
              }}>
                Disconnect
              </button>
            </>
          ) : (
            <button className="secondary-button" type="button" onClick={async () => {
              const result = await connectGoogleAccount();
              setStatus(result.message);
              await refresh();
            }}>
              Connect Google
            </button>
          )}
        </div>
      </section>

      <section className="panel-card stack">
        <div className="section-header">
          <div>
            <div className="label">Tasks to do</div>
            <h3 className="section-title">{taskSummary.active.length ? `${taskSummary.active.length} active` : 'No active tasks'}</h3>
          </div>
          <button className="ghost-button" type="button" onClick={async () => {
            const result = await openTaskWorkspace('tasks');
            setStatus(result.message);
            if (result.ok) {
              window.close();
            }
          }}>
            Open tasks
          </button>
        </div>
        <div className="mini-list">
          {taskSummary.active.slice(0, 4).map((task) => (
            <article key={task.id} className="mini-item stack compact-item">
              <strong>{task.title}</strong>
              <p className="subtle">{task.notes || 'No notes yet.'}</p>
            </article>
          ))}
          {!taskSummary.active.length ? <p className="subtle">Walt will place extracted tasks here after task runs.</p> : null}
        </div>
      </section>

      <section className="panel-card stack footer-status">
        <div className="label">Status</div>
        <p className="subtle status-line">{status || 'Local mode is ready. No OpenAI key or ChatGPT session is used.'}</p>
      </section>
    </div>
  );
}
