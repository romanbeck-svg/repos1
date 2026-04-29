import { Router } from 'express';
import { logger } from '../lib/logger.js';
import { taskLimiter } from '../middleware/security.js';
import { answerScreenFollowUp, analyzeScreenShot } from '../services/screen-analysis.js';
import { sanitizeText } from '../services/safety.js';
import type {
  ScreenAnalyzeRequestBody,
  ScreenFollowUpRequestBody,
  ScreenImageMetadata,
  ScreenQuestionType,
  ScreenTextContext,
  ScreenViewport
} from '../types/screen.js';

const MAX_IMAGE_DATA_URL_LENGTH = 5_600_000;
const MAX_CONTEXT_TEXT_LENGTH = 6_000;
const MAX_QUESTION_COUNT = 5;

export const screenRouter = Router();

screenRouter.use(taskLimiter);

function createRequestId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `screen-${Date.now()}`;
}

function normalizeViewport(input: unknown): ScreenViewport {
  const value = input && typeof input === 'object' ? (input as Partial<ScreenViewport>) : {};
  const width = Number(value.width);
  const height = Number(value.height);
  const devicePixelRatio = Number(value.devicePixelRatio);

  return {
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : 1440,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : 900,
    devicePixelRatio: Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1,
    scrollX: Number.isFinite(Number(value.scrollX)) ? Math.round(Number(value.scrollX)) : 0,
    scrollY: Number.isFinite(Number(value.scrollY)) ? Math.round(Number(value.scrollY)) : 0
  };
}

function sanitizeStringArray(value: unknown, maxItems: number, maxLength: number) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => sanitizeText(entry, maxLength)).filter(Boolean).slice(0, maxItems);
}

function normalizeImageMeta(value: unknown): ScreenImageMetadata | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const input = value as Partial<ScreenImageMetadata>;
  const format = input.format === 'jpeg' || input.format === 'png' || input.format === 'webp' ? input.format : 'unknown';
  const numberValue = (entry: unknown) => (Number.isFinite(Number(entry)) ? Math.max(0, Math.round(Number(entry))) : undefined);

  return {
    format,
    source: input.source === 'dom_context' ? 'dom_context' : 'screenshot',
    originalWidth: numberValue(input.originalWidth),
    originalHeight: numberValue(input.originalHeight),
    width: numberValue(input.width),
    height: numberValue(input.height),
    quality: Number.isFinite(Number(input.quality)) ? Math.min(Math.max(Number(input.quality), 0), 1) : undefined,
    originalBytes: numberValue(input.originalBytes),
    bytes: numberValue(input.bytes),
    resized: Boolean(input.resized)
  };
}

function normalizeBbox(value: unknown) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const input = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
  const clamp = (entry: unknown) => (Number.isFinite(Number(entry)) ? Math.min(Math.max(Number(entry), 0), 1) : 0);

  return {
    x: clamp(input.x),
    y: clamp(input.y),
    width: clamp(input.width),
    height: clamp(input.height)
  };
}

function normalizeAnchor(value: unknown) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const input = value as {
    rect?: {
      top?: unknown;
      left?: unknown;
      width?: unknown;
      height?: unknown;
      bottom?: unknown;
      right?: unknown;
    };
    viewport?: {
      width?: unknown;
      height?: unknown;
    };
    scroll?: {
      x?: unknown;
      y?: unknown;
    };
    selector?: unknown;
  };
  const numberValue = (entry: unknown) => (Number.isFinite(Number(entry)) ? Math.round(Number(entry) * 10) / 10 : 0);
  const width = numberValue(input.rect?.width);
  const height = numberValue(input.rect?.height);
  if (width <= 0 || height <= 0) {
    return undefined;
  }

  return {
    rect: {
      top: numberValue(input.rect?.top),
      left: numberValue(input.rect?.left),
      width,
      height,
      bottom: numberValue(input.rect?.bottom),
      right: numberValue(input.rect?.right)
    },
    viewport: {
      width: Math.max(1, Math.round(numberValue(input.viewport?.width))),
      height: Math.max(1, Math.round(numberValue(input.viewport?.height)))
    },
    scroll: {
      x: Math.round(numberValue(input.scroll?.x)),
      y: Math.round(numberValue(input.scroll?.y))
    },
    selector: sanitizeText(input.selector, 160) || undefined
  };
}

function normalizeQuestionType(value: unknown): ScreenQuestionType | undefined {
  return value === 'multiple_choice' || value === 'multi_select' || value === 'short_answer' || value === 'unknown'
    ? value
    : undefined;
}

