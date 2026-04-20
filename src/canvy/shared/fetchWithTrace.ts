import {
  createHttpRequestError,
  createInvalidPayloadError,
  createNetworkRequestError,
  formatRequestTraceError,
  logTrace,
  logTraceError,
  type RequestTraceMeta
} from './requestDiagnostics';

export function tryParseJson<T>(value: string) {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function fetchWithTrace(url: string, init: RequestInit, meta: RequestTraceMeta) {
  const method = init.method?.toUpperCase() ?? 'GET';
  const startedAt = Date.now();
  const trace = {
    ...meta,
    method,
    url
  };

  logTrace('sw:request:start', {
    requestId: trace.requestId,
    context: trace.context,
    source: trace.source,
    method,
    url
  });
  logTrace('sw:request:url', {
    requestId: trace.requestId,
    context: trace.context,
    source: trace.source,
    url
  });

  try {
    const response = await fetch(url, init);
    const payload = {
      requestId: trace.requestId,
      context: trace.context,
      source: trace.source,
      method,
      url,
      status: response.status,
      elapsedMs: Math.max(0, Date.now() - startedAt)
    };

    if (response.ok) {
      logTrace('sw:request:ok', payload);
    } else {
      logTraceError('sw:request:error', payload);
    }
    return response;
  } catch (error) {
    const tracedError = createNetworkRequestError(trace, error);
    logTraceError('sw:request:error', {
      ...formatRequestTraceError(tracedError),
      elapsedMs: Math.max(0, Date.now() - startedAt)
    });
    throw tracedError;
  }
}

export async function readJsonResponse<T>(
  response: Response,
  meta: RequestTraceMeta,
  options: { routeLabel?: string; invalidJsonMessage: string; invalidResponseMessage?: string }
) {
  const text = await response.text();
  const parsed = text ? tryParseJson<T & { error?: string; message?: string }>(text) : null;

  if (!response.ok) {
    const parsedError =
      parsed && typeof parsed === 'object'
        ? typeof parsed.error === 'string'
          ? parsed.error
          : typeof parsed.message === 'string'
            ? parsed.message
            : ''
        : '';

    throw createHttpRequestError(meta, response.status, text, {
      routeLabel: options.routeLabel,
      parsedError
    });
  }

  if (!parsed || typeof parsed !== 'object') {
    throw createInvalidPayloadError(
      meta,
      'invalid_json',
      options.invalidJsonMessage,
      text.slice(0, 500),
      response.status
    );
  }

  if (options.invalidResponseMessage && !parsed) {
    throw createInvalidPayloadError(
      meta,
      'invalid_response',
      options.invalidResponseMessage,
      text.slice(0, 500),
      response.status
    );
  }

  return {
    text,
    parsed
  };
}
