import { sanitizeText } from '../services/safety.js';
import { ANALYSIS_MODES, type AnalyzeRequestBody, type AnalysisMode } from '../types/analysis.js';

const MAX_PAGE_TEXT_LENGTH = 12_000;
const MAX_SCREENSHOT_BASE64_LENGTH = 3_500_000;

function isAnalysisMode(value: unknown): value is AnalysisMode {
  return typeof value === 'string' && ANALYSIS_MODES.includes(value as AnalysisMode);
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
      error: 'A page object with url, title, and text is required.'
    };
  }

  const normalized: AnalyzeRequestBody = {
    mode: payload.mode,
    instruction: sanitizeText(payload.instruction, 2_000),
    page: {
      url: sanitizeText(page.url, 500),
      title: sanitizeText(page.title, 240) || 'Current page',
      text: sanitizeText(page.text, MAX_PAGE_TEXT_LENGTH)
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
