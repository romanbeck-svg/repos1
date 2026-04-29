import type {
  ScreenBoundingBox,
  ScreenQuestionAnchor,
  ScreenQuestionDomHints,
  ScreenQuestionType,
  ScreenQuestionContext,
  ScreenStructuredChoice,
  ScreenStructuredExtraction,
  ScreenStructuredQuestion,
  ScreenTextContext
} from '../shared/types';
import { hashText } from '../shared/perf';

const MAX_VISIBLE_TEXT = 6_000;
const MAX_TEXT_BLOCKS = 34;
const MAX_HEADINGS = 10;
const MAX_LABELS = 18;
const MAX_QUESTIONS = 5;
const MAX_CHOICES = 8;
const MAX_QUESTION_CHARS = 1_200;
const MAX_CHOICE_CHARS = 500;
const MAX_CONTEXT_CHARS = 1_000;
const MAX_ELEMENTS_TO_INSPECT = 760;
const MAX_CONTAINER_CANDIDATES = 160;

const MAKO_UI_ROOT_SELECTORS = [
  '#mako-iq-assistant-root',
  '#mako-iq-overlay-root',
  '#canvy-output-overlay-host',
  '#walt-overlay-root'
].join(', ');

const NOISE_CONTAINER_SELECTOR = [
  MAKO_UI_ROOT_SELECTORS,
  'script',
  'style',
  'noscript',
  'svg',
  'canvas',
  'nav',
  'header',
  'footer',
  'aside',
  'menu',
  'dialog',
  '[role="navigation"]',
  '[role="toolbar"]',
  '[role="menubar"]',
  '[role="menu"]',
  '[role="dialog"]',
  '[role="complementary"]',
  '[aria-hidden="true"]',
  '[aria-label*="navigation" i]',
  '[aria-label*="toolbar" i]',
  '[data-testid*="navigation" i]',
  '[data-testid*="toolbar" i]',
  '[class*="navigation" i]',
  '[class*="sidebar" i]',
  '[class*="cookie" i]',
  '[class*="ad-" i]',
  '[id*="cookie" i]',
  '[id*="sidebar" i]'
].join(', ');

const CANVAS_QUESTION_CONTAINER_SELECTORS = [
  '.display_question',
  '.quiz_question',
  '.question',
  '.ic-QuizQuestion',
  '.assessment_question',
  '.quiz-item',
  '[data-testid*="question" i]',
  '[class*="question" i]',
  '[aria-label*="question" i]',
  'fieldset',
  '[role="radiogroup"]',
  '[role="group"]'
].join(', ');

const QUESTION_TEXT_SELECTORS = [
  '.question_text',
  '.display_question .question_text',
  '.question-text',
  '.prompt',
  '.stem',
  '[data-testid*="question-text" i]',
  '[data-testid*="prompt" i]',
  '[class*="question_text" i]',
  '[class*="stem" i]',
  'legend',
  'h1',
  'h2',
  'h3',
  'h4',
  'p'
].join(', ');

const CHOICE_ELEMENT_SELECTORS = [
  'label',
  'li',
  '.answer',
  '.answers .answer',
  '.answer_label',
  '.choice',
  '.option',
  '[class*="answer" i]',
  '[class*="choice" i]',
  '[class*="option" i]',
  '[data-testid*="answer" i]',
  '[data-testid*="choice" i]',
  '[role="option"]',
  '[role="radio"]',
  '[role="checkbox"]',
  'button'
].join(', ');

const TEXT_BLOCK_SELECTORS = [
  'main h1',
  'main h2',
  'main h3',
  'main h4',
  'main p',
  'main li',
  'main label',
  'main legend',
  'main td',
  'article h1',
  'article h2',
  'article h3',
  'article h4',
  'article p',
  'article li',
  'section h1',
  'section h2',
  'section h3',
  'section h4',
  'section p',
  'section li',
  '.question_text',
  '.display_question',
  '.quiz_question',
  '.question',
  'fieldset',
  '[role="radiogroup"]',
  '[data-testid*="question" i]',
  'p',
  'li',
  'label',
  'legend'
].join(', ');

const SIGNATURE_TEXT_SELECTORS = [
  '.question_text',
  '.display_question',
  '.quiz_question',
  '.question',
  '.ic-QuizQuestion',
  '.answers',
  '.answer',
  '.answer_label',
  '.choice',
  '.option',
  'fieldset',
  'legend',
  'label',
  'li',
  '[role="radiogroup"]',
  '[role="group"]',
  '[role="radio"]',
  '[role="checkbox"]',
  '[data-testid*="question" i]',
  '[data-testid*="answer" i]',
  '[class*="question" i]',
  '[class*="answer" i]',
  '[class*="choice" i]'
].join(', ');

