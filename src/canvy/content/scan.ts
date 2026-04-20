import { buildPageAnalysis } from '../shared/analysis';
import { detectAssistantMode, detectPageType as detectLmsPageType, isCanvasUrl } from '../shared/lms';
import type { PageAssistTarget, PageContextSummary, PageSurfaceType, ScanPagePayload, ScanSourceMode } from '../shared/types';
import { extractCanvasContext } from './canvas';
import { cleanExtractedText, extractReadableContent, uniqueCleanText } from './extraction';

interface BaseScanExtraction {
  title: string;
  url: string;
  hostname: string;
  readableText: string;
  headings: string[];
  sourceType: ScanPagePayload['sourceType'];
  pageType: PageSurfaceType;
  sourceMode: ScanSourceMode;
  urlSignals: string[];
  domSignals: string[];
  extractionNotes: string[];
  errors: string[];
  scannedAt: string;
}

function buildFallbackReadableText(pageType: PageSurfaceType) {
  return pageType === 'canvas'
    ? 'Canvas page detected, but very little readable text was available from the current DOM.'
    : 'Very little readable text was available from the current page.';
}

function finalizeExtraction(extraction: BaseScanExtraction): BaseScanExtraction {
  const readableText = cleanExtractedText(extraction.readableText);
  const errors = [...extraction.errors];
  const extractionNotes = [...extraction.extractionNotes];

  if (!readableText || readableText.length < 120) {
    errors.push('Readable page text was limited, so the scan may need a follow-up refresh or a different page section.');
    extractionNotes.push('Scan captured limited readable text from the current page.');
  }

  return {
    ...extraction,
    readableText: readableText || buildFallbackReadableText(extraction.pageType),
    extractionNotes,
    errors
  };
}

function buildPageContextFromExtraction(extraction: BaseScanExtraction): PageContextSummary {
  const previewText = extraction.readableText.slice(0, 1600) || buildFallbackReadableText(extraction.pageType);
  const priorityText =
    [extraction.headings.join('\n'), extraction.readableText.slice(0, 2400)].filter(Boolean).join('\n\n').slice(0, 2400) || previewText;
  const contentFingerprint = [extraction.title, extraction.url, extraction.headings.join('|'), priorityText]
    .join('\n')
    .split('')
    .reduce((hash, character) => {
      const nextHash = (hash << 5) - hash + character.charCodeAt(0);
      return nextHash | 0;
    }, 0);

  return {
    title: extraction.title,
    url: extraction.url,
    domain: extraction.hostname,
    pageType: extraction.pageType,
    headings: extraction.headings,
    previewText,
    priorityText,
    textLength: extraction.readableText.length,
    contentFingerprint: Math.abs(contentFingerprint).toString(36),
    extractionNotes: extraction.extractionNotes,
    capturedAt: extraction.scannedAt
  };
}

function detectSectionsFromText(headings: string[], readableText: string) {
  const sectionCandidates = readableText
    .split(/\n{2,}/)
    .map((block) => cleanExtractedText(block))
    .filter((block) => block.length > 18)
    .map((block) => block.split(/[.!?]/)[0] ?? block)
    .map((block) => (block.length > 72 ? `${block.slice(0, 69).trimEnd()}...` : block));

  return uniqueCleanText([...headings, ...sectionCandidates], 8);
}

