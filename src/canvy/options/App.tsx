import { useEffect, useState } from 'react';
import '../shared/app.css';
import { API_BASE_URL_ENV_KEYS } from '../shared/config';
import { sendRuntimeMessage } from '../shared/runtime';
import type { BootstrapPayload, CanvySettings } from '../shared/types';

export function App() {
  const [settings, setSettings] = useState<CanvySettings | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    void sendRuntimeMessage<BootstrapPayload>({ type: 'CANVY_GET_BOOTSTRAP' }).then((bootstrap) => setSettings(bootstrap.settings));
  }, []);

  async function save() {
    if (!settings) {
      return;
    }

    await sendRuntimeMessage({ type: 'CANVY_SAVE_SETTINGS', payload: settings });
    setStatus('Mako IQ settings saved.');
  }

  return (
    <main className="canvy-options-page">
      <section className="canvy-options-shell canvy-shell" aria-label="Mako IQ settings">
        <header className="canvy-header">
          <div>
            <div className="canvy-brand-mark">Mako IQ</div>
            <h2>Extension settings</h2>
            <p>Popup first. Workspace optional. These settings control local extension behavior only.</p>
          </div>
          <span className="canvy-status-pill canvy-status-pill-general">Settings</span>
        </header>

        <section className="canvy-card">
          <div className="canvy-card-head">
            <div>
              <div className="canvy-eyebrow">Setup</div>
              <h3>Local preferences</h3>
            </div>
          </div>

          <div className="canvy-options-toggle-list">
            <label className="canvy-panel-toggle">
              <span>Onboarding complete</span>
              <input
                type="checkbox"
                checked={Boolean(settings?.configured)}
                onChange={(event) =>
                  setSettings((current) =>
                    current
                      ? {
                          ...current,
                          configured: event.target.checked
                        }
                      : current
                  )
                }
              />
            </label>

            <label className="canvy-panel-toggle">
              <span>Tone consent saved</span>
              <input
                type="checkbox"
                checked={Boolean(settings?.toneConsentGranted)}
                onChange={(event) =>
                  setSettings((current) =>
                    current
                      ? {
                          ...current,
                          toneConsentGranted: event.target.checked
                        }
                      : current
                  )
                }
              />
            </label>

            <label className="canvy-panel-toggle">
              <span>Motion</span>
              <input
                type="checkbox"
                checked={Boolean(settings?.motionEnabled)}
                onChange={(event) =>
                  setSettings((current) =>
                    current
                      ? {
                          ...current,
                          motionEnabled: event.target.checked
                        }
                      : current
                  )
                }
              />
            </label>

            <label className="canvy-panel-toggle">
              <span>Debug mode</span>
              <input
                type="checkbox"
                checked={Boolean(settings?.debugMode)}
                onChange={(event) =>
                  setSettings((current) =>
                    current
                      ? {
                          ...current,
                          debugMode: event.target.checked
                        }
                      : current
                  )
                }
              />
            </label>
          </div>

          <label className="canvy-field">
            <span className="canvy-field-label">API base URL</span>
            <input
              className="canvy-input"
              type="url"
              placeholder="http://localhost:8787"
              value={settings?.apiBaseUrl ?? ''}
              onChange={(event) =>
                setSettings((current) =>
                  current
                    ? {
                        ...current,
                        apiBaseUrl: event.target.value,
                        apiBaseUrlSource: 'storage'
                      }
                    : current
                )
              }
            />
          </label>

          <p className="canvy-muted">
            Resolved from <strong>{settings?.apiBaseUrlSource ?? 'default'}</strong>. The build-time default comes from{' '}
            <code>{API_BASE_URL_ENV_KEYS[0]}</code>. Paste only the backend origin here, for example{' '}
            <code>https://your-service.onrender.com</code>, to override localhost at runtime.
          </p>

          <div className="canvy-action-row">
            <button className="canvy-primary canvy-options-primary" type="button" onClick={() => void save()}>
              Save
            </button>
            <button className="canvy-secondary" type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>

          <p className="canvy-muted">
            Shortcut: <strong>Ctrl+Shift+Y</strong>. Change it in <code>chrome://extensions/shortcuts</code>.
          </p>
          {status ? <div className="canvy-banner">{status}</div> : null}
        </section>
      </section>
    </main>
  );
}