const QUESTION_WORD_PATTERN =
  /\b(?:what|why|how|when|where|which|who|whom|whose|solve|calculate|find|determine|choose|select|identify|explain|describe|compare|define|write|complete|state|analyze|infer|evaluate)\b/i;
const QUESTION_LIKE_PATTERN = /\?|^\s*(?:\d+[\.\)]\s+)?(?:what|why|how|when|where|which|who|solve|calculate|find|determine|choose|select|identify|explain|describe|compare|define|write|complete|state|analyze|infer|evaluate)\b/i;
const CHOICE_PREFIX_PATTERN =
  /^(?:choice\s*)?(?:\(?([A-H])\)?[\s.\):\-\u2013\u2014]+|([A-H])\s+[-\u2013\u2014]\s+|([A-H])\s{2,}|(\d{1,2})[\.\)]\s+)(.+)$/i;
const CANVAS_NAV_PATTERN =
  /^(?:home|announcements|assignments|discussions|grades|people|pages|files|syllabus|modules|quizzes|outcomes|collaborations|settings|account|dashboard|courses|calendar|inbox|history|studio|commons|help)$/i;

interface ExtractedChoice extends ScreenStructuredChoice {
  element?: Element;
}

interface CandidateInput {
  question: string;
  choices: ExtractedChoice[];
  nearbyContext: string;
  questionType: ScreenQuestionType;
  domHints: ScreenQuestionDomHints;
  bbox?: ScreenBoundingBox;
  anchor?: ScreenQuestionAnchor;
  confidence: number;
  extractionStrategy: string;
}

interface VisibleTextBundle {
  text: string;
  headings: string[];
  labels: string[];
  inspectedNodeCount: number;
}

let lastVisibleTextBundle: VisibleTextBundle | null = null;

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function normalizeText(value: string | null | undefined, maxLength = Number.POSITIVE_INFINITY) {
  const clean = (value ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 3).trimEnd()}...` : clean;
}

function normalizeMultiline(value: string | null | undefined, maxLength = Number.POSITIVE_INFINITY) {
  const clean = (value ?? '')
    .replace(/\r/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 3).trimEnd()}...` : clean;
}

function normalizeKey(value: string) {
  return normalizeText(value).toLowerCase();
}

function isDebugPerfEnabled() {
  try {
    return Boolean(import.meta.env.DEV || localStorage.getItem('MAKO_DEBUG_PERF') === '1');
  } catch {
    return Boolean(import.meta.env.DEV);
  }
}

function logPerf(payload: Record<string, unknown>) {
  if (isDebugPerfEnabled()) {
    console.info('[MakoIQ Perf]', payload);
  }
}

function safeCssEscape(value: string) {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\#.:,[\]>~+*^$|=]/g, '\\$&');
}

function isMakoUiElement(element: Element) {
  return Boolean(element.closest(MAKO_UI_ROOT_SELECTORS));
}

function isSkippableElement(element: Element) {
  return isMakoUiElement(element) || Boolean(element.closest(NOISE_CONTAINER_SELECTOR));
}

function isElementVisible(element: Element, requireViewport = true) {
  if (isSkippableElement(element)) {
    return false;
  }

  const htmlElement = element as HTMLElement;
  if (htmlElement.hidden || htmlElement.getAttribute('aria-hidden') === 'true') {
    return false;
  }

  const style = window.getComputedStyle(htmlElement);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return false;
  }

  const rect = htmlElement.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  if (!requireViewport) {
    return true;
  }

  return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
}

function getNormalizedBbox(element: Element): ScreenBoundingBox {
  const rect = element.getBoundingClientRect();
  const width = Math.max(window.innerWidth, 1);
  const height = Math.max(window.innerHeight, 1);
  const clamp = (value: number) => Math.min(Math.max(value, 0), 1);

  return {
    x: clamp(rect.left / width),
    y: clamp(rect.top / height),
    width: clamp(rect.width / width),
    height: clamp(rect.height / height)
  };
}

function getAnchorFromRect(rect: DOMRect | ClientRect, selector?: string): ScreenQuestionAnchor | undefined {
  if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top) || rect.width <= 0 || rect.height <= 0) {
    return undefined;
  }

  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    rect: {
      top: round(rect.top),
      left: round(rect.left),
      width: round(rect.width),
      height: round(rect.height),
      bottom: round(rect.bottom),
      right: round(rect.right)
    },
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight
    },
    scroll: {
      x: Math.round(window.scrollX),
      y: Math.round(window.scrollY)
    },
    selector
  };
}

function getElementAnchor(element: Element): ScreenQuestionAnchor | undefined {
  if (!isElementVisible(element, false)) {
    return undefined;
  }

  return getAnchorFromRect(element.getBoundingClientRect(), buildSelectorHint(element));
}

