import type {
  QuizAnswerChoice,
  QuizAnswerInputType,
  QuizBoundingBox,
  QuizQuestionExtraction,
  QuizQuestionType
} from '../../shared/quizTypes';
import type { ScreenQuestionAnchor, ScreenViewport } from '../../shared/types';
import { buildQuestionHash, normalizeQuizText } from './questionHash';

const MAKO_ROOT_SELECTOR = '#mako-iq-overlay-root, #mako-iq-assistant-root, #canvy-output-overlay-host, #walt-overlay-root';
const MAX_CANDIDATES = 140;
const MAX_CHOICES = 10;
const MAX_QUESTION_TEXT = 1_600;
const MAX_CHOICE_TEXT = 520;

const NOISE_SELECTOR = [
  MAKO_ROOT_SELECTOR,
  'script',
  'style',
  'noscript',
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
  '[class*="sidebar" i]',
  '[class*="navigation" i]',
  '[class*="cookie" i]',
  '[data-testid*="navigation" i]',
  '[data-testid*="toolbar" i]'
].join(', ');

const QUESTION_CONTAINER_SELECTORS = [
  '.display_question',
  '.quiz_question',
  '.question',
  '.ic-QuizQuestion',
  '.assessment_question',
  '.quiz-item',
  '.problem',
  '.prompt',
  '.item',
  '[data-question-id]',
  '[data-testid*="question" i]',
  '[data-testid*="quiz" i]',
  '[class*="question" i]',
  '[class*="quiz" i]',
  '[class*="assessment" i]',
  '[class*="prompt" i]',
  '[class*="problem" i]',
  'fieldset',
  '[role="radiogroup"]',
  '[role="group"]',
  '[role="listbox"]',
  'main',
  '[role="main"]'
].join(', ');

const QUESTION_TEXT_SELECTORS = [
  '.question_text',
  '.question-text',
  '.prompt',
  '.stem',
  '.problem',
  '[data-testid*="question-text" i]',
  '[data-testid*="prompt" i]',
  '[class*="question_text" i]',
  '[class*="question-text" i]',
  '[class*="stem" i]',
  'legend',
  'h1',
  'h2',
  'h3',
  'h4',
  'p'
].join(', ');

const CHOICE_SELECTORS = [
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
  '[data-testid*="option" i]',
  '[data-testid*="card" i]',
  '[data-testid*="tile" i]',
  '[role="option"]',
  '[role="radio"]',
  '[role="checkbox"]',
  '[role="button"]',
  '[tabindex]:not([tabindex="-1"])',
  '[data-answer-id]',
  '[data-answer-index]',
  '[class*="card" i]',
  '[class*="tile" i]',
  'button'
].join(', ');

const CARD_CHOICE_HINT_PATTERN = /\b(answer|choice|option|response|quiz|question|card|tile|selectable|selection)\b/i;
const EXACT_CHOICE_LABEL_PATTERN = /^(?:\(?([A-H])\)?|(\d{1,2}))$/i;

const QUESTION_WORD_PATTERN =
  /\b(?:what|why|how|when|where|which|who|solve|calculate|find|determine|choose|select|identify|explain|describe|compare|define|write|complete|state|analyze|infer|evaluate)\b/i;
const QUESTION_LIKE_PATTERN =
  /\?|^\s*(?:\d+[\.)]\s+)?(?:what|why|how|when|where|which|who|solve|calculate|find|determine|choose|select|identify|explain|describe|compare|define|write|complete|state|analyze|infer|evaluate)\b/i;
const CHOICE_PREFIX_PATTERN =
  /^(?:choice\s*)?(?:\(?([A-H])\)?[\s.\):\-\u2013\u2014]+|([A-H])\s+[-\u2013\u2014]\s+|([A-H])\s{2,}|(\d{1,2})[\.\)]\s+)(.+)$/i;
