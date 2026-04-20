import { useEffect, useState } from 'react';
import '../shared/app.css';
import { API_BASE_URL_ENV_KEYS } from '../shared/config';
import { AppShell, GlassButton, GlassSurface, InlineNotice, MotionProvider, SectionHeader, StatusPill } from '../shared/components/ui';
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
    <MotionProvider>
      <AppShell surface="options" aria-label="Mako IQ settings">
        <div className="mako-shell mako-shell--options">
          <GlassSurface tone="hero">
            <SectionHeader
              eyebrow="Settings"
              title="Extension settings"
              description="Popup first, workspace intentional, overlay lightweight. These settings stay local to the extension."
              meta={<StatusPill label="Local" tone="accent" />}
            />
          </GlassSurface>

          <GlassSurface tone="elevated">
            <SectionHeader
              eyebrow="Preferences"
              title="Core controls"
              description="Keep only the controls that affect how Mako IQ behaves day to day."
            />

            <div className="mako-toggle-list">
              <label className="mako-toggle">
                <div className="mako-toggle__copy">
                  <span className="mako-toggle__title">Onboarding complete</span>
                  <span className="mako-toggle__description">Marks the initial setup flow as finished.</span>
                </div>
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

              <label className="mako-toggle">
                <div className="mako-toggle__copy">
                  <span className="mako-toggle__title">Tone consent saved</span>
                  <span className="mako-toggle__description">Stores whether tone personalization has already been approved.</span>
                </div>
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

              <label className="mako-toggle">
                <div className="mako-toggle__copy">
                  <span className="mako-toggle__title">Motion</span>
                  <span className="mako-toggle__description">Enables the quick glass transitions used across popup, workspace, and overlay.</span>
                </div>
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

              <label className="mako-toggle">
                <div className="mako-toggle__copy">
                  <span className="mako-toggle__title">Debug mode</span>
                  <span className="mako-toggle__description">Keeps extra diagnostics available for troubleshooting.</span>
                </div>
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

            <label className="mako-field">
              <span className="mako-field__label">API base URL</span>
              <input
                className="mako-input"
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

            <p className="mako-muted">
              Resolved from <strong>{settings?.apiBaseUrlSource ?? 'default'}</strong>. The build-time default comes from{' '}
              <code>{API_BASE_URL_ENV_KEYS[0]}</code>. Use only the backend origin here, for example{' '}
              <code>https://your-service.onrender.com</code>.
            </p>

            <div className="mako-actions-row">
              <GlassButton variant="primary" onClick={() => void save()}>
                Save settings
              </GlassButton>
              <GlassButton variant="ghost" onClick={() => window.location.reload()}>
                Reload
              </GlassButton>
            </div>

            <p className="mako-muted">
              Shortcut: <strong>Ctrl+Shift+Y</strong>. Change it in <code>chrome://extensions/shortcuts</code>.
            </p>

            {status ? <InlineNotice tone="success">{status}</InlineNotice> : null}
          </GlassSurface>
        </div>
      </AppShell>
    </MotionProvider>
  );
}
