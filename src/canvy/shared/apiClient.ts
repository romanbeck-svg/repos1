import type {
  ApiBaseUrlSource,
  ApiTaskRequest,
  ApiTaskResponse,
  CanvasApiContextRequest,
  CanvasApiSummary,
  CanvyTaskKind,
  ImageScanRequest,
  ScanPagePayload,
  ToneProfileRequest,
  ToneProfileResponse
} from './types';
import { fetchWithTrace, readJsonResponse } from './fetchWithTrace';
import {
  mapRequestTraceErrorToUiMessage,
  RequestTraceError,
  type RequestTraceMeta
} from './requestDiagnostics';
import type { RequestFailureCategory } from './types';

type HttpMethod = 'GET' | 'POST';
type AuthMode = 'none' | 'required';
type DevTokenSubscription = 'inactive' | 'trialing' | 'active' | 'past_due' | 'canceled';

interface DevTokenResponse {
  token: string;
}

interface VisionScanResponse {
  ok: boolean;
  page: ScanPagePayload;
  message: string;
}

interface PersistScanResponse {
  ok: boolean;
  stored: boolean;
  summary?: string;
}

interface DevTokenSeed {
  userId?: string;
  email?: string;
  subscriptionStatus?: DevTokenSubscription;
}

interface ApiTraceOptions {
  requestId?: string;
  source?: string;
  context?: string;
  routeLabel?: string;
  apiBaseUrlSource?: ApiBaseUrlSource;
}

export type CanvyApiErrorCode =
  | 'timeout'
  | 'network_error'
  | 'unauthorized'
  | 'http_error'
  | 'invalid_json'
  | 'invalid_response';

export class CanvyApiError extends Error {
  code: CanvyApiErrorCode;
  status?: number;
  detail?: string;
  requestId?: string;
  url?: string;
  method?: string;
  context?: string;
  category?: RequestFailureCategory;
  originalMessage?: string;

