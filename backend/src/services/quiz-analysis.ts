import { env, flags } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { sanitizeText } from './safety.js';
import type {
  QuizAnalyzeRequestBody,
  QuizAnalyzeResponse,
  QuizAnalyzeStatus,
  QuizAnswerChoice,
  QuizFailReason
} from '../types/quiz.js';

const MODEL_TIMEOUT_MS = 16_000;
const MAX_PROVIDER_RETRIES = 0;
const RESTRICTED_CONTEXT_PATTERN =
  /\b(lockdown|respondus|honorlock|proctorio|proctored|proctortrack|examity|examsoft|safe exam|locked quiz|restricted assessment)\b/i;

const QUIZ_ANALYSIS_SYSTEM_PROMPT =
  'You are answering a single extracted quiz/study question. Use only the provided question and answer choices. If answer choices are provided, choose one of the provided choices. Return strict JSON only. Do not include markdown. Do not include extra text. Do not repeat the whole question. If the provided data is insufficient, return "needs_more_context" instead of guessing.';

const QUIZ_ANALYSIS_USER_PROMPT = `Mode: quiz-prefetch.
Task:
1. Answer the single provided question only.
2. If answer choices are provided, choose exactly one provided choice.
3. Return status "needs_more_context" when the provided data is insufficient.
4. Keep the explanation short.

Return JSON only matching:
{
  "status": "answered|needs_more_context|error",
  "answerLabel": "A|B|C|D|null",
  "answerIndex": 0,
  "answerText": "string",
  "confidence": 0.0,
  "explanation": "short explanation"
}

Rules:
- Never output markdown.
- Never return text outside JSON.
- Use only the provided question, choices, and screenshot if included.
- Do not invent page context that was not provided.
- If choices are provided, answer with one choice index, label, and text copied from that choice.
- If uncertain or missing needed visual/page context, use status "needs_more_context".
- Keep explanation under 35 words.
- Do not answer restricted/proctored assessment content; return status "needs_more_context".`;

const QUIZ_ANALYSIS_SCHEMA = {
  name: 'mako_quiz_prefetch_answer',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'answerLabel', 'answerIndex', 'answerText', 'confidence', 'explanation'],
    properties: {
      status: {
        type: 'string',
        enum: ['answered', 'needs_more_context', 'error']
      },
      answerLabel: { type: ['string', 'null'] },
      answerIndex: { type: ['number', 'null'] },
      answerText: { type: 'string' },
      confidence: { type: 'number' },
      explanation: { type: 'string' }
    }
  }
} as const;

interface RawQuizAnswer {
  status?: unknown;
  requestId?: unknown;
  questionHash?: unknown;
  answer?: unknown;
  answerText?: unknown;
  answerLabel?: unknown;
  answerIndex?: unknown;
  answerIndexes?: unknown;
  confidence?: unknown;
  explanation?: unknown;
  evidence?: unknown;
  shouldDisplay?: unknown;
}

export class QuizAnalysisError extends Error {
  status: number;
  exposeMessage: string;
  code?: QuizFailReason;

  constructor(message: string, options: { status?: number; exposeMessage?: string; code?: QuizFailReason } = {}) {
    super(message);
    this.name = 'QuizAnalysisError';
    this.status = options.status ?? 500;
    this.exposeMessage = options.exposeMessage ?? 'Mako IQ could not prefetch the quiz answer.';
    this.code = options.code;
  }
}

function createTimeout(signal?: AbortSignal) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort);

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', abort);
    }
  };
}

function cleanText(value: unknown, maxLength: number, fallback = '') {
  const text = sanitizeText(value, maxLength);
  return text || fallback;
}

function clampConfidence(value: number) {
  return Math.min(Math.max(value, 0), 1);
}

function parseConfidenceScore(value: unknown) {
  const rawText = typeof value === 'string' ? value.trim() : '';
  const percentMatch = rawText.match(/^([0-9]+(?:\.[0-9]+)?)\s*%$/);
  const numberValue = percentMatch
    ? Number(percentMatch[1]) / 100
    : typeof value === 'string'
      ? Number(rawText.replace(/,/g, ''))
      : Number(value);

  if (!Number.isFinite(numberValue)) {
    return null;
  }

  return clampConfidence(numberValue > 1 ? numberValue / 100 : numberValue);
}

