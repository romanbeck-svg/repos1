import type {
  AnalysisApiResponse,
  AnalysisRequestPayload,
  AnalysisStreamEvent,
  AnalysisSuccessResponse
} from '../types/analysis';
import type {
  ScreenAnalyzeRequestPayload,
  ScreenAnalyzeResponse,
  ScreenFollowUpRequestPayload,
  ScreenFollowUpResponse
} from '../shared/types';
import type { QuizAnalyzeRequestPayload, QuizAnalyzeResponse } from '../shared/quizTypes';
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
const DEFAULT_SCREEN_ANALYSIS_TIMEOUT_MS = 20_000;
const DEFAULT_QUIZ_ANALYSIS_TIMEOUT_MS = 18_000;
const MAX_PAGE_TEXT_LENGTH = 12_000;
const MAX_INSTRUCTION_LENGTH = 2_000;
const MAX_SCREENSHOT_BASE64_LENGTH = 3_500_000;
const MAX_SCREENSHOT_DATA_URL_LENGTH = 5_600_000;
const MAX_BLOCK_COUNT = 32;
const MAX_QUESTION_CANDIDATE_COUNT = 12;
const MAX_SCREEN_CONTEXT_TEXT_LENGTH = 6_000;
const MAX_SCREEN_CONTEXT_QUESTION_COUNT = 5;

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