const IMAGE_CONTEXT_PATTERN = /\b(shown in the image|shown in the graph|shown in the diagram|graph|diagram|figure|table|chart|image below|picture)\b/i;
const INSTRUCTION_TEXT_PATTERN =
  /\b(?:select|choose|pick)\s+(?:one|an|the|all|\d+)\s+(?:answer|option|choice)s?\.?/i;
const MAKO_TEXT_PATTERN = /\b(?:mako iq|scan again|rescan|low confidence|thinking\.{0,3}|answer bubble)\b/i;

interface Candidate {
  element: Element;
  score: number;
  selector: string;
  reasons: string[];
}

function getViewport(): ScreenViewport {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
    scrollX: window.scrollX,
    scrollY: window.scrollY
  };
}

function safeCssEscape(value: string) {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\#.:,[\]>~+*^$|=]/g, '\\$&');
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
  const dataQuestionId = element.getAttribute('data-question-id');
  return `${tag}${id}${classes}${dataQuestionId ? '[data-question-id]' : ''}`.slice(0, 160);
}

function isMakoElement(element: Element) {
  return Boolean(element.matches(MAKO_ROOT_SELECTOR) || element.closest(MAKO_ROOT_SELECTOR));
}

function isVisible(element: Element, requireViewport = true) {
  if (isMakoElement(element) || element.closest(NOISE_SELECTOR)) {
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

function getElementText(element: Element, maxLength = 1_400) {
  const htmlElement = element as HTMLElement;
  return normalizeQuizText(htmlElement.innerText || element.textContent || element.getAttribute('aria-label') || '', maxLength);
}

function getVisibleTextSource(element: Element | null | undefined, maxLength = 1_400) {
  if (!element || !isVisible(element, false)) {
    return '';
  }

  return getElementText(element, maxLength);
}

function getElementTextLines(element: Element, maxLength = 1_400) {
  const htmlElement = element as HTMLElement;
  const raw = htmlElement.innerText || element.textContent || element.getAttribute('aria-label') || '';
  return raw
    .replace(/\u00a0/g, ' ')
    .split(/\n+/)
    .map((line) => normalizeQuizText(line, maxLength))
    .filter(Boolean);
}

function bboxFromElement(element: Element | null): QuizBoundingBox {
  if (!element) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.left * 10) / 10,
    y: Math.round(rect.top * 10) / 10,
    width: Math.round(rect.width * 10) / 10,
    height: Math.round(rect.height * 10) / 10
  };
}

function anchorFromElement(element: Element | null): ScreenQuestionAnchor | undefined {
  if (!element || !isVisible(element, false)) {
    return undefined;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
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
    selector: buildSelectorHint(element)
  };
}

function parseChoicePrefix(value: string) {
  const match = normalizeQuizText(value, MAX_CHOICE_TEXT + 40).match(CHOICE_PREFIX_PATTERN);
  if (!match) {
    return null;
  }

  const rawKey = match[1] ?? match[2] ?? match[3] ?? match[4] ?? '';
  const key = /^\d+$/.test(rawKey) ? String.fromCharCode(64 + Number(rawKey)) : rawKey.toUpperCase();
  const text = normalizeQuizText(match[5], MAX_CHOICE_TEXT);
  return key && text ? { key, text } : null;
}

function stripChoicePrefix(value: string) {
  return parseChoicePrefix(value)?.text ?? normalizeQuizText(value, MAX_CHOICE_TEXT);
}

function normalizeChoiceLabel(value: string | undefined, fallbackIndex: number) {
  const raw = normalizeQuizText(value, 12);
  const match = raw.match(EXACT_CHOICE_LABEL_PATTERN);
  if (!match) {
    return String.fromCharCode(65 + fallbackIndex);
  }

  const label = match[1] ?? match[2] ?? '';
  return /^\d+$/.test(label) ? String.fromCharCode(64 + Number(label)) : label.toUpperCase();
}

function parseExactChoiceLabel(value: string) {
  const match = normalizeQuizText(value, 20).match(EXACT_CHOICE_LABEL_PATTERN);
  if (!match) {
    return '';
  }

  const label = match[1] ?? match[2] ?? '';
  return /^\d+$/.test(label) ? String.fromCharCode(64 + Number(label)) : label.toUpperCase();
}

