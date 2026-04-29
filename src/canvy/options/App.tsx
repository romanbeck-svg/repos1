import { useEffect, useState } from 'react';
import '../shared/app.css';
import { API_BASE_URL_ENV_KEYS } from '../shared/config';
import {
  AppIcon,
  AppShell,
  GhostButton,
  GlassButton,
  GlassInput,
  GlassPanel,
  GlassToolbar,
  InlineNotice,
  MotionProvider,
  SectionHeader,
  StatusPill,
  ToggleRow,
  WorkspaceShell
} from '../shared/components/ui';
import { sendRuntimeMessage } from '../shared/runtime';
import type { BootstrapPayload, CanvySettings } from '../shared/types';

export function App() {
  const [settings, setSettings] = useState<CanvySettings | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    void sendRuntimeMessage<BootstrapPayload>({ type: 'CANVY_GET_BOOTSTRAP' }).then((bootstrap) =>
      setSettings(bootstrap.settings)
    );
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
      <AppShell
        surface="options"
        animated={settings?.motionEnabled !== false}
        className={settings?.motionEnabled === false ? 'mako-app--no-motion' : undefined}
        aria-label="Mako IQ settings"
      >
        <WorkspaceShell surface="options">
          <GlassToolbar>
            <div className="mako-brand-row">
              <div className="mako-brand-mark">
                <AppIcon size={38} />
                <div className="mako-brand-copy">
                  <p className="mako-eyebrow">Settings</p>
                  <h1 className="mako-brand-title">Extension controls</h1>
                  <p className="mako-brand-caption">
                    Keep only the settings that change how Mako IQ behaves day to day.
                  </p>
                </div>
              </div>
              <StatusPill label="Local" tone="accent" />
            </div>
          </GlassToolbar>

          <GlassPanel tone="elevated">
            <SectionHeader
              eyebrow="Preferences"
              title="Core controls"
              description="Workspace opens from the toolbar, floating popup stays compact, answer bubbles stay lightweight."
            />

            <div className="mako-toggle-list">
              <ToggleRow
                title="Onboarding complete"
                description="Marks the initial setup flow as finished."
                checked={Boolean(settings?.configured)}
                onChange={(checked) =>
                  setSettings((current) =>
                    current
                      ? {
                          ...current,
                          configured: checked
                        }
                      : current
                  )
                }
              />
              <ToggleRow
                title="Tone consent saved"
                description="Stores whether tone personalization has already been approved."
                checked={Boolean(settings?.toneConsentGranted)}
                onChange={(checked) =>
                  setSettings((current) =>
                    current
                      ? {
                          ...current,
                          toneConsentGranted: checked
                        }
                      : current
                  )
                }
              />
              <ToggleRow
                title="Motion"
                description="Enables the quick glass transitions used across the workspace, floating popup, and answer bubbles."
                checked={Boolean(settings?.motionEnabled)}
                onChange={(checked) =>
                  setSettings((current) =>
                    current
                      ? {
                          ...current,
                          motionEnabled: checked
                        }
                      : current
                  )
                }
              />
              <ToggleRow
                title="Debug mode"
                description="Keeps extra diagnostics available for troubleshooting."
                checked={Boolean(settings?.debugMode)}
                onChange={(checked) =>
                  setSettings((current) =>
                    current
                      ? {
                          ...current,
                          debugMode: checked
                        }
                      : current
                  )
                }
              />
            </div>

            <label className="mako-field">
              <span className="mako-field__label">API base URL</span>
              <GlassInput
                type="url"
                placeholder="http://127.0.0.1:8787"
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
              <code>{API_BASE_URL_ENV_KEYS[0]}</code>. Use only the backend origin here, normally{' '}
              <code>http://127.0.0.1:8787</code>.
            </p>

            <div className="mako-chip-row">
              <GlassButton variant="primary" onClick={() => void save()}>
                Save settings
              </GlassButton>
              <GhostButton onClick={() => window.location.reload()}>Reload</GhostButton>
            </div>

            <p className="mako-muted">
              Shortcut: <strong>Ctrl+Shift+Y</strong>. Change it in <code>chrome://extensions/shortcuts</code>.
            </p>

            {status ? <InlineNotice tone="success">{status}</InlineNotice> : null}
          </GlassPanel>
        </WorkspaceShell>
      </AppShell>
    </MotionProvider>
  );
}