function createScreenTraceMeta(baseUrl: string, path: string, options: RequestOptions): RequestTraceMeta {
  return {
    requestId: options.requestId,
    source: options.source ?? 'screen-analysis',
    context: 'service_worker.screen_analysis',
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

function normalizeStringArray(values: string[] | undefined, maxItems: number, maxLength: number) {
  return (values ?? [])
    .map((value) => normalizeText(value, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeQuestionCandidates(payload: AnalysisRequestPayload['page']['questionCandidates']) {
  return (payload ?? [])
    .map((candidate, index) => ({
      id: normalizeText(candidate.id, 80) || `q${index + 1}`,
      question: normalizeText(candidate.question, 1_200),
      sectionLabel: normalizeText(candidate.sectionLabel ?? '', 140) || undefined,
      nearbyText: normalizeStringArray(candidate.nearbyText, 4, 1_000),
      answerChoices: normalizeStringArray(candidate.answerChoices, 8, 500),
      sourceAnchor: normalizeText(candidate.sourceAnchor, 120),
      selectorHint: normalizeText(candidate.selectorHint ?? '', 160) || undefined
    }))
    .filter((candidate) => candidate.question || candidate.sourceAnchor)
    .slice(0, MAX_QUESTION_CANDIDATE_COUNT);
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

function normalizeScreenshotDataUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith('data:image/')) {
    return '';
  }

  return trimmed.slice(0, MAX_SCREENSHOT_DATA_URL_LENGTH);
}

function normalizeQuestionAnchor<T extends { rect?: unknown; viewport?: unknown; scroll?: unknown; selector?: unknown }>(
  value: T | undefined
) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const rect = value.rect as
    | {
        top?: unknown;
        left?: unknown;
        width?: unknown;
        height?: unknown;
        bottom?: unknown;
        right?: unknown;
      }
    | undefined;
  const viewport = value.viewport as { width?: unknown; height?: unknown } | undefined;
  const scroll = value.scroll as { x?: unknown; y?: unknown } | undefined;
  const numberValue = (entry: unknown) => (Number.isFinite(Number(entry)) ? Math.round(Number(entry) * 10) / 10 : 0);
  const width = numberValue(rect?.width);
  const height = numberValue(rect?.height);

  if (width <= 0 || height <= 0) {
    return undefined;
  }

  return {
    rect: {
      top: numberValue(rect?.top),
      left: numberValue(rect?.left),
      width,
      height,
      bottom: numberValue(rect?.bottom),
      right: numberValue(rect?.right)
    },
    viewport: {
      width: Math.max(1, Math.round(numberValue(viewport?.width))),
      height: Math.max(1, Math.round(numberValue(viewport?.height)))
    },
    scroll: {
      x: Math.round(numberValue(scroll?.x)),
      y: Math.round(numberValue(scroll?.y))
    },
    selector: normalizeText(typeof value.selector === 'string' ? value.selector : '', 160) || undefined
  };
}

function normalizeStructuredExtraction(value: NonNullable<ScreenAnalyzeRequestPayload['textContext']>['structuredExtraction']) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const extraction = value;

  return {
    source: {
      url: normalizeText(extraction.source?.url ?? '', 700),
      title: normalizeText(extraction.source?.title ?? '', 240) || 'Current page',
      host: normalizeText(extraction.source?.host ?? '', 180),
      pathname: normalizeText(extraction.source?.pathname ?? '', 500)
    },
    mode: 'answer_questions' as const,
    extraction: {
      strategy: normalizeText(extraction.extraction?.strategy ?? '', 80) || 'generic-dom',
      confidence: Number.isFinite(extraction.extraction?.confidence)
        ? Math.min(Math.max(Number(extraction.extraction?.confidence), 0), 1)
        : 0,
      warnings: normalizeStringArray(extraction.extraction?.warnings, 8, 120),
      extractionMs: Number.isFinite(extraction.extraction?.extractionMs) ? Math.max(0, Math.round(extraction.extraction?.extractionMs ?? 0)) : 0,
      inspectedNodeCount: Number.isFinite(extraction.extraction?.inspectedNodeCount)
        ? Math.max(0, Math.round(extraction.extraction?.inspectedNodeCount ?? 0))
        : 0
    },
    questions: (extraction.questions ?? [])
      .map((question, index) => ({
        id: normalizeText(question.id, 80) || `q_${index + 1}`,
        question: normalizeText(question.question, 1_200),
        choices: (question.choices ?? [])
          .map((choice, choiceIndex) => ({
            key: normalizeText(choice.key, 8) || String.fromCharCode(65 + choiceIndex),
            text: normalizeText(choice.text, 500)
          }))
          .filter((choice) => choice.text)
          .slice(0, 8),
        nearbyContext: normalizeText(question.nearbyContext, 1_000),
        questionType: question.questionType,
        domHints: {
          selector: normalizeText(question.domHints?.selector ?? '', 160),
          hasRadioInputs: Boolean(question.domHints?.hasRadioInputs),
          hasCheckboxInputs: Boolean(question.domHints?.hasCheckboxInputs)
        },
        bbox: question.bbox
          ? {
              x: Number.isFinite(question.bbox.x) ? Math.min(Math.max(question.bbox.x, 0), 1) : 0,
              y: Number.isFinite(question.bbox.y) ? Math.min(Math.max(question.bbox.y, 0), 1) : 0,
              width: Number.isFinite(question.bbox.width) ? Math.min(Math.max(question.bbox.width, 0), 1) : 0,
              height: Number.isFinite(question.bbox.height) ? Math.min(Math.max(question.bbox.height, 0), 1) : 0
            }
          : undefined,
        anchor: normalizeQuestionAnchor(question.anchor),
        confidence: Number.isFinite(question.confidence) ? Math.min(Math.max(Number(question.confidence), 0), 1) : 0,
        extractionStrategy: normalizeText(question.extractionStrategy, 80) || 'generic-dom'
      }))
      .filter((question) => question.question)
      .slice(0, MAX_SCREEN_CONTEXT_QUESTION_COUNT),
    visibleTextFallback: normalizeText(extraction.visibleTextFallback ?? '', 6_000) || undefined
  };
}

function normalizeQuestionContext(value: NonNullable<ScreenAnalyzeRequestPayload['textContext']>['questionContext']) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const extractionMode =
    value.extractionMode === 'screenshot' || value.extractionMode === 'mixed' || value.extractionMode === 'dom'
      ? value.extractionMode
      : 'dom';
  const questions = (value.questions ?? [])
    .map((question, index) => ({
      id: normalizeText(question.id, 80) || `q_${index + 1}`,
      questionText: normalizeText(question.questionText, 1_200),
      choices: (question.choices ?? [])
        .map((choice, choiceIndex) => ({
          key: normalizeText(choice.key, 8) || String.fromCharCode(65 + choiceIndex),
          text: normalizeText(choice.text, 500)
        }))
        .filter((choice) => choice.text)
        .slice(0, 8),
      nearbyText: normalizeText(question.nearbyText, 420),
      elementHints: {
        selector: normalizeText(question.elementHints?.selector ?? '', 160),
        hasRadioInputs: Boolean(question.elementHints?.hasRadioInputs),
        hasCheckboxInputs: Boolean(question.elementHints?.hasCheckboxInputs),
        bbox: question.elementHints?.bbox
          ? {
              x: Number.isFinite(question.elementHints.bbox.x) ? Math.min(Math.max(question.elementHints.bbox.x, 0), 1) : 0,
              y: Number.isFinite(question.elementHints.bbox.y) ? Math.min(Math.max(question.elementHints.bbox.y, 0), 1) : 0,
              width: Number.isFinite(question.elementHints.bbox.width) ? Math.min(Math.max(question.elementHints.bbox.width, 0), 1) : 0,
              height: Number.isFinite(question.elementHints.bbox.height) ? Math.min(Math.max(question.elementHints.bbox.height, 0), 1) : 0
            }
          : undefined
      }
    }))
    .filter((question) => question.questionText)
    .slice(0, MAX_SCREEN_CONTEXT_QUESTION_COUNT);

  if (!questions.length) {
    return undefined;
  }

  return {
    pageUrl: normalizeText(value.pageUrl, 700),
    pageTitle: normalizeText(value.pageTitle, 240) || 'Current page',
    visibleTextHash: normalizeText(value.visibleTextHash, 120),
    extractionMode,
    questions
  };
}

function normalizeScreenAnalyzeRequest(payload: ScreenAnalyzeRequestPayload): ScreenAnalyzeRequestPayload {
  const viewport = {
    width: Number.isFinite(payload.viewport.width) ? Math.max(1, Math.round(payload.viewport.width)) : 1440,
    height: Number.isFinite(payload.viewport.height) ? Math.max(1, Math.round(payload.viewport.height)) : 900,
    devicePixelRatio:
      Number.isFinite(payload.viewport.devicePixelRatio) && payload.viewport.devicePixelRatio > 0
        ? payload.viewport.devicePixelRatio
        : 1,
    scrollX: Number.isFinite(payload.viewport.scrollX) ? Math.round(payload.viewport.scrollX ?? 0) : 0,
    scrollY: Number.isFinite(payload.viewport.scrollY) ? Math.round(payload.viewport.scrollY ?? 0) : 0
  };

  const textContext = payload.textContext
    ? {
        pageTitle: normalizeText(payload.textContext.pageTitle, 240) || 'Current page',
        pageUrl: normalizeText(payload.textContext.pageUrl, 700),
        selectedText: normalizeText(payload.textContext.selectedText ?? '', 1_200) || undefined,
        visibleText: normalizeText(payload.textContext.visibleText, MAX_SCREEN_CONTEXT_TEXT_LENGTH),
        headings: normalizeStringArray(payload.textContext.headings, 10, 180),
        labels: normalizeStringArray(payload.textContext.labels, 18, 160),
        questionCandidates: (payload.textContext.questionCandidates ?? [])
          .map((candidate, index) => ({
            id: normalizeText(candidate.id ?? '', 80) || `q_${index + 1}`,
            question: normalizeText(candidate.question, 1_200),
            answerChoices: normalizeStringArray(candidate.answerChoices, 8, 500),
            nearbyText: normalizeStringArray(candidate.nearbyText, 4, 1_000),
            bbox: candidate.bbox
              ? {
                  x: Number.isFinite(candidate.bbox.x) ? Math.min(Math.max(candidate.bbox.x, 0), 1) : 0,
                  y: Number.isFinite(candidate.bbox.y) ? Math.min(Math.max(candidate.bbox.y, 0), 1) : 0,
                  width: Number.isFinite(candidate.bbox.width) ? Math.min(Math.max(candidate.bbox.width, 0), 1) : 0,
                  height: Number.isFinite(candidate.bbox.height) ? Math.min(Math.max(candidate.bbox.height, 0), 1) : 0
                }
              : undefined,
            anchor: normalizeQuestionAnchor(candidate.anchor),
            questionType: candidate.questionType,
            confidence: Number.isFinite(candidate.confidence) ? Math.min(Math.max(Number(candidate.confidence), 0), 1) : undefined,
            extractionStrategy: normalizeText(candidate.extractionStrategy ?? '', 80) || undefined
          }))
          .filter((candidate) => candidate.question)
          .slice(0, MAX_SCREEN_CONTEXT_QUESTION_COUNT),
        structuredExtraction: normalizeStructuredExtraction(payload.textContext.structuredExtraction),
        questionContext: normalizeQuestionContext(payload.textContext.questionContext),
        visibleTextHash: normalizeText(payload.textContext.visibleTextHash ?? '', 120) || undefined,
        extractionMode:
          payload.textContext.extractionMode === 'screenshot' ||
          payload.textContext.extractionMode === 'mixed' ||
          payload.textContext.extractionMode === 'dom'
            ? payload.textContext.extractionMode
            : undefined,
        viewport,
        capturedAt: normalizeText(payload.textContext.capturedAt, 80) || new Date().toISOString(),
        pageSignature: normalizeText(payload.textContext.pageSignature ?? '', 700) || undefined
      }
    : undefined;

  return {
    image: normalizeScreenshotDataUrl(payload.image),
    pageUrl: normalizeText(payload.pageUrl, 700),
    pageTitle: normalizeText(payload.pageTitle, 240) || 'Current page',
    viewport,
    mode: payload.mode === 'find_questions_and_answer' ? 'find_questions_and_answer' : 'questions',
    imageMeta: payload.imageMeta
      ? {
          format: payload.imageMeta.format,
          source: payload.imageMeta.source === 'dom_context' ? 'dom_context' : 'screenshot',
          originalWidth: Number.isFinite(payload.imageMeta.originalWidth) ? Math.round(payload.imageMeta.originalWidth ?? 0) : undefined,
          originalHeight: Number.isFinite(payload.imageMeta.originalHeight) ? Math.round(payload.imageMeta.originalHeight ?? 0) : undefined,
          width: Number.isFinite(payload.imageMeta.width) ? Math.round(payload.imageMeta.width ?? 0) : undefined,
          height: Number.isFinite(payload.imageMeta.height) ? Math.round(payload.imageMeta.height ?? 0) : undefined,
          quality: Number.isFinite(payload.imageMeta.quality) ? payload.imageMeta.quality : undefined,
          originalBytes: Number.isFinite(payload.imageMeta.originalBytes) ? Math.round(payload.imageMeta.originalBytes ?? 0) : undefined,
          bytes: Number.isFinite(payload.imageMeta.bytes) ? Math.round(payload.imageMeta.bytes ?? 0) : undefined,
          resized: Boolean(payload.imageMeta.resized)
        }
      : undefined,
    textContext,
    debug: Boolean(payload.debug)
  };
}

function normalizeScreenFollowUpRequest(payload: ScreenFollowUpRequestPayload): ScreenFollowUpRequestPayload {
  return {
    analysisId: normalizeText(payload.analysisId, 120),
    itemId: normalizeText(payload.itemId, 120),
    question: normalizeText(payload.question, 800),
    originalQuestion: normalizeText(payload.originalQuestion, 900),
    originalAnswer: normalizeText(payload.originalAnswer, 900),
    screenshotContext: normalizeText(payload.screenshotContext ?? '', 1200) || undefined
  };
}

function normalizeRequest(payload: AnalysisRequestPayload): AnalysisRequestPayload {
  return {
    mode: payload.mode,
    instruction: normalizeText(payload.instruction, MAX_INSTRUCTION_LENGTH),
    page: {
      url: normalizeText(payload.page.url, 500),
      title: normalizeText(payload.page.title, 240) || 'Current page',
      text: normalizeText(payload.page.text, MAX_PAGE_TEXT_LENGTH),
      headings: normalizeStringArray(payload.page.headings, 12, 200),
      blocks: normalizeStringArray(payload.page.blocks, MAX_BLOCK_COUNT, 280),
      questionCandidates: normalizeQuestionCandidates(payload.page.questionCandidates),
      extractionNotes: normalizeStringArray(payload.page.extractionNotes, 8, 220)
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

export async function analyzeScreenshotWithBackend(
  baseUrl: string,
  payload: ScreenAnalyzeRequestPayload,
  timeoutMs = DEFAULT_SCREEN_ANALYSIS_TIMEOUT_MS,
  options: RequestOptions = {}
): Promise<ScreenAnalyzeResponse> {
  const timeout = createTimeoutController(timeoutMs, options.signal);
  const trace = createScreenTraceMeta(baseUrl, '/api/screen/analyze', options);

  try {
    const response = await fetchWithTrace(trace.url ?? joinUrl(baseUrl, '/api/screen/analyze'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(normalizeScreenAnalyzeRequest(payload)),
      signal: timeout.signal
    }, trace);

    const { parsed } = await readJsonResponse<ScreenAnalyzeResponse>(response, trace, {
      routeLabel: 'Screen analyze route',
      invalidJsonMessage: 'The backend returned an invalid screen analysis payload.'
    });

    if (!parsed || typeof parsed.ok !== 'boolean') {
      throw new AnalysisApiError('invalid_response', 'The backend returned an incomplete screen analysis response.', {
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
        throw createAbortError('cancelled', 'The screen analysis request was cancelled.', options, trace);
      }

      throw createAbortError('timeout', `The screen analysis request timed out after ${timeoutMs}ms.`, options, trace);
    }

    throw toAnalysisApiError(new RequestTraceError('Mako IQ could not reach the screen analysis backend.', {
      ...trace,
      category: 'network_error',
      detail: String(error),
      originalMessage: error instanceof Error ? error.message : String(error)
    }));
  } finally {
    timeout.dispose();
  }
}

export async function analyzeQuizWithBackend(
  baseUrl: string,
  payload: QuizAnalyzeRequestPayload,
  timeoutMs = DEFAULT_QUIZ_ANALYSIS_TIMEOUT_MS,
  options: RequestOptions = {}
): Promise<QuizAnalyzeResponse> {
  const timeout = createTimeoutController(timeoutMs, options.signal);
  const trace = createScreenTraceMeta(baseUrl, '/api/quiz/analyze', {
    ...options,
    source: options.source ?? 'quiz-prefetch'
  });

  try {
    const response = await fetchWithTrace(trace.url ?? joinUrl(baseUrl, '/api/quiz/analyze'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: timeout.signal
    }, trace);

    const { parsed } = await readJsonResponse<QuizAnalyzeResponse>(response, trace, {
      routeLabel: 'Quiz analyze route',
      invalidJsonMessage: 'The backend returned an invalid quiz analysis payload.'
    });

    if (!parsed || typeof parsed.status !== 'string' || parsed.questionHash !== payload.questionHash || parsed.requestId !== payload.requestId) {
      throw new AnalysisApiError('invalid_response', 'The backend returned an incomplete quiz analysis response.', {
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
        throw createAbortError('cancelled', 'The quiz prefetch request was cancelled.', options, trace);
      }

      throw createAbortError('timeout', `The quiz prefetch request timed out after ${timeoutMs}ms.`, options, trace);
    }

    throw toAnalysisApiError(new RequestTraceError('Mako IQ could not reach the quiz analysis backend.', {
      ...trace,
      category: 'network_error',
      detail: String(error),
      originalMessage: error instanceof Error ? error.message : String(error)
    }));
  } finally {
    timeout.dispose();
  }
}

export async function askScreenFollowUpWithBackend(
  baseUrl: string,
  payload: ScreenFollowUpRequestPayload,
  timeoutMs = DEFAULT_ANALYSIS_TIMEOUT_MS,
  options: RequestOptions = {}
): Promise<ScreenFollowUpResponse> {
  const timeout = createTimeoutController(timeoutMs, options.signal);
  const trace = createScreenTraceMeta(baseUrl, '/api/screen/follow-up', options);

  try {
    const response = await fetchWithTrace(trace.url ?? joinUrl(baseUrl, '/api/screen/follow-up'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(normalizeScreenFollowUpRequest(payload)),
      signal: timeout.signal
    }, trace);

    const { parsed } = await readJsonResponse<ScreenFollowUpResponse>(response, trace, {
      routeLabel: 'Screen follow-up route',
      invalidJsonMessage: 'The backend returned an invalid screen follow-up payload.'
    });

    if (!parsed || typeof parsed.ok !== 'boolean') {
      throw new AnalysisApiError('invalid_response', 'The backend returned an incomplete screen follow-up response.', {
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
        throw createAbortError('cancelled', 'The follow-up request was cancelled.', options, trace);
      }

      throw createAbortError('timeout', `The follow-up request timed out after ${timeoutMs}ms.`, options, trace);
    }

    throw toAnalysisApiError(new RequestTraceError('Mako IQ could not reach the screen follow-up backend.', {
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