function removeLeadingChoiceLabel(value: string, label: string) {
  const normalized = normalizeQuizText(value, MAX_CHOICE_TEXT + 40);
  if (!label) {
    return normalized;
  }

  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return normalizeQuizText(
    normalized.replace(new RegExp(`^\\(?${escaped}\\)?(?:[\\s.\\):\\-\\u2013\\u2014]+|$)`, 'i'), ''),
    MAX_CHOICE_TEXT
  );
}

function findVisibleChoiceLabelElement(element: Element) {
  const descendants = Array.from(
    element.querySelectorAll<HTMLElement>(
      [
        '[class*="label" i]',
        '[class*="letter" i]',
        '[class*="key" i]',
        '[class*="badge" i]',
        '[data-testid*="label" i]',
        '[data-testid*="letter" i]',
        '[aria-label]'
      ].join(', ')
    )
  ).slice(0, 18);

  return descendants.find((descendant) => isVisible(descendant, false) && Boolean(parseExactChoiceLabel(getElementText(descendant, 20))));
}

function extractChoiceTextFromElement(element: Element, fallbackIndex: number) {
  const lines = getElementTextLines(element, MAX_CHOICE_TEXT + 80);
  const firstLineLabel = lines.length > 1 ? parseExactChoiceLabel(lines[0] ?? '') : '';
  if (firstLineLabel) {
    return {
      label: firstLineLabel,
      text: normalizeQuizText(lines.slice(1).join(' '), MAX_CHOICE_TEXT)
    };
  }

  const rawText = getElementText(element, MAX_CHOICE_TEXT + 80);
  const parsed = parseChoicePrefix(rawText);
  if (parsed) {
    return {
      label: parsed.key,
      text: parsed.text
    };
  }

  const labelElement = findVisibleChoiceLabelElement(element);
  const label = labelElement ? parseExactChoiceLabel(getElementText(labelElement, 20)) : '';
  if (label && labelElement) {
    const labelText = getElementText(labelElement, 20);
    const textFromLines = lines
      .filter((line, index) => index > 0 || normalizeQuizText(line, 20) !== normalizeQuizText(labelText, 20))
      .join(' ');
    return {
      label,
      text: removeLeadingChoiceLabel(textFromLines || rawText, label)
    };
  }

  return {
    label: normalizeChoiceLabel(undefined, fallbackIndex),
    text: rawText
  };
}

function normalizeKey(value: string) {
  return normalizeQuizText(value).toLowerCase();
}

function looksLikeNoiseText(value: string) {
  const text = normalizeQuizText(value, 240);
  if (!text) {
    return true;
  }

  if (MAKO_TEXT_PATTERN.test(text)) {
    return true;
  }

  if (/^[A-H]$/i.test(text)) {
    return true;
  }

  if (/^(?:next|previous|prev|back|submit|cancel|save|continue|search|menu|share|settings|close|open|edit|view|help)$/i.test(text)) {
    return true;
  }

  if (/^(?:select|choose|pick)\s+(?:one|an|the|\d+)\s+(?:answer|option|choice)s?\.?$/i.test(text)) {
    return true;
  }

  if (/^(?:home|announcements|assignments|discussions|grades|people|pages|files|syllabus|modules|quizzes|account|dashboard|courses)$/i.test(text)) {
    return true;
  }

  if (/^[\d\s%./:-]+$/.test(text) && text.length < 18) {
    return true;
  }

  return false;
}

function getInputType(input: HTMLInputElement): QuizAnswerInputType {
  if (input.type === 'radio') {
    return 'radio';
  }
  if (input.type === 'checkbox') {
    return 'checkbox';
  }
  if (input.type === 'text' || input.type === 'search' || input.type === '' || input.tagName === 'TEXTAREA') {
    return 'text';
  }
  return 'unknown';
}