function estimateQuizConfidence(input: {
  rawConfidence: unknown;
  finalStatus: QuizAnalyzeStatus;
  finalAnswer: string;
  matchedChoice: QuizAnswerChoice | undefined;
  request: QuizAnalyzeRequestBody;
  explanation: string;
}) {
  const parsed = parseConfidenceScore(input.rawConfidence);
  if (parsed !== null) {
    return parsed;
  }

  if (input.finalStatus !== 'answered' || !input.finalAnswer) {
    return 0.35;
  }

  let estimated = input.request.question.answerChoices.length ? 0.58 : 0.62;
  if (input.matchedChoice) {
    estimated = 0.76;
  }

  if (input.request.extraction.confidence >= 0.7) {
    estimated += 0.04;
  }

  if (input.explanation) {
    estimated += 0.04;
  }

  return clampConfidence(Math.min(0.86, Math.max(0.45, estimated)));
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
  const jsonText = extractFirstJsonObject(stripCodeFence(value));
  try {
    return JSON.parse(jsonText) as T;
  } catch {
    try {
      const repaired = jsonText.replace(/,\s*([}\]])/g, '$1').replace(/[\u0000-\u001F]+/g, ' ').trim();
      return JSON.parse(repaired) as T;
    } catch (error) {
      throw new QuizAnalysisError(error instanceof Error ? error.message : 'AI returned malformed JSON.', {
        status: 502,
        exposeMessage: 'AI_JSON_PARSE_ERROR',
        code: 'AI_JSON_PARSE_ERROR'
      });
    }
  }
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
  return extractProviderMessageContent(payload?.choices?.[0]?.message?.content);
}

function shouldFallbackToJsonObject(status: number, responseText: string) {
  return status === 400 && /json_schema|response_format|schema/i.test(responseText);
}

function getKimiExposeMessage(status?: number) {
  if (status === 401 || status === 403) {
    return 'Kimi rejected the API key. Check MOONSHOT_API_KEY in backend/.env.';
  }

  return 'Kimi API request failed. Check internet connection, API key, billing, or model name.';
}

function normalizeAnswerIndexes(value: unknown, choiceCount: number) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry) && entry >= 0 && entry < choiceCount)
    .slice(0, Math.max(choiceCount, 1));
}

function normalizeAnswerIndex(value: unknown, choiceCount: number) {
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 && index < choiceCount ? index : null;
}

function normalizeAnswerLabel(value: unknown) {
  const label = cleanText(value, 12).replace(/[^A-H]/gi, '').slice(0, 1).toUpperCase();
  return label || null;
}

function normalizeStatus(value: unknown): QuizAnalyzeResponse['status'] {
  const status = cleanText(value, 40);
  if (status === 'answered' || status === 'no_question' || status === 'needs_more_context' || status === 'error') {
    return status;
  }

  return 'needs_more_context';
}

function findChoiceByLabelOrText(
  request: QuizAnalyzeRequestBody,
  answerLabel: string | null,
  answerText: string,
  answerIndexes: number[],
  answerIndex: number | null
) {
  const choices = request.question.answerChoices;
  const bySingleIndex = answerIndex === null ? undefined : choices.find((choice) => choice.index === answerIndex);
  if (bySingleIndex) {
    return bySingleIndex;
  }

  const byIndex = answerIndexes.map((index) => choices.find((choice) => choice.index === index)).find(Boolean);
  if (byIndex) {
    return byIndex;
  }

  const byLabel = answerLabel ? choices.find((choice) => choice.label.toLowerCase() === answerLabel.toLowerCase()) : undefined;
  if (byLabel) {
    return byLabel;
  }

  const normalizedAnswer = answerText.toLowerCase();
  return choices.find((choice) => {
    const text = choice.text.toLowerCase();
    return text === normalizedAnswer || text.includes(normalizedAnswer) || normalizedAnswer.includes(text);
  });
}

