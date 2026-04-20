import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import type {
  AnalysisCacheStatus,
  AnalysisChart,
  AnalysisResponseMeta,
  AnalysisStreamEvent,
  AnalysisTimingMetrics,
  AnalyzeRequestBody,
  StructuredAnalysisOutput
} from '../types/analysis.js';

const MODEL_TIMEOUT_MS = 20_000;
const MAX_PROVIDER_RETRIES = 1;
const RETRY_DELAY_MS = 650;

interface GenerateAnalysisResult {
  output: StructuredAnalysisOutput;
  meta: AnalysisResponseMeta;
}

interface StreamAnalysisOptions {
  requestId: string;
  signal?: AbortSignal;
  onEvent?: (event: AnalysisStreamEvent) => void;
}

interface AttemptContext {
  request: AnalyzeRequestBody;
  requestId: string;
  signal?: AbortSignal;
  route: ModelRoute;
}

interface StreamAttemptResult {
  rawContent: string;
  timings: AnalysisTimingMetrics;
}

interface NonStreamAttemptResult {
  rawContent: string;
  timings: AnalysisTimingMetrics;
}

interface ModelRoute {
  profile: 'quick' | 'reasoning' | 'vision';
  model: string;
  maxTokens: number;
  includeThinkingControl: boolean;
  thinkingMode: 'disabled' | 'enabled';
}

export class ModelServiceError extends Error {
  status: number;
  exposeMessage: string;
  retryable: boolean;

  constructor(message: string, options: { status?: number; exposeMessage?: string; retryable?: boolean } = {}) {
    super(message);
    this.name = 'ModelServiceError';
    this.status = options.status ?? 500;
    this.exposeMessage = options.exposeMessage ?? 'The AI analysis service is unavailable right now.';
    this.retryable = options.retryable ?? false;
  }
}

function stripCodeFence(value: string) {
  return value.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
}

function extractFirstJsonObject(value: string) {
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return value.slice(start, end + 1);
  }

  return value;
}

function safeParseJson<T>(value: string) {
  return JSON.parse(extractFirstJsonObject(stripCodeFence(value))) as T;
}

function sanitizeString(value: unknown, fallback: string, maxLength = 420) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, maxLength) || fallback;
}

function sanitizeStringArray(value: unknown, maxItems = 3, maxItemLength = 160) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => sanitizeString(item, '', maxItemLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function sanitizeChart(input: unknown): AnalysisChart | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const chart = input as Partial<AnalysisChart>;
  const type = chart.type;
  if (type !== 'bar' && type !== 'line' && type !== 'pie' && type !== 'table') {
    return null;
  }

  const labels = sanitizeStringArray(chart.labels, 12, 120);
  const datasets = Array.isArray(chart.datasets)
    ? chart.datasets
        .map((dataset) => {
          if (!dataset || typeof dataset !== 'object') {
            return null;
          }

          const safeDataset = dataset as Partial<AnalysisChart['datasets'][number]>;
          const data = Array.isArray(safeDataset.data)
            ? safeDataset.data.map((value) => Number(value)).filter((value) => Number.isFinite(value)).slice(0, 12)
            : [];

          if (!data.length) {
            return null;
          }

          return {
            label: sanitizeString(safeDataset.label, 'Series', 120),
            data
          };
        })
        .filter((dataset): dataset is NonNullable<typeof dataset> => Boolean(dataset))
        .slice(0, 4)
    : [];

  if (!labels.length || !datasets.length) {
    return null;
  }

  return {
    type,
    title: sanitizeString(chart.title, 'Structured chart', 160),
    labels,
    datasets
  };
}

function selectModelRoute(request: AnalyzeRequestBody): ModelRoute {
  if (request.screenshotBase64) {
    return {
      profile: 'vision',
      model: env.moonshotVisionModel || env.moonshotModel,
      maxTokens: request.mode === 'chart' ? 420 : 320,
      includeThinkingControl: true,
      thinkingMode: 'disabled'
    };
  }

  if (request.mode === 'chart') {
    return {
      profile: 'reasoning',
      model: env.moonshotReasoningModel || env.moonshotModel,
      maxTokens: 420,
      includeThinkingControl: false,
      thinkingMode: 'enabled'
    };
  }

  return {
    profile: 'quick',
    model: env.moonshotQuickModel || env.moonshotModel,
    maxTokens: request.mode === 'quick_summary' ? 220 : request.mode === 'summary' ? 280 : request.mode === 'send_to_doc' ? 300 : 340,
    includeThinkingControl: false,
    thinkingMode: 'disabled'
  };
}