function getInputLabelText(input: HTMLInputElement | HTMLTextAreaElement) {
  const id = input.id?.trim();
  const explicitLabel = id ? document.querySelector(`label[for="${safeCssEscape(id)}"]`) : null;
  const parentLabel = input.closest('label');
  const labelledBy = input.getAttribute('aria-labelledby')
    ?.split(/\s+/)
    .map((part) => document.getElementById(part))
    .filter((node): node is HTMLElement => Boolean(node))
    .map((node) => getElementText(node, MAX_CHOICE_TEXT))
    .join(' ');
  const row = input.closest('.answer, .choice, .option, li, [class*="answer" i], [class*="choice" i], [role="radio"], [role="checkbox"]');
  const sources = [
    getVisibleTextSource(explicitLabel, MAX_CHOICE_TEXT),
    getVisibleTextSource(parentLabel, MAX_CHOICE_TEXT),
    normalizeQuizText(labelledBy, MAX_CHOICE_TEXT),
    getVisibleTextSource(row, MAX_CHOICE_TEXT),
    normalizeQuizText(input.getAttribute('aria-label') || input.value, MAX_CHOICE_TEXT)
  ].filter(Boolean);
  const fullChoice = sources.find((source) => stripChoicePrefix(source).length > 1 && !looksLikeNoiseText(stripChoicePrefix(source)));

  return fullChoice ?? sources[0] ?? '';
}

function createChoice(options: {
  element: Element | null;
  index: number;
  label?: string;
  text: string;
  inputType: QuizAnswerInputType;
  selected?: boolean;
  disabled?: boolean;
}): QuizAnswerChoice | null {
  const text = stripChoicePrefix(options.text);
  if (!text || looksLikeNoiseText(text) || QUESTION_LIKE_PATTERN.test(text) || MAKO_TEXT_PATTERN.test(text)) {
    return null;
  }

  const parsed = parseChoicePrefix(options.text);
  const label = parsed?.key ?? normalizeChoiceLabel(options.label, options.index);
  return {
    id: `${label}-${options.index}`,
    index: options.index,
    label,
    text,
    inputType: options.inputType,
    selected: Boolean(options.selected),
    disabled: Boolean(options.disabled),
    bbox: bboxFromElement(options.element)
  };
}

function hasNestedVisibleChoices(element: Element) {
  const role = element.getAttribute('role')?.toLowerCase() ?? '';
  const isDirectInteractiveChoice =
    element.tagName === 'LABEL' ||
    element.tagName === 'BUTTON' ||
    role === 'button' ||
    role === 'option' ||
    role === 'radio' ||
    role === 'checkbox' ||
    element.hasAttribute('data-answer-id') ||
    element.hasAttribute('data-answer-index');

  if (isDirectInteractiveChoice) {
    return false;
  }

  const nestedChoices = Array.from(
    element.querySelectorAll(
      [
        'input[type="radio"]',
        'input[type="checkbox"]',
        'label',
        'button',
        '[role="button"]',
        '[role="option"]',
        '[role="radio"]',
        '[role="checkbox"]',
        '[data-answer-id]',
        '[data-answer-index]',
        '[data-testid*="answer" i]',
        '[data-testid*="choice" i]',
        '[class*="answer" i]',
        '[class*="choice" i]',
        '[class*="option" i]'
      ].join(', ')
    )
  ).filter((child) => child !== element && isVisible(child, false));

  return nestedChoices.length >= 2 && getElementText(element, MAX_CHOICE_TEXT + 80).length > 80;
}

function dedupeChoices(choices: QuizAnswerChoice[]) {
  const seen = new Set<string>();
  const results: QuizAnswerChoice[] = [];

  for (const choice of choices) {
    const textKey = normalizeKey(choice.text);
    if (!textKey || seen.has(textKey)) {
      continue;
    }

    seen.add(textKey);
    results.push({
      ...choice,
      index: results.length,
      label: choice.label || String.fromCharCode(65 + results.length)
    });

    if (results.length >= MAX_CHOICES) {
      break;
    }
  }

  return results;
}

