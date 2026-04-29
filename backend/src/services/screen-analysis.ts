import { env, flags } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { sanitizeText } from './safety.js';
import { createPerfTimer } from '../utils/perf.js';
import type {
  ScreenAnalysisTiming,
  ScreenAnalysisItem,
  ScreenAnalysisItemType,
  ScreenAnalyzeRequestBody,
  ScreenAnalyzeResponse,
  ScreenFollowUpRequestBody,
  ScreenFollowUpResponse
} from '../types/screen.js';

const MODEL_TIMEOUT_MS = 16_000;
const MAX_PROVIDER_RETRIES = 0;
const RETRY_DELAY_MS = 650;
const RESTRICTED_WARNING = 'RESTRICTED_ASSESSMENT';
const RESTRICTED_MESSAGE =
  'Mako IQ can help explain concepts or create study notes, but it will not provide live answers for restricted assessments.';

const SCREEN_ANALYSIS_SYSTEM_PROMPT =
  "You are Mako IQ's fast page-question analyzer. You receive structured question data extracted from a webpage. Your job is to answer only the detected questions. Return strict JSON only. Do not return markdown. Do not echo the page. Do not include hidden reasoning. Be concise and fast.";

const SCREEN_ANALYSIS_USER_PROMPT = `Mode: quick_scan.
Task:
1. Read the provided question objects.
2. For each question, select the best answer from the provided choices when choices exist.
3. Return the exact answer key and answer text.
4. Include one short explanation sentence.
5. Include a confidence score between 0 and 1.
6. If no clear question exists, return status "no_question_found".
7. If the extracted data is incomplete, return status "needs_more_context" and mark needsScreenshotFallback when visual context could help.

Return JSON only matching:
{
  "status": "success|needs_more_context|no_question_found|error",
  "questions": [
    {
      "id": "q_1",
      "question": "string",
      "recommendedAnswerKey": "A|B|C|D|E|null",
      "recommendedAnswerText": "string",
      "confidence": 0.0,
      "explanation": "one short sentence",
      "evidence": "short phrase",
      "needsMoreContext": false,
      "needsScreenshotFallback": false
    }
  ],
  "message": "string"
}

Rules:
- Never output markdown.
- Never output text outside JSON.
- Do not repeat the whole page.
- Do not invent choices that are not present.
- Prefer exact choice text from the input.
- If answer choices are visible, answer with the best matching choice key.
- Keep explanation under 25 words.
- If uncertain, lower confidence.
- If no question was provided, return status "no_question_found".
- If the provided context is insufficient for a reliable answer, return status "needs_more_context", keep confidence below 0.55, and set needsMoreContext true.
- If a screenshot/visual fallback is likely required, set needsScreenshotFallback true.
- Ignore decorative text, nav bars, buttons, ads, and unrelated UI.
- Do not answer restricted/proctored assessment content; return status "no_question_found" with a short message instead.`;

const SCREEN_ANALYSIS_SCHEMA = {
  name: 'mako_quick_scan_answer',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'questions', 'message'],
    properties: {
      status: {
        type: 'string',
        enum: ['success', 'partial', 'needs_more_context', 'no_question_found', 'error']
      },
      questions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'id',
            'question',
            'recommendedAnswerKey',
            'recommendedAnswerText',
            'confidence',
            'explanation',
            'evidence',
            'needsMoreContext',
            'needsScreenshotFallback'
          ],
          properties: {
            id: { type: 'string' },
            question: { type: 'string' },
            recommendedAnswerKey: { type: ['string', 'null'] },
            recommendedAnswerText: { type: 'string' },
            confidence: { type: 'number' },
            explanation: { type: 'string' },
            evidence: { type: 'string' },
            needsMoreContext: { type: 'boolean' },
            needsScreenshotFallback: { type: 'boolean' }
          }
        }
      },
      message: { type: 'string' }
    }
  }
} as const;

interface RawQuickScanAnalysis {
  status?: unknown;
  questions?: unknown;
  message?: unknown;
}

