import { useEffect, useState } from 'react';
import { connectGoogleAccount, disconnectGoogleAccount, updateProviderMode } from '../shared/browser';
import { getState, updateGoogleClientConfigured } from '../shared/storage';
import type { AppState, ProviderMode } from '../shared/types';

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [status, setStatus] = useState('');

  const refresh = async () => {
    setState(await getState());
  };

  useEffect(() => {
    void refresh();
  }, []);

  if (!state) {
    return null;
  }

  return (
    <div className="app-shell">
      <section className="hero-card stack">
        <span className="label">Settings</span>
        <h1 className="headline">Walt</h1>
        <p className="subtle">
          Walt now runs as a local-first Chrome extension with provider modes, screenshot routing, Google OAuth hooks, and no ChatGPT session reuse.
        </p>
      </section>

      <section className="panel-card stack">
        <div className="label">Provider modes</div>
        <p className="subtle">Local mode is the default. Google mode adds Docs, Gmail, and Calendar hooks. Backend mode is a future stub only.</p>
        <div className="task-actions">
          {(['local', 'google', 'backend'] as ProviderMode[]).map((mode) => (
            <button
              key={mode}
              className={state.settings.providerMode === mode ? 'primary-button' : 'ghost-button'}
              type="button"
              onClick={async () => {
                const result = await updateProviderMode(mode);
                setStatus(result.message);
                await refresh();
              }}
            >
              {mode}
            </button>
          ))}
        </div>
      </section>

      <section className="panel-card stack">
        <div className="label">Google OAuth setup</div>
        <p className="subtle">Before Google-connected mode works, replace the placeholder `oauth2.client_id` in `public/manifest.json` with your real Chrome extension OAuth client.</p>
        <div className="task-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={async () => {
              const nextValue = !state.settings.googleClientConfigured;
              await updateGoogleClientConfigured(nextValue);
              setStatus(nextValue ? 'Marked Google OAuth client as configured.' : 'Marked Google OAuth client as not configured.');
              await refresh();
            }}
          >
            {state.settings.googleClientConfigured ? 'Mark as not configured' : 'Mark as configured'}
          </button>
          {state.google.connected ? (
            <button
              className="ghost-button"
              type="button"
              onClick={async () => {
                const result = await disconnectGoogleAccount();
                setStatus(result.message);
                await refresh();
              }}
            >
              Disconnect Google
            </button>
          ) : (
            <button
              className="ghost-button"
              type="button"
              onClick={async () => {
                const result = await connectGoogleAccount();
                setStatus(result.message);
                await refresh();
              }}
            >
              Test Google sign-in
            </button>
          )}
        </div>
        <p className="subtle">Connected account: {state.google.email ?? 'none'}</p>
      </section>

      <section className="panel-card stack">
        <div className="label">Current data flow</div>
        <p className="subtle">Popup and side panel send workflow messages to the background service worker.</p>
        <p className="subtle">The background worker captures screenshots, asks the content script for page context, routes to the selected provider, then stores the result in `chrome.storage.local`.</p>
        <p className="subtle">Content scripts only read page context, show overlays, and optionally apply stored autofill suggestions. They do not scrape or automate ChatGPT.</p>
      </section>

      <section className="panel-card stack">
        <div className="label">Workflow support</div>
        <p className="subtle">Walt currently supports these local-first flows:</p>
        <p className="subtle">1. Screenshot → What should I do?</p>
        <p className="subtle">2. Quick summary</p>
        <p className="subtle">3. Give me an answer</p>
        <p className="subtle">4. Send to doc queue</p>
        <p className="subtle">5. Task extraction</p>
        <p className="subtle">6. Page understanding</p>
        <p className="subtle">7. Auto form fill suggestions</p>
      </section>

      <section className="panel-card stack">
        <div className="label">Status</div>
        <p className="subtle">{status || 'No cloud AI credentials are embedded in this extension.'}</p>
      </section>
    </div>
  );
}
