import { Router } from 'express';
import { logger } from '../lib/logger.js';
import { recordAiRequest } from '../lib/runtime-status.js';
import { taskLimiter } from '../middleware/security.js';
import { env } from '../config/env.js';
import { sanitizeText } from '../services/safety.js';
import { analyzeQuizQuestion, QuizAnalysisError } from '../services/quiz-analysis.js';
import type { QuizAnalyzeRequestBody, QuizAnswerInputType, QuizQuestionType } from '../types/quiz.js';

const MAX_QUESTION_TEXT_LENGTH = 1_800;
const MAX_CHOICE_TEXT_LENGTH = 600;
const MAX_INSTRUCTIONS_LENGTH = 220;
const MAX_DEBUG_REASONS = 16;
const MAX_SCREENSHOT_BASE64_LENGTH = 3_500_000;

export const quizRouter = Router();

quizRouter.use(taskLimiter);

function normalizeQuestionType(value: unknown): QuizQuestionType {
  return value === 'multiple_choice' || value === 'multi_select' || value === 'short_answer' || value === 'dropdown' || value === 'unknown'
    ? value
    : 'unknown';
}

function normalizeInputType(value: unknown): QuizAnswerInputType {
  return value === 'radio' ||
    value === 'checkbox' ||
    value === 'text' ||
    value === 'select' ||
    value === 'button' ||
    value === 'button_or_card' ||
    value === 'unknown'
    ? value
    : 'unknown';
}

function normalizeChoice(value: unknown, fallbackIndex: number) {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const text = sanitizeText(input.text, MAX_CHOICE_TEXT_LENGTH);
  if (!text) {
    return null;
  }

  const index = Number.isInteger(Number(input.index)) ? Math.max(0, Number(input.index)) : fallbackIndex;
  const label = sanitizeText(input.label, 12) || String.fromCharCode(65 + index);
  return {
    id: sanitizeText(input.id, 80) || `${label}-${index}`,
    index,
    label: label.slice(0, 8),
    text,
    inputType: normalizeInputType(input.inputType),
    selected: Boolean(input.selected),
    disabled: Boolean(input.disabled)
  };
}

function normalizeScreenshot(value: unknown): QuizAnalyzeRequestBody['screenshot'] {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const included = Boolean(input.included);
  if (!included) {
    return {
      included: false
    };
  }

  const mimeType = input.mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
  const data = sanitizeText(input.data, MAX_SCREENSHOT_BASE64_LENGTH).replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
  return {
    included: Boolean(data),
    mimeType,
    data
  };
}

function normalizeExtraction(value: unknown): QuizAnalyzeRequestBody['extraction'] {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const confidenceValue = Number(input.confidence);
  const method = input.method === 'screenshot' || input.method === 'hybrid' || input.method === 'dom' ? input.method : 'dom';

  return {
    confidence: Number.isFinite(confidenceValue) ? Math.min(Math.max(confidenceValue > 1 ? confidenceValue / 100 : confidenceValue, 0), 1) : 0,
    method,
    needsScreenshot: Boolean(input.needsScreenshot),
    debugReasons: Array.isArray(input.debugReasons)
      ? input.debugReasons.map((reason) => sanitizeText(reason, 80)).filter(Boolean).slice(0, MAX_DEBUG_REASONS)
      : []
  };
}

