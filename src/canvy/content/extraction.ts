import type { AnalysisQuestionCandidate, PageSurfaceType } from '../shared/types';

const CONTENT_ROOT_SELECTORS = [
  'article',
  'main',
  '[role="main"]',
  '.article-body',
  '.article-content',
  '.entry-content',
  '.post-content',
  '.markdown-body',
  '.content-body',
  '.main-content',
  '#content',
  '.user_content'
].join(', ');

const DOCS_CONTENT_SELECTORS = [
  '.kix-page-content-wrapper',
  '.kix-page-paginated',
  '.kix-appview-editor-container',
  '.docs-texteventtarget-iframe'
].join(', ');

const UI_PRUNE_SELECTORS = [
  'script',
  'style',
  'noscript',
  'svg',
  'canvas',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'dialog',
  'button',
  'input',
  'select',
  'textarea',
  '[role="navigation"]',
  '[role="toolbar"]',
  '[role="menubar"]',
  '[role="menu"]',
  '[role="dialog"]',
  '[role="complementary"]',
  '[aria-label*="menu" i]',
  '[aria-label*="toolbar" i]',
  '[aria-label*="navigation" i]',
  '[data-testid*="toolbar"]',
  '[data-testid*="menu"]',
  '.toolbar',
  '.menu',
  '.menubar',
  '.sidebar',
  '.side-bar',
  '.app-shell'
].join(', ');

const DOCS_PRUNE_SELECTORS = [
  '.docs-titlebar-badges',
  '.docs-titlebar-buttons',
  '.docs-titlebar-share-client-button',
  '.docs-menubar',
  '.docs-material',
  '.docs-explore-widget',
  '.docs-companion-app-switcher-container',
  '.companion-app-switcher-container',
  '.workspace-title-bar',
  '.kix-appview-editor-breadcrumb',
  '.kix-appview-editor-container > div[role="toolbar"]',
  '.kix-statusindicator-container',
  '.kix-page-column-header',
  '.kix-horizontal-ruler',
  '.kix-vertical-ruler',
  '.kix-cursor-caret',
  '.kix-canvas-tile-content',
  '.docs-gm',
  '.goog-toolbar',
  '.goog-menu',
  '.goog-control',
  '.goog-inline-block'
].join(', ');

const UI_SHORT_TERMS = new Set([
  'account',
  'apps',
  'comment',
  'comments',
  'download',
  'edit',
  'extensions',
  'file',
  'format',
  'help',
  'history',
  'insert',
  'language',
  'menu',
  'open',
  'print',
  'profile',
  'redo',
  'reply',
  'search',
  'settings',
  'share',
  'sign',
  'skip',
  'tools',
  'toolbar',
  'undo',
  'view',
  'zoom'
]);

const NOISE_PHRASES = [
  'skip to content',
  'open menu',
  'main menu',
  'keyboard shortcuts',
  'screen reader',
  'google docs',
  'google drive',
  'last edit was',
  'show spelling suggestions',
  'accessibility',
  'toggle navigation',
  'sign in',
  'language'
];

const QUESTION_PROMPT_PATTERN =
  /^(?:\d+[\.\)]\s+|[A-Z][\.\)]\s+)?(?:what|why|how|when|where|which|who|explain|describe|solve|complete|identify|compare|list|define|discuss|calculate|find|determine|write|choose|select|state|summarize|analyze)\b/i;
const QUESTION_SIGNAL_PATTERN = /\?$|^(?:\d+[\.\)]\s+|[A-Z][\.\)]\s+)/;
const QUESTION_CONTEXT_PATTERN = /\b(question|prompt|task|worksheet|assignment|response|answer|discussion)\b/i;
const QUESTION_ANCHOR_ATTRIBUTE = 'data-mako-question-anchor';