function collectChoices(container: Element): QuizAnswerChoice[] {
  const choices: QuizAnswerChoice[] = [];

  Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]')).forEach((input) => {
    const row =
      input.closest(
        'label, .answer, .choice, .option, li, [class*="answer" i], [class*="choice" i], [class*="option" i], [role="radio"], [role="checkbox"], [role="button"], [tabindex]'
      ) ?? input;
    if (!isVisible(input, false) && !isVisible(row, false)) {
      return;
    }

    const choice = createChoice({
      element: row,
      index: choices.length,
      text: getInputLabelText(input),
      inputType: getInputType(input),
      selected: input.checked,
      disabled: input.disabled
    });
    if (choice) {
      choices.push(choice);
    }
  });

  Array.from(container.querySelectorAll<HTMLSelectElement>('select')).forEach((select) => {
    if (!isVisible(select, false)) {
      return;
    }

    Array.from(select.options).forEach((option) => {
      if (!option.value && option.disabled) {
        return;
      }

      const choice = createChoice({
        element: select,
        index: choices.length,
        text: option.text,
        inputType: 'select',
        selected: option.selected,
        disabled: option.disabled || select.disabled
      });
      if (choice) {
        choices.push(choice);
      }
    });
  });

  Array.from(container.querySelectorAll(CHOICE_SELECTORS)).forEach((element) => {
    if (!isVisible(element)) {
      return;
    }

    if (hasNestedVisibleChoices(element)) {
      return;
    }

    const extracted = extractChoiceTextFromElement(element, choices.length);
    const text = extracted.text;
    if (!text || text.length > MAX_CHOICE_TEXT + 28 || MAKO_TEXT_PATTERN.test(text)) {
      return;
    }

    const role = element.getAttribute('role')?.toLowerCase() ?? '';
    const className = typeof element.className === 'string' ? element.className.toLowerCase() : '';
    const attrHints = [
      className,
      element.getAttribute('data-testid') ?? '',
      element.getAttribute('data-answer-id') ?? '',
      element.getAttribute('data-answer-index') ?? '',
      element.getAttribute('aria-label') ?? ''
    ].join(' ');
    const parsed = parseChoicePrefix(getElementText(element, MAX_CHOICE_TEXT + 40));
    const hasCardInteraction =
      role === 'button' ||
      element.hasAttribute('tabindex') ||
      element.hasAttribute('data-answer-id') ||
      element.hasAttribute('data-answer-index');
    const hasLabelAndNestedText = Boolean(extracted.label && extracted.text && extracted.text !== getElementText(element, 20));
    const isChoiceLike =
      Boolean(parsed) ||
      hasLabelAndNestedText ||
      element.tagName === 'LABEL' ||
      element.tagName === 'LI' ||
      element.tagName === 'BUTTON' ||
      role === 'button' ||
      role === 'option' ||
      role === 'radio' ||
      role === 'checkbox' ||
      (hasCardInteraction && CARD_CHOICE_HINT_PATTERN.test(attrHints)) ||
      /\b(answer|choice|option|response|selectable|selection|card|tile)\b/.test(className);

    if (!isChoiceLike) {
      return;
    }

    const choice = createChoice({
      element,
      index: choices.length,
      text,
      label: extracted.label,
      inputType:
        role === 'option'
          ? 'select'
          : element.tagName === 'BUTTON' || role === 'button' || hasCardInteraction
            ? 'button_or_card'
            : 'unknown',
      selected: element.getAttribute('aria-checked') === 'true' || element.getAttribute('aria-selected') === 'true',
      disabled: element.getAttribute('aria-disabled') === 'true' || (element as HTMLButtonElement).disabled
    });
    if (choice) {
      choices.push(choice);
    }
  });

  return dedupeChoices(choices);
}

function splitLines(value: string) {
  return normalizeQuizText(value, 6_000)
    .replace(/\s+((?:\(?[A-H]\)?[\).:\-\u2013\u2014])\s+)/g, '\n$1')
    .split(/\n+/)
    .map((line) => normalizeQuizText(line, 900))
    .filter(Boolean);
}