interface ScreenAttemptResult {
  raw: RawQuickScanAnalysis;
  aiMs: number;
  aiFirstByteMs: number;
  promptBuildMs: number;
  parseMs: number;
  inputChars: number;
  outputChars: number;
  modelUsed: string;
}

function createAnalysisId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `screen-${Date.now()}`;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value: number, min = 0, max = 1) {
  return Math.min(Math.max(value, min), max);
}

function cleanText(value: unknown, maxLength: number, fallback = '') {
  const text = sanitizeText(value, maxLength);
  return text || fallback;
}

function normalizeItemType(value: unknown): ScreenAnalysisItemType {
  const type = cleanText(value, 40);
  if (
    type === 'task' ||
    type === 'math' ||
    type === 'multiple_choice' ||
    type === 'short_answer' ||
    type === 'reading' ||
    type === 'science' ||
    type === 'general_question'
  ) {
    return type;
  }

  return 'general_question';
}

function normalizeBbox(value: unknown) {
  if (!value || typeof value !== 'object') {
    return {
      x: 0.72,
      y: 0.12,
      width: 0.2,
      height: 0.12
    };
  }

  const record = value as Record<string, unknown>;
  const x = clamp(Number(record.x));
  const y = clamp(Number(record.y));
  const width = clamp(Number(record.width));
  const height = clamp(Number(record.height));

  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return {
      x: 0.72,
      y: 0.12,
      width: 0.2,
      height: 0.12
    };
  }

  if (width <= 0 || height <= 0) {
    return {
      x: clamp(x, 0, 0.98),
      y: clamp(y, 0, 0.98),
      width: 0.12,
      height: 0.08
    };
  }

  const normalizedWidth = clamp(width, 0.01, Math.max(0.01, 1 - x));
  const normalizedHeight = clamp(height, 0.01, Math.max(0.01, 1 - y));

  return {
    x,
    y,
    width: normalizedWidth,
    height: normalizedHeight
  };
}

function parseChoicePrefix(value: string) {
  const match = cleanText(value, 560).match(
    /^(?:choice\s*)?(?:\(?([A-H])\)?[\s.\):\-\u2013\u2014]+|([A-H])\s+[-\u2013\u2014]\s+|([A-H])\s{2,}|(\d{1,2})[\.\)]\s+)(.+)$/i
  );
  if (!match) {
    return null;
  }

  const rawKey = match[1] ?? match[2] ?? match[3] ?? match[4] ?? '';
  return {
    key: /^\d+$/.test(rawKey) ? String.fromCharCode(64 + Number(rawKey)) : rawKey.toUpperCase(),
    text: cleanText(match[5], 500)
  };
}

function normalizeQuickStatus(value: unknown): 'success' | 'partial' | 'needs_more_context' | 'no_question_found' | 'error' {
  const status = cleanText(value, 40);
  if (status === 'success' || status === 'partial' || status === 'needs_more_context' || status === 'no_question_found' || status === 'error') {
    return status;
  }

  return 'needs_more_context';
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

  return clamp(numberValue > 1 ? numberValue / 100 : numberValue);
}

function estimateQuickScanConfidence(input: {
  rawConfidence: unknown;
  answerText: string;
  answerChoice: string | null;
  explanation: string;
  sourceQuestion: ReturnType<typeof findSourceQuestion>;
}) {
  const parsed = parseConfidenceScore(input.rawConfidence);
  if (parsed !== null) {
    return parsed;
  }

  if (!input.answerText) {
    return 0.35;
  }

  let estimated = input.sourceQuestion?.choices.length ? 0.62 : 0.58;
  if (input.answerChoice) {
    estimated = 0.74;
  }

  if (input.sourceQuestion?.question) {
    estimated += 0.04;
  }

  if (input.explanation) {
    estimated += 0.04;
  }

  return clamp(estimated, 0.45, 0.84);
}

function normalizeAnswerKey(value: unknown) {
  const key = cleanText(value, 12).replace(/[^A-H]/gi, '').slice(0, 1).toUpperCase();
  return key || null;
}

