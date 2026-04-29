import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_TARGET_URL = new URL(process.env.CANVY_SMOKE_URL ?? 'https://example.com/').href;
const DEFAULT_API_BASE_URL = (process.env.CANVY_SMOKE_API_BASE_URL ?? 'http://localhost:8787').replace(/\/+$/, '');
const DEFAULT_REMOTE_DEBUGGING_PORT = Number(process.env.CANVY_SMOKE_PORT ?? 9230 + Math.floor(Math.random() * 200));
const DEFAULT_STEP_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_TIMEOUT_MS = 20_000;
const KEEP_BROWSER_OPEN = process.env.CANVY_SMOKE_KEEP_BROWSER === '1';
const EXPECT_BACKEND_OFFLINE = process.env.CANVY_SMOKE_EXPECT_BACKEND_OFFLINE === '1';
const EXTENSION_DIR = path.resolve(process.cwd(), 'dist');
const WINDOWS_BROWSER_CANDIDATES = [
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureReadableFile(filePath) {
  accessSync(filePath, constants.R_OK);
}

function findBrowserBinary() {
  const override = process.env.CANVY_SMOKE_BROWSER?.trim();
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`Configured browser was not found: ${override}`);
    }

    return override;
  }

  if (process.platform === 'win32') {
    const browserPath = WINDOWS_BROWSER_CANDIDATES.find((candidate) => existsSync(candidate));
    if (browserPath) {
      return browserPath;
    }
  }

  throw new Error('No supported browser was found. Set CANVY_SMOKE_BROWSER to Brave or Edge.');
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request to ${url} failed with status ${response.status}.`);
  }

  return response.json();
}

async function waitFor(description, readValue, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS, intervalMs = 250) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const value = await readValue();
    if (value) {
      return value;
    }

    await sleep(intervalMs);
  }

  throw new Error(`Timed out waiting for ${description}.`);
}

function summarizeExpression(expression) {
  const normalized = String(expression).replace(/\s+/g, ' ').trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function normalizeUrl(url) {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

function createPendingMap() {
  return new Map();
}

async function connectWebSocket(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return ws;
}

async function openPageSession(port, targetUrl) {
  const normalizedTargetUrl = normalizeUrl(targetUrl);
  const pageTarget = await waitFor('the browser page target', async () => {
    try {
      const targets = await fetchJson(`http://localhost:${port}/json/list`);
      return targets.find((target) => target.type === 'page' && normalizeUrl(target.url) === normalizedTargetUrl) ?? null;
    } catch {
      return null;
    }
  });

  const ws = await connectWebSocket(pageTarget.webSocketDebuggerUrl);
  let nextMessageId = 0;
  const pending = createPendingMap();
  const contexts = new Map();

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.executionContextCreated') {
      contexts.set(message.params.context.id, message.params.context);
    }

    if (message.method === 'Runtime.executionContextDestroyed') {
      contexts.delete(message.params.executionContextId);
    }

    if (message.method === 'Runtime.executionContextsCleared') {
      contexts.clear();
    }

    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });

  async function send(method, params = {}) {
    const messageId = ++nextMessageId;
    ws.send(JSON.stringify({ id: messageId, method, params }));
    const response = await new Promise((resolve) => pending.set(messageId, resolve));
    if (response?.error) {
      throw new Error(`CDP ${method} failed (${response.error.code}): ${response.error.message}`);
    }

    return response;
  }

  await send('Runtime.enable');

  const findContentContext = () =>
    Array.from(contexts.values())
      .reverse()
      .find((candidate) => candidate.origin?.startsWith('chrome-extension://')) ?? null;
  const findMainContext = () =>
    Array.from(contexts.values())
      .reverse()
      .find((candidate) => candidate.auxData?.isDefault) ?? null;

  const contentContext = await waitFor('the extension content-script context', async () => findContentContext());
  const mainContext = await waitFor('the main page execution context', async () => findMainContext());

  if (!mainContext) {
    throw new Error('The main page execution context was not found.');
  }

  const extensionOrigin = contentContext.origin;
  const extensionId = extensionOrigin.replace('chrome-extension://', '');

  return {
    ws,
    send,
    getContentContextId: () => findContentContext()?.id ?? null,
    getMainContextId: () => findMainContext()?.id ?? null,
    extensionId,
    extensionOrigin
  };
}

