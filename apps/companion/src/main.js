import { app, BrowserWindow, Menu, Tray, clipboard, ipcMain, nativeImage, shell } from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const companionRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(companionRoot, '..', '..');
const LOCAL_BACKEND_ORIGIN = 'http://127.0.0.1:8787';
const HEALTH_URL = `${LOCAL_BACKEND_ORIGIN}/health`;
const AI_HEALTH_URL = `${LOCAL_BACKEND_ORIGIN}/health/ai`;
const SCREEN_ANALYSIS_URL = `${LOCAL_BACKEND_ORIGIN}/api/screen/analyze`;
const DEFAULT_KIMI_BASE_URL = 'https://api.moonshot.ai/v1';
const DEFAULT_KIMI_MODEL = 'kimi-k2.6';
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const EXTENSION_ORIGIN = 'chrome-extension://himeagaboplmdgfhajkiipplhoklbooa';
const LOGIN_HIDDEN_ARG = '--mako-start-hidden';
const WINDOWS_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const WINDOWS_RUN_VALUE = 'MakoIQCompanion';
const LEGACY_WINDOWS_RUN_VALUE = 'electron.app.Electron';

let mainWindow = null;
let tray = null;
let isQuitting = false;
let backendProcess = null;
let backendLogStream = null;
let companionLogStream = null;
let configPath = '';
let logDir = '';
let backendLogPath = '';
let companionLogPath = '';
let restartAttempts = [];
let restartTimer = null;
let statusPollTimer = null;

const state = {
  aiProvider: 'kimi',
  backend: {
    state: 'stopped',
    pid: null,
    ownedByCompanion: false,
    port: 8787,
    lastError: '',
    lastStartedAt: null,
    recentExit: null
  },
  kimi: {
    configured: false,
    apiKeyLoaded: false,
    baseUrl: DEFAULT_KIMI_BASE_URL,
    model: DEFAULT_KIMI_MODEL,
    testCallSucceeded: null,
    screenTestSucceeded: null,
    lastError: '',
    checkedAt: null
  },
  ollama: {
    enabled: false,
    reachable: false,
    executablePath: '',
    selectedModel: '',
    modelInstalled: false,
    visionModel: process.env.OLLAMA_VISION_MODEL || '',
    visionModelInstalled: null,
    models: [],
    lastError: '',
    checkedAt: null
  },
  extensionConnected: false,
  lastExtensionRequestAt: null,
  lastAiRequest: null,
  launchAtLogin: false,
  pull: {
    running: false,
    model: '',
    lastStatus: ''
  },
  paths: {
    backendLogPath: '',
    companionLogPath: '',
    logDir: ''
  }
};

function readConfig() {
  if (!configPath || !existsSync(configPath)) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(patch) {
  const current = readConfig();
  writeFileSync(configPath, JSON.stringify({ ...current, ...patch }, null, 2));
}

function writeLog(source, message, detail = undefined) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    source,
    message,
    detail
  });

  if (source === 'backend') {
    backendLogStream?.write(`${line}\n`);
  } else {
    companionLogStream?.write(`${line}\n`);
  }
}

function parseEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }

  const parsed = {};
  for (const rawLine of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex < 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }

  return parsed;
}

function readBackendEnvFiles() {
  const files = [path.join(repoRoot, '.env'), path.join(getBackendRoot(), '.env')];
  const values = {};

  for (const filePath of files) {
    Object.assign(values, parseEnvFile(filePath));
  }

  return {
    files,
    values
  };
}

function normalizeAiProvider(value) {
  const normalized = String(value || 'kimi').trim().toLowerCase();
  return normalized === 'moonshot' ? 'kimi' : normalized || 'kimi';
}

function maskSecret(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return '';
  }

  return `${trimmed.slice(0, 3)}...${trimmed.slice(-4)}`;
}