function findSourceQuestion(
  id: string,
  question: string,
  request?: Pick<ScreenAnalyzeRequestBody, 'textContext'>
) {
  const normalizedId = cleanText(id, 80).toLowerCase();
  const normalizedQuestion = cleanText(question, 1200).toLowerCase();
  const structuredQuestions = request?.textContext?.structuredExtraction?.questions ?? [];

  const structuredMatch = structuredQuestions.find((candidate) => {
    const candidateQuestion = cleanText(candidate.question, 1200).toLowerCase();
    return (
      cleanText(candidate.id, 80).toLowerCase() === normalizedId ||
      candidateQuestion === normalizedQuestion ||
      candidateQuestion.includes(normalizedQuestion.slice(0, 120)) ||
      normalizedQuestion.includes(candidateQuestion.slice(0, 120))
    );
  });
  if (structuredMatch) {
    return {
      id: structuredMatch.id,
      question: structuredMatch.question,
      choices: structuredMatch.choices,
      bbox: structuredMatch.bbox,
      anchor: structuredMatch.anchor,
      questionType: structuredMatch.questionType
    };
  }

  const candidateMatch = request?.textContext?.questionCandidates.find((candidate) => {
    const candidateQuestion = cleanText(candidate.question, 1200).toLowerCase();
    return (
      cleanText(candidate.id, 80).toLowerCase() === normalizedId ||
      candidateQuestion === normalizedQuestion ||
      candidateQuestion.includes(normalizedQuestion.slice(0, 120)) ||
      normalizedQuestion.includes(candidateQuestion.slice(0, 120))
    );
  });
  if (!candidateMatch) {
    return undefined;
  }

  return {
    id: candidateMatch.id,
    question: candidateMatch.question,
    choices: candidateMatch.answerChoices
      .map((choice, index) => parseChoicePrefix(choice) ?? { key: String.fromCharCode(65 + index), text: cleanText(choice, 500) })
      .filter((choice) => choice.text),
    bbox: candidateMatch.bbox,
    anchor: candidateMatch.anchor,
    questionType: candidateMatch.questionType
  };
}

function getExactChoiceText(
  key: string | null,
  answerText: string,
  sourceQuestion: ReturnType<typeof findSourceQuestion>
) {
  if (!sourceQuestion?.choices.length) {
    return {
      answerText,
      answerChoice: key && answerText ? `${key}. ${answerText}` : null
    };
  }

  const byKey = key ? sourceQuestion.choices.find((choice) => choice.key.toUpperCase() === key.toUpperCase()) : undefined;
  if (byKey) {
    return {
      answerText: byKey.text,
      answerChoice: `${byKey.key}. ${byKey.text}`
    };
  }

  const normalizedAnswer = answerText.toLowerCase();
  const byText = sourceQuestion.choices.find((choice) => {
    const choiceText = choice.text.toLowerCase();
    return choiceText === normalizedAnswer || choiceText.includes(normalizedAnswer) || normalizedAnswer.includes(choiceText);
  });
  if (byText) {
    return {
      answerText: byText.text,
      answerChoice: `${byText.key}. ${byText.text}`
    };
  }

  return {
    answerText,
    answerChoice: null
  };
}

