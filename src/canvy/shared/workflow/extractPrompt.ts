import type { PromptExtraction } from '../types';
import type { PromptExtractionInput, WorkflowType } from './types';

interface PromptCandidate {
  text: string;
  source: PromptExtraction['source'];
  score: number;
}

interface TextLine {
  text: string;
  source: PromptExtraction['source'];
  index: number;
}

function cleanText(value: string | null | undefined) {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function trimText(value: string | null | undefined, maxLength: number) {
  const source = cleanText(value);
  if (!source) {
    return '';
  }

  return source.length > maxLength ? `${source.slice(0, maxLength).trimEnd()}...` : source;
}

function inferWorkflowType(input: PromptExtractionInput): WorkflowType {
  return input.workflowClassification?.workflowType ?? 'general';
}

function detectPromptType(text: string): PromptExtraction['promptType'] {
  const lowered = text.toLowerCase();

  if (/discussion|reply|classmates|peer response|initial post|thread/.test(lowered)) {
    return 'discussion';
  }

  if (/quiz|question|attempt|multiple choice|true or false|select the best answer|next question/.test(lowered)) {
    return 'quiz';
  }

  if (/upload|submit assignment|attach file|worksheet|rubric|due date|assignment instructions|complete the following/.test(lowered)) {
    return 'assignment';
  }

  if (/article|reading|resource|reference|lesson|chapter|module|documentation/.test(lowered)) {
    return 'resource';
  }

  return 'unknown';
}

function splitReadableBlocks(input: PromptExtractionInput) {
  const blocks = [
    ...(input.latestScan?.readableText?.split(/\n{2,}/) ?? []),
    ...(input.latestScan?.keyText?.split(/\n{2,}/) ?? []),
    ...(input.pageContext?.previewText?.split(/\n{2,}/) ?? [])
  ]
    .map((block) => cleanText(block))
    .filter((block) => block.length >= 24);

  return Array.from(new Set(blocks)).slice(0, 16);
}

function splitLines(value: string | null | undefined, source: PromptExtraction['source']) {
  return (value ?? '')
    .split(/\n+/)
    .map((text, index) => ({
      text: cleanText(text),
      source,
      index
    }))
    .filter((line) => line.text.length >= 12);
}

function getInstructionLines(input: PromptExtractionInput) {
  const readableLines = splitLines(input.latestScan?.readableText, 'body');
  const keyTextLines = splitLines(input.latestScan?.keyText, 'body');
  const previewLines = splitLines(input.pageContext?.previewText, 'body');
  return [...readableLines, ...keyTextLines, ...previewLines].slice(0, 60);
}

function candidateScore(workflowType: WorkflowType, text: string, source: PromptExtraction['source']) {
  const lowered = text.toLowerCase();
  let score = source === 'heading' ? 30 : source === 'mixed' ? 28 : source === 'body' ? 24 : 16;

  if (text.length >= 48 && text.length <= 360) {
    score += 12;
  }

  if (/[?]/.test(text)) {
    score += 12;
  }

  if (/instructions?|guidelines|requirements|prompt|task|question|respond|write|explain|analyze|compare|discuss|complete/.test(lowered)) {
    score += 18;
  }

  switch (workflowType) {
    case 'discussion_post':
      if (/discussion|reply|classmates|initial post|peer response|thread/.test(lowered)) {
        score += 26;
      }
      break;
    case 'quiz':
      if (/quiz|question|attempt|multiple choice|true or false|select the best answer/.test(lowered)) {
        score += 28;
      }
      break;
    case 'file_assignment':
      if (/assignment|submit|upload|rubric|worksheet|due date|attach file/.test(lowered)) {
        score += 28;
      }
      break;
    case 'resource':
      if (/article|reading|resource|lesson|module|chapter|reference|documentation/.test(lowered)) {
        score += 20;
      }
      break;
    default:
      if (/summary|overview|topic|key point/.test(lowered)) {
        score += 10;
      }
      break;
  }

  return score;
}

function boostInstructionLikeLine(workflowType: WorkflowType, line: string) {
  const lowered = line.toLowerCase();
  let score = 0;

  if (/^(prompt|question|instructions?|task|assignment|discussion|quiz)\b/.test(lowered)) {
    score += 18;
  }
  if (/^(write|respond|reply|discuss|compare|explain|analyze|complete|submit|upload|choose|select)\b/.test(lowered)) {
    score += 16;
  }
  if (/[:?]$/.test(line)) {
    score += 8;
  }
  if (/due date|rubric|classmates|true or false|multiple choice|best answer/.test(lowered)) {
    score += 10;
  }

  if (workflowType === 'resource' && /learning objectives|overview|lesson|chapter|notes|summary/.test(lowered)) {
    score += 8;
  }

  return score;
}

function findInstructionCandidate(input: PromptExtractionInput, workflowType: WorkflowType, headings: string[]) {
  const lines = getInstructionLines(input);
  const headingMatches = headings.map((heading) => heading.toLowerCase());

  let best: PromptCandidate | null = null;

  for (const line of lines) {
    let score = candidateScore(workflowType, line.text, line.source) + boostInstructionLikeLine(workflowType, line.text);

    if (headingMatches.some((heading) => heading && line.text.toLowerCase().includes(heading))) {
      score += 10;
    }

    if (line.index <= 8) {
      score += 6;
    }

    if (!best || score > best.score) {
      best = {
        text: line.text,
        source: line.source,
        score
      };
    }
  }

  return best;
}

function buildCandidates(input: PromptExtractionInput, workflowType: WorkflowType) {
  const headings = [...(input.pageContext?.headings ?? []), ...(input.latestScan?.headings ?? [])]
    .map((heading) => cleanText(heading))
    .filter(Boolean);
  const blocks = splitReadableBlocks(input);
  const candidates: PromptCandidate[] = [];

  for (const heading of headings) {
    candidates.push({
      text: heading,
      source: 'heading',
      score: candidateScore(workflowType, heading, 'heading')
    });
  }

  const instructionCandidate = findInstructionCandidate(input, workflowType, headings);
  if (instructionCandidate) {
    candidates.push(instructionCandidate);
  }

  blocks.forEach((block, index) => {
    candidates.push({
      text: block,
      source: 'body',
      score: candidateScore(workflowType, block, 'body') + (index === 0 ? 6 : 0)
    });
  });

  if (headings.length && blocks.length) {
    const mixed = `${headings[0]} ${blocks[0]}`;
    candidates.push({
      text: mixed,
      source: 'mixed',
      score: candidateScore(workflowType, mixed, 'mixed') + 8
    });
  }

  const fallbackTitle = cleanText(input.latestScan?.pageTitle ?? input.pageContext?.title ?? input.currentTitle);
  if (fallbackTitle) {
    candidates.push({
      text: fallbackTitle,
      source: 'title',
      score: candidateScore(workflowType, fallbackTitle, 'title')
    });
  }

  const summaryFallback = cleanText(input.latestScan?.summary);
  if (summaryFallback) {
    candidates.push({
      text: summaryFallback,
      source: 'body',
      score: candidateScore(workflowType, summaryFallback, 'body') - 4
    });
  }

  return candidates;
}

export function extractPrompt(input: PromptExtractionInput): PromptExtraction {
  const workflowType = inferWorkflowType(input);
  const ranked = buildCandidates(input, workflowType)
    .filter((candidate) => candidate.text.length >= 12)
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];

  if (!best || best.score < 34) {
    return {
      promptText: null,
      promptType: 'unknown',
      source: 'none',
      confidence: 0.18
    };
  }

  const promptType = detectPromptType(best.text);
  const confidence = Math.max(0.26, Math.min(0.94, Number((0.2 + best.score / 100).toFixed(2))));
  const result: PromptExtraction = {
    promptText: trimText(best.text, workflowType === 'quiz' ? 260 : 360),
    promptType: promptType === 'unknown' && workflowType === 'resource' ? 'resource' : promptType,
    source: best.source,
    confidence
  };

  console.info('[Canvy workflow] Prompt extraction result.', result);

  return result;
}