function readBackendEnvDefaults() {
  const fileEnv = readBackendEnvFiles().values;
  const value = (name, fallback = '') => process.env[name] || fileEnv[name] || fallback;
  const kimiBaseUrl = value('KIMI_BASE_URL') || value('MOONSHOT_BASE_URL') || DEFAULT_KIMI_BASE_URL;
  const kimiModel = value('KIMI_MODEL') || value('MOONSHOT_MODEL') || DEFAULT_KIMI_MODEL;
  const ollamaBaseUrl = value('OLLAMA_BASE_URL') || DEFAULT_OLLAMA_BASE_URL;
  const ollamaModel = value('OLLAMA_MODEL');

  return {
    fileEnv,
    aiProvider: normalizeAiProvider(value('AI_PROVIDER', 'kimi')),
    host: value('HOST', '127.0.0.1'),
    port: value('PORT', '8787'),
    appUrl: value('APP_URL', LOCAL_BACKEND_ORIGIN),
    kimiBaseUrl,
    kimiModel,
    moonshotBaseUrl: value('MOONSHOT_BASE_URL') || kimiBaseUrl,
    moonshotModel: value('MOONSHOT_MODEL') || kimiModel,
    moonshotApiKey: value('MOONSHOT_API_KEY'),
    ollamaBaseUrl,
    ollamaModel,
    ollamaVisionModel: value('OLLAMA_VISION_MODEL'),
    ollamaKeepAlive: value('OLLAMA_KEEP_ALIVE', '10m')
  };
}

function syncConfiguredAiState() {
  const defaults = readBackendEnvDefaults();
  state.aiProvider = defaults.aiProvider;
  state.kimi.baseUrl = defaults.kimiBaseUrl;
  state.kimi.model = defaults.kimiModel;
  state.kimi.apiKeyLoaded = Boolean(defaults.moonshotApiKey);
  state.kimi.configured = defaults.aiProvider === 'kimi' && Boolean(defaults.moonshotApiKey);
  if (defaults.aiProvider === 'kimi' && !defaults.moonshotApiKey) {
    state.kimi.lastError = 'MOONSHOT_API_KEY is missing from the backend environment.';
  } else if (state.kimi.lastError === 'MOONSHOT_API_KEY is missing from the backend environment.') {
    state.kimi.lastError = '';
  }
  state.ollama.enabled = defaults.aiProvider === 'ollama';
  state.ollama.selectedModel = defaults.ollamaModel;
  state.ollama.visionModel = defaults.ollamaVisionModel;
  state.pull.model = defaults.ollamaModel;
}

function emitStatus() {
  state.launchAtLogin = getLaunchAtLogin();
  state.paths = { backendLogPath, companionLogPath, logDir };
  mainWindow?.webContents.send('status:update', state);
  updateTrayMenu();
}

function getBackendRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, 'backend') : path.join(repoRoot, 'backend');
}

function getIconImage() {
  const packagedIcon = path.join(process.resourcesPath ?? '', 'public', 'icons', 'icon-32.png');
  const devIcon = path.join(repoRoot, 'public', 'icons', 'icon-32.png');
  const iconPath = existsSync(packagedIcon) ? packagedIcon : devIcon;
  const image = nativeImage.createFromPath(iconPath);

  if (!image.isEmpty()) {
    return image;
  }

  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAI0lEQVR4AWP4z8Dwn4ECwESJ5lEDRg0YNWDUgFEDhgAAf5sCH2oacWkAAAAASUVORK5CYII='
  );
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 860,
    height: 640,
    minWidth: 720,
    minHeight: 520,
    title: 'Mako IQ Companion',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('close', (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    mainWindow.hide();
  });
}

function showWindow() {
  if (!mainWindow) {
    createWindow();
  }

  mainWindow.show();
  mainWindow.focus();
  emitStatus();
}