async function openTargetSessionByUrl(port, targetUrl) {
  const normalizedTargetUrl = normalizeUrl(targetUrl);
  const target = await waitFor('the launcher target', async () => {
    try {
      const targets = await fetchJson(`http://localhost:${port}/json/list`);
      return targets.find((candidate) => normalizeUrl(candidate.url) === normalizedTargetUrl) ?? null;
    } catch {
      return null;
    }
  });

  const ws = await connectWebSocket(target.webSocketDebuggerUrl);
  let nextMessageId = 0;
  const pending = createPendingMap();
  const contexts = new Map();

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.executionContextCreated') {
      contexts.set(message.params.context.id, message.params.context);
    }

    if (message.method === 'Runtime.executionContextDestroyed') {
      contexts.delete(message.params.executionContextId);
    }

    if (message.method === 'Runtime.executionContextsCleared') {
      contexts.clear();
    }

    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });

  async function send(method, params = {}) {
    const messageId = ++nextMessageId;
    ws.send(JSON.stringify({ id: messageId, method, params }));
    const response = await new Promise((resolve) => pending.set(messageId, resolve));
    if (response?.error) {
      throw new Error(`CDP ${method} failed (${response.error.code}): ${response.error.message}`);
    }

    return response;
  }

  await send('Runtime.enable');

  const findDefaultContext = () =>
    Array.from(contexts.values())
      .reverse()
      .find((candidate) => candidate.auxData?.isDefault) ?? null;

  await waitFor('the launcher execution context', async () => findDefaultContext());

  return {
    ws,
    send,
    getContextId: () => findDefaultContext()?.id ?? null
  };
}

async function evaluateInContext(send, readContextId, contextLabel, expression) {
  const contextId = await waitFor(contextLabel, async () => readContextId());
  const response = await send('Runtime.evaluate', {
    expression,
    contextId,
    returnByValue: true,
    awaitPromise: true
  });

  const evaluation = response?.result;
  if (!evaluation) {
    throw new Error(`Runtime.evaluate returned no result for: ${summarizeExpression(expression)}`);
  }

  if (evaluation.exceptionDetails) {
    const description =
      evaluation.exceptionDetails.exception?.description ??
      evaluation.exceptionDetails.text ??
      'Unknown evaluation error';
    throw new Error(`Runtime.evaluate failed for: ${summarizeExpression(expression)} :: ${description}`);
  }

  if (!evaluation.result) {
    throw new Error(`Runtime.evaluate returned no remote object for: ${summarizeExpression(expression)}`);
  }

  return 'value' in evaluation.result ? evaluation.result.value : undefined;
}

async function sendRuntimeMessage(send, readContentContextId, message, timeoutMs = DEFAULT_STEP_TIMEOUT_MS) {
  const expression = `new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ __timeout: true, type: ${JSON.stringify(message.type)} }), ${timeoutMs});
    chrome.runtime.sendMessage(${JSON.stringify(message)}, (response) => {
      const runtimeError = chrome.runtime.lastError;
      clearTimeout(timer);
      if (runtimeError) {
        resolve({ __runtimeError: runtimeError.message, type: ${JSON.stringify(message.type)} });
      } else {
        resolve(response);
      }
    });
  })`;

  return evaluateInContext(send, readContentContextId, 'the extension content-script context', expression);
}

async function readOverlay(send, readContentContextId) {
  return evaluateInContext(
    send,
    readContentContextId,
    'the extension content-script context',
    `(() => {
      const host = document.getElementById('canvy-output-overlay-host');
      const mount = host?.shadowRoot?.querySelector('[data-canvy-overlay-root]');
      const shell = host?.shadowRoot?.querySelector('.mako-overlay-window');
      const shellText = shell?.innerText?.replace(/\\s+/g, ' ').trim() ?? '';
      const normalizedText = shellText.toLowerCase();
      const followUpInput = host?.shadowRoot?.querySelector('.mako-overlay-input');
      return {
        hasHost: Boolean(host),
        hasShadowRoot: Boolean(host?.shadowRoot),
        hasMount: Boolean(mount),
        hasShell: Boolean(shell),
        hasRecommendedAnswer: normalizedText.includes('recommended answer'),
        hasSuggestedNotes: normalizedText.includes('suggested notes'),
        followUpPlaceholder: followUpInput?.getAttribute('placeholder') ?? '',
        textPreview: shellText.slice(0, 320) ?? '',
        mountPreview: mount?.innerHTML?.slice(0, 600) ?? '',
        shadowPreview: host?.shadowRoot?.innerHTML?.slice(0, 600) ?? ''
      };
    })()`
  );
}

async function submitOverlayFollowUp(send, readContentContextId, text) {
  return evaluateInContext(
    send,
    readContentContextId,
    'the extension content-script context',
    `new Promise((resolve) => {
      const host = document.getElementById('canvy-output-overlay-host');
      const root = host?.shadowRoot;
      const input = root?.querySelector('.mako-overlay-input');
      const form = root?.querySelector('.mako-overlay-window__composer');
      if (!input || !form) {
        resolve({ ok: false, reason: 'overlay-composer-missing' });
        return;
      }

      input.focus();
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));

      setTimeout(() => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true, composed: true }));
        resolve({
          ok: true,
          placeholder: input.getAttribute('placeholder') ?? '',
          currentValue: input.value
        });
      }, 60);
    })`
  );
}

function countReadableWords(value) {
  return value.match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*/g)?.length ?? 0;
}

function isPlaceholderScanText(value) {
  return /image-based scan placeholder/i.test(value) || /configured ai provider is needed for ocr fallback/i.test(value);
}

function summarizeCheck(label, ok, detail) {
  return { label, ok, detail };
}

function printChecks(checks) {
  for (const check of checks) {
    const prefix = check.ok ? '[pass]' : '[fail]';
    console.log(`${prefix} ${check.label}${check.detail ? `: ${check.detail}` : ''}`);
  }
}