function normalizeQuizAnswer(raw: RawQuizAnswer, request: QuizAnalyzeRequestBody): QuizAnalyzeResponse {
  const status = normalizeStatus(raw.status);
  const answerIndex = normalizeAnswerIndex(raw.answerIndex, request.question.answerChoices.length);
  const answerIndexes = answerIndex === null ? normalizeAnswerIndexes(raw.answerIndexes, request.question.answerChoices.length) : [answerIndex];
  const answerLabel = normalizeAnswerLabel(raw.answerLabel);
  const rawAnswer = cleanText(raw.answerText, 700) || cleanText(raw.answer, 700);
  const matchedChoice = findChoiceByLabelOrText(request, answerLabel, rawAnswer, answerIndexes, answerIndex);
  const finalIndexes = matchedChoice
    ? [matchedChoice.index]
    : answerIndexes;
  const finalLabel = matchedChoice?.label ?? answerLabel;
  const finalAnswer = matchedChoice?.text ?? rawAnswer;
  const hasChoices = request.question.answerChoices.length > 0;
  const validAnsweredChoice = !hasChoices || Boolean(matchedChoice);
  const finalStatus = status === 'answered' && (!finalAnswer || !validAnsweredChoice) ? 'needs_more_context' : status;
  const shouldDisplay = finalStatus === 'answered' && Boolean(finalAnswer) && validAnsweredChoice;
  const explanation = cleanText(raw.explanation, 320, finalStatus === 'needs_more_context' ? 'More visible context is needed to answer reliably.' : '');
  const confidence = estimateQuizConfidence({
    rawConfidence: raw.confidence,
    finalStatus,
    finalAnswer,
    matchedChoice,
    request,
    explanation
  });

  return {
    status: finalStatus,
    requestId: request.requestId,
    questionHash: request.questionHash,
    answer: finalStatus === 'answered' ? finalAnswer : '',
    answerLabel: finalStatus === 'answered' ? finalLabel : null,
    answerIndex: finalStatus === 'answered' ? finalIndexes[0] ?? null : null,
    answerIndexes: finalStatus === 'answered' ? finalIndexes : [],
    confidence,
    explanation,
    evidence: finalStatus === 'answered' && matchedChoice ? `Matched provided choice ${matchedChoice.label}.` : cleanText(raw.evidence, 220),
    shouldDisplay
  };
}

function isRestrictedAssessmentContext(request: QuizAnalyzeRequestBody) {
  return RESTRICTED_CONTEXT_PATTERN.test(`${request.pageUrl} ${request.pageTitle ?? ''}`);
}

function buildRequestInput(request: QuizAnalyzeRequestBody) {
  return {
    mode: request.mode,
    questionHash: request.questionHash,
    pageUrl: request.pageUrl,
    question: {
      questionText: request.question.questionText,
      questionType: request.question.questionType,
      instructions: request.question.instructions || (request.question.questionType === 'multi_select' ? 'Select all that apply.' : 'Select one answer.'),
      answerChoices: request.question.answerChoices.map((choice) => ({
        index: choice.index,
        label: choice.label,
        text: choice.text
      }))
    },
    extraction: {
      confidence: request.extraction.confidence,
      method: request.screenshot.included ? (request.extraction.method === 'dom' ? 'hybrid' : request.extraction.method) : request.extraction.method,
      needsScreenshot: request.extraction.needsScreenshot,
      debugReasons: request.extraction.debugReasons
    }
  };
}

function buildQuizRequestBody(request: QuizAnalyzeRequestBody, useJsonSchema: boolean) {
  const userContent: Array<Record<string, unknown>> = [
    {
      type: 'text',
      text: [
        QUIZ_ANALYSIS_USER_PROMPT,
        '',
        'Input:',
        JSON.stringify(buildRequestInput(request))
      ].join('\n')
    }
  ];

  if (request.screenshot.included && request.screenshot.data && request.screenshot.mimeType) {
    userContent.push({
      type: 'image_url',
      image_url: {
        url: `data:${request.screenshot.mimeType};base64,${request.screenshot.data}`
      }
    });
  }

  const body: Record<string, unknown> = {
    model: env.moonshotQuickModel || env.kimiModel,
    messages: [
      {
        role: 'system',
        content: QUIZ_ANALYSIS_SYSTEM_PROMPT
      },
      {
        role: 'user',
        content: userContent
      }
    ],
    max_tokens: 420,
    thinking: {
      type: 'disabled'
    },
    stream: false
  };

  body.response_format = useJsonSchema
    ? {
        type: 'json_schema',
        json_schema: QUIZ_ANALYSIS_SCHEMA
      }
    : {
        type: 'json_object'
      };

  return body;
}

