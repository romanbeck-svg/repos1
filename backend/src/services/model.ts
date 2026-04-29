import { env, flags } from '../config/env.js';
import { OllamaServiceError, ollamaChat } from '../ai/ollama.js';
import { logger } from '../lib/logger.js';
import type {
  AnalysisAiTag,
  AnalysisExtractionMode,
  AnalysisQuestionCandidate,
  AnalysisQuestionStatus,
  AnalysisResponseMeta,
  AnalysisTimingMetrics,
  AnalysisValidationSummary,
  AnalyzeRequestBody,
  StructuredAnalysisOutput,
  StructuredQuestionAnswer,
  AnalysisStreamEvent
} from '../types/analysis.js';

const MODEL_TIMEOUT_MS = env.aiRequestTimeoutMs;
const MAX_PROVIDER_RETRIES = 1;
const RETRY_DELAY_MS = 650;
const ACCEPTABLE_FINISH_REASONS = new Set(['stop']);

const QUESTION_ENGINE_PROMPT = `You are Mako IQ's page question extraction and answer engine.
You are not a page summarizer.
Your job is to read the supplied page content and return only structured question-answer results.

Rules:

Identify only real questions, prompts, or answerable tasks visible or strongly implied by the supplied page context.
For each question, produce a direct answer.
If answer choices are supplied, select the best visible choice and include the exact choice key/text in the answer.
Under each answer, produce a short context block that helps the student understand why the answer fits.
Keep each answer tied to the exact question id provided in the input.
Use only the supplied page content and screenshot/context.
If there are no real questions on the page, return ai_tag = "no_questions".
If a question exists but cannot be answered confidently from the supplied context, mark it as answered = false and status = "insufficient_context".
If the content appears to be a restricted or proctored assessment, do not provide direct answers; provide only study-safe concept support.
Never summarize the whole page.
Never repeat long passages from the page.
Never echo the question as the answer.
Never output prose outside the required JSON object.`;

const QUESTION_SCHEMA = {
  name: 'mako_page_question_answers',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ai_tag', 'extraction_mode', 'questions'],
    properties: {
      ai_tag: {
        type: 'string',
        enum: ['success', 'no_questions', 'insufficient_context', 'error']
      },
      extraction_mode: {
        type: 'string',
        enum: ['dom', 'vision', 'hybrid']
      },
      questions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'question', 'answer', 'context', 'answered', 'status', 'confidence', 'evidence', 'source_anchor'],
          properties: {
            id: { type: 'string' },
            question: { type: 'string' },
            answer: { type: 'string' },
            context: { type: 'string' },
            answered: { type: 'boolean' },
            status: {
              type: 'string',
              enum: ['answered', 'insufficient_context']
            },
            confidence: { type: 'number' },
            evidence: {
              type: 'array',
              items: { type: 'string' }
            },
            source_anchor: { type: 'string' }
          }
        }
      }
    }
  }
} as const;

interface GenerateAnalysisResult {
  output: StructuredAnalysisOutput;
  meta: AnalysisResponseMeta;
}

interface StreamAnalysisOptions {
  requestId: string;
  signal?: AbortSignal;
  onEvent?: (event: AnalysisStreamEvent) => void;
}

interface ModelRoute {
  provider: 'ollama' | 'kimi';
  profile: AnalysisExtractionMode;
  model: string;
  maxTokens: number;
}

interface AttemptContext {
  request: AnalyzeRequestBody;
  requestId: string;
  signal?: AbortSignal;
  route: ModelRoute;
}

interface AttemptResult {
  rawContent: string;
  finishReason: string;
  timings: AnalysisTimingMetrics;
}