function buildSystemPrompt(route: ModelRoute) {
  return [
    "You are Mako IQ's structured analysis engine.",
    'Return valid JSON only.',
    'Do not include markdown fences, preambles, or commentary outside the JSON object.',
    'Keep the output concise by default.',
    'Rules:',
    '- `title`: a short answer line, ideally 2 to 6 words.',
    '- `text`: 1 to 3 short sentences. Lead with the answer, not a preamble.',
    '- `bullets`: at most 3 short bullets.',
    '- `actions`: at most 1 concise next step.',
    '- Avoid repeating the page title or the user instruction unless it adds value.',
    route.profile === 'quick' ? '- Favor speed and directness over exhaustive detail.' : '- Stay concise even when deeper reasoning is needed.',
    'Use this exact schema:',
    '{',
    '  "title": "string",',
    '  "text": "string",',
    '  "bullets": ["string"],',
    '  "chart": null | {',
    '    "type": "bar" | "line" | "pie" | "table",',
    '    "title": "string",',
    '    "labels": ["string"],',
    '    "datasets": [{ "label": "string", "data": [number] }]',
    '  },',
    '  "actions": ["string"]',
    '}'
  ].join('\n');
}

function buildUserPrompt(request: AnalyzeRequestBody) {
  const pageText = request.page.text || 'No readable page text was available. Mention that limitation briefly if it matters.';
  const screenshotNote = request.screenshotBase64
    ? 'A screenshot is attached. Use it only when it adds clear value.'
    : 'No screenshot was included.';

  return [
    `MODE: ${request.mode}`,
    `INSTRUCTION: ${request.instruction || 'None provided.'}`,
    `PAGE TITLE: ${request.page.title}`,
    `PAGE URL: ${request.page.url}`,
    `SCREENSHOT: ${screenshotNote}`,
    'PAGE TEXT:',
    pageText,
    '',
    'Mode guidance:',
    '- answer: direct explanation first, then up to 3 bullets if needed.',
    '- summary: condensed answer plus up to 3 bullets.',
    '- quick_summary: very short answer, bullet-heavy if useful.',
    '- chart: include a chart only when the page contains clear structured data; otherwise explain why briefly.',
    '- send_to_doc: concise structured summary suitable for saving elsewhere.'
  ].join('\n');
}

