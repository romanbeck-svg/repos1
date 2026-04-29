import { isLoopbackApiBaseUrl } from './config';
import type { ApiBaseUrlSource, RequestDiagnosticEvent, RequestFailureCategory } from './types';

export interface RequestTraceMeta {
  requestId?: string;
  context: string;
  source?: string;
  method?: string;
  url?: string;
  apiBaseUrlSource?: ApiBaseUrlSource;
}

interface RequestTraceErrorOptions extends RequestTraceMeta {
  category: RequestFailureCategory;
  status?: number;
  detail?: string;
  originalMessage?: string;
  userMessage?: string;
}

export class RequestTraceError extends Error {
  category: RequestFailureCategory;
  requestId?: string;
  context: string;
  source?: string;
  method?: string;
  url?: string;
  status?: number;
  detail?: string;
  originalMessage?: string;
  userMessage: string;

  constructor(message: string, options: RequestTraceErrorOptions) {
    super(message);
    this.name = 'RequestTraceError';
    this.category = options.category;
    this.requestId = options.requestId;
    this.context = options.context;
    this.source = options.source;
    this.method = options.method;
    this.url = options.url;
    this.status = options.status;
    this.detail = options.detail;
    this.originalMessage = options.originalMessage;
    this.userMessage = options.userMessage ?? message;
  }
}

function normalizeMethod(value?: string) {
  return value?.trim().toUpperCase() || 'GET';
}

function tryGetOrigin(value?: string) {
  if (!value) {
    return undefined;
  }

  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

export function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === 'string' ? error : 'Unknown error';
}

export function createRequestDiagnostic(
  tag: string,
  message: string,
  meta: Partial<RequestTraceMeta> & Partial<Pick<RequestDiagnosticEvent, 'status' | 'category' | 'detail'>> = {}
): RequestDiagnosticEvent {
  return {
    id: crypto.randomUUID(),
    tag,
    message,
    createdAt: new Date().toISOString(),
    requestId: meta.requestId,
    context: meta.context,
    source: meta.source,
    method: meta.method ? normalizeMethod(meta.method) : undefined,
    url: meta.url,
    status: meta.status,
    category: meta.category,
    detail: meta.detail
  };
}

function withRequestId(message: string, requestId?: string) {
  return requestId ? `${message} (req ${requestId})` : message;
}

function mapLocalAiMessage(message: string) {
  if (/MOONSHOT_API_KEY is missing|Kimi API key is missing/i.test(message)) {
    return 'Kimi API key is missing in the local backend. Add MOONSHOT_API_KEY to backend/.env or configure it in Mako IQ Companion.';
  }

  if (/Kimi rejected the API key/i.test(message)) {
    return 'Kimi rejected the API key. Check MOONSHOT_API_KEY in backend/.env.';
  }

  if (/Kimi API request failed|Kimi .*failed|Moonshot .*failed/i.test(message)) {
    return 'Mako IQ reached the local backend, but Kimi failed to respond. Check the Companion app status.';
  }

  if (/selected ollama model is not installed|selected local model is not installed/i.test(message)) {
    return 'Selected local model is not installed. Open Mako IQ Companion and install the model.';
  }

  if (/local ai model is not running|could not reach ollama|ollama request/i.test(message)) {
    return 'Local AI model is not running. Open Ollama or check Mako IQ Companion.';
  }

  return message;
}

export function logTrace(tag: string, payload: Record<string, unknown> = {}) {
  console.info(`[Mako IQ][${tag}]`, payload);
}

export function logTraceError(tag: string, payload: Record<string, unknown> = {}) {
  console.error(`[Mako IQ][${tag}]`, payload);
}

export function createRuntimeMessageError(meta: RequestTraceMeta, error: unknown) {
  const originalMessage = getErrorMessage(error);
  const userMessage = withRequestId('Message channel closed before the extension responded.', meta.requestId);
  const detail = [
    `context=${meta.context}`,
    `source=${meta.source ?? 'unknown'}`,
    `original=${originalMessage}`
  ].join(' ');

  return new RequestTraceError(userMessage, {
    ...meta,
    method: normalizeMethod(meta.method),
    category: 'message_channel_closed',
    detail,
    originalMessage,
    userMessage
  });
}