function removeChoiceTexts(source: string, choices: QuizAnswerChoice[]) {
  let text = source;
  choices.forEach((choice) => {
    const escaped = choice.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`\\b${escaped}\\b`, 'i'), ' ');
  });
  return normalizeQuizText(text, 2_400);
}

function detectInstructionText(container: Element, questionType: QuizQuestionType) {
  const candidates = Array.from(container.querySelectorAll('p, span, div, legend, [class*="instruction" i], [data-testid*="instruction" i]'))
    .filter((element) => isVisible(element))
    .map((element) => getElementText(element, 160))
    .filter(Boolean);

  const explicitInstruction = candidates.find((text) => INSTRUCTION_TEXT_PATTERN.test(text));
  if (explicitInstruction) {
    const match = explicitInstruction.match(INSTRUCTION_TEXT_PATTERN);
    return normalizeQuizText(match?.[0] ?? explicitInstruction, 120).replace(/\s*\.$/, '') + '.';
  }

  if (questionType === 'multi_select') {
    return 'Select all that apply.';
  }

  if (questionType === 'multiple_choice' || questionType === 'dropdown') {
    return 'Select one answer.';
  }

  return '';
}

function pickQuestionText(container: Element, choices: QuizAnswerChoice[]) {
  const choiceKeys = new Set(choices.map((choice) => normalizeKey(choice.text)));
  const preferred = Array.from(container.querySelectorAll(QUESTION_TEXT_SELECTORS)).find((element) => {
    if (!isVisible(element)) {
      return false;
    }

    const text = getElementText(element, MAX_QUESTION_TEXT);
    const key = normalizeKey(text);
    return text.length >= 8 && !choiceKeys.has(key) && !parseChoicePrefix(text) && !looksLikeNoiseText(text);
  });

  const rawText = preferred ? getElementText(preferred, MAX_QUESTION_TEXT) : getElementText(container, 2_600);
  const lines = splitLines(removeChoiceTexts(rawText, choices)).filter((line) => !parseChoicePrefix(line) && !looksLikeNoiseText(line));
  const direct = lines.find((line) => line.includes('?') && line.length >= 8) ?? lines.find((line) => QUESTION_WORD_PATTERN.test(line));
  if (direct) {
    return {
      text: normalizeQuizText(direct, MAX_QUESTION_TEXT),
      element: preferred ?? container
    };
  }

  const firstBlock = lines.slice(0, 4).join(' ');
  if (QUESTION_WORD_PATTERN.test(firstBlock) || firstBlock.length >= 24) {
    return {
      text: normalizeQuizText(firstBlock, MAX_QUESTION_TEXT),
      element: preferred ?? container
    };
  }

  return {
    text: '',
    element: preferred ?? container
  };
}

function detectQuestionType(container: Element, choices: QuizAnswerChoice[]): QuizQuestionType {
  if (container.querySelector('input[type="checkbox"]')) {
    return 'multi_select';
  }

  if (container.querySelector('select')) {
    return 'dropdown';
  }

  if (container.querySelector('input[type="radio"]') || choices.length >= 2) {
    return 'multiple_choice';
  }

  if (container.querySelector('textarea, input[type="text"], input:not([type]), [contenteditable="true"]')) {
    return 'short_answer';
  }

  return 'unknown';
}