function buildScanPayload(extraction: BaseScanExtraction): ScanPagePayload {
  const finalized = finalizeExtraction(extraction);
  const mode = detectAssistantMode(finalized.url);
  const pageContext = buildPageContextFromExtraction(finalized);
  const canvasContext = mode === 'canvas' ? extractCanvasContext() : null;
  const analysis = buildPageAnalysis(mode, pageContext, canvasContext);
  const detectedSections = detectSectionsFromText(finalized.headings, finalized.readableText);

  return {
    pageTitle: finalized.title,
    title: finalized.title,
    url: finalized.url,
    hostname: finalized.hostname,
    mode,
    readableText: finalized.readableText,
    keyText: pageContext.previewText,
    headings: finalized.headings,
    detectedSections,
    sourceType: finalized.sourceType,
    scanSource: finalized.sourceType === 'tone_sample' ? 'tone_sample_capture' : 'manual_scan',
    pageType: finalized.pageType,
    sourceMode: finalized.sourceMode,
    urlSignals: finalized.urlSignals,
    domSignals: finalized.domSignals,
    summary: analysis.pageSummary,
    keyTopics: analysis.keyTopics,
    importantDetails: analysis.importantDetails,
    suggestedNextActions: analysis.suggestedNextActions,
    canvasEnhancedRelevant: analysis.canvasEnhancedAvailable,
    canvasDetails: canvasContext
      ? {
          courseName: canvasContext.courseName,
          pageKind: canvasContext.pageKind,
          courseId: canvasContext.courseId,
          assignmentId: canvasContext.assignmentId,
          dueAtText: canvasContext.dueAtText
        }
      : undefined,
    extractionNotes: finalized.extractionNotes,
    errors: finalized.errors,
    scannedAt: finalized.scannedAt
  };
}

function getDocsTitle() {
  return (
    cleanExtractedText(document.querySelector('.docs-title-input-label-inner')?.textContent) ||
    cleanExtractedText(document.querySelector('#docs-title-input-label-inner')?.textContent) ||
    cleanExtractedText(document.title.replace(/\s*-\s*Google Docs$/i, ''))
  );
}

function detectUrlSignals(url: string) {
  const signals = new Set<string>();

  if (/\/courses\//i.test(url)) {
    signals.add('course_path');
  }
  if (/\/assignments\//i.test(url)) {
    signals.add('assignment_path');
  }
  if (/\/discussion_topics\//i.test(url)) {
    signals.add('discussion_path');
  }
  if (/\/quizzes\//i.test(url)) {
    signals.add('quiz_path');
  }
  if (/\/modules/i.test(url)) {
    signals.add('module_path');
  }
  if (/\/pages\//i.test(url)) {
    signals.add('page_path');
  }
  if (/\/files\//i.test(url)) {
    signals.add('file_path');
  }

  return Array.from(signals);
}

function detectDomSignals(pageType: PageSurfaceType, readableText: string) {
  const pageText = readableText.toLowerCase();
  const signals = new Set<string>();

  if (document.querySelector('input[type="file"], .file_upload, [data-testid*="upload"]') || /upload|file submission/.test(pageText)) {
    signals.add('file_upload_control');
  }

  if (document.querySelector('textarea, [contenteditable="true"], .ic-RichContentEditor, .tox-editor-container')) {
    signals.add('editor_present');
  }

  if (document.querySelector('.discussion-reply-form, .discussion_entry, [data-testid*="reply"]') || /discussion|reply/.test(pageText)) {
    signals.add('discussion_reply_ui');
  }

  if (
    document.querySelector('.question_text, .quiz_question, [role="radiogroup"], input[type="radio"], input[type="checkbox"]') ||
    /quiz|question \d|answer choice|submit quiz/.test(pageText)
  ) {
    signals.add('quiz_ui');
  }

  if (/due\b/.test(pageText)) {
    signals.add('due_date_text');
  }

  if (/points?\b/.test(pageText)) {
    signals.add('points_text');
  }

  if (document.querySelector('.context_module_items, .module-sequence-footer') || /module|reading|resource|article/.test(pageText)) {
    signals.add('resource_layout');
  }

  if (pageType === 'canvas') {
    signals.add('canvas_shell');
  }

  return Array.from(signals);
}

function scanDocsPage(sourceType: ScanPagePayload['sourceType']): ScanPagePayload {
  const readableContent = extractReadableContent('docs');
  const readableText = readableContent.readableText || readableContent.previewText;
  const headings = readableContent.headings.length ? readableContent.headings : [getDocsTitle()].filter(Boolean);

  return buildScanPayload({
    title: getDocsTitle() || 'Google Doc',
    url: window.location.href,
    hostname: window.location.hostname.replace(/^www\./i, ''),
    readableText,
    headings,
    sourceType,
    pageType: 'docs',
    sourceMode: 'docs_dom',
    urlSignals: detectUrlSignals(window.location.href),
    domSignals: ['document_editor', 'resource_layout'],
    extractionNotes: readableContent.notes,
    errors: [],
    scannedAt: new Date().toISOString()
  });
}