async function postMoonshotJson(body: Record<string, unknown>, signal?: AbortSignal) {
  const response = await fetch(`${env.kimiBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.moonshotApiKey}`
    },
    body: JSON.stringify(body),
    signal
  });
  const text = await response.text();
  let parsedResponse: any = null;

  try {
    parsedResponse = text ? JSON.parse(text) : null;
  } catch {
    parsedResponse = null;
  }

  return {
    response,
    text,
    parsedResponse
  };
}

async function runQuizAnalysisAttempt(request: QuizAnalyzeRequestBody, useJsonSchema: boolean, signal?: AbortSignal) {
  const timeout = createTimeout(signal);
  try {
    const { response, text, parsedResponse } = await postMoonshotJson(buildQuizRequestBody(request, useJsonSchema), timeout.signal);
    if (!response.ok) {
      if (useJsonSchema && shouldFallbackToJsonObject(response.status, text)) {
        return runQuizAnalysisAttempt(request, false, signal);
      }

      throw new QuizAnalysisError(text.slice(0, 300) || `Moonshot returned HTTP ${response.status}.`, {
        status: response.status >= 500 ? 502 : 500,
        exposeMessage: getKimiExposeMessage(response.status)
      });
    }

    const content = extractCompletionText(parsedResponse);
    if (!content) {
      throw new QuizAnalysisError('Moonshot returned an empty Quiz Mode response.', {
        status: 502,
        exposeMessage: 'Kimi returned an empty Quiz Mode response.'
      });
    }

    logger.info(
      {
        requestId: request.requestId,
        questionHash: request.questionHash,
        rawResponse: content.slice(0, 1200)
      },
      '[MakoIQ AI] rawResponse'
    );
    const normalized = normalizeQuizAnswer(safeParseJson<RawQuizAnswer>(content), request);
    logger.info(
      {
        requestId: request.requestId,
        questionHash: request.questionHash,
        normalizedResponse: normalized
      },
      '[MakoIQ AI] normalizedResponse'
    );
    return normalized;
  } catch (error) {
    if (error instanceof QuizAnalysisError) {
      throw error;
    }

    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new QuizAnalysisError('Moonshot quiz analysis timed out.', {
        status: 504,
        exposeMessage: 'Kimi took too long to prefetch the quiz answer. Try again in a moment.'
      });
    }

    throw new QuizAnalysisError(error instanceof Error ? error.message : 'Kimi quiz analysis failed.', {
      status: 502,
      exposeMessage: getKimiExposeMessage()
    });
  } finally {
    timeout.dispose();
  }
}

export async function analyzeQuizQuestion(request: QuizAnalyzeRequestBody, signal?: AbortSignal): Promise<QuizAnalyzeResponse> {
  if (isRestrictedAssessmentContext(request)) {
    return {
      status: 'no_question',
      requestId: request.requestId,
      questionHash: request.questionHash,
      answer: '',
      answerLabel: null,
      answerIndex: null,
      answerIndexes: [],
      confidence: 0,
      explanation: '',
      evidence: 'Restricted/proctored assessment context was detected.',
      shouldDisplay: false
    };
  }

  if (!flags.moonshotConfigured) {
    throw new QuizAnalysisError('Missing MOONSHOT_API_KEY.', {
      status: 500,
      exposeMessage: 'Kimi API key is missing in the local backend. Add MOONSHOT_API_KEY to backend/.env or configure it in Mako IQ Companion.'
    });
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_PROVIDER_RETRIES; attempt += 1) {
    try {
      logger.info(
        {
          requestId: request.requestId,
          questionHash: request.questionHash,
          questionType: request.question.questionType,
          choiceCount: request.question.answerChoices.length,
          screenshotIncluded: request.screenshot.included,
          model: env.moonshotQuickModel || env.kimiModel
        },
        'quiz prefetch request sent to moonshot'
      );
      return await runQuizAnalysisAttempt(request, true, signal);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new QuizAnalysisError('Quiz Mode analysis failed.');
}