function createTray() {
  tray = new Tray(getIconImage());
  tray.setToolTip('Mako IQ Companion');
  tray.on('click', showWindow);
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) {
    return;
  }

  const backendLabel = state.backend.state === 'running' ? 'Running' : state.backend.state === 'starting' ? 'Starting' : 'Stopped';
  const loginLabel = getLaunchAtLogin() ? 'On' : 'Off';
  const kimiLabel = state.aiProvider === 'kimi'
    ? state.kimi.apiKeyLoaded
      ? 'Configured'
      : 'Missing API key'
    : 'Disabled';
  const ollamaLabel = state.ollama.enabled
    ? state.ollama.reachable
      ? 'Running'
      : 'Stopped'
    : 'Optional';
  const template = [
    { label: 'Open Mako IQ Companion', click: showWindow },
    { type: 'separator' },
    { label: `Backend: ${backendLabel}`, enabled: false },
    { label: `Kimi: ${kimiLabel}`, enabled: false },
    { label: 'Start Backend', click: () => void startBackend(true), enabled: state.backend.state !== 'running' && state.backend.state !== 'starting' },
    { label: 'Stop Backend', click: () => void stopBackend(true), enabled: state.backend.state === 'running' && state.backend.ownedByCompanion },
    { label: 'Restart Backend', click: () => void restartBackend(), enabled: state.backend.state !== 'starting' },
    { label: 'Test Kimi Connection', click: () => void testKimiConnection(), enabled: state.backend.state === 'running' },
    { type: 'separator' },
    { label: `Optional Ollama: ${ollamaLabel}`, enabled: false },
    { label: 'Check Ollama', click: () => void checkOllama(true) },
    { label: 'Pull/Install Ollama Model', click: () => void pullSelectedModel(), enabled: !state.pull.running && Boolean(state.ollama.selectedModel) },
    { type: 'separator' },
    { label: 'Open Logs', click: () => void openLogs() },
    { label: 'Open Local Health Check', click: () => void shell.openExternal(HEALTH_URL) },
    {
      label: `Launch at Login: ${loginLabel}`,
      click: () => {
        setLaunchAtLogin(!getLaunchAtLogin());
        emitStatus();
      }
    },
    { type: 'separator' },
    { label: 'Quit', click: () => void quitApp() }
  ];

  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function getLoginItemOptions(openAtLogin = true) {
  return {
    openAtLogin,
    path: process.execPath,
    args: app.isPackaged ? [LOGIN_HIDDEN_ARG] : [companionRoot, LOGIN_HIDDEN_ARG]
  };
}