function normalizeWhitespace(value: string | null | undefined) {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeForDedup(value: string) {
  return normalizeWhitespace(value).toLowerCase();
}

function buildSelectorHint(element: Element) {
  const classes = Array.from(element.classList).slice(0, 3).join('.');
  const id = element.id ? `#${element.id}` : '';
  const tag = element.tagName.toLowerCase();
  return `${tag}${id}${classes ? `.${classes}` : ''}`.slice(0, 160);
}

function isVisibleElement(element: Element) {
  const htmlElement = element as HTMLElement;
  if (htmlElement.hidden || htmlElement.getAttribute('aria-hidden') === 'true') {
    return false;
  }

  const rect = htmlElement.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function labelQuestionAnchor(element: Element) {
  const existing = element.getAttribute(QUESTION_ANCHOR_ATTRIBUTE);
  if (existing) {
    return existing;
  }

  const next = `mako-question-${crypto.randomUUID().slice(0, 8)}`;
  element.setAttribute(QUESTION_ANCHOR_ATTRIBUTE, next);
  return next;
}

function firstSentence(value: string) {
  return normalizeWhitespace(value.split(/(?<=[.!?])\s+/)[0] ?? value);
}

function trimForQuestion(value: string, maxLength = 260) {
  const clean = normalizeWhitespace(value);
  if (!clean) {
    return '';
  }

  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1).trimEnd()}...` : clean;
}

function pickQuestionText(value: string) {
  const lines = value
    .split(/\n+/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);
  const directLine =
    lines.find((line) => QUESTION_SIGNAL_PATTERN.test(line) || QUESTION_PROMPT_PATTERN.test(line)) ??
    lines.find((line) => line.length >= 16);

  return trimForQuestion(firstSentence(directLine ?? value));
}

function findNearbyHeading(element: Element, root: Element | HTMLElement) {
  const sectionHeading =
    element.closest('section, article, form, fieldset, table, main')?.querySelector('h1, h2, h3, h4, legend') ??
    undefined;
  const previousHeading = (() => {
    let current: Element | null = element.previousElementSibling;
    while (current) {
      if (current.matches('h1, h2, h3, h4, legend')) {
        return current;
      }
      current = current.previousElementSibling;
    }
    return null;
  })();
  const rootHeading = root.querySelector('h1, h2, h3');

  return trimForQuestion(
    normalizeWhitespace(sectionHeading?.textContent) ||
      normalizeWhitespace(previousHeading?.textContent) ||
      normalizeWhitespace(rootHeading?.textContent),
    120
  );
}

function collectNearbyText(element: Element, questionText: string) {
  const candidates = [
    normalizeWhitespace(element.previousElementSibling?.textContent),
    normalizeWhitespace(element.nextElementSibling?.textContent),
    normalizeWhitespace(element.parentElement?.previousElementSibling?.textContent),
    normalizeWhitespace(element.parentElement?.nextElementSibling?.textContent)
  ];

  return uniqueCleanText(
    candidates.filter((value) => value && normalizeForDedup(value) !== normalizeForDedup(questionText)),
    4
  ).map((value) => trimForQuestion(value, 200));
}

function collectAnswerChoices(element: Element, questionText: string) {
  const container =
    element.closest('.quiz_question, .question, fieldset, form, article, section, table') ?? element.parentElement;

  if (!container) {
    return [];
  }

  const choices = uniqueCleanText(
    Array.from(container.querySelectorAll('li, label, .answer, .choice, [role="option"], [role="radio"]'))
      .map((node) => normalizeWhitespace(node.textContent))
      .filter(
        (text) =>
          text &&
          text.length >= 1 &&
          text.length <= 140 &&
          normalizeForDedup(text) !== normalizeForDedup(questionText) &&
          !looksLikeUiLabel(text)
      ),
    6
  );

  return choices.length >= 2 ? choices : [];
}

function scoreQuestionCandidate(questionText: string, sectionLabel: string, answerChoices: string[], nearbyText: string[]) {
  let score = 0;

  if (/\?$/.test(questionText)) {
    score += 4;
  }

  if (QUESTION_PROMPT_PATTERN.test(questionText)) {
    score += 3;
  }

  if (QUESTION_SIGNAL_PATTERN.test(questionText)) {
    score += 2;
  }

  if (answerChoices.length) {
    score += 1;
  }

  if (sectionLabel && QUESTION_CONTEXT_PATTERN.test(sectionLabel)) {
    score += 1;
  }

  if (nearbyText.some((value) => QUESTION_CONTEXT_PATTERN.test(value))) {
    score += 1;
  }

  if (questionText.length >= 18 && questionText.length <= 260) {
    score += 1;
  }

  if (questionText.length > 340) {
    score -= 3;
  }

  return score;
}

function collectQuestionElements(root: Element | HTMLElement, pageType: PageSurfaceType) {
  const strongSelectors = [
    '.question_text',
    '.quiz_question',
    '.ic-QuizQuestion',
    '.assignment-description',
    '.discussion-topic',
    '.discussion_topic',
    '[data-testid*="question"]',
    '[aria-label*="question" i]',
    '[role="radiogroup"]'
  ];
  const baseSelectors =
    pageType === 'docs'
      ? ['.kix-page-content-wrapper .kix-paragraphrenderer', '.kix-page-content-wrapper .kix-lineview']
      : ['h1', 'h2', 'h3', 'h4', 'p', 'li', 'label', 'legend', 'blockquote', 'td'];

  const allSelectors = [...strongSelectors, ...baseSelectors].join(', ');

  return Array.from(root.querySelectorAll(allSelectors)).filter((element, index, array) => {
    if (array.indexOf(element) !== index) {
      return false;
    }

    if (!isVisibleElement(element)) {
      return false;
    }

    return !element.closest(UI_PRUNE_SELECTORS);
  });
}

export function uniqueCleanText(items: string[], limit: number) {
  const seen = new Set<string>();
  const results: string[] = [];

  for (const item of items) {
    const cleanItem = normalizeWhitespace(item);
    const dedupeKey = normalizeForDedup(cleanItem);

    if (!cleanItem || seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    results.push(cleanItem);

    if (results.length >= limit) {
      break;
    }
  }

  return results;
}

function looksLikeKeyboardShortcut(text: string) {
  return /(ctrl|cmd|alt|shift)\s*[+\-]/i.test(text);
}

function looksLikeUiLabel(text: string) {
  const cleanText = normalizeWhitespace(text);
  if (!cleanText) {
    return true;
  }

  const lower = cleanText.toLowerCase();

  if (NOISE_PHRASES.some((phrase) => lower.includes(phrase))) {
    return true;
  }

  const words = lower.match(/[a-z][a-z'-]*/g) ?? [];
  const shortTokenLine = words.length > 0 && words.length <= 4 && words.every((word) => UI_SHORT_TERMS.has(word));

  if (shortTokenLine) {
    return true;
  }

  if (looksLikeKeyboardShortcut(cleanText) && cleanText.length < 40) {
    return true;
  }

  if (/^[\d\s%/.:-]+$/.test(cleanText) && cleanText.length < 18) {
    return true;
  }

  if (cleanText.length < 20 && /^(share|edit|view|file|help|tools|insert|format|comment|reply|download|print)$/i.test(cleanText)) {
    return true;
  }

  return false;
}

function isMeaningfulTextBlock(text: string, minimumLength: number) {
  const cleanText = normalizeWhitespace(text);

  if (!cleanText || cleanText.length < minimumLength) {
    return false;
  }

  if (looksLikeUiLabel(cleanText)) {
    return false;
  }

  const words = cleanText.match(/[a-z][a-z'-]*/gi) ?? [];
  if (!words.length) {
    return false;
  }

  const averageWordLength = words.reduce((total, word) => total + word.length, 0) / words.length;
  if (averageWordLength < 3 && cleanText.length < 80) {
    return false;
  }

  const repeatedWordRatio = new Set(words.map((word) => word.toLowerCase())).size / words.length;
  if (repeatedWordRatio < 0.35 && cleanText.length < 120) {
    return false;
  }

  return true;
}

function isMeaningfulHeading(text: string) {
  const cleanText = normalizeWhitespace(text);
  if (!cleanText || cleanText.length < 4 || cleanText.length > 120) {
    return false;
  }

  if (looksLikeUiLabel(cleanText)) {
    return false;
  }

  return !/^(back|next|previous|reply|comment|share|search|help)$/i.test(cleanText);
}

function scoreRootCandidate(element: Element, pageType: PageSurfaceType) {
  const textContent = normalizeWhitespace(element.textContent);
  const paragraphs = element.querySelectorAll('p, li, blockquote, pre').length;
  const headings = element.querySelectorAll('h1, h2, h3').length;
  const uiDescendants = element.querySelectorAll('button, input, select, textarea, nav, header, footer, [role="button"], [role="menuitem"]').length;
  const textScore = Math.min(textContent.length, 8000) / 55;
  const bonus =
    element.matches(pageType === 'docs' ? DOCS_CONTENT_SELECTORS : CONTENT_ROOT_SELECTORS) ? 80 : 0;

  return textScore + paragraphs * 16 + headings * 10 - uiDescendants * 8 + bonus;
}

function pickReadableRoot(pageType: PageSurfaceType) {
  const selectors = pageType === 'docs' ? `${DOCS_CONTENT_SELECTORS}, ${CONTENT_ROOT_SELECTORS}` : CONTENT_ROOT_SELECTORS;
  const candidates = Array.from(document.querySelectorAll(selectors));

  if (!candidates.length) {
    return document.body ?? document.documentElement;
  }

  return candidates.sort((left, right) => scoreRootCandidate(right, pageType) - scoreRootCandidate(left, pageType))[0];
}

function pruneRoot(root: Element | HTMLElement, pageType: PageSurfaceType) {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(UI_PRUNE_SELECTORS).forEach((node) => node.remove());

  if (pageType === 'docs') {
    clone.querySelectorAll(DOCS_PRUNE_SELECTORS).forEach((node) => node.remove());
  }

  return clone;
}

function collectHeadings(root: ParentNode, limit: number) {
  return uniqueCleanText(
    Array.from(root.querySelectorAll('h1, h2, h3'))
      .map((node) => node.textContent ?? '')
      .filter((text) => isMeaningfulHeading(text)),
    limit
  );
}

function collectTextBlocks(root: ParentNode, selectors: string[], limit: number, minimumLength: number) {
  return uniqueCleanText(
    selectors.flatMap((selector) =>
      Array.from(root.querySelectorAll(selector))
        .map((node) => node.textContent ?? '')
        .filter((text) => isMeaningfulTextBlock(text, minimumLength))
    ),
    limit
  );
}

function collectFallbackLines(root: ParentNode, limit: number) {
  const rootText = normalizeWhitespace((root as HTMLElement).innerText || root.textContent || '');
  return uniqueCleanText(
    rootText
      .split(/\n+/)
      .map((line) => normalizeWhitespace(line))
      .filter((line) => isMeaningfulTextBlock(line, 28)),
    limit
  );
}

function extractDocsParagraphs() {
  const selectorGroups = [
    ['.kix-page-content-wrapper .kix-paragraphrenderer', '.kix-page-content-wrapper .kix-lineview'],
    ['.kix-page-paginated .kix-paragraphrenderer', '.kix-page-paginated .kix-lineview'],
    ['.kix-appview-editor-container .kix-paragraphrenderer', '.kix-appview-editor-container .kix-lineview']
  ];

  for (const selectors of selectorGroups) {
    const paragraphs = uniqueCleanText(
      selectors.flatMap((selector) =>
        Array.from(document.querySelectorAll(selector))
          .map((node) => node.textContent ?? '')
          .filter((text) => isMeaningfulTextBlock(text, 12))
      ),
      180
    );

    if (paragraphs.length >= 6 || paragraphs.join(' ').length > 420) {
      return paragraphs;
    }
  }

  return [];
}

function buildPreviewText(headings: string[], blocks: string[], limit: number) {
  return uniqueCleanText([...headings, ...blocks], 40).join('\n\n').slice(0, limit);
}

export interface ExtractedReadableContent {
  headings: string[];
  blocks: string[];
  readableText: string;
  previewText: string;
  notes: string[];
}

export function cleanExtractedText(value: string | null | undefined) {
  return normalizeWhitespace(value);
}

export function extractReadableContent(pageType: PageSurfaceType): ExtractedReadableContent {
  if (pageType === 'docs') {
    const docsBlocks = extractDocsParagraphs();
    const docsTitle = normalizeWhitespace(
      document.querySelector('.docs-title-input-label-inner, #docs-title-input-label-inner')?.textContent ?? ''
    );

    if (docsBlocks.length) {
      const headings = uniqueCleanText([docsTitle, ...docsBlocks.filter((text) => isMeaningfulHeading(text)).slice(0, 5)], 8);
      return {
        headings,
        blocks: docsBlocks,
        readableText: docsBlocks.join('\n\n').slice(0, 12000),
        previewText: buildPreviewText(headings, docsBlocks, 1600),
        notes: ['Prioritized Google Docs page content and filtered editor chrome.']
      };
    }
  }

  const root = pickReadableRoot(pageType);
  const readableRoot = pruneRoot(root as Element, pageType);
  const headings = collectHeadings(readableRoot, 8);
  const blocks = collectTextBlocks(readableRoot, ['p', 'li', 'blockquote', 'pre', 'figcaption'], 140, 24);
  const fallbackBlocks = blocks.length ? blocks : collectFallbackLines(readableRoot, 120);
  const readableText = uniqueCleanText([...headings, ...fallbackBlocks], 180).join('\n\n').slice(0, 12000);

  return {
    headings,
    blocks: fallbackBlocks,
    readableText,
    previewText: buildPreviewText(headings, fallbackBlocks, 1600),
    notes: ['Prioritized main content containers and reduced likely interface chrome.']
  };
}

export function extractQuestionCandidates(pageType: PageSurfaceType, limit = 10): AnalysisQuestionCandidate[] {
  const root = pickReadableRoot(pageType);
  const candidates = collectQuestionElements(root as Element, pageType);
  const seen = new Set<string>();
  const results: AnalysisQuestionCandidate[] = [];

  for (const element of candidates) {
    const rawText = normalizeWhitespace(element.textContent);
    if (!rawText || rawText.length < 12 || looksLikeUiLabel(rawText)) {
      continue;
    }

    const question = pickQuestionText(rawText);
    if (!question || question.length < 12) {
      continue;
    }

    const sectionLabel = findNearbyHeading(element, root as Element);
    const nearbyText = collectNearbyText(element, question);
    const answerChoices = collectAnswerChoices(element, question);
    const score = scoreQuestionCandidate(question, sectionLabel, answerChoices, nearbyText);
    const dedupeKey = normalizeForDedup(question);

    if (score < 4 || seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    results.push({
      id: `q${results.length + 1}`,
      question,
      sectionLabel: sectionLabel || undefined,
      nearbyText,
      answerChoices,
      sourceAnchor: labelQuestionAnchor(element),
      selectorHint: buildSelectorHint(element)
    });

    if (results.length >= limit) {
      break;
    }
  }

  return results;
}