function normalizeScreenAnalysis(
  raw: RawQuickScanAnalysis,
  analysisId: string,
  request?: Pick<ScreenAnalyzeRequestBody, 'textContext'>,
  timing?: ScreenAnalysisTiming
): ScreenAnalyzeResponse {
  const validationStartedAt = Date.now();
  const status = normalizeQuickStatus(raw.status);
  const warnings: string[] = [];
  if (status === 'error') {
    warnings.push('AI_QUICK_SCAN_ERROR');
  }

  const rawItems = Array.isArray(raw.questions) ? raw.questions : [];
  const seenItems = new Set<string>();
  const items = rawItems
    .map((rawItem, index): ScreenAnalysisItem | null => {
      if (!rawItem || typeof rawItem !== 'object') {
        return null;
      }

      const record = rawItem as Record<string, unknown>;
      const id = cleanText(record.id, 80, `q_${index + 1}`);
      const rawQuestion = cleanText(record.question, 1200);
      const sourceQuestion = findSourceQuestion(id, rawQuestion, request);
      const question = cleanText(rawQuestion || sourceQuestion?.question, 1200);
      if (!question) {
        return null;
      }

      const recommendedAnswerKey = normalizeAnswerKey(record.recommendedAnswerKey);
      const recommendedAnswerText = cleanText(record.recommendedAnswerText, 700);
      const { answerText, answerChoice } = getExactChoiceText(recommendedAnswerKey, recommendedAnswerText, sourceQuestion);
      const normalizedExplanation = cleanText(record.explanation, 220);
      const confidence = estimateQuickScanConfidence({
        rawConfidence: record.confidence,
        answerText,
        answerChoice,
        explanation: normalizedExplanation,
        sourceQuestion
      });
      const needsMoreContext = Boolean(record.needsMoreContext) || Boolean(record.needsScreenshotFallback) || confidence < 0.55 || !answerText;
      const normalizedAnswer = answerChoice ?? (answerText || (needsMoreContext ? 'Needs more visible context.' : ''));
      const explanation =
        normalizedExplanation ||
        (needsMoreContext ? 'The visible screenshot or page text does not provide enough context for a reliable answer.' : '');
      const echoGuardKey = question.toLowerCase();
      if (normalizedAnswer.toLowerCase() === echoGuardKey || normalizedAnswer.length > 900) {
        return null;
      }

      const dedupeKey = `${question.toLowerCase()}|${normalizedAnswer.toLowerCase()}`;
      if (seenItems.has(dedupeKey)) {
        return null;
      }
      seenItems.add(dedupeKey);

      return {
        id,
        type: sourceQuestion?.choices.length ? 'multiple_choice' : normalizeItemType(sourceQuestion?.questionType),
        question,
        answer: normalizedAnswer,
        answerChoice,
        explanation,
        confidence,
        bbox: normalizeBbox(sourceQuestion?.bbox),
        anchor: sourceQuestion?.anchor,
        needsMoreContext
      };
    })
    .filter((item): item is ScreenAnalysisItem => item !== null)
    .slice(0, 5);

  const summary = cleanText(
    raw.message,
    500,
    status === 'no_question_found'
      ? 'No clear questions found on the visible screen.'
      : items.length
        ? `Found ${items.length} visible question${items.length === 1 ? '' : 's'}.`
        : 'No usable answer was returned for the detected context.'
  );

  return {
    ok: true,
    analysisId,
    summary,
    items,
    warnings: items.length ? warnings : [...new Set([...warnings, 'NO_QUESTIONS_DETECTED'])],
    timing: timing
      ? {
          ...timing,
          validationMs: Date.now() - validationStartedAt
        }
      : undefined
  };
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
    const repaired = jsonText
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/[\u0000-\u001F]+/g, ' ')
      .trim();
    return JSON.parse(repaired) as T;
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

function isRestrictedAssessmentContext(request: Pick<ScreenAnalyzeRequestBody, 'pageUrl' | 'pageTitle'>) {
  const source = `${request.pageUrl} ${request.pageTitle}`.toLowerCase();
  return /\b(lockdown|respondus|honorlock|proctorio|proctored|proctortrack|examity|examsoft|safe exam|locked quiz|restricted assessment)\b/.test(
    source
  );
}

function createRestrictedResponse(analysisId: string): ScreenAnalyzeResponse {
  return {
    ok: true,
    analysisId,
    summary: RESTRICTED_MESSAGE,
    items: [],
    warnings: [RESTRICTED_WARNING]
  };
}

function shouldIncludeTiming(request: Pick<ScreenAnalyzeRequestBody, 'debug'>) {
  return Boolean(request.debug) || !env.isProduction;
}

