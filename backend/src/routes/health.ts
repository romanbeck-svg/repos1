import { Router } from 'express';
import { env, flags } from '../config/env.js';
import { checkOllamaHealth } from '../ai/ollama.js';
import { getRuntimeStatus } from '../lib/runtime-status.js';

export const healthRouter = Router();

function isKimiProvider() {
  return env.aiProvider === 'kimi' || env.rawAiProvider === 'moonshot';
}

function baseHealthPayload() {
  const runtime = getRuntimeStatus();

  return {
    ok: true,
    service: 'mako-iq-backend',
    backendRunning: true,
    environment: env.nodeEnv,
    host: env.host,
    port: env.port,
    appUrl: env.appUrl,
    aiProvider: env.aiProvider,
    kimiConfigured: flags.kimiConfigured,
    kimiBaseUrl: env.kimiBaseUrl,
    kimiModel: env.kimiModel,
    moonshotApiKeyLoaded: flags.moonshotConfigured,
    ollamaEnabled: env.aiProvider === 'ollama',
    aiConfigured: flags.aiConfigured,
    analysisConfigured: flags.analysisConfigured,
    taskAiConfigured: flags.taskAiConfigured,
    jwtSecretConfigured: flags.jwtSecretConfigured,
    extensionOriginsConfigured: flags.extensionOriginsConfigured,
    allowedOriginsCount: env.allowedOrigins.length,
    allowedExtensionOriginsCount: env.allowedExtensionOrigins.length,
    allowAllExtensionOrigins: env.allowAllExtensionOrigins,
    supabaseConfigured: flags.supabaseConfigured,
    stripeConfigured: flags.stripeConfigured,
    extensionConnected: runtime.extensionConnected,
    lastExtensionRequestAt: runtime.lastExtensionRequestAt,
    lastAiRequest: runtime.lastAiRequest,
    version: process.env.npm_package_version ?? '0.1.0',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  };
}

function kimiConfigError() {
  if (!flags.moonshotConfigured) {
    return 'MOONSHOT_API_KEY is missing from the backend environment.';
  }

  if (!env.kimiModel) {
    return 'KIMI_MODEL is missing from the backend environment.';
  }

  return '';
}

async function testKimiConnection() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(`${env.kimiBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.moonshotApiKey}`
      },
      body: JSON.stringify({
        model: env.kimiModel,
        messages: [
          {
            role: 'user',
            content: 'Reply with OK only.'
          }
        ],
        max_tokens: 8,
        stream: false
      }),
      signal: controller.signal
    });
    const text = await response.text();
    let parsed: any = null;

    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const message =
        response.status === 401 || response.status === 403
          ? 'Kimi rejected the API key. Check MOONSHOT_API_KEY in backend/.env.'
          : 'Kimi API request failed. Check internet connection, API key, billing, or model name.';

      return {
        ok: false,
        status: response.status,
        error: message,
        providerError: parsed?.error?.message ?? text.slice(0, 300)
      };
    }

    return {
      ok: true,
      status: response.status
    };
  } catch (error) {
    return {
      ok: false,
      status: error instanceof DOMException && error.name === 'AbortError' ? 504 : 503,
      error: 'Kimi API request failed. Check internet connection, API key, billing, or model name.',
      providerError: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

healthRouter.get('/', async (_req, res) => {
  const payload = baseHealthPayload();

  if (env.aiProvider !== 'ollama') {
    return res.json({
      ...payload,
      ollamaReachable: false,
      selectedModel: env.ollamaModel,
      modelInstalled: false,
      visionModel: env.ollamaVisionModel,
      visionModelInstalled: null
    });
  }

  const ollama = await checkOllamaHealth(1_500);
  res.json({
    ...payload,
    ollamaReachable: ollama.reachable,
    selectedModel: ollama.selectedModel,
    modelInstalled: ollama.modelInstalled,
    visionModel: ollama.visionModel,
    visionModelInstalled: ollama.visionModelInstalled
  });
});

healthRouter.get('/ai', async (req, res) => {
  const shouldTest = req.query.test === 'true';
  const common = {
    provider: env.aiProvider,
    configured: flags.aiConfigured,
    aiConfigured: flags.aiConfigured,
    kimiConfigured: flags.kimiConfigured,
    kimiBaseUrl: env.kimiBaseUrl,
    kimiModel: env.kimiModel,
    moonshotApiKeyLoaded: flags.moonshotConfigured,
    ollamaEnabled: env.aiProvider === 'ollama'
  };

  if (env.aiProvider === 'ollama') {
    if (!shouldTest) {
      return res.status(flags.ollamaConfigured ? 200 : 503).json({
        ok: flags.ollamaConfigured,
        ...common,
        testCallSucceeded: false,
        error: flags.ollamaConfigured ? undefined : 'OLLAMA_MODEL is missing from the backend environment.'
      });
    }

    const ollama = await checkOllamaHealth(3_000);
    return res.status(ollama.ok && ollama.modelInstalled ? 200 : 503).json({
      ok: ollama.ok && ollama.modelInstalled,
      ...common,
      configured: flags.ollamaConfigured,
      testCallSucceeded: ollama.ok && ollama.modelInstalled,
      ollamaReachable: ollama.reachable,
      selectedModel: ollama.selectedModel,
      modelInstalled: ollama.modelInstalled,
      error: ollama.ok && ollama.modelInstalled ? undefined : ollama.error ?? 'Selected Ollama model is not installed.'
    });
  }

  if (!isKimiProvider()) {
    return res.status(400).json({
      ok: false,
      ...common,
      testCallSucceeded: false,
      error: `Unsupported AI_PROVIDER "${env.rawAiProvider}". Use kimi, moonshot, or ollama.`
    });
  }

  const configError = kimiConfigError();
  if (configError) {
    return res.status(503).json({
      ok: false,
      ...common,
      configured: false,
      testCallSucceeded: false,
      error: configError
    });
  }

  if (!shouldTest) {
    return res.json({
      ok: true,
      ...common,
      configured: true,
      testCallSucceeded: false
    });
  }

  const test = await testKimiConnection();
  return res.status(test.ok ? 200 : test.status).json({
    ok: test.ok,
    ...common,
    configured: true,
    testCallSucceeded: test.ok,
    error: test.ok ? undefined : test.error,
    providerError: test.ok ? undefined : test.providerError
  });
});

healthRouter.get('/ollama', async (_req, res) => {
  const ollama = await checkOllamaHealth(3_000);

  res.status(ollama.reachable ? 200 : 503).json({
    ok: ollama.ok,
    ollamaReachable: ollama.reachable,
    baseUrl: ollama.baseUrl,
    selectedModel: ollama.selectedModel,
    modelInstalled: ollama.modelInstalled,
    visionModel: ollama.visionModel,
    visionModelInstalled: ollama.visionModelInstalled,
    models: ollama.models,
    error: ollama.error
  });
});