function getSelectionAnchor(): ScreenQuestionAnchor | undefined {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return undefined;
  }

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    return getAnchorFromRect(rect, 'selection');
  }

  const firstRect = Array.from(range.getClientRects()).find((entry) => entry.width > 0 && entry.height > 0);
  return firstRect ? getAnchorFromRect(firstRect, 'selection') : undefined;
}

function getElementText(element: Element, maxLength = 1_200) {
  const htmlElement = element as HTMLElement;
  const text = htmlElement.innerText || element.textContent || element.getAttribute('aria-label') || '';
  return normalizeText(text, maxLength);
}

function getElementMultilineText(element: Element, maxLength = 2_400) {
  const htmlElement = element as HTMLElement;
  const text = htmlElement.innerText || element.textContent || element.getAttribute('aria-label') || '';
  return normalizeMultiline(text, maxLength);
}

function buildSelectorHint(element: Element) {
  const tag = element.tagName.toLowerCase();
  const id = element.id ? `#${element.id.slice(0, 48)}` : '';
  const classes =
    typeof element.className === 'string'
      ? element.className
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 3)
          .map((className) => `.${className.slice(0, 32)}`)
          .join('')
      : '';
  return `${tag}${id}${classes}`.slice(0, 160);
}

function looksLikeNoiseText(text: string) {
  const clean = normalizeText(text, 260);
  if (!clean) {
    return true;
  }

  if (CANVAS_NAV_PATTERN.test(clean)) {
    return true;
  }

  if (/^(?:next|previous|back|submit|cancel|save|search|menu|share|settings|close|open|edit|view|file|help)$/i.test(clean)) {
    return true;
  }

  if (/^(?:\d+\s*){1,3}$/.test(clean)) {
    return true;
  }

  return false;
}