function quoteCommandPart(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function buildWindowsStartupCommand() {
  const options = getLoginItemOptions();
  return [quoteCommandPart(options.path), ...options.args.map((arg) => quoteCommandPart(arg))].join(' ');
}

function runRegistryCommand(args) {
  const result = spawnSync('reg.exe', args, {
    encoding: 'utf8',
    windowsHide: true
  });
  return result.status === 0;
}

function getWindowsLaunchAtLogin() {
  return runRegistryCommand(['query', WINDOWS_RUN_KEY, '/v', WINDOWS_RUN_VALUE]);
}

function setWindowsLaunchAtLogin(openAtLogin) {
  runRegistryCommand(['delete', WINDOWS_RUN_KEY, '/v', LEGACY_WINDOWS_RUN_VALUE, '/f']);
  if (!openAtLogin) {
    runRegistryCommand(['delete', WINDOWS_RUN_KEY, '/v', WINDOWS_RUN_VALUE, '/f']);
    return;
  }

  runRegistryCommand([
    'add',
    WINDOWS_RUN_KEY,
    '/v',
    WINDOWS_RUN_VALUE,
    '/t',
    'REG_SZ',
    '/d',
    buildWindowsStartupCommand(),
    '/f'
  ]);
}

function getLaunchAtLogin() {
  if (process.platform === 'win32') {
    return getWindowsLaunchAtLogin();
  }

  return app.getLoginItemSettings(getLoginItemOptions()).openAtLogin;
}

function setLaunchAtLogin(openAtLogin) {
  if (process.platform === 'win32') {
    setWindowsLaunchAtLogin(openAtLogin);
  } else {
    app.setLoginItemSettings({ openAtLogin: false, path: process.execPath });
    app.setLoginItemSettings(getLoginItemOptions(openAtLogin));
  }
  writeConfig({ launchAtLogin: openAtLogin });
  state.launchAtLogin = openAtLogin;
  writeLog('companion', 'launch-at-login updated', {
    openAtLogin,
    path: process.execPath,
    args: getLoginItemOptions().args,
    windowsStartupCommand: process.platform === 'win32' ? buildWindowsStartupCommand() : undefined
  });
}

function buildBackendEnv() {
  const defaults = readBackendEnvDefaults();
  return {
    ...defaults.fileEnv,
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    HOST: defaults.host,
    PORT: defaults.port,
    APP_URL: defaults.appUrl,
    AI_PROVIDER: defaults.aiProvider,
    KIMI_BASE_URL: defaults.kimiBaseUrl,
    KIMI_MODEL: defaults.kimiModel,
    MOONSHOT_BASE_URL: defaults.moonshotBaseUrl,
    MOONSHOT_MODEL: defaults.moonshotModel,
    MOONSHOT_API_KEY: defaults.moonshotApiKey,
    OLLAMA_BASE_URL: defaults.ollamaBaseUrl,
    OLLAMA_MODEL: defaults.ollamaModel,
    OLLAMA_VISION_MODEL: defaults.ollamaVisionModel,
    OLLAMA_KEEP_ALIVE: defaults.ollamaKeepAlive,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || defaults.fileEnv.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173',
    ALLOWED_EXTENSION_ORIGINS: process.env.ALLOWED_EXTENSION_ORIGINS || defaults.fileEnv.ALLOWED_EXTENSION_ORIGINS || EXTENSION_ORIGIN,
    ALLOW_ALL_EXTENSION_ORIGINS: process.env.ALLOW_ALL_EXTENSION_ORIGINS || defaults.fileEnv.ALLOW_ALL_EXTENSION_ORIGINS || 'false',
    ALLOW_ANONYMOUS_USAGE: process.env.ALLOW_ANONYMOUS_USAGE || defaults.fileEnv.ALLOW_ANONYMOUS_USAGE || 'true'
  };
}

function getBackendLaunchSpec() {
  const backendRoot = getBackendRoot();
  const builtEntry = path.join(backendRoot, 'dist', 'server.js');

  if (existsSync(builtEntry)) {
    return {
      command: process.execPath,
      args: [builtEntry],
      cwd: backendRoot,
      env: buildBackendEnv()
    };
  }

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const devEnv = buildBackendEnv();
  delete devEnv.ELECTRON_RUN_AS_NODE;

  return {
    command: npmCommand,
    args: ['run', 'dev'],
    cwd: backendRoot,
    env: devEnv
  };
}

async function fetchJson(url, timeoutMs = 2_000, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      parsed: text ? JSON.parse(text) : null,
      text
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function createScreenAnalysisSmokePayload() {
  const viewport = { width: 1280, height: 720, devicePixelRatio: 1, scrollX: 0, scrollY: 0 };
  return {
    image:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
    pageUrl: 'https://mako-iq.local/health-check',
    pageTitle: 'Mako IQ Kimi Screen Test',
    viewport,
    mode: 'find_questions_and_answer',
    imageMeta: {
      format: 'png',
      source: 'dom_context',
      width: 1,
      height: 1,
      bytes: 68,
      resized: false
    },
    textContext: {
      pageTitle: 'Mako IQ Kimi Screen Test',
      pageUrl: 'https://mako-iq.local/health-check',
      selectedText: '',
      visibleText: 'Question: What is 2 + 2? A. 3 B. 4 C. 5',
      headings: ['Quiz'],
      labels: [],
      questionCandidates: [
        {
          question: 'What is 2 + 2?',
          answerChoices: ['A. 3', 'B. 4', 'C. 5'],
          nearbyText: ['Question: What is 2 + 2? A. 3 B. 4 C. 5'],
          bbox: { x: 0.2, y: 0.2, width: 0.4, height: 0.2 }
        }
      ],
      viewport,
      capturedAt: new Date().toISOString()
    },
    debug: true
  };
}

async function testKimiScreenAnalysis() {
  const result = await fetchJson(SCREEN_ANALYSIS_URL, 35_000, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(createScreenAnalysisSmokePayload())
  });
  const parsed = result.parsed ?? {};
  if (!result.ok || !parsed.ok) {
    throw new Error(parsed.message || parsed.error || `Kimi screen-analysis test returned HTTP ${result.status}.`);
  }

  return parsed;
}

function canConnectToPort(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    const done = (connected) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(800);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function inspectBackendPort() {
  try {
    const health = await fetchJson(HEALTH_URL, 1_500);
    if (health.parsed?.service === 'mako-iq-backend') {
      return { kind: 'mako', health: health.parsed };
    }

    return { kind: 'other-http', detail: `HTTP ${health.status}` };
  } catch {
    const connected = await canConnectToPort(8787);
    return connected ? { kind: 'other-port', detail: 'Port 8787 accepts connections but is not Mako IQ.' } : { kind: 'free' };
  }
}

function syncHealthToState(health) {
  state.backend.state = 'running';
  state.backend.ownedByCompanion = Boolean(backendProcess);
  state.backend.port = health.port ?? state.backend.port;
  state.backend.lastError = '';
  state.aiProvider = health.aiProvider ?? state.aiProvider;
  state.kimi.configured = Boolean(health.kimiConfigured);
  state.kimi.apiKeyLoaded = Boolean(health.moonshotApiKeyLoaded);
  state.kimi.baseUrl = health.kimiBaseUrl ?? state.kimi.baseUrl;
  state.kimi.model = health.kimiModel ?? state.kimi.model;
  state.kimi.checkedAt = health.timestamp ?? new Date().toISOString();
  if (state.aiProvider === 'kimi' && !state.kimi.apiKeyLoaded) {
    state.kimi.lastError = 'MOONSHOT_API_KEY is missing from the backend environment.';
  } else if (state.kimi.lastError === 'MOONSHOT_API_KEY is missing from the backend environment.') {
    state.kimi.lastError = '';
  }
  state.ollama.enabled = Boolean(health.ollamaEnabled);
  state.extensionConnected = Boolean(health.extensionConnected);
  state.lastExtensionRequestAt = health.lastExtensionRequestAt ?? null;
  state.lastAiRequest = health.lastAiRequest ?? null;
  state.ollama.reachable = Boolean(health.ollamaReachable);
  state.ollama.selectedModel = health.selectedModel ?? state.ollama.selectedModel;
  state.ollama.modelInstalled = Boolean(health.modelInstalled);
  state.ollama.visionModel = health.visionModel ?? '';
  state.ollama.visionModelInstalled = health.visionModelInstalled ?? null;
  state.ollama.checkedAt = health.timestamp ?? new Date().toISOString();
}

async function refreshBackendHealth() {
  try {
    const health = await fetchJson(HEALTH_URL, 1_500);
    if (health.parsed?.service === 'mako-iq-backend') {
      syncHealthToState(health.parsed);
    } else if (!backendProcess) {
      state.backend.state = 'stopped';
      state.backend.ownedByCompanion = false;
    }
  } catch (error) {
    if (!backendProcess) {
      state.backend.state = 'stopped';
      state.backend.ownedByCompanion = false;
    } else if (state.backend.state !== 'starting') {
      state.backend.lastError = error instanceof Error ? error.message : 'Backend health check failed.';
    }
  }

  emitStatus();
}

async function testKimiConnection() {
  try {
    const result = await fetchJson(`${AI_HEALTH_URL}?test=true`, 20_000);
    const parsed = result.parsed ?? {};
    state.aiProvider = parsed.provider ?? state.aiProvider;
    state.kimi.configured = Boolean(parsed.configured);
    state.kimi.apiKeyLoaded = Boolean(parsed.moonshotApiKeyLoaded);
    state.kimi.baseUrl = parsed.kimiBaseUrl ?? state.kimi.baseUrl;
    state.kimi.model = parsed.kimiModel ?? state.kimi.model;
    state.kimi.testCallSucceeded = Boolean(parsed.testCallSucceeded);
    state.kimi.lastError = parsed.error ?? (result.ok ? '' : `Kimi test returned HTTP ${result.status}.`);
    state.kimi.checkedAt = new Date().toISOString();
    emitStatus();

    if (!result.ok || !parsed.ok) {
      throw new Error(state.kimi.lastError || 'Kimi connection test failed.');
    }

    await testKimiScreenAnalysis();
    state.kimi.screenTestSucceeded = true;
    state.kimi.testCallSucceeded = true;
    state.kimi.lastError = '';
    state.kimi.checkedAt = new Date().toISOString();
    emitStatus();

    return parsed;
  } catch (error) {
    state.kimi.testCallSucceeded = false;
    state.kimi.screenTestSucceeded = false;
    state.kimi.lastError = error instanceof Error ? error.message : 'Kimi connection test failed.';
    state.kimi.checkedAt = new Date().toISOString();
    emitStatus();
    throw error;
  }
}

async function startBackend(manual = false) {
  if (backendProcess) {
    state.backend.state = 'running';
    emitStatus();
    return;
  }

  const port = await inspectBackendPort();
  if (port.kind === 'mako') {
    syncHealthToState(port.health);
    state.backend.ownedByCompanion = false;
    state.backend.lastError = 'Backend is already running outside the companion.';
    emitStatus();
    return;
  }

  if (port.kind !== 'free') {
    state.backend.state = 'blocked';
    state.backend.lastError = `Port 8787 is already in use by something other than Mako IQ (${port.detail}).`;
    writeLog('companion', 'backend start blocked', { reason: state.backend.lastError });
    emitStatus();
    return;
  }

  const spec = getBackendLaunchSpec();
  state.backend.state = 'starting';
  state.backend.ownedByCompanion = true;
  state.backend.lastError = '';
  state.backend.lastStartedAt = new Date().toISOString();
  emitStatus();

  writeLog('companion', 'starting backend', {
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    manual,
    aiProvider: spec.env.AI_PROVIDER,
    kimiBaseUrl: spec.env.KIMI_BASE_URL,
    kimiModel: spec.env.KIMI_MODEL,
    moonshotApiKeyLoaded: Boolean(spec.env.MOONSHOT_API_KEY),
    moonshotApiKeyPreview: maskSecret(spec.env.MOONSHOT_API_KEY)
  });
  backendProcess = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    windowsHide: true
  });

  state.backend.pid = backendProcess.pid ?? null;

  backendProcess.stdout?.on('data', (chunk) => {
    writeLog('backend', chunk.toString().trim());
  });
  backendProcess.stderr?.on('data', (chunk) => {
    writeLog('backend', chunk.toString().trim());
  });
  backendProcess.once('error', (error) => {
    state.backend.state = 'crashed';
    state.backend.lastError = error.message;
    writeLog('companion', 'backend process error', { message: error.message });
    emitStatus();
  });
  backendProcess.once('exit', (code, signal) => {
    const wasIntentional = state.backend.state === 'stopping';
    state.backend.recentExit = { code, signal, at: new Date().toISOString() };
    state.backend.pid = null;
    backendProcess = null;

    if (wasIntentional || isQuitting) {
      state.backend.state = 'stopped';
      state.backend.ownedByCompanion = false;
      emitStatus();
      return;
    }

    state.backend.state = 'crashed';
    state.backend.lastError = `Backend exited unexpectedly (${signal ?? code ?? 'unknown'}).`;
    writeLog('companion', 'backend exited unexpectedly', state.backend.recentExit);
    emitStatus();
    scheduleBackendRestart();
  });

  await waitForBackend();
}

