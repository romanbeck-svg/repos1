const api = window.makoCompanion;

const elements = {
  extensionDot: document.querySelector('#extensionDot'),
  extensionStatus: document.querySelector('#extensionStatus'),
  extensionMeta: document.querySelector('#extensionMeta'),
  backendDot: document.querySelector('#backendDot'),
  backendStatus: document.querySelector('#backendStatus'),
  backendMeta: document.querySelector('#backendMeta'),
  kimiDot: document.querySelector('#kimiDot'),
  kimiStatus: document.querySelector('#kimiStatus'),
  kimiMeta: document.querySelector('#kimiMeta'),
  keyDot: document.querySelector('#keyDot'),
  keyStatus: document.querySelector('#keyStatus'),
  keyMeta: document.querySelector('#keyMeta'),
  ollamaDot: document.querySelector('#ollamaDot'),
  ollamaStatus: document.querySelector('#ollamaStatus'),
  ollamaMeta: document.querySelector('#ollamaMeta'),
  modelDot: document.querySelector('#modelDot'),
  modelStatus: document.querySelector('#modelStatus'),
  modelMeta: document.querySelector('#modelMeta'),
  lastRequest: document.querySelector('#lastRequest'),
  logPath: document.querySelector('#logPath'),
  launchAtLogin: document.querySelector('#launchAtLogin'),
  notice: document.querySelector('#notice')
};

function setTone(element, tone) {
  element.className = `dot dot--${tone}`;
}

function formatDate(value) {
  if (!value) {
    return 'never';
  }

  return new Date(value).toLocaleString();
}

function showNotice(message) {
  elements.notice.textContent = message;
  elements.notice.hidden = false;
  window.setTimeout(() => {
    elements.notice.hidden = true;
  }, 5000);
}