export function createNetworkRequestError(meta: RequestTraceMeta, error: unknown) {
  const originalMessage = getErrorMessage(error);
  const origin = tryGetOrigin(meta.url);
  const isLoopback = isLoopbackApiBaseUrl(meta.url);
  let category: RequestFailureCategory = 'network_error';
  let message = `Mako IQ could not reach ${origin ?? 'the backend'}.`;

  if (/Access-Control-Allow-Origin|blocked by CORS|CORS/i.test(originalMessage)) {
    category = 'cors_blocked';
    message = `CORS blocked the request to ${origin ?? 'the backend'}.`;
  } else if (/message port closed|Could not establish connection|Receiving end does not exist/i.test(originalMessage)) {
    category = 'message_channel_closed';
    message = 'Message channel closed before the extension responded.';
  } else if (/Failed to fetch|NetworkError|Load failed|fetch failed|ECONNREFUSED|ENOTFOUND/i.test(originalMessage)) {
    if (isLoopback) {
      category = 'backend_offline';
      message = 'Mako IQ Local Server is not running. Open Mako IQ Companion and try again.';
    } else {
      category = 'wrong_api_url';
      message = `Wrong API URL. Could not reach ${origin ?? meta.url ?? 'the configured backend'}.`;
    }
  }

  const detail = [
    `context=${meta.context}`,
    `source=${meta.source ?? 'unknown'}`,
    `method=${normalizeMethod(meta.method)}`,
    `url=${meta.url ?? 'unknown'}`,
    `apiBaseUrlSource=${meta.apiBaseUrlSource ?? 'unknown'}`,
    `original=${originalMessage}`
  ].join(' ');

  return new RequestTraceError(withRequestId(message, meta.requestId), {
    ...meta,
    method: normalizeMethod(meta.method),
    category,
    detail,
    originalMessage,
    userMessage: message
  });
}

export function createHttpRequestError(
  meta: RequestTraceMeta,
  status: number,
  responseText: string,
  options: { routeLabel?: string; parsedError?: string } = {}
) {
  const routeLabel = options.routeLabel ?? 'Request';
  const parsedError = mapLocalAiMessage(options.parsedError?.trim() || '');
  const summary = `${routeLabel} returned HTTP ${status}.`;
  const message = parsedError || summary;
  const detail = [
    `context=${meta.context}`,
    `source=${meta.source ?? 'unknown'}`,
    `method=${normalizeMethod(meta.method)}`,
    `url=${meta.url ?? 'unknown'}`,
    `status=${status}`,
    `body=${responseText.slice(0, 500)}`
  ].join(' ');

  return new RequestTraceError(withRequestId(message, meta.requestId), {
    ...meta,
    method: normalizeMethod(meta.method),
    category: 'http_error',
    status,
    detail,
    originalMessage: parsedError || responseText.slice(0, 500),
    userMessage: message
  });
}

export function createInvalidPayloadError(
  meta: RequestTraceMeta,
  category: Extract<RequestFailureCategory, 'invalid_json' | 'invalid_response'>,
  message: string,
  detail?: string,
  status?: number
) {
  return new RequestTraceError(withRequestId(message, meta.requestId), {
    ...meta,
    method: normalizeMethod(meta.method),
    category,
    status,
    detail,
    originalMessage: detail,
    userMessage: message
  });
}

export function formatRequestTraceError(error: RequestTraceError) {
  return {
    category: error.category,
    requestId: error.requestId,
    context: error.context,
    source: error.source,
    method: error.method,
    url: error.url,
    status: error.status,
    detail: error.detail,
    originalMessage: error.originalMessage,
    message: error.message
  };
}

export function mapRequestTraceErrorToUiMessage(error: RequestTraceError) {
  return error.message;
}