function scoreCandidate(element: Element): Candidate | null {
  if (!isVisible(element)) {
    return null;
  }

  const text = getElementText(element, 1_800);
  if (!text || looksLikeNoiseText(text)) {
    return null;
  }

  const reasons: string[] = [];
  let score = 0;
  const selector = buildSelectorHint(element);
  const classAndAttrs = [
    selector,
    element.getAttribute('role') ?? '',
    element.getAttribute('aria-label') ?? '',
    element.getAttribute('data-testid') ?? ''
  ].join(' ');

  if (/\b(question|quiz|assessment|prompt|item|problem)\b/i.test(classAndAttrs)) {
    score += 24;
    reasons.push('question-like-selector');
  }

  const inputCount = element.querySelectorAll('input[type="radio"], input[type="checkbox"], textarea, select').length;
  if (inputCount > 0) {
    score += Math.min(24, inputCount * 7);
    reasons.push('input-structure');
  }

  const roleCount = element.querySelectorAll('[role="radio"], [role="checkbox"], [role="option"], [role="listbox"], [role="radiogroup"]').length;
  if (roleCount > 0) {
    score += Math.min(18, roleCount * 5);
    reasons.push('aria-choice-structure');
  }

  const cardChoiceCount = element.querySelectorAll(
    [
      'button',
      '[role="button"]',
      '[tabindex]:not([tabindex="-1"])',
      '[data-answer-id]',
      '[data-answer-index]',
      '[data-testid*="answer" i]',
      '[data-testid*="choice" i]',
      '[data-testid*="option" i]',
      '[class*="answer" i]',
      '[class*="choice" i]',
      '[class*="option" i]',
      '[class*="card" i]',
      '[class*="tile" i]'
    ].join(', ')
  ).length;
  if (cardChoiceCount >= 2) {
    score += Math.min(24, cardChoiceCount * 5);
    reasons.push('card-choice-structure');
  }

  if (QUESTION_LIKE_PATTERN.test(text)) {
    score += 18;
    reasons.push('question-text');
  }

  const choices = collectChoices(element).length;
  if (choices >= 2 && choices <= 10) {
    score += 26;
    reasons.push('answer-choices');
  } else if (choices > 10) {
    score -= 16;
    reasons.push('too-many-choices');
  }

  if (text.length > 4_000) {
    score -= 24;
    reasons.push('large-container');
  }

  return score >= 16 ? { element, score, selector, reasons } : null;
}

function collectCandidates() {
  const seen = new Set<Element>();
  const candidates: Candidate[] = [];

  for (const element of Array.from(document.querySelectorAll(QUESTION_CONTAINER_SELECTORS))) {
    if (seen.has(element)) {
      continue;
    }
    seen.add(element);
    const candidate = scoreCandidate(element);
    if (candidate) {
      candidates.push(candidate);
    }
    if (candidates.length >= MAX_CANDIDATES) {
      break;
    }
  }

  if (!candidates.length && document.body) {
    const fallback = scoreCandidate(document.body);
    if (fallback) {
      candidates.push({ ...fallback, reasons: [...fallback.reasons, 'body-fallback'] });
    }
  }

  return candidates.sort((left, right) => right.score - left.score);
}

function collectCandidateAttributes(element: Element) {
  return [
    buildSelectorHint(element),
    element.getAttribute('role') ?? '',
    element.getAttribute('aria-label') ?? '',
    element.getAttribute('data-testid') ?? '',
    element.getAttribute('data-question-id') ?? ''
  ].filter(Boolean);
}

function calculateConfidence(options: {
  candidate: Candidate;
  questionText: string;
  choices: QuizAnswerChoice[];
  questionType: QuizQuestionType;
  hasImages: boolean;
  hasCanvas: boolean;
  hasSvg: boolean;
}) {
  const reasons = [...options.candidate.reasons];
  let confidence = Math.min(0.9, options.candidate.score / 100);

  if (options.questionText.length > 20) {
    confidence += 0.12;
    reasons.push('question-length');
  } else {
    confidence -= 0.18;
    reasons.push('short-question');
  }

  if (options.questionType === 'multiple_choice' || options.questionType === 'multi_select') {
    if (options.choices.length >= 2 && options.choices.length <= 8) {
      confidence += 0.18;
      reasons.push('expected-choice-count');
    } else if (!options.choices.length) {
      confidence -= 0.28;
      reasons.push('missing-answer-choices');
    }
  }

  if (options.hasCanvas || (options.hasImages && options.questionText.length < 80) || options.hasSvg) {
    confidence -= 0.12;
    reasons.push('visual-context');
  }

  if (getElementText(options.candidate.element, 8_000).length > 5_500) {
    confidence -= 0.18;
    reasons.push('possibly-whole-page');
  }

  return {
    confidence: Math.min(Math.max(confidence, 0), 1),
    reasons
  };
}

