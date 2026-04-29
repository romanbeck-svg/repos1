import { sanitizeText } from '../services/safety.js';
import { ANALYSIS_MODES, type AnalyzeRequestBody, type AnalysisMode } from '../types/analysis.js';

const MAX_PAGE_TEXT_LENGTH = 12_000;
const MAX_BLOCK_COUNT = 32;
const MAX_QUESTION_CANDIDATE_COUNT = 12;
const MAX_SCREENSHOT_BASE64_LENGTH = 3_500_000;

function isAnalysisMode(value: unknown): value is AnalysisMode {
  return typeof value === 'string' && ANALYSIS_MODES.includes(value as AnalysisMode);
}

function sanitizeStringArray(value: unknown, maxItems: number, maxItemLength: number) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => sanitizeText(item, maxItemLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeScreenshotBase64(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.slice(0, MAX_SCREENSHOT_BASE64_LENGTH);
}

export function validateAnalyzeRequest(input: unknown): { ok: true; data: AnalyzeRequestBody } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') {
    return {
      ok: false,
      error: 'A JSON body is required.'
    };
  }

  const payload = input as Partial<AnalyzeRequestBody>;
  if (!isAnalysisMode(payload.mode)) {
    return {
      ok: false,
      error: `Invalid mode. Use one of: ${ANALYSIS_MODES.join(', ')}.`
    };
  }

  const page = payload.page;
  if (!page || typeof page !== 'object') {
    return {
      ok: false,
      error: 'A structured page object is required.'
    };
  }

  const normalized: AnalyzeRequestBody = {
    mode: payload.mode,
    instruction: sanitizeText(payload.instruction, 2_000),
    page: {
      url: sanitizeText(page.url, 500),
      title: sanitizeText(page.title, 240) || 'Current page',
      text: sanitizeText(page.text, MAX_PAGE_TEXT_LENGTH),
      headings: sanitizeStringArray(page.headings, 12, 200),
      blocks: sanitizeStringArray(page.blocks, MAX_BLOCK_COUNT, 280),
      questionCandidates: Array.isArray(page.questionCandidates)
        ? page.questionCandidates
            .map((candidate, index) => ({
              id: sanitizeText(candidate?.id, 80) || `q${index + 1}`,
              question: sanitizeText(candidate?.question, 1200),
              sectionLabel: sanitizeText(candidate?.sectionLabel, 140) || undefined,
              nearbyText: sanitizeStringArray(candidate?.nearbyText, 4, 1000),
              answerChoices: sanitizeStringArray(candidate?.answerChoices, 8, 500),
              sourceAnchor: sanitizeText(candidate?.sourceAnchor, 120),
              selectorHint: sanitizeText(candidate?.selectorHint, 160) || undefined
            }))
            .filter((candidate) => candidate.question || candidate.sourceAnchor)
            .slice(0, MAX_QUESTION_CANDIDATE_COUNT)
        : [],
      extractionNotes: sanitizeStringArray(page.extractionNotes, 8, 220)
    },
    screenshotBase64: normalizeScreenshotBase64(payload.screenshotBase64)
  };

  if (!normalized.page.url) {
    return {
      ok: false,
      error: 'A valid page URL is required.'
    };
  }

  return {
    ok: true,
    data: normalized
  };
}
