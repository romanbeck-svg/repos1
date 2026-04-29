import type { QuizAnswerChoice } from '../../shared/quizTypes';

const VOLATILE_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'fbclid',
  'gclid',
  'session',
  'sessionid',
  'attempt',
  'preview',
  'cache',
  '_',
  'ts',
  'timestamp'
]);

export function normalizeQuizText(value: string | null | undefined, maxLength = Number.POSITIVE_INFINITY) {
  const clean = (value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return clean.length > maxLength ? `${clean.slice(0, maxLength - 3).trimEnd()}...` : clean;
}

export function normalizeQuestionUrl(value: string) {
  try {
    const url = new URL(value);
    for (const key of Array.from(url.searchParams.keys())) {
      if (VOLATILE_PARAMS.has(key.toLowerCase()) || /^utm_/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.hash = '';
    return `${url.origin}${url.pathname}${url.searchParams.toString() ? `?${url.searchParams.toString()}` : ''}`;
  } catch {
    return value.split('#', 1)[0] ?? value;
  }
}

function fallbackHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

async function sha256(value: string) {
  if (!globalThis.crypto?.subtle) {
    return fallbackHash(value);
  }

  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function buildQuestionHash(input: {
  pageUrl: string;
  pageTitle: string;
  questionText: string;
  answerChoices: Pick<QuizAnswerChoice, 'label' | 'text' | 'inputType'>[];
  inputTypes: string[];
  candidateAttributes: string[];
  hasImages: boolean;
  hasCanvas: boolean;
  hasSvg: boolean;
}) {
  const normalizedChoices = input.answerChoices
    .map((choice) => `${normalizeQuizText(choice.label).toUpperCase()}:${normalizeQuizText(choice.text, 360)}:${choice.inputType}`)
    .join('|');
  const source = [
    normalizeQuestionUrl(input.pageUrl),
    normalizeQuizText(input.pageTitle, 240),
    normalizeQuizText(input.questionText, 1_400),
    normalizedChoices,
    input.inputTypes.sort().join(','),
    input.candidateAttributes.map((item) => normalizeQuizText(item, 120)).filter(Boolean).join('|'),
    input.hasImages ? 'img:1' : 'img:0',
    input.hasCanvas ? 'canvas:1' : 'canvas:0',
    input.hasSvg ? 'svg:1' : 'svg:0'
  ].join('\n');

  return sha256(source);
}