function createEmptyExtraction(reason: string): QuizQuestionExtraction {
  const viewport = getViewport();
  return {
    found: false,
    confidence: 0,
    method: 'dom',
    questionHash: '',
    pageUrl: window.location.href,
    pageTitle: normalizeQuizText(document.title, 240) || 'Current page',
    questionText: '',
    instructions: '',
    answerChoices: [],
    questionType: 'unknown',
    bbox: { x: 0, y: 0, width: 0, height: 0 },
    viewport,
    hasImages: false,
    hasCanvas: false,
    hasSvg: false,
    needsScreenshot: false,
    debug: {
      candidateSelector: '',
      textLength: 0,
      choiceCount: 0,
      reasons: [reason]
    }
  };
}

export function getQuizObserverRoot() {
  const best = collectCandidates()[0]?.element;
  return best ?? document.querySelector('main') ?? document.querySelector('[role="main"]') ?? document.body ?? document.documentElement;
}

export async function extractQuizQuestion(): Promise<QuizQuestionExtraction> {
  const candidates = collectCandidates();
  const candidate = candidates[0];
  if (!candidate) {
    return createEmptyExtraction('no-candidate');
  }

  const choices = collectChoices(candidate.element);
  const question = pickQuestionText(candidate.element, choices);
  if (!question.text || question.text.length < 8) {
    return createEmptyExtraction('no-question-text');
  }

  const questionType = detectQuestionType(candidate.element, choices);
  const instructions = detectInstructionText(candidate.element, questionType);
  const visualElement = question.element ?? candidate.element;
  const visualTextReferences = IMAGE_CONTEXT_PATTERN.test(question.text);
  const hasImages = Boolean(visualElement.querySelector('img, picture, figure')) || (visualTextReferences && Boolean(candidate.element.querySelector('img, picture, figure')));
  const hasCanvas = Boolean(visualElement.querySelector('canvas')) || (visualTextReferences && Boolean(candidate.element.querySelector('canvas')));
  const hasSvg = Boolean(visualElement.querySelector('svg')) || (visualTextReferences && Boolean(candidate.element.querySelector('svg')));
  const confidenceResult = calculateConfidence({
    candidate,
    questionText: question.text,
    choices,
    questionType,
    hasImages,
    hasCanvas,
    hasSvg
  });
  const questionHash = await buildQuestionHash({
    pageUrl: window.location.href,
    pageTitle: document.title,
    questionText: question.text,
    answerChoices: choices,
    inputTypes: choices.map((choice) => choice.inputType),
    candidateAttributes: collectCandidateAttributes(candidate.element),
    hasImages,
    hasCanvas,
    hasSvg
  });
  const needsScreenshot =
    confidenceResult.confidence < 0.65 ||
    hasCanvas ||
    (hasSvg && visualTextReferences && question.text.length < 120) ||
    (hasImages && (question.text.length < 120 || visualTextReferences)) ||
    ((questionType === 'multiple_choice' || questionType === 'multi_select' || /\bchoose|select|which of the following\b/i.test(question.text)) &&
      choices.length === 0);

  return {
    found: true,
    confidence: confidenceResult.confidence,
    method: 'dom',
    questionHash,
    pageUrl: window.location.href,
    pageTitle: normalizeQuizText(document.title, 240) || 'Current page',
    questionText: question.text,
    instructions,
    answerChoices: choices,
    questionType,
    bbox: bboxFromElement(question.element ?? candidate.element),
    anchor: anchorFromElement(question.element ?? candidate.element),
    viewport: getViewport(),
    hasImages,
    hasCanvas,
    hasSvg,
    needsScreenshot,
    debug: {
      candidateSelector: candidate.selector,
      textLength: getElementText(candidate.element, 8_000).length,
      choiceCount: choices.length,
      reasons: confidenceResult.reasons
    }
  };
}