function createMoonshotRequestBody(request: AnalyzeRequestBody, route: ModelRoute, stream: boolean) {
  const content =
    request.screenshotBase64 && route.profile === 'vision'
      ? [
          {
            type: 'text',
            text: buildUserPrompt(request)
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${request.screenshotBase64}`
            }
          }
        ]
      : buildUserPrompt(request);

  const body: Record<string, unknown> = {
    model: route.model,
    messages: [
      {
        role: 'system',
        content: buildSystemPrompt(route)
      },
      {
        role: 'user',
        content
      }
    ],
    max_tokens: route.maxTokens,
    response_format: {
      type: 'json_object'
    },
    stream
  };

  if (route.includeThinkingControl) {
    body.thinking = {
      type: route.thinkingMode
    };
  }

  return body;
}

function readCompletionText(payload: any) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }

        if (item && typeof item === 'object' && typeof item.text === 'string') {
          return item.text;
        }

        return '';
      })
      .join('\n')
      .trim();
  }

  return '';
}

function normalizeOutput(parsed: unknown, request: AnalyzeRequestBody): StructuredAnalysisOutput {
  const source = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const chart = sanitizeChart(source.chart);
  const bulletLimit = request.mode === 'quick_summary' ? 3 : 3;
  const bullets = sanitizeStringArray(source.bullets, bulletLimit, 140);
  const actions = sanitizeStringArray(source.actions, 1, 140);
  const fallbackText =
    chart && request.mode === 'chart'
      ? `Chart ready: ${chart.title}.`
      : request.mode === 'quick_summary'
        ? 'No concise answer was returned.'
        : 'The model returned an incomplete analysis response.';

  return {
    title: sanitizeString(source.title, request.page.title || 'Quick scan', 90),
    text: sanitizeString(
      source.text,
      fallbackText,
      request.mode === 'quick_summary' ? 220 : request.mode === 'summary' ? 320 : 480
    ),
    bullets,
    chart,
    actions
  };
}

function shouldRetryStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maybeAbort(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new ModelServiceError('Moonshot request was cancelled.', {
      status: 499,
      exposeMessage: 'The analysis request was cancelled.'
    });
  }
}

function createAttemptTimings(retryCount: number): AnalysisTimingMetrics {
  const startedAt = new Date().toISOString();

  return {
    startedAt,
    updatedAt: startedAt,
    retryCount
  };
}

function withTimeout(signal?: AbortSignal) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);

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

function buildMeta(requestId: string, cacheStatus: AnalysisCacheStatus, timings: AnalysisTimingMetrics): AnalysisResponseMeta {
  return {
    requestId,
    cacheStatus,
    timings: {
      ...timings,
      updatedAt: new Date().toISOString()
    }
  };
}

function finalizeMeta(meta: AnalysisResponseMeta, normalizationMs: number, completedAt: string): AnalysisResponseMeta {
  const baseTimings = meta.timings;

  return {
    ...meta,
    timings: {
      startedAt: baseTimings?.startedAt ?? completedAt,
      ...baseTimings,
      normalizationMs,
      completedAt,
      updatedAt: completedAt
    }
  };
}

async function runNonStreamingAttempt(context: AttemptContext, retryCount: number): Promise<NonStreamAttemptResult> {
  maybeAbort(context.signal);
  const timings = createAttemptTimings(retryCount);
  const startedAt = Date.now();
  const timeout = withTimeout(context.signal);

  try {
    logger.info(
      {
        requestId: context.requestId,
        mode: context.request.mode,
        profile: context.route.profile,
        model: context.route.model,
        maxTokens: context.route.maxTokens
      },
      'sending non-stream moonshot request'
    );

    const response = await fetch(`${env.moonshotBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.moonshotApiKey}`
      },
      body: JSON.stringify(createMoonshotRequestBody(context.request, context.route, false)),
      signal: timeout.signal
    });

    const backendMs = Date.now() - startedAt;
    const responseText = await response.text();
    let parsedResponse: any = null;

    try {
      parsedResponse = responseText ? JSON.parse(responseText) : null;
    } catch {
      throw new ModelServiceError('Moonshot returned invalid JSON.', {
        status: 502,
        exposeMessage: 'Kimi returned an unreadable response. Try the scan again.'
      });
    }

    if (!response.ok) {
      logger.error(
        {
          requestId: context.requestId,
          status: response.status,
          mode: context.request.mode,
          model: context.route.model,
          providerError: parsedResponse?.error?.message ?? responseText.slice(0, 500)
        },
        'moonshot request failed'
      );

      throw new ModelServiceError(`Moonshot request failed with status ${response.status}.`, {
        status: response.status >= 500 ? 502 : 500,
        exposeMessage: 'Kimi could not complete the scan right now.',
        retryable: shouldRetryStatus(response.status)
      });
    }

    const content = readCompletionText(parsedResponse);
    if (!content) {
      throw new ModelServiceError('Moonshot returned an empty completion.', {
        status: 502,
        exposeMessage: 'Kimi returned an empty scan response.'
      });
    }

    timings.backendMs = backendMs;
    timings.modelMs = backendMs;
    timings.totalMs = backendMs;
    timings.updatedAt = new Date().toISOString();

    return {
      rawContent: content,
      timings
    };
  } catch (error) {
    if (error instanceof ModelServiceError) {
      throw error;
    }

    if (error instanceof DOMException && error.name === 'AbortError') {
      if (context.signal?.aborted) {
        throw new ModelServiceError('Moonshot request was cancelled.', {
          status: 499,
          exposeMessage: 'The analysis request was cancelled.'
        });
      }

      throw new ModelServiceError('Moonshot request timed out.', {
        status: 504,
        exposeMessage: 'Kimi took too long to respond. Try again in a moment.',
        retryable: false
      });
    }

    logger.error(
      {
        requestId: context.requestId,
        mode: context.request.mode,
        model: context.route.model,
        detail: error instanceof Error ? error.message : 'Unknown model error'
      },
      'structured analysis request failed before completion'
    );
    throw new ModelServiceError('Structured analysis failed.', {
      status: 502,
      exposeMessage: 'The AI scan failed before a response was returned.',
      retryable: true
    });
  } finally {
    timeout.dispose();
  }
}

async function runStreamingAttempt(
  context: AttemptContext,
  retryCount: number,
  onEvent?: (event: AnalysisStreamEvent) => void
): Promise<StreamAttemptResult> {
  maybeAbort(context.signal);
  const timings = createAttemptTimings(retryCount);
  const requestStartedAt = Date.now();
  const timeout = withTimeout(context.signal);
  let receivedContent = false;

  try {
    logger.info(
      {
        requestId: context.requestId,
        mode: context.request.mode,
        profile: context.route.profile,
        model: context.route.model,
        maxTokens: context.route.maxTokens
      },
      'sending streaming moonshot request'
    );

    const response = await fetch(`${env.moonshotBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.moonshotApiKey}`
      },
      body: JSON.stringify(createMoonshotRequestBody(context.request, context.route, true)),
      signal: timeout.signal
    });

    if (!response.ok) {
      const responseText = await response.text();
      logger.error(
        {
          requestId: context.requestId,
          status: response.status,
          mode: context.request.mode,
          model: context.route.model,
          providerError: responseText.slice(0, 500)
        },
        'moonshot streaming request failed'
      );

      throw new ModelServiceError(`Moonshot request failed with status ${response.status}.`, {
        status: shouldRetryStatus(response.status) ? 502 : 500,
        exposeMessage: 'Kimi could not complete the scan right now.',
        retryable: shouldRetryStatus(response.status)
      });
    }

    if (!response.body) {
      throw new ModelServiceError('Moonshot did not return a readable stream.', {
        status: 502,
        exposeMessage: 'Kimi returned an unreadable streamed response.'
      });
    }

    onEvent?.({
      type: 'status',
      requestId: context.requestId,
      phase: 'requesting_backend',
      message: 'Kimi is preparing a fast scan...',
      timings: {
        backendMs: Date.now() - requestStartedAt
      }
    });

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let rawBuffer = '';
    let lineBuffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      lineBuffer += decoder.decode(value, { stream: true });

      while (true) {
        const newlineIndex = lineBuffer.indexOf('\n');
        if (newlineIndex < 0) {
          break;
        }

        const rawLine = lineBuffer.slice(0, newlineIndex).trim();
        lineBuffer = lineBuffer.slice(newlineIndex + 1);

        if (!rawLine || !rawLine.startsWith('data:')) {
          continue;
        }

        const payload = rawLine.slice(5).trim();
        if (!payload || payload === '[DONE]') {
          continue;
        }

        const chunk = JSON.parse(payload) as any;
        for (const choice of chunk.choices ?? []) {
          const deltaContent = typeof choice?.delta?.content === 'string' ? choice.delta.content : '';
          if (!deltaContent) {
            continue;
          }

          rawBuffer += deltaContent;

          if (!receivedContent) {
            receivedContent = true;
            timings.firstChunkMs = Date.now() - requestStartedAt;
            onEvent?.({
              type: 'status',
              requestId: context.requestId,
              phase: 'streaming',
              message: 'Kimi is streaming the answer...',
              timings: {
                firstChunkMs: timings.firstChunkMs
              }
            });
          }

          onEvent?.({
            type: 'delta',
            requestId: context.requestId,
            chunk: deltaContent,
            accumulatedText: rawBuffer
          });
        }
      }
    }

    if (!rawBuffer) {
      throw new ModelServiceError('Moonshot returned an empty streamed completion.', {
        status: 502,
        exposeMessage: 'Kimi returned an empty scan response.'
      });
    }

    const totalMs = Date.now() - requestStartedAt;
    const completedAt = new Date().toISOString();
    timings.backendMs = totalMs;
    timings.modelMs = totalMs;
    timings.totalMs = totalMs;
    timings.completedAt = completedAt;
    timings.updatedAt = completedAt;

    return {
      rawContent: rawBuffer,
      timings
    };
  } catch (error) {
    if (error instanceof ModelServiceError) {
      throw error;
    }

    if (error instanceof DOMException && error.name === 'AbortError') {
      if (context.signal?.aborted) {
        throw new ModelServiceError('Moonshot request was cancelled.', {
          status: 499,
          exposeMessage: 'The analysis request was cancelled.'
        });
      }

      throw new ModelServiceError('Moonshot request timed out.', {
        status: 504,
        exposeMessage: 'Kimi took too long to respond. Try again in a moment.'
      });
    }

    logger.error(
      {
        requestId: context.requestId,
        mode: context.request.mode,
        model: context.route.model,
        detail: error instanceof Error ? error.message : 'Unknown streaming error',
        receivedContent
      },
      'structured analysis streaming request failed'
    );
    throw new ModelServiceError('Structured analysis failed.', {
      status: 502,
      exposeMessage: 'The AI scan failed before a response was returned.',
      retryable: !receivedContent
    });
  } finally {
    timeout.dispose();
  }
}

function parseStructuredOutput(rawContent: string, request: AnalyzeRequestBody, requestId: string, timings: AnalysisTimingMetrics) {
  const startedAt = Date.now();
  let parsedOutput: unknown;

  try {
    parsedOutput = safeParseJson(rawContent);
  } catch (error) {
    logger.warn(
      {
        requestId,
        mode: request.mode,
        detail: error instanceof Error ? error.message : 'Unknown parse failure',
        contentPreview: rawContent.slice(0, 500)
      },
      'moonshot completion could not be parsed as JSON'
    );
    throw new ModelServiceError('Moonshot completion was not valid JSON.', {
      status: 502,
      exposeMessage: 'Kimi returned malformed JSON. Try the scan again.'
    });
  }

  const output = normalizeOutput(parsedOutput, request);
  const normalizationMs = Date.now() - startedAt;

  return {
    output,
    meta: buildMeta(requestId, 'miss', {
      ...timings,
      totalMs: timings.totalMs ?? normalizationMs,
      updatedAt: new Date().toISOString()
    }),
    normalizationMs
  };
}

export async function generateStructuredAnalysis(request: AnalyzeRequestBody, requestId: string = crypto.randomUUID()): Promise<GenerateAnalysisResult> {
  if (!env.moonshotApiKey) {
    throw new ModelServiceError('Missing MOONSHOT_API_KEY.', {
      status: 500,
      exposeMessage: 'The backend is missing MOONSHOT_API_KEY, so live analysis is unavailable.'
    });
  }

  const route = selectModelRoute(request);
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_PROVIDER_RETRIES; attempt += 1) {
    try {
      const attemptResult = await runNonStreamingAttempt({ request, requestId, route }, attempt);
      const normalized = parseStructuredOutput(attemptResult.rawContent, request, requestId, attemptResult.timings);
      const completedAt = new Date().toISOString();

      return {
        output: normalized.output,
        meta: finalizeMeta(normalized.meta, normalized.normalizationMs, completedAt)
      };
    } catch (error) {
      lastError = error;

      if (!(error instanceof ModelServiceError) || !error.retryable || error.status === 499 || attempt >= MAX_PROVIDER_RETRIES) {
        throw error;
      }

      logger.warn(
        {
          requestId,
          mode: request.mode,
          model: route.model,
          attempt,
          detail: error.message
        },
        'retrying moonshot request after transient failure'
      );
      await wait(RETRY_DELAY_MS * (attempt + 1));
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Analysis failed.');
}

export async function streamStructuredAnalysis(request: AnalyzeRequestBody, options: StreamAnalysisOptions): Promise<GenerateAnalysisResult> {
  if (!env.moonshotApiKey) {
    throw new ModelServiceError('Missing MOONSHOT_API_KEY.', {
      status: 500,
      exposeMessage: 'The backend is missing MOONSHOT_API_KEY, so live analysis is unavailable.'
    });
  }

  const route = selectModelRoute(request);
  let lastError: unknown;

  options.onEvent?.({
    type: 'status',
    requestId: options.requestId,
    phase: 'collecting_context',
    message: route.profile === 'quick' ? 'Preparing a quick scan...' : 'Preparing the analysis request...'
  });

  for (let attempt = 0; attempt <= MAX_PROVIDER_RETRIES; attempt += 1) {
    try {
      const attemptResult = await runStreamingAttempt(
        {
          request,
          requestId: options.requestId,
          signal: options.signal,
          route
        },
        attempt,
        options.onEvent
      );
      const normalized = parseStructuredOutput(attemptResult.rawContent, request, options.requestId, attemptResult.timings);
      const completedAt = new Date().toISOString();
      const meta = finalizeMeta(normalized.meta, normalized.normalizationMs, completedAt);

      options.onEvent?.({
        type: 'complete',
        requestId: options.requestId,
        mode: request.mode,
        output: normalized.output,
        meta
      });

      return {
        output: normalized.output,
        meta
      };
    } catch (error) {
      lastError = error;

      if (!(error instanceof ModelServiceError) || !error.retryable || error.status === 499 || attempt >= MAX_PROVIDER_RETRIES) {
        throw error;
      }

      options.onEvent?.({
        type: 'status',
        requestId: options.requestId,
        phase: 'requesting_backend',
        message: 'Retrying after a transient network issue...',
        timings: {
          retryCount: attempt + 1
        }
      });
      await wait(RETRY_DELAY_MS * (attempt + 1));
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Analysis failed.');
}