async function waitForBackend() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const health = await fetchJson(HEALTH_URL, 1_000);
      if (health.parsed?.service === 'mako-iq-backend') {
        syncHealthToState(health.parsed);
        emitStatus();
        return;
      }
    } catch {
      // Keep waiting while the backend starts.
    }
  }

  state.backend.lastError = 'Backend process started, but /health did not respond yet.';
  emitStatus();
}

function scheduleBackendRestart() {
  const now = Date.now();
  restartAttempts = restartAttempts.filter((attempt) => now - attempt < 5 * 60 * 1000);
  if (restartAttempts.length >= 5) {
    state.backend.lastError = 'Backend crashed repeatedly. Use Restart Backend after checking logs.';
    writeLog('companion', 'backend restart suppressed', { attempts: restartAttempts.length });
    emitStatus();
    return;
  }

  restartAttempts.push(now);
  const delayMs = Math.min(30_000, 2_000 * restartAttempts.length);
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    void startBackend(false);
  }, delayMs);
}

async function stopBackend(manual = false) {
  clearTimeout(restartTimer);
  restartTimer = null;

  if (!backendProcess) {
    state.backend.state = 'stopped';
    state.backend.ownedByCompanion = false;
    emitStatus();
    return;
  }

  state.backend.state = 'stopping';
  writeLog('companion', 'stopping backend', { pid: backendProcess.pid, manual });
  emitStatus();
  backendProcess.kill('SIGTERM');

  setTimeout(() => {
    if (backendProcess) {
      writeLog('companion', 'force killing backend', { pid: backendProcess.pid });
      backendProcess.kill('SIGKILL');
    }
  }, 6_000).unref();
}

