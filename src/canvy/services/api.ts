import type {
  AnalysisApiResponse,
  AnalysisRequestPayload,
  AnalysisStreamEvent,
  AnalysisSuccessResponse
} from '../types/analysis';
import { fetchWithTrace, readJsonResponse, tryParseJson } from '../shared/fetchWithTrace';
import {
  createHttpRequestError,
  createInvalidPayloadError,
  mapRequestTraceErrorToUiMessage,
  RequestTraceError,
  type RequestTraceMeta
} from '../shared/requestDiagnostics';
import type { ApiBaseUrlSource, RequestFailureCategory } from '../shared/types';

const DEFAULT_ANALYSIS_TIMEOUT_MS = 25_000;
const MAX_PAGE_TEXT_LENGTH = 12_000;
const MAX_INSTRUCTION_LENGTH = 2_000;
const MAX_SCREENSHOT_BASE64_LENGTH = 3_500_000;

export type AnalysisApiErrorCode = 'timeout' | 'cancelled' | 'network_error' | 'http_error' | 'invalid_json' | 'invalid_response';

interface RequestOptions {
  signal?: AbortSignal;
  requestId?: string;
  source?: string;
  apiBaseUrlSource?: ApiBaseUrlSource;
}

interface StreamAnalysisOptions extends RequestOptions {
  onEvent?: (event: AnalysisStreamEvent) => void;
}

export class AnalysisApiError extends Error {
  code: AnalysisApiErrorCode;
  status?: number;
  detail?: string;
  requestId?: string;
  url?: string;
  method?: string;
  context?: string;
  category?: RequestFailureCategory;
  originalMessage?: string;

  constructor(
    code: AnalysisApiErrorCode,
    message: string,
    options: {
      status?: number;
      detail?: string;
      requestId?: string;
      url?: string;
      method?: string;
      context?: string;
      category?: RequestFailureCategory;
      originalMessage?: string;
    } = {}
  ) {
    super(message);
    this.name = 'AnalysisApiError';
    this.code = code;
    this.status = options.status;
    this.detail = options.detail;
    this.requestId = options.requestId;
    this.url = options.url;
    this.method = options.method;
    this.context = options.context;
    this.category = options.category;
    this.originalMessage = options.originalMessage;
  }
}

function mapTraceErrorCode(category: RequestFailureCategory): AnalysisApiErrorCode {
  switch (category) {
    case 'timeout':
      return 'timeout';
    case 'cancelled':
      return 'cancelled';
    case 'http_error':
      return 'http_error';
    case 'invalid_json':
      return 'invalid_json';
    case 'invalid_response':
      return 'invalid_response';
    default:
      return 'network_error';
  }
}

function createTraceMeta(baseUrl: string, path: string, options: RequestOptions): RequestTraceMeta {
  return {
    requestId: options.requestId,
    source: options.source ?? 'analysis',
    context: 'service_worker.analysis',
    method: 'POST',
    url: joinUrl(baseUrl, path),
    apiBaseUrlSource: options.apiBaseUrlSource
  };
}

function toAnalysisApiError(error: RequestTraceError) {
  return new AnalysisApiError(mapTraceErrorCode(error.category), mapRequestTraceErrorToUiMessage(error), {
    status: error.status,
    detail: error.detail,
    requestId: error.requestId,
    url: error.url,
    method: error.method,
    context: error.context,
    category: error.category,
    originalMessage: error.originalMessage
  });
}

function createAbortError(
  code: Extract<AnalysisApiErrorCode, 'timeout' | 'cancelled'>,
  message: string,
  options: RequestOptions,
  meta: RequestTraceMeta
) {
  return new AnalysisApiError(code, message, {
    requestId: options.requestId,
    url: meta.url,
    method: meta.method,
    context: meta.context,
    category: code
  });
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, '');
}

function joinUrl(baseUrl: string, path: string) {
  return `${normalizeBaseUrl(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`;
}

function normalizeText(value: string, maxLength: number) {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeScreenshotBase64(value: string | null) {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
  return normalized.slice(0, MAX_SCREENSHOT_BASE64_LENGTH) || null;
}

function normalizeRequest(payload: AnalysisRequestPayload): AnalysisRequestPayload {
  return {
    mode: payload.mode,
    instruction: normalizeText(payload.instruction, MAX_INSTRUCTION_LENGTH),
    page: {
      url: normalizeText(payload.page.url, 500),
      title: normalizeText(payload.page.title, 240) || 'Current page',
      text: normalizeText(payload.page.text, MAX_PAGE_TEXT_LENGTH)
    },
    screenshotBase64: normalizeScreenshotBase64(payload.screenshotBase64)
  };
}

function createTimeoutController(timeoutMs: number, signal?: AbortSignal) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = () => controller.abort();
  signal?.addEventListener('abort', forwardAbort);

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', forwardAbort);
    }
  };
}