function scanGenericPage(sourceType: ScanPagePayload['sourceType'], pageType: PageSurfaceType): ScanPagePayload {
  const readableContent = extractReadableContent(pageType);
  const readableText = readableContent.readableText || readableContent.previewText;
  const headings = readableContent.headings;

  return buildScanPayload({
    title: cleanExtractedText(document.title) || 'Scanned page',
    url: window.location.href,
    hostname: window.location.hostname.replace(/^www\./i, ''),
    readableText,
    headings,
    sourceType,
    pageType,
    sourceMode: 'dom',
    urlSignals: detectUrlSignals(window.location.href),
    domSignals: detectDomSignals(pageType, readableText),
    extractionNotes: readableContent.notes,
    errors: [],
    scannedAt: new Date().toISOString()
  });
}

export function detectPageType(url = window.location.href): PageSurfaceType {
  return detectLmsPageType(url);
}

export function scanCurrentPage(sourceType: ScanPagePayload['sourceType'] = 'reference'): ScanPagePayload {
  const pageType = detectPageType();
  return pageType === 'docs' ? scanDocsPage(sourceType) : scanGenericPage(sourceType, pageType);
}

function labelAssistNode(element: Element) {
  const existingId = element.getAttribute('data-canvy-assist-id');
  if (existingId) {
    return existingId;
  }

  const nextId = `canvy-assist-${crypto.randomUUID().slice(0, 8)}`;
  element.setAttribute('data-canvy-assist-id', nextId);
  return nextId;
}

function createAssistTarget(element: Element, kind: PageAssistTarget['kind']): PageAssistTarget | null {
  const snippet = cleanExtractedText(element.textContent);
  if (!snippet || snippet.length < 30) {
    return null;
  }

  const rect = element.getBoundingClientRect();
  const stablePlacement = rect.width > 120 && rect.height > 20 && rect.top < window.innerHeight * 1.4;
  const title = snippet.length > 72 ? `${snippet.slice(0, 72).trimEnd()}...` : snippet;

  return {
    id: crypto.randomUUID(),
    title,
    snippet,
    kind,
    stablePlacement,
    anchorId: stablePlacement ? labelAssistNode(element) : undefined
  };
}

function detectGenericAssistTargets(limit: number) {
  const selectors = [
    '.assignment-description p',
    '.discussion_topic p',
    '.question_text',
    '[data-testid="question"]',
    'article h2',
    'main h1',
    'main h2',
    'main p'
  ];

  const candidates = selectors
    .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
    .filter((node, index, array) => array.indexOf(node) === index)
    .filter((node) => {
      const cleanedText = cleanExtractedText(node.textContent);
      return cleanedText.length >= 40 && (/\?/.test(cleanedText) || /prompt|question|instructions|task|discuss|analy[sz]e|explain/i.test(cleanedText));
    })
    .slice(0, limit * 2);

  const targets = candidates
    .map((node) => createAssistTarget(node, /\?/.test(cleanExtractedText(node.textContent)) ? 'question' : 'prompt'))
    .filter(Boolean) as PageAssistTarget[];

  if (targets.length) {
    return targets.slice(0, limit);
  }

  const fallbackNodes = Array.from(document.querySelectorAll('main p, article p, p')).slice(0, limit);
  return fallbackNodes.map((node) => createAssistTarget(node, 'context')).filter(Boolean) as PageAssistTarget[];
}

export function detectPageAssistTargets(limit = 3): PageAssistTarget[] {
  const pageType = detectPageType();

  if (pageType === 'docs') {
    const docsPreview = scanDocsPage('reference');
    const snippets = docsPreview.readableText
      .split(/\n{2,}/)
      .map((part) => cleanExtractedText(part))
      .filter(Boolean)
      .slice(0, limit);

    return snippets.map((snippet, index) => ({
      id: `docs-assist-${index}`,
      title: index === 0 ? docsPreview.title : `Document excerpt ${index + 1}`,
      snippet,
      kind: index === 0 ? 'prompt' : 'context',
      stablePlacement: false
    }));
  }

  return detectGenericAssistTargets(limit);
}

export function isCanvasPage(url = window.location.href) {
  return isCanvasUrl(url);
}