function cleanQuestionText(value: string) {
  return normalizeText(value, MAX_QUESTION_CHARS)
    .replace(/^Question\s+\d+\s*/i, '')
    .replace(/^\d+\s*(?:pts?|points?)\s*/i, '')
    .replace(/\b(?:Not yet answered|Marked out of \d+(?:\.\d+)?|Flag question)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseChoicePrefix(value: string): { key: string; text: string } | null {
  const clean = normalizeText(value, MAX_CHOICE_CHARS + 24);
  const match = clean.match(CHOICE_PREFIX_PATTERN);
  if (!match) {
    return null;
  }

  const rawKey = match[1] ?? match[2] ?? match[3] ?? match[4] ?? '';
  const key = /^\d+$/.test(rawKey) ? String.fromCharCode(64 + Number(rawKey)) : rawKey.toUpperCase();
  const text = normalizeText(match[5], MAX_CHOICE_CHARS)
    .replace(/^(?:[-\u2013\u2014]\s*)+/, '')
    .replace(/\b(?:Correct Answer|Selected Answer)\b:?/gi, '')
    .trim();

  if (!key || !text) {
    return null;
  }

  return {
    key,
    text
  };
}

function stripChoicePrefix(value: string) {
  return parseChoicePrefix(value)?.text ?? normalizeText(value, MAX_CHOICE_CHARS);
}

function splitCleanLines(value: string) {
  return normalizeMultiline(value, 8_000)
    .replace(/\s+((?:\(?[A-H]\)?[\).:\-\u2013\u2014])\s+)/g, '\n$1')
    .split(/\n+/)
    .map((line) => normalizeText(line, 900))
    .filter(Boolean);
}

function extractChoicesFromTextBlock(value: string): ExtractedChoice[] {
  const choices: ExtractedChoice[] = [];
  let current: ExtractedChoice | null = null;

  for (const line of splitCleanLines(value)) {
    const parsed = parseChoicePrefix(line);
    if (parsed) {
      current = parsed;
      choices.push(current);
      if (choices.length >= MAX_CHOICES) {
        break;
      }
      continue;
    }

    if (current && !QUESTION_LIKE_PATTERN.test(line) && line.length <= 220) {
      current.text = normalizeText(`${current.text} ${line}`, MAX_CHOICE_CHARS);
    }
  }

  return dedupeChoices(choices);
}

function getInputLabelText(input: HTMLInputElement) {
  const id = input.id?.trim();
  const labelFor = id ? document.querySelector(`label[for="${safeCssEscape(id)}"]`) : null;
  const parentLabel = input.closest('label');
  const answerContainer = input.closest('.answer, .choice, .option, li, [class*="answer" i], [class*="choice" i]');
  const siblingText = normalizeText(input.nextElementSibling?.textContent, MAX_CHOICE_CHARS);
  const valueText = normalizeText(input.getAttribute('aria-label') || input.value, MAX_CHOICE_CHARS);
  const source =
    normalizeText(labelFor?.textContent, MAX_CHOICE_CHARS) ||
    normalizeText(parentLabel?.textContent, MAX_CHOICE_CHARS) ||
    normalizeText(answerContainer?.textContent, MAX_CHOICE_CHARS) ||
    siblingText ||
    valueText;

  return source.replace(/\s+/g, ' ').trim();
}

function dedupeChoices(choices: ExtractedChoice[]) {
  const seen = new Set<string>();
  const results: ExtractedChoice[] = [];

  for (const choice of choices) {
    const text = normalizeText(choice.text, MAX_CHOICE_CHARS);
    if (!text || looksLikeNoiseText(text)) {
      continue;
    }

    const key = choice.key || String.fromCharCode(65 + results.length);
    const dedupeKey = `${key}:${normalizeKey(text)}`;
    const textKey = normalizeKey(text);
    if (seen.has(dedupeKey) || seen.has(textKey)) {
      continue;
    }

    seen.add(dedupeKey);
    seen.add(textKey);
    results.push({
      key,
      text,
      element: choice.element
    });

    if (results.length >= MAX_CHOICES) {
      break;
    }
  }

  return results;
}

function collectChoicesFromContainer(container: Element): ExtractedChoice[] {
  const choices: ExtractedChoice[] = [];
  const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]')).slice(0, 20);

  inputs.forEach((input) => {
    const labelText = getInputLabelText(input);
    const parsed = parseChoicePrefix(labelText);
    const text = parsed?.text ?? stripChoicePrefix(labelText);
    if (!text) {
      return;
    }

    choices.push({
      key: parsed?.key ?? String.fromCharCode(65 + choices.length),
      text,
      element:
        (input.closest('label, .answer, .choice, .option, li, [class*="answer" i], [class*="choice" i]') as Element | null) ??
        input
    });
  });

  Array.from(container.querySelectorAll(CHOICE_ELEMENT_SELECTORS)).forEach((element) => {
    if (!isElementVisible(element) || choices.some((choice) => choice.element === element || choice.element?.contains(element))) {
      return;
    }

    const text = getElementText(element, MAX_CHOICE_CHARS + 80);
    if (!text || text.length > MAX_CHOICE_CHARS + 40) {
      return;
    }

    const parsed = parseChoicePrefix(text);
    const className = typeof element.className === 'string' ? element.className.toLowerCase() : '';
    const role = element.getAttribute('role')?.toLowerCase() ?? '';
    const isChoiceLike =
      Boolean(parsed) ||
      element.tagName === 'LABEL' ||
      element.tagName === 'LI' ||
      role === 'option' ||
      role === 'radio' ||
      role === 'checkbox' ||
      /\b(answer|choice|option)\b/.test(className);

    if (!isChoiceLike || QUESTION_LIKE_PATTERN.test(text)) {
      return;
    }

    choices.push({
      key: parsed?.key ?? String.fromCharCode(65 + choices.length),
      text: parsed?.text ?? stripChoicePrefix(text),
      element
    });
  });

  if (choices.length < 2) {
    choices.push(...extractChoicesFromTextBlock(getElementMultilineText(container, 2_400)));
  }

  return dedupeChoices(choices);
}

function removeChoiceText(source: string, choices: ExtractedChoice[]) {
  let text = normalizeMultiline(source, 2_400);
  choices.forEach((choice) => {
    const escaped = choice.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`\\b${escaped}\\b`, 'i'), ' ');
  });
  return normalizeMultiline(text, 2_400);
}

function pickQuestionFromText(value: string, choices: ExtractedChoice[] = []) {
  const lines = splitCleanLines(removeChoiceText(value, choices)).filter((line) => !parseChoicePrefix(line) && !looksLikeNoiseText(line));
  const direct = lines.find((line) => line.includes('?') && line.length >= 8) ?? lines.find((line) => QUESTION_WORD_PATTERN.test(line));

  if (direct) {
    return cleanQuestionText(direct);
  }

  const beforeChoices = lines.slice(0, 4).join(' ');
  if (QUESTION_WORD_PATTERN.test(beforeChoices) || beforeChoices.length >= 24) {
    return cleanQuestionText(beforeChoices);
  }

  return '';
}

function collectNearbyContext(container: Element, question: string, choices: ExtractedChoice[]) {
  const pieces = [
    container.previousElementSibling,
    container.nextElementSibling,
    container.parentElement?.previousElementSibling,
    container.parentElement?.nextElementSibling
  ]
    .filter((node): node is Element => Boolean(node && isElementVisible(node)))
    .map((node) => getElementText(node, 360))
    .filter(Boolean);
  const choiceKeys = new Set(choices.map((choice) => normalizeKey(choice.text)));
  const seen = new Set<string>([normalizeKey(question), ...choiceKeys]);
  const results: string[] = [];

  for (const piece of pieces) {
    const key = normalizeKey(piece);
    if (!key || seen.has(key) || looksLikeNoiseText(piece)) {
      continue;
    }
    seen.add(key);
    results.push(piece);
  }

  return normalizeText(results.join(' | '), MAX_CONTEXT_CHARS);
}

