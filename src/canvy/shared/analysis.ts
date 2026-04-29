import type { CanvasContext, PageAnalysisResult, PageContextSummary, SidebarMode } from './types';

const STOPWORDS = new Set([
  'about',
  'also',
  'after',
  'again',
  'being',
  'because',
  'between',
  'button',
  'comment',
  'comments',
  'chatgpt',
  'could',
  'document',
  'docs',
  'every',
  'file',
  'first',
  'from',
  'have',
  'help',
  'into',
  'menu',
  'more',
  'most',
  'other',
  'page',
  'search',
  'settings',
  'share',
  'should',
  'their',
  'there',
  'these',
  'this',
  'through',
  'toolbar',
  'tools',
  'using',
  'very',
  'view',
  'what',
  'when',
  'where',
  'which',
  'while',
  'with',
  'would',
  'your',
  'youre'
]);

function cleanText(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function firstSentence(text: string) {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => cleanText(sentence))
    .filter(Boolean);

  return sentences[0] ?? cleanText(text).slice(0, 180);
}

function toTitleCase(value: string) {
  return value
    .split(/\s+/)
    .map((part) => (part ? `${part.charAt(0).toUpperCase()}${part.slice(1)}` : part))
    .join(' ');
}

function extractTopicKeywords(previewText: string) {
  const counts = new Map<string, number>();

  previewText
    .toLowerCase()
    .match(/[a-z][a-z-]{3,}/g)
    ?.forEach((token) => {
      if (STOPWORDS.has(token)) {
        return;
      }

      counts.set(token, (counts.get(token) ?? 0) + 1);
    });

  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4)
    .map(([token]) => toTitleCase(token));
}

function extractTitleTopics(title: string) {
  return uniqueTopics(
    title
      .split(/[-:|]/)
      .map((part) => cleanText(part))
      .filter((part) => part.length > 2)
  );
}

function uniqueTopics(items: string[]) {
  return Array.from(new Set(items.map((item) => cleanText(item)).filter(Boolean)));
}

function extractSectionCandidates(pageContext: PageContextSummary) {
  const paragraphLeads = pageContext.previewText
    .split(/\n{2,}/)
    .map((block) => cleanText(block))
    .filter((block) => block.length > 24)
    .map((block) => block.split(/[.!?]/)[0] ?? block)
    .map((block) => (block.length > 72 ? `${block.slice(0, 69).trimEnd()}...` : block));

  return uniqueTopics([...pageContext.headings, ...paragraphLeads]).slice(0, 5);
}

function buildKeyTopics(mode: SidebarMode, pageContext: PageContextSummary, canvasContext: CanvasContext | null) {
  const topics = new Set<string>();

  extractTitleTopics(pageContext.title).forEach((topic) => topics.add(topic));

  pageContext.headings.slice(0, 3).forEach((heading) => {
    const cleanHeading = cleanText(heading);
    if (cleanHeading) {
      topics.add(cleanHeading.length > 64 ? `${cleanHeading.slice(0, 61)}...` : cleanHeading);
    }
  });

  extractTopicKeywords(pageContext.previewText).forEach((keyword) => topics.add(keyword));
  extractSectionCandidates(pageContext).forEach((section) => topics.add(section));

  if (mode === 'canvas') {
    if (canvasContext?.courseName) {
      topics.add(canvasContext.courseName);
    }

    if (canvasContext?.pageKind && canvasContext.pageKind !== 'unknown') {
      topics.add(toTitleCase(canvasContext.pageKind.replace(/_/g, ' ')));
    }
  }

  if (!topics.size) {
    topics.add(mode === 'canvas' ? 'Canvas page context' : 'General page context');
  }

  return Array.from(topics).slice(0, 4);
}

function buildLikelyUseCase(mode: SidebarMode, pageContext: PageContextSummary, canvasContext: CanvasContext | null) {
  if (mode === 'canvas') {
    if (canvasContext?.quizSafetyMode === 'active_attempt') {
      return 'Quiz-safe concept review';
    }

    switch (canvasContext?.pageKind) {
      case 'assignment':
        return 'Assignment breakdown';
      case 'discussion':
        return 'Discussion preparation';
      case 'quiz_review':
        return 'Quiz review recap';
      case 'file':
        return 'Reading and source review';
      default:
        return 'Canvas course support';
    }
  }

  if (pageContext.pageType === 'docs') {
    return 'Reference reading and note organization';
  }

  const preview = pageContext.previewText.toLowerCase();
  const title = pageContext.title.toLowerCase();

  if (/how to|step-by-step|steps|guide/.test(preview) || /guide|tutorial|how to/.test(title)) {
    return 'Step-by-step walkthrough';
  }

  if (/policy|terms|requirements|guidelines/.test(preview)) {
    return 'Policy or requirements review';
  }

  if (/chapter|reading|article|study|lesson|notes/.test(preview)) {
    return 'Study summary';
  }

  if (/chat|conversation|assistant|workspace|tool/.test(preview) || /chatgpt|workspace|assistant/.test(title)) {
    return 'Tool or workspace interpretation';
  }

  return 'General page analysis';
}