interface ParsedModelOutput {
  ai_tag: AnalysisAiTag;
  extraction_mode: AnalysisExtractionMode;
  questions: Array<{
    id: string;
    question: string;
    answer: string;
    context: string;
    answered: boolean;
    status: AnalysisQuestionStatus;
    confidence: number;
    evidence: string[];
    source_anchor: string;
  }>;
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

function cleanText(value: unknown, maxLength = 420) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function cleanStringArray(value: unknown, maxItems: number, maxItemLength: number) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => cleanText(item, maxItemLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeForCompare(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countWords(value: string) {
  return normalizeForCompare(value).split(' ').filter(Boolean).length;
}

function tokenSet(value: string) {
  return new Set(normalizeForCompare(value).split(' ').filter(Boolean));
}

function tokenJaccard(left: string, right: string) {
  const leftSet = tokenSet(left);
  const rightSet = tokenSet(right);
  if (!leftSet.size || !rightSet.size) {
    return 0;
  }

  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      intersection += 1;
    }
  }

  return intersection / (leftSet.size + rightSet.size - intersection);
}

function clampConfidence(value: number, min = 0, max = 1) {
  return Math.min(Math.max(value, min), max);
}

function parseConfidenceScore(value: unknown) {
  const rawText = typeof value === 'string' ? value.trim() : '';
  const percentMatch = rawText.match(/^([0-9]+(?:\.[0-9]+)?)\s*%$/);
  const parsed = percentMatch
    ? Number(percentMatch[1]) / 100
    : typeof value === 'string'
      ? Number(rawText.replace(/,/g, ''))
      : Number(value);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return clampConfidence(parsed > 1 ? parsed / 100 : parsed);
}

function answerMatchesCandidateChoice(answer: string, candidate?: AnalysisQuestionCandidate) {
  if (!candidate?.answerChoices.length) {
    return false;
  }

  const normalizedAnswer = normalizeForCompare(answer);
  if (!normalizedAnswer) {
    return false;
  }

  return candidate.answerChoices.some((choice) => {
    const normalizedChoice = normalizeForCompare(choice);
    return normalizedChoice === normalizedAnswer || normalizedChoice.includes(normalizedAnswer) || normalizedAnswer.includes(normalizedChoice);
  });
}

function estimateQuestionConfidence(input: {
  rawConfidence: unknown;
  answered: boolean;
  status: AnalysisQuestionStatus;
  answer: string;
  context: string;
  evidence: string[];
  candidate?: AnalysisQuestionCandidate;
}) {
  const parsed = parseConfidenceScore(input.rawConfidence);
  if (parsed !== null) {
    return parsed;
  }

  if (!input.answered || input.status !== 'answered' || !input.answer) {
    return 0.35;
  }

  let estimated = input.candidate?.answerChoices.length ? 0.64 : 0.62;
  if (answerMatchesCandidateChoice(input.answer, input.candidate)) {
    estimated = 0.76;
  }

  if (input.context) {
    estimated += 0.05;
  }

  if (input.evidence.length) {
    estimated += 0.04;
  }

  if (countWords(input.answer) >= 3) {
    estimated += 0.03;
  }

  return clampConfidence(estimated, 0.45, 0.86);
}

function isQuestionEcho(question: string, answer: string) {
  const normalizedQuestion = normalizeForCompare(question);
  const normalizedAnswer = normalizeForCompare(answer);

  if (!normalizedQuestion || !normalizedAnswer) {
    return false;
  }

  if (normalizedQuestion === normalizedAnswer) {
    return true;
  }

  if (normalizedAnswer.length >= 24 && (normalizedAnswer.includes(normalizedQuestion) || normalizedQuestion.includes(normalizedAnswer))) {
    return true;
  }

  return countWords(question) >= 4 && tokenJaccard(question, answer) >= 0.9;
}

function isSourceParrot(answer: string, sourceText: string, sourceBlocks: string[]) {
  if (answer.length < 90) {
    return false;
  }

  const normalizedAnswer = normalizeForCompare(answer);
  if (!normalizedAnswer) {
    return false;
  }

  if (normalizeForCompare(sourceText).includes(normalizedAnswer)) {
    return true;
  }

  return sourceBlocks.some((block) => normalizeForCompare(block).includes(normalizedAnswer));
}

function createAttemptTimings(retryCount: number): AnalysisTimingMetrics {
  const startedAt = new Date().toISOString();

  return {
    startedAt,
    updatedAt: startedAt,
    retryCount
  };
}

function maybeAbort(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new ModelServiceError('Moonshot request was cancelled.', {
      status: 499,
      exposeMessage: 'The analysis request was cancelled.'
    });
  }
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function shouldRetryStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

function selectModelRoute(request: AnalyzeRequestBody): ModelRoute {
  if (env.aiProvider === 'ollama') {
    const profile: AnalysisExtractionMode = request.screenshotBase64 && request.page.text.length < 180
      ? 'vision'
      : request.screenshotBase64
        ? 'hybrid'
        : 'dom';
    const model = request.screenshotBase64 && env.ollamaVisionModel ? env.ollamaVisionModel : env.ollamaModel;

    return {
      provider: 'ollama',
      profile,
      model,
      maxTokens: profile === 'dom' ? 1_200 : 1_400
    };
  }

  if (request.screenshotBase64 && request.page.text.length < 180) {
    return {
      provider: 'kimi',
      profile: 'vision',
      model: env.kimiModel,
      maxTokens: 1_200
    };
  }

  if (request.screenshotBase64) {
    return {
      provider: 'kimi',
      profile: 'hybrid',
      model: env.kimiModel,
      maxTokens: 1_400
    };
  }

  return {
    provider: 'kimi',
    profile: 'dom',
    model: env.moonshotQuickModel || env.kimiModel,
    maxTokens: request.page.questionCandidates.length ? 700 : 1_200
  };
}

function buildUserPayload(request: AnalyzeRequestBody, route: ModelRoute) {
  return JSON.stringify(
    {
      instruction: cleanText(request.instruction, 400) || null,
      expected_output: {
        ai_tag: ['success', 'no_questions', 'insufficient_context', 'error'],
        extraction_mode: route.profile,
        question_count_hint: request.page.questionCandidates.length
      },
      page: {
        url: request.page.url,
        title: request.page.title,
        headings: request.page.headings,
        blocks: request.page.blocks,
        question_candidates: request.page.questionCandidates.map((candidate) => ({
          id: candidate.id,
          question: candidate.question,
          section_label: candidate.sectionLabel ?? '',
          nearby_text: candidate.nearbyText,
          answer_choices: candidate.answerChoices,
          source_anchor: candidate.sourceAnchor,
          selector_hint: candidate.selectorHint ?? ''
        })),
        text_excerpt: request.page.text,
        extraction_notes: request.page.extractionNotes ?? []
      },
      screenshot_attached: Boolean(request.screenshotBase64)
    },
    null,
    2
  );
}

function buildMoonshotRequestBody(request: AnalyzeRequestBody, route: ModelRoute, stream: boolean, useJsonSchema: boolean) {
  const userContent =
    request.screenshotBase64 && (route.profile === 'vision' || route.profile === 'hybrid')
      ? [
          {
            type: 'text',
            text: buildUserPayload(request, route)
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${request.screenshotBase64}`
            }
          }
        ]
      : [
          {
            type: 'text',
            text: buildUserPayload(request, route)
          }
        ];

  const body: Record<string, unknown> = {
    model: route.model,
    messages: [
      {
        role: 'system',
        content: QUESTION_ENGINE_PROMPT
      },
      {
        role: 'user',
        content: userContent
      }
    ],
    max_tokens: route.maxTokens,
    thinking: {
      type: 'disabled'
    },
    stream
  };

  body.response_format = useJsonSchema
    ? {
        type: 'json_schema',
        json_schema: QUESTION_SCHEMA
      }
    : {
        type: 'json_object'
      };

  return body;
}

function buildOllamaMessages(request: AnalyzeRequestBody, route: ModelRoute) {
  const userMessage: {
    role: 'user';
    content: string;
    images?: string[];
  } = {
    role: 'user',
    content: buildUserPayload(request, route)
  };

  if (request.screenshotBase64 && env.ollamaVisionModel && route.model === env.ollamaVisionModel) {
    userMessage.images = [request.screenshotBase64];
  }

  return [
    {
      role: 'system' as const,
      content: QUESTION_ENGINE_PROMPT
    },
    userMessage
  ];
}

function extractProviderMessageContent(content: unknown) {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }

      if (part && typeof part === 'object' && typeof (part as { text?: string }).text === 'string') {
        return (part as { text: string }).text;
      }

      return '';
    })
    .join('\n')
    .trim();
}

function extractCompletionText(payload: any) {
  const messageContent = payload?.choices?.[0]?.message?.content;
  return extractProviderMessageContent(messageContent);
}

function shouldFallbackToJsonObject(status: number, responseText: string) {
  return status === 400 && /json_schema|response_format|schema/i.test(responseText);
}

function getKimiExposeMessage(status: number) {
  if (status === 401 || status === 403) {
    return 'Kimi rejected the API key. Check MOONSHOT_API_KEY in backend/.env.';
  }

  return 'Kimi API request failed. Check internet connection, API key, billing, or model name.';
}

async function runNonStreamingAttemptWithFormat(
  context: AttemptContext,
  retryCount: number,
  useJsonSchema: boolean
): Promise<AttemptResult> {
  maybeAbort(context.signal);
  const timings = createAttemptTimings(retryCount);
  const startedAt = Date.now();
  const timeout = withTimeout(context.signal);

  try {
    logger.info(
      {
        requestId: context.requestId,
        mode: context.request.mode,
        extractionMode: context.route.profile,
        model: context.route.model,
        maxTokens: context.route.maxTokens,
        schemaMode: useJsonSchema ? 'json_schema' : 'json_object'
      },
      'sending non-stream moonshot QA request'
    );

    const response = await fetch(`${env.kimiBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.moonshotApiKey}`
      },
      body: JSON.stringify(buildMoonshotRequestBody(context.request, context.route, false, useJsonSchema)),
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
      if (useJsonSchema && shouldFallbackToJsonObject(response.status, responseText)) {
        return runNonStreamingAttemptWithFormat(context, retryCount, false);
      }

      logger.error(
        {
          requestId: context.requestId,
          status: response.status,
          mode: context.request.mode,
          extractionMode: context.route.profile,
          model: context.route.model,
          providerError: parsedResponse?.error?.message ?? responseText.slice(0, 500)
        },
        'moonshot QA request failed'
      );

      throw new ModelServiceError(`Kimi request failed with status ${response.status}.`, {
        status: response.status >= 500 ? 502 : 500,
        exposeMessage: getKimiExposeMessage(response.status),
        retryable: shouldRetryStatus(response.status)
      });
    }

    const content = extractCompletionText(parsedResponse);
    const finishReason = cleanText(parsedResponse?.choices?.[0]?.finish_reason, 40) || 'unknown';
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
      finishReason,
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
        extractionMode: context.route.profile,
        model: context.route.model,
        detail: error instanceof Error ? error.message : 'Unknown model error'
      },
      'structured QA request failed before completion'
    );

    throw new ModelServiceError('Kimi structured analysis failed.', {
      status: 502,
      exposeMessage: 'Kimi API request failed. Check internet connection, API key, billing, or model name.',
      retryable: true
    });
  } finally {
    timeout.dispose();
  }
}

async function runNonStreamingOllamaAttempt(context: AttemptContext, retryCount: number): Promise<AttemptResult> {
  maybeAbort(context.signal);
  const timings = createAttemptTimings(retryCount);
  const startedAt = Date.now();
  const timeout = withTimeout(context.signal);

  try {
    logger.info(
      {
        requestId: context.requestId,
        mode: context.request.mode,
        extractionMode: context.route.profile,
        model: context.route.model,
        maxTokens: context.route.maxTokens,
        hasScreenshot: Boolean(context.request.screenshotBase64)
      },
      'sending non-stream ollama QA request'
    );

    if (context.request.screenshotBase64 && context.route.profile === 'vision' && !env.ollamaVisionModel) {
      throw new ModelServiceError('No Ollama vision model is configured for screenshot-only analysis.', {
        status: 501,
        exposeMessage: 'Screenshot analysis needs a local vision model. Configure OLLAMA_VISION_MODEL in Mako IQ Companion.'
      });
    }

    const response = await ollamaChat({
      model: context.route.model,
      messages: buildOllamaMessages(context.request, context.route),
      format: 'json',
      keepAlive: env.ollamaKeepAlive,
      options: {
        temperature: 0,
        num_predict: context.route.maxTokens
      },
      signal: timeout.signal,
      timeoutMs: MODEL_TIMEOUT_MS
    });

    const backendMs = Date.now() - startedAt;
    timings.backendMs = backendMs;
    timings.modelMs = Math.round((response.totalDuration ?? backendMs * 1_000_000) / 1_000_000);
    timings.totalMs = backendMs;
    timings.updatedAt = new Date().toISOString();

    return {
      rawContent: response.content,
      finishReason: response.doneReason || 'stop',
      timings
    };
  } catch (error) {
    if (error instanceof ModelServiceError) {
      throw error;
    }

    if (error instanceof OllamaServiceError) {
      throw new ModelServiceError(error.message, {
        status: error.status,
        exposeMessage: error.exposeMessage,
        retryable: error.retryable
      });
    }

    if (error instanceof DOMException && error.name === 'AbortError') {
      if (context.signal?.aborted) {
        throw new ModelServiceError('Ollama request was cancelled.', {
          status: 499,
          exposeMessage: 'The analysis request was cancelled.'
        });
      }

      throw new ModelServiceError('Ollama request timed out.', {
        status: 504,
        exposeMessage: 'Local AI model took too long to respond. Check Mako IQ Companion and try again.',
        retryable: true
      });
    }

    logger.error(
      {
        requestId: context.requestId,
        mode: context.request.mode,
        extractionMode: context.route.profile,
        model: context.route.model,
        detail: error instanceof Error ? error.message : 'Unknown local model error'
      },
      'ollama structured QA request failed before completion'
    );

    throw new ModelServiceError('Ollama structured analysis failed.', {
      status: 502,
      exposeMessage: 'Local AI could not complete the scan.',
      retryable: true
    });
  } finally {
    timeout.dispose();
  }
}

async function runStreamingAttemptWithFormat(
  context: AttemptContext,
  retryCount: number,
  onEvent: ((event: AnalysisStreamEvent) => void) | undefined,
  useJsonSchema: boolean
): Promise<AttemptResult> {
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
        extractionMode: context.route.profile,
        model: context.route.model,
        maxTokens: context.route.maxTokens,
        schemaMode: useJsonSchema ? 'json_schema' : 'json_object'
      },
      'sending streaming moonshot QA request'
    );

    const response = await fetch(`${env.kimiBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.moonshotApiKey}`
      },
      body: JSON.stringify(buildMoonshotRequestBody(context.request, context.route, true, useJsonSchema)),
      signal: timeout.signal
    });

    if (!response.ok) {
      const responseText = await response.text();
      if (useJsonSchema && shouldFallbackToJsonObject(response.status, responseText)) {
        return runStreamingAttemptWithFormat(context, retryCount, onEvent, false);
      }

      logger.error(
        {
          requestId: context.requestId,
          status: response.status,
          mode: context.request.mode,
          extractionMode: context.route.profile,
          model: context.route.model,
          providerError: responseText.slice(0, 500)
        },
        'moonshot streaming QA request failed'
      );

      throw new ModelServiceError(`Kimi request failed with status ${response.status}.`, {
        status: shouldRetryStatus(response.status) ? 502 : 500,
        exposeMessage: getKimiExposeMessage(response.status),
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
      message: 'Kimi is preparing question extraction...',
      timings: {
        backendMs: Date.now() - requestStartedAt
      }
    });

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let rawBuffer = '';
    let lineBuffer = '';
    let finishReason = 'unknown';

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
          const deltaContent = extractProviderMessageContent(choice?.delta?.content);
          const nextFinishReason = cleanText(choice?.finish_reason, 40);
          if (nextFinishReason) {
            finishReason = nextFinishReason;
          }

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
              message: 'Kimi is validating question-answer output...',
              timings: {
                firstChunkMs: timings.firstChunkMs
              }
            });
          }
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
      finishReason,
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
        extractionMode: context.route.profile,
        model: context.route.model,
        detail: error instanceof Error ? error.message : 'Unknown streaming error',
        receivedContent
      },
      'structured QA streaming request failed'
    );

    throw new ModelServiceError('Kimi structured analysis failed.', {
      status: 502,
      exposeMessage: 'Kimi API request failed. Check internet connection, API key, billing, or model name.',
      retryable: !receivedContent
    });
  } finally {
    timeout.dispose();
  }
}

function validateParsedOutput(
  parsed: unknown,
  request: AnalyzeRequestBody,
  finishReason: string
): { output: StructuredAnalysisOutput; normalizationMs: number } {
  const startedAt = Date.now();
  const candidateMap = new Map(request.page.questionCandidates.map((candidate) => [candidate.id, candidate]));
  const sourceBlocks = request.page.blocks.length ? request.page.blocks : request.page.text.split(/\n{2,}/).filter(Boolean);
  const raw = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  const aiTag = cleanText(raw.ai_tag, 60) as AnalysisAiTag;
  const extractionMode = cleanText(raw.extraction_mode, 20) as AnalysisExtractionMode;
  const candidateQuestionCount = request.page.questionCandidates.length;
  let parseSuccess = true;
  let schemaValid = true;
  let echoGuardHit = false;
  let resultState: StructuredAnalysisOutput['resultState'] = 'invalid_ai_output';

  const normalizedQuestions: StructuredQuestionAnswer[] = [];

  if (!['success', 'no_questions', 'insufficient_context', 'error'].includes(aiTag)) {
    schemaValid = false;
  }

  if (!['dom', 'vision', 'hybrid'].includes(extractionMode)) {
    schemaValid = false;
  }

  if (!Array.isArray(raw.questions)) {
    schemaValid = false;
  } else {
    for (const rawQuestion of raw.questions) {
      if (!rawQuestion || typeof rawQuestion !== 'object') {
        schemaValid = false;
        continue;
      }

      const questionRecord = rawQuestion as Record<string, unknown>;
      const id = cleanText(questionRecord.id, 80);
      const candidate = candidateMap.get(id);

      if (!id || !candidate) {
        schemaValid = false;
        continue;
      }

      const answered = Boolean(questionRecord.answered);
      const status = cleanText(questionRecord.status, 40) === 'answered' ? 'answered' : 'insufficient_context';
      const answer = cleanText(questionRecord.answer, 320);
      const question = cleanText(questionRecord.question, 320) || candidate.question;
      const context = cleanText(questionRecord.context, 240);
      const evidence = cleanStringArray(questionRecord.evidence, 4, 180);
      const confidence = estimateQuestionConfidence({
        rawConfidence: questionRecord.confidence,
        answered,
        status,
        answer,
        context,
        evidence,
        candidate
      });
      const normalized = {
        id,
        question,
        answer,
        context,
        answered,
        status,
        confidence,
        evidence,
        source_anchor: candidate.sourceAnchor
      } satisfies StructuredQuestionAnswer;

      if (!normalized.question || (!normalized.answer && normalized.answered)) {
        schemaValid = false;
        continue;
      }

      if (normalized.answered && (isQuestionEcho(normalized.question, normalized.answer) || isSourceParrot(normalized.answer, request.page.text, sourceBlocks))) {
        echoGuardHit = true;
      }

      if (
        normalized.answered &&
        !normalized.context &&
        isSourceParrot(normalized.answer, request.page.text, sourceBlocks)
      ) {
        echoGuardHit = true;
      }

      normalizedQuestions.push(normalized);
    }
  }

  const answeredQuestionCount = normalizedQuestions.filter((question) => question.answered).length;
  const acceptableFinishReason = ACCEPTABLE_FINISH_REASONS.has(finishReason);

  if (!acceptableFinishReason) {
    schemaValid = false;
  }

  if (aiTag === 'success' && schemaValid && answeredQuestionCount > 0 && normalizedQuestions.length > 0 && !echoGuardHit) {
    resultState = 'success';
  } else if (aiTag === 'no_questions' && schemaValid) {
    resultState = 'no_questions';
  } else if (aiTag === 'insufficient_context' && schemaValid) {
    resultState = 'insufficient_context';
  } else {
    resultState = 'invalid_ai_output';
  }

  const aiTaggedSuccessfully =
    resultState === 'success' &&
    acceptableFinishReason &&
    parseSuccess &&
    schemaValid &&
    aiTag === 'success' &&
    normalizedQuestions.length > 0 &&
    answeredQuestionCount > 0 &&
    !echoGuardHit;

  const message =
    resultState === 'success'
      ? `Validated ${answeredQuestionCount} question${answeredQuestionCount === 1 ? '' : 's'} from the page.`
      : resultState === 'no_questions'
        ? 'No real questions were detected on this page.'
        : resultState === 'insufficient_context'
          ? 'Questions were detected, but the visible context was not sufficient to answer them confidently.'
          : 'AI output was suppressed because it did not pass validation.';

  const validation: AnalysisValidationSummary = {
    modelCallSucceeded: true,
    finishReason,
    parseSuccess,
    schemaValid,
    echoGuardHit,
    candidateQuestionCount,
    answeredQuestionCount
  };

  return {
    output: {
      resultState,
      ai_tag: resultState === 'invalid_ai_output' ? 'error' : aiTag,
      extraction_mode: extractionMode || (request.screenshotBase64 ? 'hybrid' : 'dom'),
      questions: normalizedQuestions,
      aiTaggedSuccessfully,
      validation,
      message
    },
    normalizationMs: Date.now() - startedAt
  };
}

function parseStructuredOutput(rawContent: string, request: AnalyzeRequestBody, requestId: string, finishReason: string) {
  let parsedOutput: ParsedModelOutput;

  try {
    parsedOutput = safeParseJson<ParsedModelOutput>(rawContent);
  } catch (error) {
    logger.warn(
      {
        requestId,
        mode: request.mode,
        detail: error instanceof Error ? error.message : 'Unknown parse failure',
        contentPreview: rawContent.slice(0, 500)
      },
      'moonshot QA completion could not be parsed as JSON'
    );

    const validation: AnalysisValidationSummary = {
      modelCallSucceeded: true,
      finishReason,
      parseSuccess: false,
      schemaValid: false,
      echoGuardHit: false,
      candidateQuestionCount: request.page.questionCandidates.length,
      answeredQuestionCount: 0
    };
    const extractionMode: AnalysisExtractionMode = request.screenshotBase64 ? 'hybrid' : 'dom';

    return {
      output: {
        resultState: 'invalid_ai_output' as const,
        ai_tag: 'error' as const,
        extraction_mode: extractionMode,
        questions: [],
        aiTaggedSuccessfully: false,
        validation,
        message: 'AI output was suppressed because the model did not return valid JSON.'
      },
      normalizationMs: 0
    };
  }

  const result = validateParsedOutput(parsedOutput, request, finishReason);
  logger.info(
    {
      requestId,
      mode: request.mode,
      extractionMode: result.output.extraction_mode,
      aiTag: result.output.ai_tag,
      resultState: result.output.resultState,
      candidateQuestionCount: result.output.validation.candidateQuestionCount,
      answeredQuestionCount: result.output.validation.answeredQuestionCount,
      parseSuccess: result.output.validation.parseSuccess,
      schemaValid: result.output.validation.schemaValid,
      echoGuardHit: result.output.validation.echoGuardHit,
      aiTaggedSuccessfully: result.output.aiTaggedSuccessfully
    },
    'structured QA output validated'
  );
  return result;
}

function buildMeta(requestId: string, cacheStatus: 'miss', timings: AnalysisTimingMetrics): AnalysisResponseMeta {
  return {
    requestId,
    cacheStatus,
    timings
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

export async function generateStructuredAnalysis(request: AnalyzeRequestBody, requestId: string = crypto.randomUUID()): Promise<GenerateAnalysisResult> {
  const route = selectModelRoute(request);
  if (route.provider === 'kimi' && !flags.moonshotConfigured) {
    throw new ModelServiceError('Missing MOONSHOT_API_KEY.', {
      status: 500,
      exposeMessage: 'Kimi API key is missing in the local backend. Add MOONSHOT_API_KEY to backend/.env or configure it in Mako IQ Companion.'
    });
  }

  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_PROVIDER_RETRIES; attempt += 1) {
    try {
      const attemptResult =
        route.provider === 'ollama'
          ? await runNonStreamingOllamaAttempt({ request, requestId, route }, attempt)
          : await runNonStreamingAttemptWithFormat({ request, requestId, route }, attempt, true);
      const { output, normalizationMs } = parseStructuredOutput(
        attemptResult.rawContent,
        request,
        requestId,
        attemptResult.finishReason
      );
      const completedAt = new Date().toISOString();
      const meta = finalizeMeta(buildMeta(requestId, 'miss', attemptResult.timings), normalizationMs, completedAt);

      return {
        output,
        meta
      };
    } catch (error) {
      lastError = error;
      const retryable = error instanceof ModelServiceError ? error.retryable : false;
      if (attempt < MAX_PROVIDER_RETRIES && retryable) {
        await wait(RETRY_DELAY_MS);
        continue;
      }
      throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new ModelServiceError('Structured analysis failed unexpectedly.');
}

export async function streamStructuredAnalysis(request: AnalyzeRequestBody, options: StreamAnalysisOptions): Promise<void> {
  const route = selectModelRoute(request);
  if (route.provider === 'kimi' && !flags.moonshotConfigured) {
    throw new ModelServiceError('Missing MOONSHOT_API_KEY.', {
      status: 500,
      exposeMessage: 'Kimi API key is missing in the local backend. Add MOONSHOT_API_KEY to backend/.env or configure it in Mako IQ Companion.'
    });
  }

  let lastError: unknown;

  options.onEvent?.({
    type: 'status',
    requestId: options.requestId,
    phase: 'collecting_context',
    message: `Preparing ${request.page.title} for question extraction...`
  });

  if (route.provider === 'ollama') {
    options.onEvent?.({
      type: 'status',
      requestId: options.requestId,
      phase: 'requesting_backend',
      message: 'Local AI is preparing question extraction...'
    });

    const attemptResult = await runNonStreamingOllamaAttempt(
      {
        request,
        requestId: options.requestId,
        signal: options.signal,
        route
      },
      0
    );
    const { output, normalizationMs } = parseStructuredOutput(
      attemptResult.rawContent,
      request,
      options.requestId,
      attemptResult.finishReason
    );
    const completedAt = new Date().toISOString();
    const meta = finalizeMeta(buildMeta(options.requestId, 'miss', attemptResult.timings), normalizationMs, completedAt);

    options.onEvent?.({
      type: 'complete',
      requestId: options.requestId,
      mode: request.mode,
      output,
      meta
    });
    return;
  }

  for (let attempt = 0; attempt <= MAX_PROVIDER_RETRIES; attempt += 1) {
    try {
      const attemptResult = await runStreamingAttemptWithFormat(
        {
          request,
          requestId: options.requestId,
          signal: options.signal,
          route
        },
        attempt,
        options.onEvent,
        true
      );
      const { output, normalizationMs } = parseStructuredOutput(
        attemptResult.rawContent,
        request,
        options.requestId,
        attemptResult.finishReason
      );
      const completedAt = new Date().toISOString();
      const meta = finalizeMeta(buildMeta(options.requestId, 'miss', attemptResult.timings), normalizationMs, completedAt);

      options.onEvent?.({
        type: 'complete',
        requestId: options.requestId,
        mode: request.mode,
        output,
        meta
      });
      return;
    } catch (error) {
      lastError = error;
      const retryable = error instanceof ModelServiceError ? error.retryable : false;
      if (attempt < MAX_PROVIDER_RETRIES && retryable) {
        await wait(RETRY_DELAY_MS);
        continue;
      }
      throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new ModelServiceError('Structured analysis failed unexpectedly.');
}