function getQuestionType(container: Element, choices: ExtractedChoice[]): ScreenQuestionType {
  if (container.querySelector('input[type="checkbox"]')) {
    return 'multi_select';
  }

  if (container.querySelector('input[type="radio"]') || choices.length >= 2) {
    return 'multiple_choice';
  }

  if (container.querySelector('textarea, input[type="text"], input:not([type]), [contenteditable="true"]')) {
    return 'short_answer';
  }

  return choices.length ? 'multiple_choice' : 'short_answer';
}

function getDomHints(container: Element): ScreenQuestionDomHints {
  return {
    selector: buildSelectorHint(container),
    hasRadioInputs: Boolean(container.querySelector('input[type="radio"]')),
    hasCheckboxInputs: Boolean(container.querySelector('input[type="checkbox"]'))
  };
}

function collectContainerCandidates(selector: string) {
  const seen = new Set<Element>();
  const results: Element[] = [];
  let inspected = 0;

  for (const element of Array.from(document.querySelectorAll(selector))) {
    inspected += 1;
    if (inspected > MAX_CONTAINER_CANDIDATES) {
      break;
    }

    if (seen.has(element) || !isElementVisible(element)) {
      continue;
    }

    const text = getElementText(element, 1_600);
    const hasInputs = Boolean(element.querySelector('input[type="radio"], input[type="checkbox"]'));
    const hasChoices = collectChoicesFromContainer(element).length >= 2;
    if (!hasInputs && !hasChoices && !QUESTION_LIKE_PATTERN.test(text)) {
      continue;
    }

    seen.add(element);
    results.push(element);
  }

  return {
    results,
    inspected
  };
}

function buildCandidateFromContainer(container: Element, strategy: string, baseConfidence: number): CandidateInput | null {
  const choices = collectChoicesFromContainer(container);
  const preferredQuestionElement = Array.from(container.querySelectorAll(QUESTION_TEXT_SELECTORS)).find((element) => {
    if (!isElementVisible(element) || choices.some((choice) => choice.element === element || choice.element?.contains(element))) {
      return false;
    }

    const text = getElementText(element, MAX_QUESTION_CHARS);
    return text.length >= 8 && !parseChoicePrefix(text) && !looksLikeNoiseText(text);
  });
  const question =
    pickQuestionFromText(preferredQuestionElement ? getElementMultilineText(preferredQuestionElement, MAX_QUESTION_CHARS) : '', choices) ||
    pickQuestionFromText(getElementMultilineText(container, 2_400), choices);

  if (!question || question.length < 8) {
    return null;
  }

  const confidence = Math.min(
    0.98,
    baseConfidence + (choices.length >= 2 ? 0.08 : 0) + (question.includes('?') ? 0.03 : 0)
  );

  return {
    question,
    choices,
    nearbyContext: collectNearbyContext(container, question, choices),
    questionType: getQuestionType(container, choices),
    domHints: getDomHints(container),
    bbox: getNormalizedBbox(preferredQuestionElement ?? container),
    anchor: getElementAnchor(preferredQuestionElement ?? container),
    confidence,
    extractionStrategy: strategy
  };
}

function collectFormQuestionCandidates(): { candidates: CandidateInput[]; inspected: number } {
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]')).filter((input) => {
    const labelText = getInputLabelText(input);
    return labelText && !looksLikeNoiseText(labelText) && !isSkippableElement(input);
  });
  const groups = new Map<Element, HTMLInputElement[]>();

  inputs.forEach((input) => {
    const container =
      input.closest(CANVAS_QUESTION_CONTAINER_SELECTORS) ??
      input.closest('fieldset, form, section, article') ??
      input.parentElement;
    const key = container ?? input.parentElement ?? input;
    const existing = groups.get(key) ?? [];
    existing.push(input);
    groups.set(key, existing);
  });

  const candidates: CandidateInput[] = [];

  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }

    const container =
      group[0].closest(CANVAS_QUESTION_CONTAINER_SELECTORS) ??
      group[0].closest('fieldset, form, section, article') ??
      group[0].parentElement;
    if (!container || !isElementVisible(container, false)) {
      continue;
    }

    const candidate = buildCandidateFromContainer(container, 'form-dom', 0.82);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  return {
    candidates,
    inspected: inputs.length
  };
}