function buildPageSummary(mode: SidebarMode, pageContext: PageContextSummary, canvasContext: CanvasContext | null, likelyUseCase: string) {
  if (mode === 'canvas') {
    const courseName = canvasContext?.courseName ?? 'your Canvas course';
    const pageKind = canvasContext?.pageKind ? canvasContext.pageKind.replace(/_/g, ' ') : 'Canvas page';
    const promptLead = firstSentence(canvasContext?.promptText || pageContext.previewText);

    return `This Canvas ${pageKind} in ${courseName} looks best suited for ${likelyUseCase.toLowerCase()}. The visible content centers on ${promptLead.toLowerCase()}.`;
  }

  const sourceType =
    pageContext.pageType === 'docs'
      ? 'Google Doc'
      : pageContext.pageType === 'canvas'
        ? 'Canvas page'
        : 'webpage';
  const previewLead = firstSentence(pageContext.previewText || pageContext.title);
  const sectionLead = cleanText(pageContext.headings[0] ?? extractSectionCandidates(pageContext)[0] ?? '');
  const structureNote = sectionLead ? ` The clearest section signal is "${sectionLead}".` : '';

  return `"${pageContext.title}" on ${pageContext.domain} looks like a ${sourceType} focused on ${previewLead.toLowerCase()}.${structureNote}`;
}

function buildImportantDetails(mode: SidebarMode, pageContext: PageContextSummary, canvasContext: CanvasContext | null) {
  const details = [
    `Source site: ${pageContext.domain}`,
    `Detected page type: ${pageContext.pageType}`,
    `Captured about ${pageContext.textLength} characters of readable page text`,
    pageContext.headings.length
      ? `Structured headings found: ${pageContext.headings.length}`
      : 'Structured headings were limited on this page'
  ];

  if (mode === 'canvas') {
    details.push(`Canvas page kind: ${canvasContext?.pageKind?.replace(/_/g, ' ') ?? 'unknown'}`);

    if (canvasContext?.dueAtText) {
      details.push(`Visible due date: ${canvasContext.dueAtText}`);
    }

    if (canvasContext?.attachments.length) {
      details.push(`Visible attachments: ${canvasContext.attachments.length}`);
    }

    if (canvasContext?.quizSafetyMode && canvasContext.quizSafetyMode !== 'none') {
      details.push(`Quiz mode safeguard: ${canvasContext.quizSafetyMode.replace(/_/g, ' ')}`);
    }
  }

  return details.slice(0, 5);
}

function buildSuggestedNextActions(mode: SidebarMode, pageContext: PageContextSummary, canvasContext: CanvasContext | null, likelyUseCase: string) {
  if (mode === 'canvas') {
    return [
      'Review the visible prompt and instructions before drafting anything.',
      canvasContext?.attachments.length ? 'Open the linked attachments or references if you need more assignment context.' : 'Use the Canvas tab to inspect the visible course context.',
      canvasContext?.quizSafetyMode === 'active_attempt'
        ? 'Stay in explanation-only mode and focus on study support for active quiz attempts.'
        : `Use the Workspace tab to start a ${likelyUseCase.toLowerCase()} flow.`
    ];
  }

  return [
    `Use the extracted preview to guide a ${likelyUseCase.toLowerCase()} workflow.`,
    pageContext.headings.length
      ? 'Refresh page context after moving to a new section so the heading outline stays current.'
      : 'Refresh page context if you scroll to a new section or open a different article.',
    'Open the Workspace tab to keep follow-up helper actions tied to this page context.'
  ];
}

export function buildPageAnalysis(
  mode: SidebarMode,
  pageContext: PageContextSummary,
  canvasContext: CanvasContext | null
): PageAnalysisResult {
  const likelyUseCase = buildLikelyUseCase(mode, pageContext, canvasContext);
  const pageSummary = buildPageSummary(mode, pageContext, canvasContext, likelyUseCase);
  const keyTopics = buildKeyTopics(mode, pageContext, canvasContext);
  const importantDetails = buildImportantDetails(mode, pageContext, canvasContext);
  const suggestedNextActions = buildSuggestedNextActions(mode, pageContext, canvasContext, likelyUseCase);

  return {
    resultState: 'invalid_ai_output',
    aiTag: 'error',
    aiTaggedSuccessfully: false,
    extractionMode: 'dom',
    questions: [],
    candidateQuestionCount: pageContext.questionCandidates.length,
    answeredQuestionCount: 0,
    overlayEligible: false,
    overlaySuppressedReason: 'fallback_plain_text',
    validation: {
      modelCallSucceeded: false,
      finishReason: 'not_applicable',
      parseSuccess: false,
      schemaValid: false,
      echoGuardHit: false,
      candidateQuestionCount: pageContext.questionCandidates.length,
      answeredQuestionCount: 0
    },
    message: 'Local scan context is available, but the page overlay is reserved for validated AI question-answer results.',
    title: likelyUseCase,
    text: pageSummary,
    bullets: keyTopics,
    chart: null,
    actions: suggestedNextActions,
    sourceTitle: pageContext.title,
    sourceUrl: pageContext.url,
    assistantMode: mode,
    mode: 'summary',
    pageSummary,
    keyTopics,
    importantDetails,
    suggestedNextActions,
    likelyUseCase,
    canvasEnhancedAvailable: mode === 'canvas',
    extractedPreview: pageContext.previewText,
    generatedAt: new Date().toISOString()
  };
}
