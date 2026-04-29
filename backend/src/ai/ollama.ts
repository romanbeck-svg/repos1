import { env } from '../config/env.js';

export interface OllamaModelDetails {
  format?: string;
  family?: string;
  families?: string[];
  parameter_size?: string;
  quantization_level?: string;
}

export interface OllamaModelSummary {
  name?: string;
  model?: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  details?: OllamaModelDetails;
}

export interface OllamaHealthResult {
  ok: boolean;
  baseUrl: string;
  reachable: boolean;
  selectedModel: string;
  modelInstalled: boolean;
  visionModel: string | null;
  visionModelInstalled: boolean | null;
  models: string[];
  error?: string;
}

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  images?: string[];
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  format?: 'json' | Record<string, unknown>;
  keepAlive?: string;
  options?: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface OllamaChatResult {
  content: string;
  model: string;
  doneReason: string;
  totalDuration?: number;
}

export class OllamaServiceError extends Error {
  status: number;
  exposeMessage: string;
  code: 'OLLAMA_UNREACHABLE' | 'OLLAMA_MODEL_MISSING' | 'OLLAMA_TIMEOUT' | 'OLLAMA_BAD_RESPONSE';
  retryable: boolean;

  constructor(
    message: string,
    options: {
      status?: number;
      exposeMessage?: string;
      code?: OllamaServiceError['code'];
      retryable?: boolean;
    } = {}
  ) {
    super(message);
    this.name = 'OllamaServiceError';
    this.status = options.status ?? 503;
    this.exposeMessage = options.exposeMessage ?? message;
    this.code = options.code ?? 'OLLAMA_BAD_RESPONSE';
    this.retryable = options.retryable ?? false;
  }
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, '');
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const handleAbort = () => controller.abort();
  signal?.addEventListener('abort', handleAbort);

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', handleAbort);
    }
  };
}

function normalizeModelName(value: string) {
  return value.trim().toLowerCase();
}

function modelMatches(installed: string, requested: string) {
  const normalizedInstalled = normalizeModelName(installed);
  const normalizedRequested = normalizeModelName(requested);

  if (!normalizedInstalled || !normalizedRequested) {
    return false;
  }

  if (normalizedInstalled === normalizedRequested) {
    return true;
  }

  if (!normalizedRequested.includes(':')) {
    return normalizedInstalled === `${normalizedRequested}:latest` || normalizedInstalled.startsWith(`${normalizedRequested}:`);
  }

  if (normalizedRequested.endsWith(':latest')) {
    return normalizedInstalled === normalizedRequested.replace(/:latest$/, '') || normalizedInstalled === normalizedRequested;
  }

  return false;
}

async function fetchOllamaJson<T>(path: string, init: RequestInit = {}, timeoutMs = env.aiRequestTimeoutMs) {
  const timeout = withTimeout(init.signal ?? undefined, timeoutMs);
  const url = `${normalizeBaseUrl(env.ollamaBaseUrl)}${path.startsWith('/') ? path : `/${path}`}`;

  try {
    const response = await fetch(url, {
      ...init,
      signal: timeout.signal
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T & { error?: string });

    if (!response.ok) {
      throw new OllamaServiceError(parsed?.error ?? `Ollama returned HTTP ${response.status}.`, {
        status: response.status >= 500 ? 503 : response.status,
        exposeMessage: parsed?.error ?? 'Local AI model is not running. Open Ollama or use Mako IQ Companion to check setup.',
        code: response.status === 404 ? 'OLLAMA_MODEL_MISSING' : 'OLLAMA_BAD_RESPONSE',
        retryable: response.status >= 500
      });
    }

    return parsed as T;
  } catch (error) {
    if (error instanceof OllamaServiceError) {
      throw error;
    }

    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new OllamaServiceError('Ollama request timed out.', {
        status: 504,
        exposeMessage: 'Local AI model took too long to respond. Check Mako IQ Companion and try again.',
        code: 'OLLAMA_TIMEOUT',
        retryable: true
      });
    }

    throw new OllamaServiceError(error instanceof Error ? error.message : 'Could not reach Ollama.', {
      status: 503,
      exposeMessage: 'Local AI model is not running. Open Ollama or use Mako IQ Companion to check setup.',
      code: 'OLLAMA_UNREACHABLE',
      retryable: true
    });
  } finally {
    timeout.dispose();
  }
}

export async function listOllamaModels(timeoutMs = 2_500) {
  const payload = await fetchOllamaJson<{ models?: OllamaModelSummary[] }>('/api/tags', {}, timeoutMs);
  return payload.models ?? [];
}

export function getInstalledModelNames(models: OllamaModelSummary[]) {
  return models.map((model) => model.model || model.name || '').filter(Boolean);
}

export function hasInstalledModel(models: OllamaModelSummary[], requestedModel: string) {
  return getInstalledModelNames(models).some((modelName) => modelMatches(modelName, requestedModel));
}

export async function checkOllamaHealth(timeoutMs = 2_500): Promise<OllamaHealthResult> {
  const selectedModel = env.ollamaModel;
  const visionModel = env.ollamaVisionModel || null;

  try {
    const models = await listOllamaModels(timeoutMs);
    const modelNames = getInstalledModelNames(models);

    return {
      ok: true,
      baseUrl: normalizeBaseUrl(env.ollamaBaseUrl),
      reachable: true,
      selectedModel,
      modelInstalled: hasInstalledModel(models, selectedModel),
      visionModel,
      visionModelInstalled: visionModel ? hasInstalledModel(models, visionModel) : null,
      models: modelNames
    };
  } catch (error) {
    return {
      ok: false,
      baseUrl: normalizeBaseUrl(env.ollamaBaseUrl),
      reachable: false,
      selectedModel,
      modelInstalled: false,
      visionModel,
      visionModelInstalled: visionModel ? false : null,
      models: [],
      error: error instanceof Error ? error.message : 'Could not reach Ollama.'
    };
  }
}

export async function ensureOllamaModel(model: string, timeoutMs = 2_500) {
  const models = await listOllamaModels(timeoutMs);
  if (!hasInstalledModel(models, model)) {
    throw new OllamaServiceError(`Selected Ollama model is not installed: ${model}.`, {
      status: 503,
      exposeMessage: 'Selected Ollama model is not installed.',
      code: 'OLLAMA_MODEL_MISSING'
    });
  }
}

export async function ollamaChat(request: OllamaChatRequest): Promise<OllamaChatResult> {
  await ensureOllamaModel(request.model);

  const payload = await fetchOllamaJson<{
    model?: string;
    message?: { role?: string; content?: string };
    done?: boolean;
    done_reason?: string;
    total_duration?: number;
  }>(
    '/api/chat',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        stream: false,
        keep_alive: request.keepAlive ?? env.ollamaKeepAlive,
        format: request.format,
        options: request.options
      }),
      signal: request.signal
    },
    request.timeoutMs ?? env.aiRequestTimeoutMs
  );

  const content = payload.message?.content?.trim() ?? '';
  if (!content) {
    throw new OllamaServiceError('Ollama returned an empty response.', {
      status: 502,
      exposeMessage: 'Local AI returned an empty response. Try again.',
      code: 'OLLAMA_BAD_RESPONSE'
    });
  }

  return {
    content,
    model: payload.model ?? request.model,
    doneReason: payload.done_reason || (payload.done ? 'stop' : 'unknown'),
    totalDuration: payload.total_duration
  };
}