function logScreenStage(request: Pick<ScreenAnalyzeRequestBody, 'debug'>, requestId: string, stage: string, payload: Record<string, unknown>) {
  const entry = {
    requestId,
    stage,
    ...payload
  };

  if (request.debug) {
    logger.info(entry, 'screen analysis timing');
    return;
  }

  logger.debug(entry, 'screen analysis timing');
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

function shouldFallbackToJsonObject(status: number, responseText: string) {
  return status === 400 && /json_schema|response_format|schema/i.test(responseText);
}

function getKimiExposeMessage(status?: number) {
  if (status === 401 || status === 403) {
    return 'Kimi rejected the API key. Check MOONSHOT_API_KEY in backend/.env.';
  }

  return 'Kimi API request failed. Check internet connection, API key, billing, or model name.';
}

function getKimiProviderError(parsedResponse: unknown, responseText: string) {
  const parsed = parsedResponse as { error?: { message?: unknown } } | null;
  if (typeof parsed?.error?.message === 'string' && parsed.error.message.trim()) {
    return parsed.error.message.trim().slice(0, 300);
  }

  return responseText.trim().slice(0, 300);
}

function buildCompactExtractionInput(request: ScreenAnalyzeRequestBody) {
  const questionContext = request.textContext?.questionContext;
  const structured = request.textContext?.structuredExtraction;
  const structuredQuestions = structured?.questions ?? [];
  const questions = questionContext?.questions.length
    ? questionContext.questions.map((question) => ({
        id: question.id,
        question: question.questionText,
        choices: question.choices,
        nearbyContext: question.nearbyText,
        questionType: question.choices.length >= 2 ? 'multiple_choice' : 'short_answer',
        domHints: {
          selector: question.elementHints.selector,
          hasRadioInputs: Boolean(question.elementHints.hasRadioInputs),
          hasCheckboxInputs: Boolean(question.elementHints.hasCheckboxInputs)
        }
      }))
    : structuredQuestions.length
    ? structuredQuestions.map((question) => ({
        id: question.id,
        question: question.question,
        choices: question.choices,
        nearbyContext: question.nearbyContext,
        questionType: question.questionType,
        domHints: question.domHints
      }))
    : (request.textContext?.questionCandidates ?? []).map((candidate, index) => ({
        id: candidate.id ?? `q_${index + 1}`,
        question: candidate.question,
        choices: candidate.answerChoices.map((choice, choiceIndex) => {
          const parsed = parseChoicePrefix(choice);
          return parsed ?? { key: String.fromCharCode(65 + choiceIndex), text: cleanText(choice, 500) };
        }),
        nearbyContext: candidate.nearbyText.join(' | '),
        questionType: candidate.questionType ?? (candidate.answerChoices.length >= 2 ? 'multiple_choice' : 'short_answer'),
        domHints: {
          selector: candidate.extractionStrategy ?? 'screen-context',
          hasRadioInputs: false,
          hasCheckboxInputs: false
        }
      }));

  return {
    pageUrl: questionContext?.pageUrl ?? request.pageUrl,
    pageTitle: questionContext?.pageTitle ?? request.pageTitle,
    visibleTextHash: questionContext?.visibleTextHash ?? request.textContext?.visibleTextHash,
    extractionMode:
      request.imageMeta?.source === 'screenshot'
        ? questionContext?.extractionMode === 'dom'
          ? 'mixed'
          : questionContext?.extractionMode ?? 'screenshot'
        : questionContext?.extractionMode ?? request.textContext?.extractionMode ?? 'dom',
    source: structured?.source ?? {
      url: request.pageUrl,
      title: request.pageTitle,
      host: (() => {
        try {
          return new URL(request.pageUrl).host;
        } catch {
          return '';
        }
      })(),
      pathname: (() => {
        try {
          return new URL(request.pageUrl).pathname;
        } catch {
          return '';
        }
      })()
    },
    mode: 'answer_questions',
    extraction: structured?.extraction ?? {
      strategy: questionContext?.questions.length ? 'question-context' : questions.length ? 'screen-context' : 'visible-text-fallback',
      confidence: questionContext?.questions.length ? 0.72 : questions.length ? 0.55 : 0.2,
      warnings: [],
      extractionMs: 0,
      inspectedNodeCount: 0
    },
    questions: questions.slice(0, 5),
    selectedText: request.textContext?.selectedText,
    visibleTextFallback: questions.length
      ? undefined
      : cleanText(request.textContext?.selectedText || request.textContext?.visibleText || structured?.visibleTextFallback, 6_000)
  };
}

function buildRepairRequestBody(invalidContent: string) {
  return {
    model: env.moonshotQuickModel || env.kimiModel,
    messages: [
      {
        role: 'system',
        content: 'Return strict JSON only. Repair the malformed quick_scan response into the required schema.'
      },
      {
        role: 'user',
        content: JSON.stringify({
          required_shape: {
            status: 'success|needs_more_context|no_question_found|error',
            questions: [
              {
                id: 'q_1',
                question: 'string',
                recommendedAnswerKey: 'A|B|C|D|E|null',
                recommendedAnswerText: 'string',
                confidence: 0,
                explanation: 'one short sentence',
                evidence: 'short phrase',
                needsMoreContext: false,
                needsScreenshotFallback: false
              }
            ],
            message: 'string'
          },
          invalid_response: invalidContent.slice(0, 4_000)
        })
      }
    ],
    response_format: {
      type: 'json_object'
    },
    max_tokens: 420,
    thinking: {
      type: 'disabled'
    },
    stream: false
  };
}

function buildScreenRequestBody(request: ScreenAnalyzeRequestBody, useJsonSchema: boolean) {
  const compactInput = buildCompactExtractionInput(request);
  const userContent: Array<Record<string, unknown>> = [
    {
      type: 'text',
      text: [
        SCREEN_ANALYSIS_USER_PROMPT,
        '',
        'Input:',
        JSON.stringify(compactInput)
      ].join('\n')
    }
  ];
  const shouldAttachImage = request.imageMeta?.source !== 'dom_context' && /^data:image\/(?:png|jpe?g|webp);base64,/i.test(request.image);

  if (shouldAttachImage) {
    userContent.push({
      type: 'image_url',
      image_url: {
        url: request.image
      }
    });
  }

  const body: Record<string, unknown> = {
    model: env.moonshotQuickModel || env.kimiModel,
    messages: [
      {
        role: 'system',
        content: SCREEN_ANALYSIS_SYSTEM_PROMPT
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
        json_schema: SCREEN_ANALYSIS_SCHEMA
      }
    : {
        type: 'json_object'
      };

  return body;
}

async function postMoonshotJson(body: Record<string, unknown>, signal?: AbortSignal) {
  const bodyText = JSON.stringify(body);
  const response = await fetch(`${env.kimiBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.moonshotApiKey}`
    },
    body: bodyText,
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
    parsedResponse,
    inputChars: bodyText.length,
    outputChars: text.length
  };
}

async function runScreenAnalysisAttempt(request: ScreenAnalyzeRequestBody, useJsonSchema: boolean, signal?: AbortSignal) {
  const timeout = createTimeout(signal);
  const perf = createPerfTimer();
  const aiStartedAt = Date.now();

  try {
    const promptStartedAt = Date.now();
    const requestBody = buildScreenRequestBody(request, useJsonSchema);
    const promptBuildMs = Date.now() - promptStartedAt;
    const { response, text, parsedResponse } = await postMoonshotJson(
      requestBody,
      timeout.signal
    );
    const firstResponseMs = Date.now() - aiStartedAt;

    if (!response.ok) {
      if (useJsonSchema && shouldFallbackToJsonObject(response.status, text)) {
        return runScreenAnalysisAttempt(request, false, signal);
      }

      const providerError = getKimiProviderError(parsedResponse, text);
      throw new Error(providerError ? `${getKimiExposeMessage(response.status)} Provider said: ${providerError}` : getKimiExposeMessage(response.status));
    }

    const content = extractCompletionText(parsedResponse);
    if (!content) {
      throw new Error('Moonshot returned an empty screen analysis response.');
    }

    const parseStartedAt = Date.now();
    let raw: RawQuickScanAnalysis;
    try {
      raw = safeParseJson<RawQuickScanAnalysis>(content);
    } catch {
      const repair = await postMoonshotJson(buildRepairRequestBody(content), timeout.signal);
      if (!repair.response.ok) {
        throw new Error(getKimiExposeMessage(repair.response.status));
      }

      const repairedContent = extractCompletionText(repair.parsedResponse);
      raw = safeParseJson<RawQuickScanAnalysis>(repairedContent);
    }
    return {
      raw,
      aiMs: Date.now() - aiStartedAt || firstResponseMs,
      aiFirstByteMs: firstResponseMs,
      promptBuildMs,
      parseMs: Date.now() - parseStartedAt,
      inputChars: JSON.stringify(requestBody).length,
      outputChars: content.length,
      modelUsed: typeof requestBody.model === 'string' ? requestBody.model : env.moonshotQuickModel || env.kimiModel
    } satisfies ScreenAttemptResult;
  } finally {
    perf.snapshot();
    timeout.dispose();
  }
}

export async function analyzeScreenShot(request: ScreenAnalyzeRequestBody, requestId = createAnalysisId()): Promise<ScreenAnalyzeResponse> {
  const analysisId = requestId;
  const totalStartedAt = Date.now();
  const includeTiming = shouldIncludeTiming(request);
  const timing: ScreenAnalysisTiming = {};
  const preprocessingStartedAt = Date.now();
  logScreenStage(request, requestId, 'request-received', {
    pageUrl: request.pageUrl,
    pageTitle: request.pageTitle,
    mode: request.mode,
    imageMeta: request.imageMeta,
    textContextChars: request.textContext?.visibleText.length ?? 0,
    questionCandidates: request.textContext?.questionCandidates.length ?? 0,
    structuredQuestionCount: request.textContext?.structuredExtraction?.questions.length ?? 0,
    extractionMs: request.textContext?.structuredExtraction?.extraction.extractionMs,
    extractionConfidence: request.textContext?.structuredExtraction?.extraction.confidence
  });
  logScreenStage(request, requestId, 'image-preprocessing-started', {
    format: request.imageMeta?.format ?? 'unknown',
    bytes: request.imageMeta?.bytes
  });
  timing.preprocessMs = Date.now() - preprocessingStartedAt;
  logScreenStage(request, requestId, 'image-preprocessing-finished', {
    preprocessMs: timing.preprocessMs
  });

  if (isRestrictedAssessmentContext(request)) {
    const response = createRestrictedResponse(analysisId);
    return includeTiming
      ? {
          ...response,
          timing: {
            ...timing,
            totalMs: Date.now() - totalStartedAt
          }
        }
      : response;
  }

  if (!flags.moonshotConfigured) {
    return {
      ok: false,
      error: 'SCREEN_ANALYSIS_FAILED',
      message: 'Kimi API key is missing in the local backend. Add MOONSHOT_API_KEY to backend/.env or configure it in Mako IQ Companion.',
      timing: includeTiming
        ? {
            ...timing,
            totalMs: Date.now() - totalStartedAt
          }
        : undefined
    };
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_PROVIDER_RETRIES; attempt += 1) {
    try {
      logScreenStage(request, requestId, 'ai-request-started', {
        attempt,
        model: env.moonshotQuickModel || env.kimiModel,
        payloadChars: JSON.stringify(buildCompactExtractionInput(request)).length
      });
      const attemptResult = await runScreenAnalysisAttempt(request, true);
      timing.aiMs = attemptResult.aiMs;
      timing.parseMs = attemptResult.parseMs;
      logScreenStage(request, requestId, 'ai-response-received', {
        attempt,
        aiMs: timing.aiMs,
        parseMs: timing.parseMs
      });
      logScreenStage(request, requestId, 'json-validation-started', {
        attempt
      });
      const result = normalizeScreenAnalysis(
        attemptResult.raw,
        analysisId,
        request,
        includeTiming
          ? {
              ...timing,
              totalMs: Date.now() - totalStartedAt
            }
          : undefined
      );
      logScreenStage(request, requestId, 'json-validation-finished', {
        attempt,
        ok: result.ok,
        itemCount: result.ok ? result.items.length : 0,
        validationMs: result.timing?.validationMs
      });
      if (includeTiming && result.ok) {
        result.timing = {
          ...result.timing,
          totalMs: Date.now() - totalStartedAt
        };
      }
      logScreenStage(request, requestId, 'response-sent', {
        ok: result.ok,
        totalMs: includeTiming ? result.timing?.totalMs : Date.now() - totalStartedAt
      });
      return result;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_PROVIDER_RETRIES) {
        await wait(RETRY_DELAY_MS);
      }
    }
  }

  logger.error(
    {
      requestId,
      pageUrl: request.pageUrl,
      pageTitle: request.pageTitle,
      detail: lastError instanceof Error ? lastError.message : 'Unknown screen analysis failure'
    },
    'screen analysis failed'
  );

  if (lastError instanceof SyntaxError) {
    return {
      ok: true,
      analysisId,
      summary: 'The AI response could not be validated, so no answer bubbles were placed.',
      items: [],
      warnings: ['INVALID_AI_JSON', 'NO_QUESTIONS_DETECTED'],
      timing: includeTiming
        ? {
            ...timing,
            totalMs: Date.now() - totalStartedAt
          }
        : undefined
    };
  }

  return {
    ok: false,
    error: 'SCREEN_ANALYSIS_FAILED',
    message: lastError instanceof Error ? lastError.message : 'Kimi API request failed. Check internet connection, API key, billing, or model name.',
    timing: includeTiming
      ? {
          ...timing,
          totalMs: Date.now() - totalStartedAt
        }
      : undefined
  };
}

function buildFollowUpRequestBody(request: ScreenFollowUpRequestBody) {
  return {
    model: env.kimiModel,
    messages: [
      {
        role: 'system',
        content:
          'You are Mako IQ in explain_more mode. Use the original question and selected answer to give a clearer explanation after the fast answer is already shown. Return JSON only.'
      },
      {
        role: 'user',
        content: JSON.stringify(
          {
            mode: 'explain_more',
            expected_shape: {
              answer: 'string',
              explanation: 'string'
            },
            guardrails:
              'Do not provide live answers for restricted or proctored assessments. Use concept explanation or study guidance instead.',
            request
          },
          null,
          2
        )
      }
    ],
    response_format: {
      type: 'json_object'
    },
    max_tokens: 700,
    thinking: {
      type: 'disabled'
    },
    stream: false
  };
}

export async function answerScreenFollowUp(request: ScreenFollowUpRequestBody): Promise<ScreenFollowUpResponse> {
  if (!flags.moonshotConfigured) {
    return {
      ok: false,
      error: 'SCREEN_FOLLOWUP_FAILED',
      message: 'Kimi API key is missing in the local backend. Add MOONSHOT_API_KEY to backend/.env or configure it in Mako IQ Companion.'
    };
  }

  const timeout = createTimeout();

  try {
    const { response, parsedResponse } = await postMoonshotJson(buildFollowUpRequestBody(request), timeout.signal);
    if (!response.ok) {
      throw new Error(getKimiExposeMessage(response.status));
    }

    const raw = safeParseJson<{ answer?: unknown; explanation?: unknown }>(extractCompletionText(parsedResponse));
    const answer = cleanText(raw.answer, 900);
    if (!answer) {
      throw new Error('Moonshot follow-up response did not include an answer.');
    }

    return {
      ok: true,
      answer,
      explanation: cleanText(raw.explanation, 600) || undefined
    };
  } catch (error) {
    logger.error(
      {
        analysisId: request.analysisId,
        itemId: request.itemId,
        detail: error instanceof Error ? error.message : 'Unknown follow-up failure'
      },
      'screen follow-up failed'
    );

    return {
      ok: false,
      error: 'SCREEN_FOLLOWUP_FAILED',
      message: error instanceof Error ? error.message : 'Kimi API request failed. Check internet connection, API key, billing, or model name.'
    };
  } finally {
    timeout.dispose();
  }
}

export { RESTRICTED_MESSAGE, RESTRICTED_WARNING, SCREEN_ANALYSIS_SYSTEM_PROMPT, SCREEN_ANALYSIS_USER_PROMPT };
