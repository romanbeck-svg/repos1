export const CONFIDENCE_STRONG_THRESHOLD = 0.7;
export const CONFIDENCE_LOW_THRESHOLD = 0.45;

export type AnswerDisplayMode = 'final' | 'lower-confidence' | 'low-confidence' | 'invalid';
export type NormalizedAnswerStatus = 'answered' | 'needs_more_context' | 'no_question' | 'error';

export interface AnswerChoiceLike {
  index: number;
  label: string;
  text: string;
}

export interface ParsedAnswer {
  answerLabel: string | null;
  answerText: string;
}

export interface NormalizeAnswerPayloadInput {
  status?: unknown;
  questionHash?: unknown;
  answer?: unknown;
  answerLabel?: unknown;
  answerIndex?: unknown;
  answerIndexes?: unknown;
  confidence?: unknown;
  explanation?: unknown;
  evidence?: unknown;
  shouldDisplay?: unknown;
  choices?: AnswerChoiceLike[];
}

export interface NormalizedAnswerPayload {
  status: NormalizedAnswerStatus;
  questionHash: string;
  answerLabel: string | null;
  answerIndexes: number[];
  answerText: string;
  confidence: number;
  explanation: string;
  displayTitle: string;
  displayMode: AnswerDisplayMode;
  displayAnswer: string;
  shouldDisplay: boolean;
  invalidReason?: string;
}

export interface FinalBubbleViewModel {
  status: 'answered' | 'low-confidence' | 'invalid';
  questionHash: string;
  questionText: string;
  answerLabel: string | null;
  answerText: string;
  displayAnswer: string;
  confidence: number;
  confidenceLabel: string;
  confidenceTone: 'high' | 'medium' | 'low';
  explanation: string;
  displayTitle: string;
  displayMode: AnswerDisplayMode;
  shouldShowQuestionInExpanded: boolean;
  copyText: string;
}