function collectCanvasQuestionCandidates(): { candidates: CandidateInput[]; inspected: number } {
  const { results, inspected } = collectContainerCandidates(CANVAS_QUESTION_CONTAINER_SELECTORS);
  return {
    candidates: results.map((container) => buildCandidateFromContainer(container, 'canvas-dom', 0.86)).filter(Boolean) as CandidateInput[],
    inspected
  };
}

function parseQuestionChoiceBlocksFromText(text: string): CandidateInput[] {
  const lines = splitCleanLines(text);
  const candidates: CandidateInput[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseChoicePrefix(lines[index]);
    if (!parsed) {
      continue;
    }

    const choiceLines: string[] = [lines[index]];
    let cursor = index + 1;
    while (cursor < lines.length && choiceLines.length < MAX_CHOICES) {
      if (!parseChoicePrefix(lines[cursor])) {
        break;
      }
      choiceLines.push(lines[cursor]);
      cursor += 1;
    }

    const choices = dedupeChoices(choiceLines.map((line) => parseChoicePrefix(line)).filter(Boolean) as ExtractedChoice[]);
    if (choices.length < 2) {
      continue;
    }

    const questionWindow = lines.slice(Math.max(0, index - 5), index).join('\n');
    const question = pickQuestionFromText(questionWindow, choices);
    if (!question) {
      continue;
    }

    candidates.push({
      question,
      choices,
      nearbyContext: normalizeText(lines.slice(cursor, cursor + 3).join(' '), MAX_CONTEXT_CHARS),
      questionType: 'multiple_choice',
      domHints: {
        selector: 'visible-text',
        hasRadioInputs: false,
        hasCheckboxInputs: false
      },
      confidence: question.includes('?') ? 0.74 : 0.66,
      extractionStrategy: 'generic-dom'
    });
    index = cursor - 1;

    if (candidates.length >= MAX_QUESTIONS) {
      break;
    }
  }

  return candidates;
}

function collectVisibleTextBundle(): VisibleTextBundle {
  const blocks: string[] = [];
  const headings: string[] = [];
  const labels: string[] = [];
  const seen = new Set<string>();
  let inspectedNodeCount = 0;

  for (const element of Array.from(document.querySelectorAll(TEXT_BLOCK_SELECTORS))) {
    inspectedNodeCount += 1;
    if (inspectedNodeCount > MAX_ELEMENTS_TO_INSPECT || blocks.length >= MAX_TEXT_BLOCKS) {
      break;
    }

    if (!isElementVisible(element)) {
      continue;
    }

    const text = getElementMultilineText(element, 900);
    const normalized = normalizeText(text, 900);
    const key = normalizeKey(normalized);
    if (!normalized || seen.has(key) || looksLikeNoiseText(normalized)) {
      continue;
    }

    seen.add(key);
    blocks.push(text);

    if ((/^H[1-4]$/i.test(element.tagName) || element.getAttribute('role') === 'heading') && headings.length < MAX_HEADINGS) {
      headings.push(normalized);
    }

    if ((element.tagName === 'LABEL' || element.tagName === 'LEGEND' || element.hasAttribute('aria-label')) && labels.length < MAX_LABELS) {
      labels.push(normalized);
    }
  }

  const bundle = {
    text: normalizeMultiline(blocks.join('\n'), MAX_VISIBLE_TEXT),
    headings,
    labels,
    inspectedNodeCount
  };
  lastVisibleTextBundle = bundle;
  return bundle;
}

function collectSignaturePieces() {
  const questionPieces: string[] = [];
  const choicePieces: string[] = [];
  const seen = new Set<string>();
  let inspected = 0;

  for (const element of Array.from(document.querySelectorAll(SIGNATURE_TEXT_SELECTORS))) {
    inspected += 1;
    if (inspected > 220 || questionPieces.length + choicePieces.length >= 90) {
      break;
    }

    if (!isElementVisible(element)) {
      continue;
    }

    const text = normalizeText(getElementText(element, 480), 480);
    const key = normalizeKey(text);
    if (!key || seen.has(key) || looksLikeNoiseText(text)) {
      continue;
    }

    seen.add(key);
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute('role')?.toLowerCase() ?? '';
    const className = typeof element.className === 'string' ? element.className.toLowerCase() : '';
    const isChoiceLike =
      tag === 'label' ||
      role === 'radio' ||
      role === 'checkbox' ||
      role === 'option' ||
      /\b(answer|choice|option)\b/.test(className) ||
      Boolean(parseChoicePrefix(text));

    if (isChoiceLike && choicePieces.length < 42) {
      choicePieces.push(text);
    } else if (questionPieces.length < 48) {
      questionPieces.push(text);
    }
  }

  const activeQuestionText = Array.from(document.querySelectorAll(CANVAS_QUESTION_CONTAINER_SELECTORS))
    .filter((element) => isElementVisible(element))
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const viewportCenter = window.innerHeight / 2;
      return {
        text: normalizeText(getElementText(element, 700), 700),
        distance: Math.abs(rect.top + rect.height / 2 - viewportCenter)
      };
    })
    .filter((entry) => entry.text && !looksLikeNoiseText(entry.text))
    .sort((a, b) => a.distance - b.distance)[0]?.text;

  return {
    questionText: questionPieces.join('\n'),
    choiceText: choicePieces.join('\n'),
    activeQuestionText: activeQuestionText ?? ''
  };
}

