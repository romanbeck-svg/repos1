import { detectPageType } from '../shared/lms';
import type { PageContextSummary } from '../shared/types';
import { cleanExtractedText, extractQuestionCandidates, extractReadableContent } from './extraction';

function createContentFingerprint(parts: string[]) {
  let hash = 0;
  const source = parts.join('\n');

  for (let index = 0; index < source.length; index += 1) {
    hash = (hash << 5) - hash + source.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash).toString(36);
}

export function extractPageContext(): PageContextSummary {
  const pageType = detectPageType(window.location.href);
  const readableContent = extractReadableContent(pageType);
  const questionCandidates = extractQuestionCandidates(pageType);
  const previewText = readableContent.previewText || 'Readable page text is limited on this tab.';
  const priorityText = [readableContent.headings.join('\n'), readableContent.blocks.slice(0, 8).join('\n\n')]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 2_400) || previewText;
  const title = cleanExtractedText(document.title) || 'Current page';

  return {
    title,
    url: window.location.href,
    domain: window.location.hostname.replace(/^www\./i, ''),
    pageType,
    headings: readableContent.headings,
    contentBlocks: readableContent.blocks.slice(0, 24),
    questionCandidates,
    previewText,
    priorityText,
    textLength: readableContent.readableText.length || previewText.length,
    contentFingerprint: createContentFingerprint([title, window.location.href, readableContent.headings.join('|'), priorityText]),
    extractionNotes: readableContent.notes,
    capturedAt: new Date().toISOString()
  };
}