  constructor(
    code: CanvyApiErrorCode,
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
    this.name = 'CanvyApiError';
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

export interface CanvyApiClientOptions {
  baseUrl: string;
  apiBaseUrlSource?: ApiBaseUrlSource;
  authToken?: string;
  timeoutMs?: number;
  devTokenSeed?: DevTokenSeed;
  onAuthToken?: (token: string) => void | Promise<void>;
}

interface RequestOptions {
  method: HttpMethod;
  path: string;
  body?: unknown;
  authMode?: AuthMode;
  retryAuth?: boolean;
  trace?: ApiTraceOptions;
}

function normalizeBaseUrl(value: string) {
  const trimmed = value.trim();
  return trimmed.replace(/\/+$/, '');
}

function joinUrl(baseUrl: string, path: string) {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  return `${normalizeBaseUrl(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`;
}

function mapTraceErrorCode(category: RequestFailureCategory): CanvyApiErrorCode {
  switch (category) {
    case 'timeout':
      return 'timeout';
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

function toApiError(error: RequestTraceError) {
  return new CanvyApiError(mapTraceErrorCode(error.category), mapRequestTraceErrorToUiMessage(error), {
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

function mapTaskPath(task: CanvyTaskKind) {
  switch (task) {
    case 'analyze_assignment':
      return '/api/v1/tasks/assignment/analyze';
    case 'build_draft':
      return '/api/v1/tasks/assignment/draft';
    case 'discussion_post':
      return '/api/v1/tasks/discussion';
    case 'quiz_assist':
      return '/api/v1/tasks/quiz-assist';
    case 'explain_page':
      return '/api/v1/tasks/explain';
    default:
      return '/api/v1/tasks/summary';
  }
}

export function createCanvyApiClient(options: CanvyApiClientOptions) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? 10_000;
  let authToken = options.authToken?.trim() || '';

  function createTrace(path: string, request: RequestOptions): RequestTraceMeta {
    return {
      requestId: request.trace?.requestId,
      source: request.trace?.source ?? 'api-client',
      context: request.trace?.context ?? 'service_worker.api_client',
      method: request.method,
      url: joinUrl(baseUrl, path),
      apiBaseUrlSource: request.trace?.apiBaseUrlSource ?? options.apiBaseUrlSource
    };
  }

  async function fetchJson<T>(request: RequestOptions): Promise<T> {
    const authMode = request.authMode ?? 'none';
    const retryAuth = request.retryAuth ?? true;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    if (authMode === 'required') {
      const token = await ensureAuthToken();
      headers.Authorization = `Bearer ${token}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const trace = createTrace(request.path, request);

    try {
      const response = await fetchWithTrace(trace.url ?? joinUrl(baseUrl, request.path), {
        method: request.method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: controller.signal
      }, trace);

      if (response.status === 401 && authMode === 'required' && retryAuth) {
        await issueDevToken(true, request.trace);
        return fetchJson<T>({ ...request, retryAuth: false });
      }

      const { text, parsed } = await readJsonResponse<Record<string, any>>(response, trace, {
        routeLabel: request.trace?.routeLabel ?? 'API request',
        invalidJsonMessage: 'API returned an invalid JSON payload.'
      });

      if (!parsed || typeof parsed !== 'object') {
        throw new CanvyApiError('invalid_response', 'API returned an invalid response payload.', {
          status: response.status,
          detail: text.slice(0, 500),
          requestId: request.trace?.requestId,
          url: trace.url,
          method: trace.method,
          context: trace.context,
          category: 'invalid_response'
        });
      }

      return parsed as T;
    } catch (error) {
      if (error instanceof CanvyApiError) {
        throw error;
      }

      if (error instanceof RequestTraceError) {
        if (error.status === 401) {
          throw new CanvyApiError('unauthorized', error.message, {
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
        throw toApiError(error);
      }

      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new CanvyApiError('timeout', `API request timed out after ${timeoutMs}ms.`, {
          requestId: request.trace?.requestId,
          url: trace.url,
          method: trace.method,
          context: trace.context,
          category: 'timeout'
        });
      }

      throw new CanvyApiError('network_error', error instanceof Error ? error.message : 'Unknown API failure', {
        requestId: request.trace?.requestId,
        url: trace.url,
        method: trace.method,
        context: trace.context,
        category: 'network_error',
        originalMessage: error instanceof Error ? error.message : String(error)
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function issueDevToken(force = false, trace?: ApiTraceOptions) {
    if (!force && authToken) {
      return authToken;
    }

    const response = await fetchJson<DevTokenResponse>({
      method: 'POST',
      path: '/api/v1/auth/dev-token',
      body: options.devTokenSeed ?? {},
      authMode: 'none',
      trace: {
        ...trace,
        source: trace?.source ?? 'api-client-auth',
        context: trace?.context ?? 'service_worker.api_client',
        routeLabel: trace?.routeLabel ?? 'Dev token route'
      }
    });

    if (!response?.token || typeof response.token !== 'string') {
      throw new CanvyApiError('invalid_response', 'Could not read a dev token from the backend response.');
    }

    authToken = response.token;
    if (options.onAuthToken) {
      await options.onAuthToken(response.token);
    }

    return authToken;
  }

  async function ensureAuthToken() {
    if (authToken) {
      return authToken;
    }

    return issueDevToken(true);
  }

  return {
    getCurrentToken() {
      return authToken;
    },

    async checkHealth(trace?: ApiTraceOptions) {
      return fetchJson<{ ok?: boolean; status?: string; timestamp?: string }>({
        method: 'GET',
        path: '/health',
        authMode: 'none',
        trace: {
          ...trace,
          routeLabel: trace?.routeLabel ?? 'Health route'
        }
      });
    },

    async reconnectAuth(trace?: ApiTraceOptions) {
      const token = await issueDevToken(true, trace);
      return { token };
    },

    async runTask(task: CanvyTaskKind, payload: ApiTaskRequest, trace?: ApiTraceOptions) {
      return fetchJson<ApiTaskResponse>({
        method: 'POST',
        path: mapTaskPath(task),
        body: payload,
        authMode: 'required',
        trace: {
          ...trace,
          routeLabel: trace?.routeLabel ?? 'Task route'
        }
      });
    },

    async generateToneProfile(payload: ToneProfileRequest, trace?: ApiTraceOptions) {
      return fetchJson<ToneProfileResponse>({
        method: 'POST',
        path: '/api/v1/onboarding/tone-profile',
        body: payload,
        authMode: 'required',
        trace: {
          ...trace,
          routeLabel: trace?.routeLabel ?? 'Tone profile route'
        }
      });
    },

    async fetchCanvasContext(payload: CanvasApiContextRequest, trace?: ApiTraceOptions) {
      return fetchJson<CanvasApiSummary>({
        method: 'POST',
        path: '/api/v1/canvas/context',
        body: payload,
        authMode: 'required',
        trace: {
          ...trace,
          routeLabel: trace?.routeLabel ?? 'Canvas context route'
        }
      });
    },

    async persistScanPage(page: ScanPagePayload, trace?: ApiTraceOptions) {
      return fetchJson<PersistScanResponse>({
        method: 'POST',
        path: '/api/v1/scan-pages',
        body: { page },
        authMode: 'required',
        trace: {
          ...trace,
          routeLabel: trace?.routeLabel ?? 'Scan page route'
        }
      });
    },

    async scanPageFromImage(payload: ImageScanRequest, trace?: ApiTraceOptions) {
      return fetchJson<VisionScanResponse>({
        method: 'POST',
        path: '/api/v1/scan-pages/vision',
        body: payload,
        authMode: 'required',
        trace: {
          ...trace,
          routeLabel: trace?.routeLabel ?? 'Vision scan route'
        }
      });
    }
  };
}
