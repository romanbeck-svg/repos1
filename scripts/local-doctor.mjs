import net from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const backendEnvPath = path.join(repoRoot, 'backend', '.env');
const extensionConfigPath = path.join(repoRoot, 'src', 'canvy', 'shared', 'config.ts');
const backendOrigin = process.env.MAKOIQ_BACKEND_ORIGIN || 'http://127.0.0.1:8787';

function result(ok, label, detail, repair = '') {
  const status = ok ? 'OK' : 'WARN';
  console.log(`[${status}] ${label}: ${detail}`);
  if (!ok && repair) {
    console.log(`      Repair: ${repair}`);
  }
}

async function fetchJson(url, timeoutMs = 2000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    return { ok: response.ok, status: response.status, parsed: text ? JSON.parse(text) : null };
  } finally {
    clearTimeout(timeoutId);
  }
}

function canConnect(port, host = '127.0.0.1') {
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

function modelMatches(installed, requested) {
  const left = installed.toLowerCase();
  const right = requested.toLowerCase();
  return left === right || (!right.includes(':') && left.startsWith(`${right}:`)) || (right.endsWith(':latest') && left === right.replace(/:latest$/, ''));
}

console.log('Mako IQ local doctor\n');

const major = Number(process.versions.node.split('.')[0]);
result(major >= 20, 'Node version', process.version, 'Install Node 20 or newer.');

const envText = existsSync(backendEnvPath) ? readFileSync(backendEnvPath, 'utf8') : '';
result(existsSync(backendEnvPath), 'Backend .env', existsSync(backendEnvPath) ? 'found' : 'missing', 'Copy backend/.env.example to backend/.env if you run the backend outside the companion.');
if (envText) {
  result(/AI_PROVIDER=(kimi|moonshot)/.test(envText), 'AI provider default', /AI_PROVIDER=(kimi|moonshot)/.test(envText) ? 'kimi' : 'backend/.env does not default to Kimi', 'Set AI_PROVIDER=kimi for normal local-first runs.');
  result(/MOONSHOT_API_KEY=\S+/.test(envText), 'Moonshot API key', 'backend-only key entry present', 'Add MOONSHOT_API_KEY to backend/.env.');
}

try {
  const health = await fetchJson(`${backendOrigin}/health`);
  result(Boolean(health.parsed?.backendRunning), 'Backend health', `${backendOrigin}/health responded`, 'Open Mako IQ Companion and start the backend.');
  result(health.parsed?.host === '127.0.0.1', 'Backend bind host', health.parsed?.host ?? 'unknown', 'Set HOST=127.0.0.1.');
  result(health.parsed?.aiProvider === 'kimi', 'Backend AI provider', health.parsed?.aiProvider ?? 'unknown', 'Set AI_PROVIDER=kimi or start through the companion.');
  result(Boolean(health.parsed?.moonshotApiKeyLoaded), 'Moonshot API key loaded', String(Boolean(health.parsed?.moonshotApiKeyLoaded)), 'Add MOONSHOT_API_KEY to backend/.env.');
} catch {
  const occupied = await canConnect(8787);
  result(false, 'Backend health', occupied ? 'port 8787 is occupied but /health did not respond' : 'not running', 'Open Mako IQ Companion, then click Start Backend.');
}

try {
  const aiHealth = await fetchJson(`${backendOrigin}/health/ai`);
  result(Boolean(aiHealth.parsed?.configured), 'Kimi configured', aiHealth.parsed?.error ?? 'configured', 'Check MOONSHOT_API_KEY in backend/.env.');
} catch {
  result(false, 'Kimi health', `${backendOrigin}/health/ai did not respond`, 'Open Mako IQ Companion and start the backend.');
}

const extensionConfig = existsSync(extensionConfigPath) ? readFileSync(extensionConfigPath, 'utf8') : '';
result(extensionConfig.includes("http://127.0.0.1:8787"), 'Extension local URL', 'default points at 127.0.0.1:8787', 'Update src/canvy/shared/config.ts and rebuild the extension.');