export function sanitizeDisplayText(value: unknown, fallback = '') {
  const text =
    typeof value === 'string'
      ? value
      : value === null || value === undefined
        ? ''
        : String(value);

  const normalized = text
    .replace(/[\u0000-\u001F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([([{])\s+/g, '$1')
    .replace(/\s+([)\]}])/g, '$1')
    .replace(/^[\s"'`]+|[\s"'`]+$/g, '')
    .trim();

  return normalized || fallback;
}

function normalizeAnswerLabel(value: unknown) {
  const label = sanitizeDisplayText(value, '').replace(/[^A-H]/gi, '').slice(0, 1).toUpperCase();
  return label || null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripDuplicateLabelPrefix(text: string, label: string | null) {
  if (!label) {
    return sanitizeDisplayText(text);
  }

  const escaped = escapeRegExp(label);
  let next = sanitizeDisplayText(text)
    .replace(new RegExp(`^(?:choice\\s*)?\\(?${escaped}\\)?\\s*[\\.)\\]:\\-]+\\s*`, 'i'), '')
    .replace(new RegExp(`^${escaped}\\s+(.+)$`, 'i'), '$1')
    .trim();

  if (next.length > 1 && next[0]?.toUpperCase() === label) {
    const second = next[1] ?? '';
    const third = next[2] ?? '';
    if (/\s/.test(second) || /[0-9([]/.test(second) || (/[A-Z]/.test(second) && /[a-z]/.test(third))) {
      next = next.slice(1).trim();
    }
  }

  return sanitizeDisplayText(next);
}

export function parseAnswerLabelAndText(value: unknown, fallbackLabel: string | null = null): ParsedAnswer {
  const text = sanitizeDisplayText(value);
  const prefixMatch = text.match(/^(?:recommended\s+answer\s*[:\-]\s*)?(?:choice\s*)?\(?([A-H])\)?\s*[\.\):\-]\s*(.*)$/i);
  const answerLabel = normalizeAnswerLabel(prefixMatch?.[1] ?? fallbackLabel);
  const answerText = stripDuplicateLabelPrefix(prefixMatch ? prefixMatch[2] : text, answerLabel);

  return {
    answerLabel,
    answerText
  };
}

export function normalizeConfidence(value: unknown, fallback = 0.5) {
  let parsed: number;
  const rawText = typeof value === 'string' ? value.trim() : '';
  const percentageMatch = rawText.match(/^([0-9]+(?:\.[0-9]+)?)\s*%$/);

  if (percentageMatch) {
    parsed = Number(percentageMatch[1]) / 100;
  } else if (typeof value === 'string') {
    parsed = Number(rawText.replace(/,/g, ''));
  } else {
    parsed = Number(value);
  }

  const fallbackValue = Number.isFinite(fallback) ? fallback : 0.5;
  const normalized = Number.isFinite(parsed) ? (parsed > 1 ? parsed / 100 : parsed) : fallbackValue;
  const output = Math.min(Math.max(normalized, 0), 1);

  console.info('[MakoIQ Confidence] input/output', {
    input: value,
    output,
    fallbackUsed: !Number.isFinite(parsed)
  });

  return output;
}

export function shouldDisplayAsConfidentAnswer(confidence: number) {
  return normalizeConfidence(confidence, 0) >= CONFIDENCE_STRONG_THRESHOLD;
}

export function shouldRetryLowConfidence(confidence: number) {
  return normalizeConfidence(confidence, 0) < CONFIDENCE_LOW_THRESHOLD;
}

function normalizeStatus(value: unknown): NormalizedAnswerStatus {
  const status = sanitizeDisplayText(value, 'answered');
  if (status === 'answered' || status === 'needs_more_context' || status === 'no_question' || status === 'error') {
    return status;
  }

  return 'needs_more_context';
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

function findMatchingChoice(
  choices: AnswerChoiceLike[],
  answerLabel: string | null,
  answerText: string,
  answerIndexes: number[]
) {
  const byIndex = answerIndexes.map((index) => choices.find((choice) => choice.index === index)).find(Boolean);
  if (byIndex) {
    return byIndex;
  }

  const byLabel = answerLabel ? choices.find((choice) => choice.label.toLowerCase() === answerLabel.toLowerCase()) : undefined;
  if (byLabel) {
    return byLabel;
  }

  const normalizedAnswer = answerText.toLowerCase();
  if (!normalizedAnswer) {
    return undefined;
  }

  return choices.find((choice) => {
    const choiceText = sanitizeDisplayText(choice.text).toLowerCase();
    return choiceText === normalizedAnswer || choiceText.includes(normalizedAnswer) || normalizedAnswer.includes(choiceText);
  });
}

function getDisplayMode(confidence: number, valid: boolean): AnswerDisplayMode {
  if (!valid) {
    return 'invalid';
  }

  if (confidence < CONFIDENCE_LOW_THRESHOLD) {
    return 'low-confidence';
  }

  if (confidence < CONFIDENCE_STRONG_THRESHOLD) {
    return 'lower-confidence';
  }

  return 'final';
}

function getDisplayTitle(displayMode: AnswerDisplayMode) {
  if (displayMode === 'low-confidence' || displayMode === 'invalid') {
    return 'Low confidence';
  }

  if (displayMode === 'lower-confidence') {
    return 'Recommended answer';
  }

  return 'Recommended answer';
}

export function normalizeAnswerPayload(input: NormalizeAnswerPayloadInput): NormalizedAnswerPayload {
  const choices = input.choices ?? [];
  const parsedAnswer = parseAnswerLabelAndText(input.answer, normalizeAnswerLabel(input.answerLabel));
  const answerIndex = normalizeAnswerIndex(input.answerIndex, choices.length);
  const answerIndexes = answerIndex === null ? normalizeAnswerIndexes(input.answerIndexes, choices.length) : [answerIndex];
  const matchedChoice = findMatchingChoice(choices, parsedAnswer.answerLabel, parsedAnswer.answerText, answerIndexes);
  const answerLabel = matchedChoice?.label ?? parsedAnswer.answerLabel;
  const finalIndexes = matchedChoice ? [matchedChoice.index] : answerIndexes;
  const answerText = sanitizeDisplayText(matchedChoice?.text ?? parsedAnswer.answerText);
  const confidence = normalizeConfidence(input.confidence, 0.5);
  const status = normalizeStatus(input.status);
  const valid = Boolean(answerText) && status === 'answered';
  const displayMode = getDisplayMode(confidence, valid);
  const displayTitle = getDisplayTitle(displayMode);
  const displayAnswer =
    displayMode === 'low-confidence' || displayMode === 'invalid'
      ? 'I could not verify this answer confidently.'
      : answerLabel
        ? `${answerLabel}. ${answerText}`
        : answerText;
  const explanation =
    sanitizeDisplayText(input.explanation, '') ||
    sanitizeDisplayText(input.evidence, '') ||
    (displayMode === 'low-confidence' || displayMode === 'invalid'
      ? 'The result was not reliable enough to show as a confident answer.'
      : '');

  return {
    status,
    questionHash: sanitizeDisplayText(input.questionHash),
    answerLabel,
    answerIndexes: finalIndexes,
    answerText,
    confidence,
    explanation,
    displayTitle,
    displayMode,
    displayAnswer,
    shouldDisplay: input.shouldDisplay !== false && valid,
    invalidReason: valid ? undefined : 'missing_answer'
  };
}

export function buildFinalBubbleViewModel(input: {
  questionHash: string;
  question: unknown;
  answer: unknown;
  answerChoice?: unknown;
  confidence: unknown;
  explanation?: unknown;
  needsMoreContext?: boolean;
}): FinalBubbleViewModel {
  const rawPayload = {
    status: 'answered',
    questionHash: input.questionHash,
    answer: sanitizeDisplayText(input.answerChoice, '') || input.answer,
    confidence: input.confidence,
    explanation: input.explanation,
    shouldDisplay: true
  };
  const normalized = normalizeAnswerPayload(rawPayload);
  const questionText = sanitizeDisplayText(input.question);
  const answerEchoesQuestion =
    Boolean(questionText) && normalized.answerText.toLowerCase() === questionText.toLowerCase();
  const displayMode = answerEchoesQuestion ? 'invalid' : normalized.displayMode;
  const confidenceTone =
    displayMode === 'low-confidence' || displayMode === 'invalid'
      ? 'low'
      : normalized.confidence < CONFIDENCE_STRONG_THRESHOLD
        ? 'medium'
        : 'high';
  const displayAnswer =
    displayMode === 'low-confidence' || displayMode === 'invalid'
      ? 'I could not verify this answer confidently.'
      : normalized.displayAnswer;
  const displayTitle = getDisplayTitle(displayMode);

  return {
    status: displayMode === 'invalid' ? 'invalid' : displayMode === 'low-confidence' ? 'low-confidence' : 'answered',
    questionHash: normalized.questionHash || input.questionHash,
    questionText,
    answerLabel: normalized.answerLabel,
    answerText: normalized.answerText,
    displayAnswer,
    confidence: normalized.confidence,
    confidenceLabel:
      displayMode === 'low-confidence' || displayMode === 'invalid'
        ? 'Low confidence'
        : displayMode === 'lower-confidence'
          ? 'Lower confidence'
          : `${Math.round(normalized.confidence * 100)}%`,
    confidenceTone,
    explanation:
      sanitizeDisplayText(input.explanation, normalized.explanation) ||
      (displayMode === 'low-confidence' || displayMode === 'invalid'
        ? 'The answer could not be verified reliably. Scan again for a cleaner result.'
        : 'No extra explanation was returned.'),
    displayTitle,
    displayMode,
    shouldShowQuestionInExpanded: Boolean(questionText),
    copyText: displayMode === 'low-confidence' || displayMode === 'invalid' ? normalized.answerText : displayAnswer
  };
}