async function restartBackend() {
  restartAttempts = [];
  await stopBackend(true);
  setTimeout(() => void startBackend(true), 900);
}

async function findOllamaExecutable() {
  const candidates = [
    process.env.OLLAMA_EXE,
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
    path.join(process.env.ProgramFiles || '', 'Ollama', 'ollama.exe'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'Ollama', 'ollama.exe')
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return new Promise((resolve) => {
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    const child = spawn(command, ['ollama'], { windowsHide: true });
    let stdout = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.once('close', (code) => {
      const first = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      resolve(code === 0 && first ? first : '');
    });
    child.once('error', () => resolve(''));
  });
}

function modelMatches(installed, requested) {
  const left = installed.toLowerCase();
  const right = requested.toLowerCase();

  return left === right || (!right.includes(':') && left.startsWith(`${right}:`)) || (right.endsWith(':latest') && left === right.replace(/:latest$/, ''));
}

async function startOllamaIfPossible() {
  const executable = await findOllamaExecutable();
  state.ollama.executablePath = executable;
  if (!executable) {
    return false;
  }

  const child = spawn(executable, ['serve'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
  writeLog('companion', 'attempted to start ollama', { executable });
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  return true;
}

async function checkOllama(attemptStart = false) {
  const defaults = readBackendEnvDefaults();
  const ollamaBaseUrl = defaults.ollamaBaseUrl;
  const ollamaModel = defaults.ollamaModel;
  state.ollama.executablePath = await findOllamaExecutable();
  state.ollama.enabled = defaults.aiProvider === 'ollama';
  state.ollama.selectedModel = ollamaModel;

  async function readTags() {
    const tags = await fetchJson(`${ollamaBaseUrl.replace(/\/+$/, '')}/api/tags`, 2_500);
    const models = Array.isArray(tags.parsed?.models) ? tags.parsed.models : [];
    const names = models.map((model) => model.model || model.name).filter(Boolean);
    state.ollama.reachable = true;
    state.ollama.models = names;
    state.ollama.modelInstalled = ollamaModel ? names.some((name) => modelMatches(name, ollamaModel)) : false;
    state.ollama.visionModel = defaults.ollamaVisionModel || '';
    state.ollama.visionModelInstalled = state.ollama.visionModel ? names.some((name) => modelMatches(name, state.ollama.visionModel)) : null;
    state.ollama.lastError = '';
    state.ollama.checkedAt = new Date().toISOString();
  }

  try {
    await readTags();
  } catch (error) {
    if (attemptStart && state.ollama.executablePath) {
      await startOllamaIfPossible();
      try {
        await readTags();
      } catch (retryError) {
        state.ollama.reachable = false;
        state.ollama.lastError = retryError instanceof Error ? retryError.message : 'Could not reach Ollama.';
      }
    } else {
      state.ollama.reachable = false;
      state.ollama.lastError = state.ollama.executablePath
        ? error instanceof Error ? error.message : 'Could not reach Ollama.'
        : 'Ollama is not installed or not on PATH. Install Ollama, then restart Mako IQ Companion.';
    }
    state.ollama.checkedAt = new Date().toISOString();
  }

  emitStatus();
  return state.ollama;
}

async function pullSelectedModel() {
  if (state.pull.running) {
    return state.pull;
  }

  const defaults = readBackendEnvDefaults();
  const ollamaModel = defaults.ollamaModel;
  state.pull.model = ollamaModel;
  state.ollama.selectedModel = ollamaModel;
  if (!ollamaModel) {
    state.pull.lastStatus = 'OLLAMA_MODEL is not configured. Set it only if you want to use the optional local model provider.';
    emitStatus();
    return state.pull;
  }

  const executable = await findOllamaExecutable();
  state.ollama.executablePath = executable;
  if (!executable) {
    state.pull.lastStatus = 'Ollama is not installed or not on PATH. Install Ollama, then restart Mako IQ Companion.';
    emitStatus();
    return state.pull;
  }

  state.pull.running = true;
  state.pull.model = ollamaModel;
  state.pull.lastStatus = `Installing ${ollamaModel}...`;
  emitStatus();
  writeLog('companion', 'starting ollama pull', { executable, model: ollamaModel });

  const child = spawn(executable, ['pull', ollamaModel], { windowsHide: true });
  child.stdout?.on('data', (chunk) => writeLog('companion', `ollama pull: ${chunk.toString().trim()}`));
  child.stderr?.on('data', (chunk) => writeLog('companion', `ollama pull: ${chunk.toString().trim()}`));

  child.once('close', async (code) => {
    state.pull.running = false;
    state.pull.lastStatus = code === 0 ? `Installed ${ollamaModel}.` : `Model install failed with exit code ${code}.`;
    writeLog('companion', 'ollama pull finished', { code, model: ollamaModel });
    await checkOllama(false);
    emitStatus();
  });

  child.once('error', (error) => {
    state.pull.running = false;
    state.pull.lastStatus = error.message;
    writeLog('companion', 'ollama pull failed', { message: error.message });
    emitStatus();
  });

  return state.pull;
}

async function openLogs() {
  await shell.openPath(logDir);
}

function buildDiagnosticReport() {
  return [
    'Mako IQ Companion Diagnostics',
    `Generated: ${new Date().toISOString()}`,
    `App version: ${app.getVersion()}`,
    `Backend status: ${state.backend.state}`,
    `Backend port: ${state.backend.port}`,
    `Backend owned by companion: ${state.backend.ownedByCompanion}`,
    `AI provider: ${state.aiProvider}`,
    `Kimi configured: ${state.kimi.configured}`,
    `Kimi API key loaded: ${state.kimi.apiKeyLoaded}`,
    `Kimi base URL: ${state.kimi.baseUrl}`,
    `Kimi model: ${state.kimi.model}`,
    `Kimi screen-analysis test: ${
      state.kimi.screenTestSucceeded === null ? 'not run' : state.kimi.screenTestSucceeded ? 'passed' : 'failed'
    }`,
    `Kimi last error: ${state.kimi.lastError || 'none'}`,
    `Ollama reachable: ${state.ollama.reachable}`,
    `Ollama executable: ${state.ollama.executablePath || 'not found'}`,
    `Optional Ollama model: ${state.ollama.selectedModel || 'not configured'}`,
    `Model installed: ${state.ollama.modelInstalled}`,
    `Recent backend error: ${state.backend.lastError || 'none'}`,
    `Last AI request: ${state.lastAiRequest ? `${state.lastAiRequest.message} at ${state.lastAiRequest.at}` : 'none'}`,
    `Extension connected: ${state.extensionConnected}`,
    `Extension base URL: ${LOCAL_BACKEND_ORIGIN}`,
    `Backend log: ${backendLogPath}`,
    `Companion log: ${companionLogPath}`
  ].join('\n');
}

async function copyDiagnostics() {
  const report = buildDiagnosticReport();
  clipboard.writeText(report);
  return report;
}

async function quitApp() {
  isQuitting = true;
  clearInterval(statusPollTimer);
  await stopBackend(true);
  setTimeout(() => app.quit(), 300);
}

function setupIpc() {
  ipcMain.handle('status:get', () => state);
  ipcMain.handle('backend:start', () => startBackend(true));
  ipcMain.handle('backend:stop', () => stopBackend(true));
  ipcMain.handle('backend:restart', () => restartBackend());
  ipcMain.handle('kimi:test', () => testKimiConnection());
  ipcMain.handle('ollama:check', () => checkOllama(true));
  ipcMain.handle('ollama:pull', () => pullSelectedModel());
  ipcMain.handle('logs:open', () => openLogs());
  ipcMain.handle('health:open', () => shell.openExternal(HEALTH_URL));
  ipcMain.handle('diagnostics:copy', () => copyDiagnostics());
  ipcMain.handle('login:toggle', (_event, enabled) => {
    setLaunchAtLogin(Boolean(enabled));
    return getLaunchAtLogin();
  });
}

function initializePaths() {
  logDir = path.join(app.getPath('userData'), 'logs');
  mkdirSync(logDir, { recursive: true });
  configPath = path.join(app.getPath('userData'), 'config.json');
  backendLogPath = path.join(logDir, 'backend.log');
  companionLogPath = path.join(logDir, 'companion.log');
  backendLogStream = createWriteStream(backendLogPath, { flags: 'a' });
  companionLogStream = createWriteStream(companionLogPath, { flags: 'a' });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    const shouldStartHidden = process.argv.includes(LOGIN_HIDDEN_ARG) || process.argv.includes('--hidden');
    initializePaths();
    setupIpc();
    createWindow();
    createTray();

    const config = readConfig();
    if (config.launchAtLogin === undefined) {
      setLaunchAtLogin(true);
    } else {
      setLaunchAtLogin(Boolean(config.launchAtLogin));
    }

    syncConfiguredAiState();
    writeLog('companion', 'companion ready', {
      appVersion: app.getVersion(),
      repoRoot,
      backendRoot: getBackendRoot(),
      aiProvider: state.aiProvider,
      kimiBaseUrl: state.kimi.baseUrl,
      kimiModel: state.kimi.model,
      moonshotApiKeyLoaded: state.kimi.apiKeyLoaded
    });
    if (state.aiProvider === 'ollama') {
      await checkOllama(false);
    }
    await startBackend(false);
    if (shouldStartHidden) {
      emitStatus();
    } else {
      showWindow();
    }
    statusPollTimer = setInterval(() => {
      void refreshBackendHealth();
    }, 5_000);
  });
}

app.on('window-all-closed', () => {
  // Keep the companion alive in the tray when the status window is closed.
});

app.on('before-quit', () => {
  isQuitting = true;
  if (backendProcess) {
    backendProcess.kill('SIGTERM');
  }
});