function printFailureDiagnostics(details) {
  console.log('');
  console.log('Failure diagnostics:');
  console.log(JSON.stringify(details, null, 2));
}

function launchBrowser(browserPath, extensionDir, profileDir, port, targetUrl) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    targetUrl
  ];

  return spawn(browserPath, args, {
    stdio: 'ignore',
    windowsHide: true
  });
}

async function closeBrowser(child) {
  if (!child?.pid) {
    return;
  }

  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      });
      killer.once('exit', resolve);
      killer.once('error', resolve);
    });
    return;
  }

  child.kill('SIGTERM');
}

async function waitForDebugger(port) {
  return waitFor('the browser debugger endpoint', async () => {
    try {
      const targets = await fetchJson(`http://localhost:${port}/json/list`);
      return Array.isArray(targets) ? targets : null;
    } catch {
      return null;
    }
  });
}

async function main() {
  ensureReadableFile(path.join(EXTENSION_DIR, 'manifest.json'));
  ensureReadableFile(path.join(EXTENSION_DIR, 'launcher.html'));
  ensureReadableFile(path.join(EXTENSION_DIR, 'sidepanel.html'));
  ensureReadableFile(path.join(EXTENSION_DIR, 'background.js'));
  ensureReadableFile(path.join(EXTENSION_DIR, 'content.js'));
  const manifest = JSON.parse(readFileSync(path.join(EXTENSION_DIR, 'manifest.json'), 'utf8'));
  const launcherBundle = readFileSync(path.join(EXTENSION_DIR, 'assets', 'launcher.js'), 'utf8');
  const backgroundBundle = readFileSync(path.join(EXTENSION_DIR, 'background.js'), 'utf8');

  const browserPath = findBrowserBinary();
  const health = EXPECT_BACKEND_OFFLINE ? null : await fetchJson(`${DEFAULT_API_BASE_URL}/health`);
  const profileDir = mkdtempSync(path.join(os.tmpdir(), 'canvy-smoke-'));
  const browser = launchBrowser(browserPath, EXTENSION_DIR, profileDir, DEFAULT_REMOTE_DEBUGGING_PORT, DEFAULT_TARGET_URL);

  if (!browser.pid) {
    throw new Error('The smoke browser did not start successfully.');
  }

  let session;

  try {
    await waitForDebugger(DEFAULT_REMOTE_DEBUGGING_PORT);
    session = await openPageSession(DEFAULT_REMOTE_DEBUGGING_PORT, DEFAULT_TARGET_URL);

    const contentInitialized = await evaluateInContext(
      session.send,
      session.getContentContextId,
      'the extension content-script context',
      'globalThis.__makoIqContentInitialized === true || globalThis.__canvyContentInitialized === true'
    );
    const popupStatus = await sendRuntimeMessage(session.send, session.getContentContextId, { type: 'GET_POPUP_STATUS' });
    const launchConfiguration = await sendRuntimeMessage(session.send, session.getContentContextId, {
      type: 'CANVY_GET_LAUNCH_CONFIGURATION',
      requestId: 'smoke-launch-config'
    });

    if (EXPECT_BACKEND_OFFLINE) {
      const scan = await sendRuntimeMessage(session.send, session.getContentContextId, {
        type: 'CANVY_SCAN_ACTIVE_PAGE',
        requestId: 'smoke-offline-scan',
        sourceType: 'reference'
      });
      const analyze = await sendRuntimeMessage(session.send, session.getContentContextId, {
        type: 'CANVY_ANALYZE_ACTIVE_PAGE',
        requestId: 'smoke-offline-analyze',
        instruction: ''
      });
      const bootstrapAfterOfflineAnalyze = await waitFor(
        'the offline analyze error state',
        async () => {
          const bootstrap = await sendRuntimeMessage(session.send, session.getContentContextId, {
            type: 'CANVY_GET_BOOTSTRAP',
            requestId: 'smoke-bootstrap-after-offline-analyze'
          });
          if (bootstrap?.session?.pageState?.uiStatus?.lifecycle === 'error') {
            return bootstrap;
          }

          return null;
        },
        DEFAULT_STEP_TIMEOUT_MS * 2,
        300
      );
      const offlineError =
        bootstrapAfterOfflineAnalyze?.session?.pageState?.errors?.analysis ??
        bootstrapAfterOfflineAnalyze?.session?.pageState?.uiStatus?.message ??
        analyze?.error ??
        '';
      const diagnostics = bootstrapAfterOfflineAnalyze?.session?.requestDiagnostics ?? [];
      const lastRequestError =
        [...diagnostics].reverse().find((entry) => entry.tag === 'sw:request:error') ??
        diagnostics[diagnostics.length - 1];
      const checks = [
        summarizeCheck(
          'manifest action opens workspace sidebar',
          !manifest?.action?.default_popup && manifest?.side_panel?.default_path === 'sidepanel.html',
          `popup=${manifest?.action?.default_popup ?? 'none'} sidePanel=${manifest?.side_panel?.default_path ?? 'none'}`
        ),
        summarizeCheck(
          'launcher bundle opens workspace directly',
          launcherBundle.includes('sidePanel.open') && launcherBundle.includes('sidePanel.setOptions'),
          'launcher bundle sidePanel API'
        ),
        summarizeCheck(
          'launcher bundle no longer delegates workspace open',
          !launcherBundle.includes('OPEN_SIDEPANEL'),
          'launcher bundle runtime message path'
        ),
        summarizeCheck(
          'background keeps workspace-first action behavior',
          backgroundBundle.includes('sidePanel.open') &&
            backgroundBundle.includes('openPanelOnActionClick') &&
            backgroundBundle.includes('setPopup'),
          'background workspace-first wiring'
        ),
        summarizeCheck('content bridge initialized', contentInitialized === true, session.extensionId),
        summarizeCheck('popup status', popupStatus?.isSupportedLaunchPage === true, popupStatus?.statusLabel ?? 'missing'),
        summarizeCheck(
          'workspace-first action behavior',
          launchConfiguration?.popupPath === '' &&
            launchConfiguration?.launcherPath === 'launcher.html' &&
            launchConfiguration?.openPanelOnActionClick === true,
          launchConfiguration
            ? `popup=${launchConfiguration.popupPath || 'none'} launcher=${launchConfiguration.launcherPath} openPanelOnActionClick=${String(launchConfiguration.openPanelOnActionClick)}`
            : 'missing launch configuration'
        ),
        summarizeCheck('offline scan still extracts page content', scan?.ok === true, scan?.message ?? 'missing scan response'),
        summarizeCheck('offline analyze fails clearly', analyze?.ok === false, analyze?.error ?? analyze?.message ?? 'missing analyze response'),
        summarizeCheck(
          'offline analyze is actionable',
          Boolean(offlineError && !/^Failed to fetch$/i.test(offlineError) && /(Backend offline|Wrong API URL|HTTP|CORS|req )/i.test(offlineError)),
          offlineError || 'missing actionable error'
        ),
        summarizeCheck(
          'offline diagnostic persisted',
          Boolean(lastRequestError?.tag === 'sw:request:error' && lastRequestError?.url && lastRequestError?.category),
          lastRequestError ? `${lastRequestError.category} ${lastRequestError.url}` : 'missing request diagnostic'
        ),
        summarizeCheck(
          'resolved api base source available',
          Boolean(bootstrapAfterOfflineAnalyze?.settings?.apiBaseUrlSource),
          bootstrapAfterOfflineAnalyze?.settings?.apiBaseUrlSource ?? 'missing'
        )
      ];

      const failures = checks.filter((check) => !check.ok);
      printChecks(checks);

      console.log('');
      console.log(`Browser: ${browserPath}`);
      console.log(`Profile: ${profileDir}`);
      console.log(`Target: ${DEFAULT_TARGET_URL}`);
      console.log(`Extension: ${session.extensionId}`);

      if (failures.length) {
        printFailureDiagnostics({
          popupStatus,
          launchConfiguration,
          scan,
          analyze,
          bootstrapAfterOfflineAnalyze: {
            settings: bootstrapAfterOfflineAnalyze?.settings,
            uiStatus: bootstrapAfterOfflineAnalyze?.session?.pageState?.uiStatus,
            errors: bootstrapAfterOfflineAnalyze?.session?.pageState?.errors,
            diagnostics
          }
        });
        console.log('');
        console.log('Smoke run failed.');
        process.exitCode = 1;
        return;
      }

      console.log('');
      console.log('Smoke run passed.');
      return;
    }

    const launcherOpen = await sendRuntimeMessage(session.send, session.getContentContextId, {
      type: 'CANVY_DEBUG_OPEN_LAUNCHER_WINDOW',
      requestId: 'smoke-launcher-open',
      windowId: popupStatus?.windowId
    });
    const launcherOpenAgain = await sendRuntimeMessage(session.send, session.getContentContextId, {
      type: 'CANVY_DEBUG_OPEN_LAUNCHER_WINDOW',
      requestId: 'smoke-launcher-focus',
      windowId: popupStatus?.windowId
    });
    const launcherWindowAfterMove = await sendRuntimeMessage(session.send, session.getContentContextId, {
      type: 'CANVY_DEBUG_UPDATE_LAUNCHER_WINDOW',
      requestId: 'smoke-launcher-move',
      bounds: {
        left: (launcherOpen?.left ?? 60) + 28,
        top: (launcherOpen?.top ?? 60) + 24,
        width: Math.max(420, (launcherOpen?.width ?? 440) + 36),
        height: Math.max(560, (launcherOpen?.height ?? 720) - 32)
      }
    });
    const launcherInspectAfterMove = await sendRuntimeMessage(session.send, session.getContentContextId, {
      type: 'CANVY_DEBUG_GET_LAUNCHER_WINDOW',
      requestId: 'smoke-launcher-inspect-after-move'
    });
    const launcherStoredState = launcherInspectAfterMove?.stored
      ? { 'makoiq.launcherWindow': launcherInspectAfterMove.stored }
      : null;
    const launcherClose = await sendRuntimeMessage(session.send, session.getContentContextId, {
      type: 'CANVY_DEBUG_CLOSE_LAUNCHER_WINDOW',
      requestId: 'smoke-launcher-close'
    });
    const launcherReopen = await sendRuntimeMessage(session.send, session.getContentContextId, {
      type: 'CANVY_DEBUG_OPEN_LAUNCHER_WINDOW',
      requestId: 'smoke-launcher-reopen',
      windowId: popupStatus?.windowId
    });
    const launcherWindowAfterReopen = await sendRuntimeMessage(session.send, session.getContentContextId, {
      type: 'CANVY_DEBUG_GET_LAUNCHER_WINDOW',
      requestId: 'smoke-launcher-inspect-after-reopen'
    });
    const launchConfigurationAfterOpen = await sendRuntimeMessage(session.send, session.getContentContextId, {
      type: 'CANVY_GET_LAUNCH_CONFIGURATION',
      requestId: 'smoke-launch-config-after-open'
    });
    const launcherCloseBeforeAnalyze = await sendRuntimeMessage(session.send, session.getContentContextId, {
      type: 'CANVY_DEBUG_CLOSE_LAUNCHER_WINDOW',
      requestId: 'smoke-launcher-close-before-analyze'
    });

    const popupAnalyzeStart = await sendRuntimeMessage(session.send, session.getContentContextId, {
      type: 'CANVY_START_ANALYSIS_RUN',
      requestId: 'smoke-popup-analyze',
      instruction: ''
    });
    let popupStreamingBootstrap;
    try {
      popupStreamingBootstrap = await waitFor(
        'the popup streaming state',
        async () => {
          const bootstrap = await sendRuntimeMessage(session.send, session.getContentContextId, {
            type: 'CANVY_GET_BOOTSTRAP',
            requestId: 'smoke-bootstrap-during-popup-analyze'
          });
          const analysisRun = bootstrap?.session?.analysisRun;
          if (analysisRun?.phase === 'streaming' && analysisRun?.partialText) {
            return bootstrap;
          }

          return null;
        },
        DEFAULT_STEP_TIMEOUT_MS,
        200
      );
    } catch {
      popupStreamingBootstrap = await sendRuntimeMessage(session.send, session.getContentContextId, {
        type: 'CANVY_GET_BOOTSTRAP',
        requestId: 'smoke-bootstrap-after-stream-timeout'
      });
    }
    const bootstrapAfterPopupAnalyze = await waitFor(
      'the popup analysis result',
      async () => {
        const bootstrap = await sendRuntimeMessage(session.send, session.getContentContextId, {
          type: 'CANVY_GET_BOOTSTRAP',
          requestId: 'smoke-bootstrap-after-popup-analyze'
        });
        const lifecycle = bootstrap?.session?.pageState?.uiStatus?.lifecycle;
        if (lifecycle === 'error') {
          return bootstrap;
        }

        if (lifecycle === 'ready' && bootstrap?.session?.pageState?.analysis) {
          return bootstrap;
        }

        return null;
      },
      DEFAULT_STEP_TIMEOUT_MS,
      400
    );
    const cachedAnalyzeStart = await sendRuntimeMessage(session.send, session.getContentContextId, {
      type: 'CANVY_START_ANALYSIS_RUN',
      requestId: 'smoke-cached-analyze',
      instruction: ''
    });
    const bootstrapAfterCachedAnalyze = await waitFor(
      'the cached popup analysis result',
      async () => {
        const bootstrap = await sendRuntimeMessage(session.send, session.getContentContextId, {
          type: 'CANVY_GET_BOOTSTRAP',
          requestId: 'smoke-bootstrap-after-cached-analyze'
        });
        const lifecycle = bootstrap?.session?.pageState?.uiStatus?.lifecycle;
        const analysis = bootstrap?.session?.pageState?.analysis;
        if (lifecycle === 'error') {
          return bootstrap;
        }

        if (lifecycle === 'ready' && analysis?.requestId === 'smoke-cached-analyze' && analysis?.cacheStatus === 'hit') {
          return bootstrap;
        }

        return null;
      },
      DEFAULT_STEP_TIMEOUT_MS,
      400
    );
    const scan = await sendRuntimeMessage(session.send, session.getContentContextId, {
      type: 'CANVY_SCAN_ACTIVE_PAGE',
      requestId: 'smoke-scan',
      sourceType: 'reference'
    });
    const bootstrapAfterScan = await sendRuntimeMessage(session.send, session.getContentContextId, {
      type: 'CANVY_GET_BOOTSTRAP',
      requestId: 'smoke-bootstrap-after-scan'
    });
    const workflowState =
      bootstrapAfterCachedAnalyze?.session?.workflowState ??
      bootstrapAfterScan?.session?.workflowState ??
      null;
    const workflowAction = workflowState?.actionCards?.[0];
    if (!workflowAction?.task || !workflowAction.id) {
      throw new Error('No workflow action card was available after analyze/scan.');
    }

    const workflow = await sendRuntimeMessage(session.send, session.getContentContextId, {
      type: 'CANVY_START_WORKFLOW_ACTION',
      requestId: 'smoke-workflow',
      task: workflowAction.task,
      actionId: workflowAction.id,
      extraInstructions: ''
    });

    await sleep(1200);

    const overlay = await readOverlay(session.send, session.getContentContextId);
    const overlayFollowUpText = 'What should I remember from this page?';
    const overlayFollowUpSubmit = await submitOverlayFollowUp(session.send, session.getContentContextId, overlayFollowUpText);
    let overlayFollowUpStreaming = null;
    try {
      overlayFollowUpStreaming = await waitFor(
        'the overlay follow-up streaming state',
        async () => {
          const bootstrap = await sendRuntimeMessage(session.send, session.getContentContextId, {
            type: 'CANVY_GET_BOOTSTRAP',
            requestId: 'smoke-bootstrap-after-overlay-followup'
          });
          const analysisRun = bootstrap?.session?.analysisRun;
          if (analysisRun?.instruction === overlayFollowUpText && analysisRun?.phase === 'streaming' && analysisRun?.partialText) {
            return bootstrap;
          }

          return null;
        },
        DEFAULT_STEP_TIMEOUT_MS,
        200
      );
    } catch {}
    let overlayFollowUpCompleted = null;
    try {
      overlayFollowUpCompleted = await waitFor(
        'the overlay follow-up result',
        async () => {
          const bootstrap = await sendRuntimeMessage(session.send, session.getContentContextId, {
            type: 'CANVY_GET_BOOTSTRAP',
            requestId: 'smoke-bootstrap-complete-overlay-followup'
          });
          const analysisRun = bootstrap?.session?.analysisRun;
          if (
            bootstrap?.session?.pageState?.uiStatus?.lifecycle === 'ready' &&
            analysisRun?.instruction === overlayFollowUpText &&
            analysisRun?.phase === 'completed' &&
            bootstrap?.session?.pageState?.analysis
          ) {
            return bootstrap;
          }

          if (bootstrap?.session?.pageState?.uiStatus?.lifecycle === 'error') {
            return bootstrap;
          }

          return null;
        },
        DEFAULT_STEP_TIMEOUT_MS,
        300
      );
    } catch {
      overlayFollowUpCompleted = await sendRuntimeMessage(session.send, session.getContentContextId, {
        type: 'CANVY_GET_BOOTSTRAP',
        requestId: 'smoke-bootstrap-timeout-overlay-followup'
      });
    }
    const overlayAfterFollowUp = await readOverlay(session.send, session.getContentContextId);
    const reconnect = await sendRuntimeMessage(session.send, session.getContentContextId, {
      type: 'CANVY_RECONNECT_BACKEND'
    });
    const finalBootstrap = await sendRuntimeMessage(session.send, session.getContentContextId, {
      type: 'CANVY_GET_BOOTSTRAP',
      requestId: 'smoke-final-bootstrap'
    });

    const scannedPage = scan?.page ?? bootstrapAfterScan?.session?.latestScan ?? bootstrapAfterScan?.session?.pageState?.scan;
    const finalOverlayStatus = finalBootstrap?.session?.overlayStatus;
    const storedLauncherWindow = launcherStoredState?.['makoiq.launcherWindow'];
    const reopenedMatchesStoredBounds =
      typeof storedLauncherWindow?.left === 'number' &&
      typeof storedLauncherWindow?.top === 'number' &&
      typeof storedLauncherWindow?.width === 'number' &&
      typeof storedLauncherWindow?.height === 'number' &&
      Math.abs((launcherReopen?.left ?? 0) - storedLauncherWindow.left) <= 2 &&
      Math.abs((launcherReopen?.top ?? 0) - storedLauncherWindow.top) <= 2 &&
      Math.abs((launcherReopen?.width ?? 0) - storedLauncherWindow.width) <= 2 &&
      Math.abs((launcherReopen?.height ?? 0) - storedLauncherWindow.height) <= 2;
      const checks = [
        summarizeCheck(
          'manifest action opens workspace sidebar',
          !manifest?.action?.default_popup && manifest?.side_panel?.default_path === 'sidepanel.html',
          `popup=${manifest?.action?.default_popup ?? 'none'} sidePanel=${manifest?.side_panel?.default_path ?? 'none'}`
        ),
      summarizeCheck(
        'launcher bundle opens workspace directly',
        launcherBundle.includes('sidePanel.open') && launcherBundle.includes('sidePanel.setOptions'),
        'launcher bundle sidePanel API'
      ),
      summarizeCheck(
        'launcher bundle no longer delegates workspace open',
        !launcherBundle.includes('OPEN_SIDEPANEL'),
        'launcher bundle runtime message path'
      ),
      summarizeCheck(
        'background keeps workspace-first action behavior',
        backgroundBundle.includes('sidePanel.open') &&
          backgroundBundle.includes('openPanelOnActionClick') &&
          backgroundBundle.includes('setPopup'),
        'background workspace-first wiring'
      ),
      summarizeCheck('backend health', health?.ok === true, `service=${health?.service ?? 'unknown'}`),
      summarizeCheck('content bridge initialized', contentInitialized === true, session.extensionId),
      summarizeCheck('popup status', popupStatus?.isSupportedLaunchPage === true, popupStatus?.statusLabel ?? 'missing'),
      summarizeCheck(
        'workspace-first action behavior',
        launchConfiguration?.popupPath === '' &&
          launchConfiguration?.launcherPath === 'launcher.html' &&
          launchConfiguration?.openPanelOnActionClick === true,
        launchConfiguration
          ? `popup=${launchConfiguration.popupPath || 'none'} launcher=${launchConfiguration.launcherPath} openPanelOnActionClick=${String(launchConfiguration.openPanelOnActionClick)}`
          : 'missing launch configuration'
      ),
      summarizeCheck(
        'launcher window opens',
        launcherOpen?.ok === true && typeof launcherOpen?.windowId === 'number',
        launcherOpen?.error ?? `windowId=${launcherOpen?.windowId ?? 'missing'}`
      ),
      summarizeCheck(
        'launcher window stays single-instance',
        launcherOpenAgain?.ok === true &&
          launcherOpenAgain?.windowId === launcherOpen?.windowId &&
          launchConfigurationAfterOpen?.launcherWindowId === launcherReopen?.windowId,
        launcherOpenAgain?.error ??
          `windowId=${launcherOpenAgain?.windowId ?? 'missing'} reopen=${launcherReopen?.windowId ?? 'missing'} launchConfig=${launchConfigurationAfterOpen?.launcherWindowId ?? 'missing'}`
      ),
      summarizeCheck(
        'launch configuration reports live launcher window',
        typeof launchConfigurationAfterOpen?.launcherWindowId === 'number' &&
          launchConfigurationAfterOpen?.launcherPath === 'launcher.html',
        launchConfigurationAfterOpen
          ? `launcher=${launchConfigurationAfterOpen.launcherPath} windowId=${launchConfigurationAfterOpen.launcherWindowId ?? 'missing'}`
          : 'missing launch configuration'
      ),
      summarizeCheck(
        'popup analyze request',
        popupAnalyzeStart?.ok === true,
        popupAnalyzeStart?.message ?? popupAnalyzeStart?.error ?? 'missing popup start response'
      ),
      summarizeCheck(
        'popup analyze persisted state',
        Boolean(
          bootstrapAfterPopupAnalyze?.session?.pageState?.analysis &&
            bootstrapAfterPopupAnalyze?.session?.pageState?.uiStatus?.lifecycle === 'ready'
        ),
        bootstrapAfterPopupAnalyze?.session?.pageState?.uiStatus?.lifecycle ?? 'missing'
      ),
      summarizeCheck(
        'popup analyze state available',
        Boolean(
          popupStreamingBootstrap?.session?.analysisRun?.partialText ||
            bootstrapAfterPopupAnalyze?.session?.pageState?.analysis
        ),
        popupStreamingBootstrap?.session?.analysisRun?.phase ??
          bootstrapAfterPopupAnalyze?.session?.pageState?.uiStatus?.lifecycle ??
          'missing'
      ),
      summarizeCheck(
        'repeat analyze request',
        cachedAnalyzeStart?.ok === true,
        cachedAnalyzeStart?.message ?? cachedAnalyzeStart?.error ?? 'missing repeat analysis'
      ),
      summarizeCheck(
        'repeat analyze cache hit',
        bootstrapAfterCachedAnalyze?.session?.pageState?.analysis?.cacheStatus === 'hit',
        bootstrapAfterCachedAnalyze?.session?.pageState?.analysis?.cacheStatus ?? 'missing'
      ),
      summarizeCheck('scan step', scan?.ok === true, scannedPage?.sourceMode ?? 'missing scan'),
      summarizeCheck(
        'scan preserved useful DOM text',
        Boolean(scannedPage?.sourceMode === 'dom' && !isPlaceholderScanText(scannedPage.readableText ?? '')),
        scannedPage?.sourceMode === 'dom'
          ? `${countReadableWords(scannedPage.readableText ?? '')} words`
          : scannedPage?.sourceMode ?? 'missing scan mode'
      ),
      summarizeCheck('workflow action available', Boolean(workflowAction?.id && workflowAction?.task), workflowAction?.label ?? 'missing'),
      summarizeCheck('workflow step', workflow?.ok === true, workflowAction.label),
      summarizeCheck('overlay rendered', Boolean(overlay?.hasHost && overlay?.textPreview), overlay?.textPreview || 'overlay missing'),
      summarizeCheck(
        'overlay answer hierarchy',
        Boolean(overlay?.hasRecommendedAnswer && overlay?.hasSuggestedNotes),
        overlay?.textPreview || 'missing overlay labels'
      ),
      summarizeCheck(
        'overlay follow-up input',
        overlay?.followUpPlaceholder === 'Ask a follow-up...',
        overlay?.followUpPlaceholder || 'missing placeholder'
      ),
      summarizeCheck(
        'overlay follow-up submit',
        overlayFollowUpSubmit?.ok === true,
        overlayFollowUpSubmit?.reason ?? overlayFollowUpSubmit?.placeholder ?? 'missing overlay submit'
      ),
      summarizeCheck(
        'overlay follow-up state available',
        Boolean(
          overlayFollowUpStreaming?.session?.analysisRun?.partialText ||
            overlayFollowUpCompleted?.session?.pageState?.analysis
        ),
        overlayFollowUpStreaming?.session?.analysisRun?.phase ??
          overlayFollowUpCompleted?.session?.pageState?.uiStatus?.lifecycle ??
          'missing'
      ),
      summarizeCheck(
        'overlay follow-up result',
        Boolean(
          overlayFollowUpCompleted?.session?.pageState?.uiStatus?.lifecycle === 'ready' &&
            overlayFollowUpCompleted?.session?.analysisRun?.phase === 'completed'
        ),
        overlayFollowUpCompleted?.session?.pageState?.uiStatus?.lifecycle ?? 'missing'
      ),
      summarizeCheck(
        'overlay updated after follow-up',
        Boolean(overlayAfterFollowUp?.hasRecommendedAnswer),
        overlayAfterFollowUp?.textPreview || 'overlay missing after follow-up'
      ),
      summarizeCheck('reconnect step', reconnect?.ok === true, reconnect?.backendConnection?.state ?? 'missing'),
      summarizeCheck('final backend state', finalBootstrap?.settings?.backendConnection?.state === 'connected', finalBootstrap?.settings?.backendConnection?.state ?? 'missing'),
      summarizeCheck('resolved api base source', Boolean(finalBootstrap?.settings?.apiBaseUrlSource), finalBootstrap?.settings?.apiBaseUrlSource ?? 'missing'),
      summarizeCheck('final overlay status', finalOverlayStatus?.state === 'shown', finalOverlayStatus?.message ?? 'missing')
    ];

    const failures = checks.filter((check) => !check.ok);
    printChecks(checks);

    console.log('');
    console.log(`Browser: ${browserPath}`);
    console.log(`Profile: ${profileDir}`);
    console.log(`Target: ${DEFAULT_TARGET_URL}`);
    console.log(`Extension: ${session.extensionId}`);

    if (failures.length) {
        printFailureDiagnostics({
          popupStatus,
          launchConfiguration,
          launcherOpen,
          launcherOpenAgain,
          launcherWindowAfterMove,
          launcherInspectAfterMove,
          launcherClose,
          launcherReopen,
          launcherWindowAfterReopen,
          launchConfigurationAfterOpen,
          popupAnalyzeStart,
          popupStreamingBootstrap: {
            analysisRun: popupStreamingBootstrap?.session?.analysisRun,
          uiStatus: popupStreamingBootstrap?.session?.pageState?.uiStatus
        },
        bootstrapAfterPopupAnalyze: {
          uiStatus: bootstrapAfterPopupAnalyze?.session?.pageState?.uiStatus,
          errors: bootstrapAfterPopupAnalyze?.session?.pageState?.errors,
          analysis: bootstrapAfterPopupAnalyze?.session?.pageState?.analysis,
          backendConnection: bootstrapAfterPopupAnalyze?.settings?.backendConnection
        },
        cachedAnalyzeStart,
        bootstrapAfterCachedAnalyze: {
          uiStatus: bootstrapAfterCachedAnalyze?.session?.pageState?.uiStatus,
          errors: bootstrapAfterCachedAnalyze?.session?.pageState?.errors,
          analysis: bootstrapAfterCachedAnalyze?.session?.pageState?.analysis,
          backendConnection: bootstrapAfterCachedAnalyze?.settings?.backendConnection
        },
        bootstrapAfterScan: {
          uiStatus: bootstrapAfterScan?.session?.pageState?.uiStatus,
          errors: bootstrapAfterScan?.session?.pageState?.errors,
          analysis: bootstrapAfterScan?.session?.pageState?.analysis,
          workflowState: bootstrapAfterScan?.session?.workflowState,
          backendConnection: bootstrapAfterScan?.settings?.backendConnection
        },
        workflow,
        reconnect,
        finalBootstrap: {
          uiStatus: finalBootstrap?.session?.pageState?.uiStatus,
          errors: finalBootstrap?.session?.pageState?.errors,
          analysis: finalBootstrap?.session?.pageState?.analysis,
          backendConnection: finalBootstrap?.settings?.backendConnection,
          overlayStatus: finalBootstrap?.session?.overlayStatus
        },
        overlay,
        overlayFollowUpSubmit,
        overlayFollowUpStreaming: {
          analysisRun: overlayFollowUpStreaming?.session?.analysisRun,
          uiStatus: overlayFollowUpStreaming?.session?.pageState?.uiStatus
        },
        overlayFollowUpCompleted: {
          analysisRun: overlayFollowUpCompleted?.session?.analysisRun,
          uiStatus: overlayFollowUpCompleted?.session?.pageState?.uiStatus,
          analysis: overlayFollowUpCompleted?.session?.pageState?.analysis
        },
        overlayAfterFollowUp
      });
      console.log('');
      console.log('Smoke run failed.');
      process.exitCode = 1;
      return;
    }

    console.log('');
    console.log('Smoke run passed.');
  } finally {
    session?.ws.close();
    if (!KEEP_BROWSER_OPEN) {
      await closeBrowser(browser);
    }
  }
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