function validateQuizAnalyzeRequest(input: unknown): { ok: true; data: QuizAnalyzeRequestBody } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') {
    return {
      ok: false,
      error: 'A JSON body is required.'
    };
  }

  const payload = input as Record<string, unknown>;
  const question = payload.question && typeof payload.question === 'object' ? (payload.question as Record<string, unknown>) : {};
  const questionText = sanitizeText(question.questionText, MAX_QUESTION_TEXT_LENGTH);
  if (!questionText) {
    return {
      ok: false,
      error: 'A question is required.'
    };
  }

  const questionHash = sanitizeText(payload.questionHash, 160);
  if (!questionHash) {
    return {
      ok: false,
      error: 'A questionHash is required.'
    };
  }

  const answerChoices = Array.isArray(question.answerChoices)
    ? question.answerChoices
        .map((choice, index) => normalizeChoice(choice, index))
        .filter((choice): choice is NonNullable<ReturnType<typeof normalizeChoice>> => Boolean(choice))
        .slice(0, 10)
    : [];

  return {
    ok: true,
    data: {
      mode: 'quiz-prefetch',
      requestId: sanitizeText(payload.requestId, 120) || `quiz-${Date.now()}`,
      questionHash,
      pageUrl: sanitizeText(payload.pageUrl, 700),
      pageTitle: sanitizeText(payload.pageTitle, 240) || undefined,
      question: {
        questionText,
        instructions: sanitizeText(question.instructions, MAX_INSTRUCTIONS_LENGTH),
        answerChoices,
        questionType: normalizeQuestionType(question.questionType)
      },
      extraction: normalizeExtraction(payload.extraction),
      screenshot: normalizeScreenshot(payload.screenshot)
    }
  };
}

quizRouter.post('/analyze', async (req, res) => {
  const validation = validateQuizAnalyzeRequest(req.body);
  if (!validation.ok) {
    return res.status(400).json({
      status: 'error',
      requestId: '',
      questionHash: '',
      answer: '',
      answerLabel: null,
      answerIndex: null,
      answerIndexes: [],
      confidence: 0,
      explanation: validation.error,
      evidence: '',
      shouldDisplay: false,
      error: 'NO_QUESTION_FOUND'
    });
  }

  const request = validation.data;
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.on('close', abort);

  logger.info(
    {
      requestId: request.requestId,
      questionHash: request.questionHash,
      pageUrl: request.pageUrl,
      questionType: request.question.questionType,
      choiceCount: request.question.answerChoices.length,
      screenshotIncluded: request.screenshot.included
    },
    'quiz analysis request received'
  );

  try {
    const result = await analyzeQuizQuestion(request, controller.signal);
    recordAiRequest({
      ok: true,
      route: '/api/quiz/analyze',
      provider: env.aiProvider,
      message: 'Quiz Mode prefetch completed.'
    });
    return res.json(result);
  } catch (error) {
    if (error instanceof QuizAnalysisError) {
      recordAiRequest({
        ok: false,
        route: '/api/quiz/analyze',
        provider: env.aiProvider,
        status: error.status,
        message: error.exposeMessage
      });
      logger.error(
        {
          requestId: request.requestId,
          questionHash: request.questionHash,
          status: error.status,
          failReason: error.code,
          detail: error.message
        },
        'quiz analysis request failed'
      );
      return res.status(error.status).json({
        status: 'error',
        requestId: request.requestId,
        questionHash: request.questionHash,
        answer: '',
        answerLabel: null,
        answerIndex: null,
        answerIndexes: [],
        confidence: 0,
        explanation: error.exposeMessage,
        evidence: '',
        shouldDisplay: false,
        error: error.code ?? 'QUIZ_ANALYSIS_FAILED'
      });
    }

    recordAiRequest({
      ok: false,
      route: '/api/quiz/analyze',
      provider: env.aiProvider,
      status: 500,
      message: 'Mako IQ could not prefetch the quiz answer.'
    });
    logger.error(
      {
        requestId: request.requestId,
        questionHash: request.questionHash,
        detail: error instanceof Error ? error.message : 'Unknown quiz analysis error'
      },
      'unexpected quiz route failure'
    );
    return res.status(500).json({
      status: 'error',
      requestId: request.requestId,
      questionHash: request.questionHash,
      answer: '',
      answerLabel: null,
      answerIndex: null,
      answerIndexes: [],
      confidence: 0,
      explanation: 'Mako IQ could not prefetch the quiz answer.',
      evidence: '',
      shouldDisplay: false,
      error: 'BACKEND_5XX'
    });
  } finally {
    req.off('close', abort);
  }
});