export async function analyzeWithBackend(
  baseUrl: string,
  payload: AnalysisRequestPayload,
  timeoutMs = DEFAULT_ANALYSIS_TIMEOUT_MS,
  options: RequestOptions = {}
): Promise<AnalysisSuccessResponse> {
  const timeout = createTimeoutController(timeoutMs, options.signal);
  const trace = createTraceMeta(baseUrl, '/api/analyze', options);

  try {
    const response = await fetchWithTrace(trace.url ?? joinUrl(baseUrl, '/api/analyze'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(normalizeRequest(payload)),
      signal: timeout.signal
    }, trace);

    const { parsed } = await readJsonResponse<AnalysisApiResponse>(response, trace, {
      routeLabel: 'Analyze route',
      invalidJsonMessage: 'The backend returned an invalid analysis payload.'
    });

    if (!parsed || !parsed.ok || !parsed.output) {
      throw new AnalysisApiError('invalid_response', 'The backend returned an incomplete analysis response.', {
        status: response.status,
        requestId: options.requestId,
        url: trace.url,
        method: trace.method,
        context: trace.context,
        category: 'invalid_response'
      });
    }

    return parsed;
  } catch (error) {
    if (error instanceof AnalysisApiError) {
      throw error;
    }

    if (error instanceof RequestTraceError) {
      throw toAnalysisApiError(error);
    }

    if (error instanceof DOMException && error.name === 'AbortError') {
      if (options.signal?.aborted) {
        throw createAbortError('cancelled', 'The analysis request was cancelled.', options, trace);
      }

      throw createAbortError('timeout', `The analysis request timed out after ${timeoutMs}ms.`, options, trace);
    }

    throw toAnalysisApiError(new RequestTraceError('Mako IQ could not reach the analysis backend.', {
      ...trace,
      category: 'network_error',
      detail: String(error),
      originalMessage: error instanceof Error ? error.message : String(error)
    }));
  } finally {
    timeout.dispose();
  }
}

export async function streamAnalysisWithBackend(
  baseUrl: string,
  payload: AnalysisRequestPayload,
  timeoutMs = DEFAULT_ANALYSIS_TIMEOUT_MS,
  options: StreamAnalysisOptions = {}
): Promise<AnalysisSuccessResponse> {
  const timeout = createTimeoutController(timeoutMs, options.signal);
  let finalEvent: AnalysisSuccessResponse | null = null;
  const trace = createTraceMeta(baseUrl, '/api/analyze/stream', options);

  try {
    const response = await fetchWithTrace(trace.url ?? joinUrl(baseUrl, '/api/analyze/stream'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(normalizeRequest(payload)),
      signal: timeout.signal
    }, trace);

    if (!response.ok) {
      const text = await response.text();
      const parsed = text ? tryParseJson<AnalysisApiResponse>(text) : null;
      const parsedError = parsed && !parsed.ok && parsed.error ? parsed.error : '';
      throw toAnalysisApiError(createHttpRequestError(trace, response.status, text, {
        routeLabel: 'Analyze stream route',
        parsedError
      }));
    }

    if (!response.body) {
      throw new AnalysisApiError('invalid_response', 'The backend did not return a readable analysis stream.', {
        requestId: options.requestId,
        url: trace.url,
        method: trace.method,
        context: trace.context,
        category: 'invalid_response'
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex < 0) {
          break;
        }

        const rawLine = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (!rawLine) {
          continue;
        }

        let event: AnalysisStreamEvent;
        try {
          event = JSON.parse(rawLine) as AnalysisStreamEvent;
        } catch {
          throw toAnalysisApiError(
            createInvalidPayloadError(
              trace,
              'invalid_json',
              'The backend returned malformed stream data.',
              rawLine.slice(0, 500)
            )
          );
        }

        options.onEvent?.(event);

        if (event.type === 'error') {
          throw new AnalysisApiError('http_error', event.error, {
            requestId: options.requestId,
            url: trace.url,
            method: trace.method,
            context: trace.context,
            category: 'http_error'
          });
        }

        if (event.type === 'complete') {
          finalEvent = {
            ok: true,
            mode: event.mode,
            output: event.output,
            meta: event.meta
          };
        }
      }
    }

    if (!finalEvent) {
      throw new AnalysisApiError('invalid_response', 'The backend stream ended before a final analysis response was received.', {
        requestId: options.requestId,
        url: trace.url,
        method: trace.method,
        context: trace.context,
        category: 'invalid_response'
      });
    }

    return finalEvent;
  } catch (error) {
    if (error instanceof AnalysisApiError) {
      throw error;
    }

    if (error instanceof RequestTraceError) {
      throw toAnalysisApiError(error);
    }

    if (error instanceof DOMException && error.name === 'AbortError') {
      if (options.signal?.aborted) {
        throw createAbortError('cancelled', 'The analysis request was cancelled.', options, trace);
      }

      throw createAbortError('timeout', `The analysis request timed out after ${timeoutMs}ms.`, options, trace);
    }

    throw toAnalysisApiError(new RequestTraceError('Mako IQ could not reach the analysis backend.', {
      ...trace,
      category: 'network_error',
      detail: String(error),
      originalMessage: error instanceof Error ? error.message : String(error)
    }));
  } finally {
    timeout.dispose();
  }
}