export function buildScreenPageSignature() {
  const pieces = collectSignaturePieces();
  const selectedText = normalizeText(window.getSelection()?.toString(), 900);

  return [
    `url:${window.location.href}`,
    `title:${normalizeText(document.title, 240)}`,
    `q:${hashText(pieces.questionText)}`,
    `c:${hashText(pieces.choiceText)}`,
    `a:${hashText(pieces.activeQuestionText)}`,
    selectedText ? `s:${hashText(selectedText)}` : 's:0'
  ].join('|');
}

export function clearScreenExtractionCache() {
  lastVisibleTextBundle = null;
}

function toQuestionCandidate(question: ScreenStructuredQuestion): ScreenTextContext['questionCandidates'][number] {
  return {
    id: question.id,
    question: question.question,
    answerChoices: question.choices.map((choice) => `${choice.key}. ${choice.text}`),
    nearbyText: question.nearbyContext ? [question.nearbyContext] : [],
    bbox: question.bbox,
    anchor: question.anchor,
    questionType: question.questionType,
    confidence: question.confidence,
    extractionStrategy: question.extractionStrategy
  };
}

function hasMeaningfulFallback(text: string) {
  if (text.length < 80) {
    return false;
  }

  const words = text.match(/[a-z][a-z'-]*/gi) ?? [];
  return words.length >= 12 && !CANVAS_NAV_PATTERN.test(normalizeText(text, 120));
}

function extractionSource() {
  let url: URL | null = null;
  try {
    url = new URL(window.location.href);
  } catch {
    url = null;
  }

  return {
    url: window.location.href,
    title: normalizeText(document.title, 240) || 'Current page',
    host: url?.host ?? window.location.hostname,
    pathname: url?.pathname ?? window.location.pathname
  };
}

function buildQuestionContext(
  structuredExtraction: ScreenStructuredExtraction,
  visibleTextHash: string
): ScreenQuestionContext {
  return {
    pageUrl: window.location.href,
    pageTitle: normalizeText(document.title, 240) || 'Current page',
    visibleTextHash,
    extractionMode: 'dom',
    questions: structuredExtraction.questions.map((question) => ({
      id: question.id,
      questionText: normalizeText(question.question, MAX_QUESTION_CHARS),
      choices: question.choices.map((choice) => ({
        key: normalizeText(choice.key, 8),
        text: normalizeText(choice.text, MAX_CHOICE_CHARS)
      })),
      nearbyText: normalizeText(question.nearbyContext, 420),
      elementHints: {
        selector: normalizeText(question.domHints.selector, 160),
        hasRadioInputs: question.domHints.hasRadioInputs,
        hasCheckboxInputs: question.domHints.hasCheckboxInputs,
        bbox: question.bbox
      }
    }))
  };
}

export function extractPageQuestionsFast(): ScreenStructuredExtraction {
  const startedAt = nowMs();
  const visibleBundle = collectVisibleTextBundle();
  const selectedText = normalizeMultiline(window.getSelection()?.toString(), 2_000);
  const warnings: string[] = [];
  const seenQuestions = new Set<string>();
  const questions: ScreenStructuredQuestion[] = [];
  let inspectedNodeCount = visibleBundle.inspectedNodeCount;

  const addCandidate = (candidate: CandidateInput | null) => {
    if (!candidate || questions.length >= MAX_QUESTIONS) {
      return;
    }

    const question = cleanQuestionText(candidate.question);
    if (!question || question.length < 8 || looksLikeNoiseText(question)) {
      return;
    }

    const key = normalizeKey(question.slice(0, 240));
    if (seenQuestions.has(key)) {
      return;
    }

    const choices = dedupeChoices(candidate.choices).slice(0, MAX_CHOICES);
    const confidence = Math.min(Math.max(candidate.confidence - (choices.length < 2 ? 0.12 : 0), 0), 1);
    seenQuestions.add(key);
    questions.push({
      id: `q_${questions.length + 1}`,
      question,
      choices,
      nearbyContext: normalizeText(candidate.nearbyContext, MAX_CONTEXT_CHARS),
      questionType: choices.length >= 2 ? candidate.questionType : candidate.questionType === 'multi_select' ? 'multi_select' : 'short_answer',
      domHints: candidate.domHints,
      bbox: candidate.bbox,
      anchor: candidate.anchor,
      confidence,
      extractionStrategy: candidate.extractionStrategy
    });
  };

  const canvas = collectCanvasQuestionCandidates();
  inspectedNodeCount += canvas.inspected;
  canvas.candidates.forEach(addCandidate);

  if (questions.length < MAX_QUESTIONS) {
    const form = collectFormQuestionCandidates();
    inspectedNodeCount += form.inspected;
    form.candidates.forEach(addCandidate);
  }

  if (questions.length < MAX_QUESTIONS) {
    parseQuestionChoiceBlocksFromText(visibleBundle.text).forEach(addCandidate);
  }

  if (selectedText && questions.length < MAX_QUESTIONS) {
    const selectedChoices = extractChoicesFromTextBlock(selectedText);
    const selectedQuestion = pickQuestionFromText(selectedText, selectedChoices) || cleanQuestionText(selectedText);
    if (selectedQuestion.length >= 8) {
      addCandidate({
        question: selectedQuestion,
        choices: selectedChoices,
        nearbyContext: '',
        questionType: selectedChoices.length >= 2 ? 'multiple_choice' : 'short_answer',
        domHints: {
          selector: 'selection',
          hasRadioInputs: false,
          hasCheckboxInputs: false
        },
        anchor: getSelectionAnchor(),
        confidence: selectedChoices.length >= 2 ? 0.76 : 0.64,
        extractionStrategy: 'selection'
      });
    }
  }

  if (!questions.length && !hasMeaningfulFallback(visibleBundle.text)) {
    warnings.push('no_meaningful_visible_text');
  }

  if (visibleBundle.text.length >= MAX_VISIBLE_TEXT - 3) {
    warnings.push('content_truncated');
  }

  const confidence = questions.length
    ? Math.max(...questions.map((question) => question.confidence))
    : hasMeaningfulFallback(visibleBundle.text)
      ? 0.28
      : 0.08;
  const strategy =
    questions[0]?.extractionStrategy ??
    (selectedText ? 'selection' : hasMeaningfulFallback(visibleBundle.text) ? 'visible-text-fallback' : 'generic-dom');
  const extractionMs = Math.round(nowMs() - startedAt);
  const payload: ScreenStructuredExtraction = {
    source: extractionSource(),
    mode: 'answer_questions',
    extraction: {
      strategy,
      confidence,
      warnings,
      extractionMs,
      inspectedNodeCount
    },
    questions,
    visibleTextFallback: questions.length ? undefined : visibleBundle.text
  };
  const payloadChars = JSON.stringify(payload).length;

  logPerf({
    stage: 'content-extraction',
    extractionMs,
    inspectedNodeCount,
    extractedQuestionCount: questions.length,
    payloadChars,
    confidence,
    strategy
  });

  return payload;
}

export function extractScreenTextContext(): ScreenTextContext {
  const structuredExtraction = extractPageQuestionsFast();
  const visibleBundle = lastVisibleTextBundle ?? collectVisibleTextBundle();
  const formattedQuestions = structuredExtraction.questions
    .map((question) =>
      [
        `Question: ${question.question}`,
        question.choices.length ? `Answer choices: ${question.choices.map((choice) => `${choice.key}. ${choice.text}`).join(' | ')}` : '',
        question.nearbyContext ? `Nearby context: ${question.nearbyContext}` : ''
      ]
        .filter(Boolean)
        .join('\n')
    )
    .join('\n\n');
  const selectedText = normalizeText(window.getSelection()?.toString(), 1_200);
  const visibleText = normalizeMultiline(
    [formattedQuestions, selectedText ? `Selected text: ${selectedText}` : '', visibleBundle.text].filter(Boolean).join('\n\n'),
    MAX_VISIBLE_TEXT
  );
  const visibleTextHash = hashText(visibleText);
  const questionContext = buildQuestionContext(structuredExtraction, visibleTextHash);

  return {
    pageTitle: normalizeText(document.title, 240) || 'Current page',
    pageUrl: window.location.href,
    selectedText: selectedText || undefined,
    visibleText,
    headings: visibleBundle.headings,
    labels: visibleBundle.labels,
    questionCandidates: structuredExtraction.questions.map(toQuestionCandidate),
    structuredExtraction,
    questionContext,
    visibleTextHash,
    extractionMode: 'dom',
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      scrollX: window.scrollX,
      scrollY: window.scrollY
    },
    capturedAt: new Date().toISOString(),
    pageSignature: buildScreenPageSignature()
  };
}