function render(status) {
  const backendRunning = status.backend.state === 'running';
  const backendTone = backendRunning ? 'success' : status.backend.state === 'blocked' || status.backend.state === 'crashed' ? 'danger' : 'warning';
  setTone(elements.backendDot, backendTone);
  elements.backendStatus.textContent = backendRunning ? 'Backend running' : status.backend.state === 'starting' ? 'Backend starting' : 'Backend stopped';
  elements.backendMeta.textContent = status.backend.lastError || `Port ${status.backend.port}${status.backend.pid ? `, PID ${status.backend.pid}` : ''}`;

  const kimiActive = status.aiProvider === 'kimi';
  const kimiTone = !kimiActive ? 'warning' : status.kimi.configured ? 'success' : 'danger';
  setTone(elements.kimiDot, kimiTone);
  elements.kimiStatus.textContent = !kimiActive
    ? `Provider: ${status.aiProvider}`
    : status.kimi.configured
      ? 'Kimi configured'
      : 'Kimi not configured';
  elements.kimiMeta.textContent = `${status.kimi.model || 'kimi-k2.6'} at ${status.kimi.baseUrl || 'https://api.moonshot.ai/v1'}${
    status.kimi.testCallSucceeded === true ? ' · Test succeeded' : status.kimi.testCallSucceeded === false ? ' · Test failed' : ''
  }`;

  const kimiTestStatus =
    status.kimi.testCallSucceeded === true
      ? status.kimi.screenTestSucceeded === true
        ? ' - Chat and screen tests passed'
        : ' - Chat test passed'
      : status.kimi.testCallSucceeded === false
        ? ' - Test failed'
        : '';
  elements.kimiMeta.textContent = `${status.kimi.model || 'kimi-k2.6'} at ${status.kimi.baseUrl || 'https://api.moonshot.ai/v1'}${kimiTestStatus}`;

  setTone(elements.keyDot, !kimiActive ? 'warning' : status.kimi.apiKeyLoaded ? 'success' : 'danger');
  elements.keyStatus.textContent = !kimiActive ? 'Not required' : status.kimi.apiKeyLoaded ? 'API key loaded' : 'API key missing';
  elements.keyMeta.textContent = !kimiActive
    ? 'MOONSHOT_API_KEY is only required when AI_PROVIDER=kimi.'
    : status.kimi.lastError || 'MOONSHOT_API_KEY is loaded by the local backend only.';

  const ollamaRequired = status.aiProvider === 'ollama';
  const ollamaTone = ollamaRequired ? (status.ollama.reachable ? 'success' : 'danger') : 'warning';
  setTone(elements.ollamaDot, ollamaTone);
  elements.ollamaStatus.textContent = ollamaRequired
    ? status.ollama.reachable
      ? 'Ollama running'
      : 'Ollama stopped'
    : 'Optional, disabled';
  elements.ollamaMeta.textContent = ollamaRequired
    ? status.ollama.lastError || (status.ollama.executablePath ? status.ollama.executablePath : 'Ollama executable not found yet.')
    : 'Not required while AI_PROVIDER=kimi.';

  setTone(elements.modelDot, ollamaRequired && status.ollama.modelInstalled ? 'success' : 'warning');
  elements.modelStatus.textContent = ollamaRequired
    ? status.ollama.modelInstalled
      ? 'Model installed'
      : 'Model missing'
    : 'Optional';
  elements.modelMeta.textContent = status.pull.running
    ? `Installing ${status.pull.model}...`
    : status.pull.lastStatus || (status.ollama.selectedModel ? `Selected: ${status.ollama.selectedModel}` : 'No Ollama model configured.');

  setTone(elements.extensionDot, status.extensionConnected ? 'success' : 'warning');
  elements.extensionStatus.textContent = status.extensionConnected ? 'Extension connected' : 'Extension not connected yet';
  elements.extensionMeta.textContent = `Last request: ${formatDate(status.lastExtensionRequestAt)}`;

  elements.lastRequest.textContent = status.lastAiRequest
    ? `${status.lastAiRequest.ok ? 'OK' : 'Error'}: ${status.lastAiRequest.message} (${formatDate(status.lastAiRequest.at)})`
    : 'No AI requests yet.';
  elements.logPath.textContent = status.paths.backendLogPath || 'Log path will appear after startup.';
  elements.launchAtLogin.checked = Boolean(status.launchAtLogin);

  document.querySelector('#stopBackend').disabled = !backendRunning || !status.backend.ownedByCompanion;
  document.querySelector('#startBackend').disabled = backendRunning || status.backend.state === 'starting';
  document.querySelector('#testKimi').disabled = !backendRunning;
  document.querySelector('#pullModel').disabled = Boolean(status.pull.running) || !status.ollama.selectedModel;
}

async function run(action, message) {
  try {
    await action();
    if (message) {
      showNotice(message);
    }
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error));
  }
}

document.querySelector('#startBackend').addEventListener('click', () => run(api.startBackend, 'Backend start requested.'));
document.querySelector('#restartBackend').addEventListener('click', () => run(api.restartBackend, 'Backend restart requested.'));
document.querySelector('#stopBackend').addEventListener('click', () => run(api.stopBackend, 'Backend stop requested.'));
document.querySelector('#testKimi').addEventListener('click', () => run(api.testKimi, 'Kimi connection test complete.'));
document.querySelector('#checkOllama').addEventListener('click', () => run(api.checkOllama, 'Ollama check complete.'));
document.querySelector('#pullModel').addEventListener('click', () => run(api.pullModel, 'Model install started.'));
document.querySelector('#openLogs').addEventListener('click', () => run(api.openLogs));
document.querySelector('#openHealth').addEventListener('click', () => run(api.openHealth));
document.querySelector('#copyDiagnostics').addEventListener('click', () => run(api.copyDiagnostics, 'Diagnostic report copied.'));
elements.launchAtLogin.addEventListener('change', (event) => {
  run(() => api.toggleLaunchAtLogin(event.target.checked), event.target.checked ? 'Launch at login enabled.' : 'Launch at login disabled.');
});

api.onStatusUpdate(render);
api.getStatus().then(render);