function normalizeStructuredExtraction(value: unknown): ScreenTextContext['structuredExtraction'] | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const input = value as NonNullable<ScreenTextContext['structuredExtraction']>;
  const questions = Array.isArray(input.questions)
    ? input.questions
        .map((question, index) => ({
          id: sanitizeText(question?.id, 80) || `q_${index + 1}`,
          question: sanitizeText(question?.question, 1200),
          choices: Array.isArray(question?.choices)
            ? question.choices
                .map((choice, choiceIndex) => ({
                  key: sanitizeText(choice?.key, 8) || String.fromCharCode(65 + choiceIndex),
                  text: sanitizeText(choice?.text, 500)
                }))
                .filter((choice) => choice.text)
                .slice(0, 8)
            : [],
          nearbyContext: sanitizeText(question?.nearbyContext, 1000),
          questionType: normalizeQuestionType(question?.questionType) ?? 'unknown',
          domHints: {
            selector: sanitizeText(question?.domHints?.selector, 160),
            hasRadioInputs: Boolean(question?.domHints?.hasRadioInputs),
            hasCheckboxInputs: Boolean(question?.domHints?.hasCheckboxInputs)
          },
          bbox: normalizeBbox(question?.bbox),
          anchor: normalizeAnchor(question?.anchor),
          confidence: Number.isFinite(Number(question?.confidence)) ? Math.min(Math.max(Number(question.confidence), 0), 1) : 0,
          extractionStrategy: sanitizeText(question?.extractionStrategy, 80) || 'generic-dom'
        }))
        .filter((question) => question.question)
        .slice(0, MAX_QUESTION_COUNT)
    : [];

  const extraction =
    input.extraction && typeof input.extraction === 'object'
      ? (input.extraction as Partial<NonNullable<ScreenTextContext['structuredExtraction']>['extraction']>)
      : {};

  return {
    source: {
      url: sanitizeText(input.source?.url, 700),
      title: sanitizeText(input.source?.title, 240),
      host: sanitizeText(input.source?.host, 180),
      pathname: sanitizeText(input.source?.pathname, 500)
    },
    mode: 'answer_questions',
    extraction: {
      strategy: sanitizeText(extraction.strategy, 80) || 'generic-dom',
      confidence: Number.isFinite(Number(extraction.confidence)) ? Math.min(Math.max(Number(extraction.confidence), 0), 1) : 0,
      warnings: sanitizeStringArray(extraction.warnings, 8, 120),
      extractionMs: Number.isFinite(Number(extraction.extractionMs)) ? Math.max(0, Math.round(Number(extraction.extractionMs))) : 0,
      inspectedNodeCount: Number.isFinite(Number(extraction.inspectedNodeCount))
        ? Math.max(0, Math.round(Number(extraction.inspectedNodeCount)))
        : 0
    },
    questions,
    visibleTextFallback: sanitizeText(input.visibleTextFallback, MAX_CONTEXT_TEXT_LENGTH) || undefined
  };
}

function normalizeQuestionContext(value: unknown): ScreenTextContext['questionContext'] | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const input = value as NonNullable<ScreenTextContext['questionContext']>;
  const extractionMode =
    input.extractionMode === 'screenshot' || input.extractionMode === 'mixed' || input.extractionMode === 'dom'
      ? input.extractionMode
      : 'dom';
  const questions = Array.isArray(input.questions)
    ? input.questions
        .map((question, index) => ({
          id: sanitizeText(question?.id, 80) || `q_${index + 1}`,
          questionText: sanitizeText(question?.questionText, 1200),
          choices: Array.isArray(question?.choices)
            ? question.choices
                .map((choice, choiceIndex) => ({
                  key: sanitizeText(choice?.key, 8) || String.fromCharCode(65 + choiceIndex),
                  text: sanitizeText(choice?.text, 500)
                }))
                .filter((choice) => choice.text)
                .slice(0, 8)
            : [],
          nearbyText: sanitizeText(question?.nearbyText, 420),
          elementHints: {
            selector: sanitizeText(question?.elementHints?.selector, 160),
            hasRadioInputs: Boolean(question?.elementHints?.hasRadioInputs),
            hasCheckboxInputs: Boolean(question?.elementHints?.hasCheckboxInputs),
            bbox: normalizeBbox(question?.elementHints?.bbox)
          }
        }))
        .filter((question) => question.questionText)
        .slice(0, MAX_QUESTION_COUNT)
    : [];

  if (!questions.length) {
    return undefined;
  }

  return {
    pageUrl: sanitizeText(input.pageUrl, 700),
    pageTitle: sanitizeText(input.pageTitle, 240) || 'Current page',
    visibleTextHash: sanitizeText(input.visibleTextHash, 120),
    extractionMode,
    questions
  };
}

function normalizeTextContext(value: unknown, fallbackViewport: ScreenViewport): ScreenTextContext | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const input = value as Partial<ScreenTextContext>;
  const questionCandidates = Array.isArray(input.questionCandidates)
    ? input.questionCandidates
        .map((candidate) => ({
          id: sanitizeText(candidate?.id, 80) || undefined,
          question: sanitizeText(candidate?.question, 1200),
          answerChoices: sanitizeStringArray(candidate?.answerChoices, 8, 500),
          nearbyText: sanitizeStringArray(candidate?.nearbyText, 4, 1000),
          bbox: normalizeBbox(candidate?.bbox),
          anchor: normalizeAnchor(candidate?.anchor),
          questionType: normalizeQuestionType(candidate?.questionType),
          confidence: Number.isFinite(Number(candidate?.confidence)) ? Math.min(Math.max(Number(candidate.confidence), 0), 1) : undefined,
          extractionStrategy: sanitizeText(candidate?.extractionStrategy, 80) || undefined
        }))
        .filter((candidate) => candidate.question)
        .slice(0, MAX_QUESTION_COUNT)
    : [];

  const visibleText = sanitizeText(input.visibleText, MAX_CONTEXT_TEXT_LENGTH);
  const selectedText = sanitizeText(input.selectedText, 1_200);
  const structuredExtraction = normalizeStructuredExtraction(input.structuredExtraction);
  const questionContext = normalizeQuestionContext(input.questionContext);

  if (!visibleText && !selectedText && !questionCandidates.length && !structuredExtraction?.questions.length && !questionContext?.questions.length) {
    return undefined;
  }

  return {
    pageTitle: sanitizeText(input.pageTitle, 240),
    pageUrl: sanitizeText(input.pageUrl, 700),
    selectedText: selectedText || undefined,
    visibleText,
    headings: sanitizeStringArray(input.headings, 10, 180),
    labels: sanitizeStringArray(input.labels, 18, 160),
    questionCandidates,
    structuredExtraction,
    questionContext,
    visibleTextHash: sanitizeText(input.visibleTextHash, 120) || questionContext?.visibleTextHash || undefined,
    extractionMode:
      input.extractionMode === 'screenshot' || input.extractionMode === 'mixed' || input.extractionMode === 'dom'
        ? input.extractionMode
        : questionContext?.extractionMode,
    viewport: normalizeViewport(input.viewport ?? fallbackViewport),
    capturedAt: sanitizeText(input.capturedAt, 80) || new Date().toISOString(),
    pageSignature: sanitizeText(input.pageSignature, 700) || undefined
  };
}

function validateScreenAnalyzeRequest(input: unknown): { ok: true; data: ScreenAnalyzeRequestBody } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') {
    return {
      ok: false,
      error: 'A JSON body is required.'
    };
  }

  const payload = input as Partial<ScreenAnalyzeRequestBody>;
  const image = sanitizeText(payload.image, MAX_IMAGE_DATA_URL_LENGTH);
  if (!image.startsWith('data:image/')) {
    return {
      ok: false,
      error: 'A screenshot data URL is required.'
    };
  }

  return {
    ok: true,
    data: {
      image,
      pageUrl: sanitizeText(payload.pageUrl, 700),
      pageTitle: sanitizeText(payload.pageTitle, 240) || 'Current page',
      viewport: normalizeViewport(payload.viewport),
      mode: payload.mode === 'find_questions_and_answer' ? 'find_questions_and_answer' : 'questions',
      textContext: normalizeTextContext(payload.textContext, normalizeViewport(payload.viewport)),
      imageMeta: normalizeImageMeta(payload.imageMeta),
      debug: Boolean(payload.debug)
    }
  };
}

function validateFollowUpRequest(input: unknown): { ok: true; data: ScreenFollowUpRequestBody } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') {
    return {
      ok: false,
      error: 'A JSON body is required.'
    };
  }

  const payload = input as Partial<ScreenFollowUpRequestBody>;
  const question = sanitizeText(payload.question, 800);
  if (!question) {
    return {
      ok: false,
      error: 'A follow-up question is required.'
    };
  }

  return {
    ok: true,
    data: {
      analysisId: sanitizeText(payload.analysisId, 120),
      itemId: sanitizeText(payload.itemId, 120),
      question,
      originalQuestion: sanitizeText(payload.originalQuestion, 900),
      originalAnswer: sanitizeText(payload.originalAnswer, 900),
      screenshotContext: sanitizeText(payload.screenshotContext, 1200) || undefined
    }
  };
}

screenRouter.post('/analyze', async (req, res) => {
  const validation = validateScreenAnalyzeRequest(req.body);
  if (!validation.ok) {
    return res.status(400).json({
      ok: false,
      error: 'SCREEN_ANALYSIS_FAILED',
      message: validation.error
    });
  }

  const requestId = createRequestId();
  logger.info(
    {
      requestId,
      pageUrl: validation.data.pageUrl,
      pageTitle: validation.data.pageTitle,
      viewport: validation.data.viewport,
      mode: validation.data.mode,
      imageMeta: validation.data.imageMeta,
      textContextChars: validation.data.textContext?.visibleText.length ?? 0,
      questionCandidates: validation.data.textContext?.questionCandidates.length ?? 0
    },
    'screen analysis request received'
  );

  const result = await analyzeScreenShot(validation.data, requestId);
  return res.json(result);
});

screenRouter.post('/follow-up', async (req, res) => {
  const validation = validateFollowUpRequest(req.body);
  if (!validation.ok) {
    return res.status(400).json({
      ok: false,
      error: 'SCREEN_FOLLOWUP_FAILED',
      message: validation.error
    });
  }

  const result = await answerScreenFollowUp(validation.data);
  return res.json(result);
});
