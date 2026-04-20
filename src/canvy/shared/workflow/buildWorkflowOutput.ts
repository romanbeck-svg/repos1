import type {
  DiscussionOutputShell,
  FileAssignmentOutputShell,
  GeneralOutputShell,
  QuizOutputShell,
  ResourceOutputShell,
  WorkflowOutputShell
} from '../types';
import type { BuildWorkflowOutputInput } from './types';

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

function unique(items: string[], maxItems = 5) {
  return Array.from(new Set(items.map((item) => cleanText(item)).filter(Boolean))).slice(0, maxItems);
}

function splitIntoSentences(value: string | null | undefined) {
  return cleanText(value)
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => cleanText(sentence))
    .filter((sentence) => sentence.length >= 24);
}

function extractSummary(input: BuildWorkflowOutputInput) {
  return (
    input.analysis?.pageSummary ??
    input.latestScan?.summary ??
    input.pageContext?.previewText ??
    input.workflowClassification.reasons[0] ??
    'Canvy is ready to use the current page context.'
  );
}

function extractPromptText(input: BuildWorkflowOutputInput) {
  return (
    input.promptExtraction?.promptText ??
    input.taskClassification?.metadata.instructionsText ??
    input.taskClassification?.metadata.discussionPrompt ??
    input.taskClassification?.metadata.quizInstructions ??
    input.latestScan?.keyText ??
    input.pageContext?.previewText ??
    input.latestScan?.pageTitle ??
    input.pageContext?.title ??
    'Current page context'
  );
}

function extractKeyPoints(input: BuildWorkflowOutputInput) {
  return unique(
    [
      ...(input.analysis?.importantDetails ?? []),
      ...(input.analysis?.keyTopics ?? []),
      ...(input.latestScan?.importantDetails ?? []),
      ...(input.latestScan?.keyTopics ?? []),
      ...(input.taskClassification?.detectedSections ?? []),
      ...(input.pageContext?.headings ?? [])
    ],
    5
  );
}

function extractSupportingLines(input: BuildWorkflowOutputInput, maxItems = 4) {
  return unique(
    [
      ...(input.latestScan?.importantDetails ?? []),
      ...(input.analysis?.importantDetails ?? []),
      ...splitIntoSentences(input.latestScan?.readableText).slice(0, 4),
      ...(input.pageContext?.headings ?? [])
    ],
    maxItems
  );
}

function applyInstructions(text: string, extraInstructions?: string) {
  const trimmed = trimText(extraInstructions, 180);
  return trimmed ? `${text} Extra instructions: ${trimmed}.` : text;
}

function explainNextStep(input: BuildWorkflowOutputInput, fallback: string) {
  return trimText(
    input.workflowRoute?.primaryMessage ??
      input.workflowClassification.recommendedActions[0] ??
      input.taskClassification?.recommendedNextAction ??
      fallback,
    220
  );
}

export function buildWorkflowOutput(input: BuildWorkflowOutputInput): WorkflowOutputShell {
  const summary = trimText(extractSummary(input), 260);
  const prompt = trimText(extractPromptText(input), 320);
  const keyPoints = extractKeyPoints(input);
  const supportLines = extractSupportingLines(input);
  const instructions = input.extraInstructions ?? '';
  const updatedAt = new Date().toISOString();
  const logContext = {
    workflowType: input.workflowType,
    actionId: input.action.id,
    hasInstructions: Boolean(instructions.trim())
  };

  switch (input.workflowType) {
    case 'resource': {
      const resourceShell = {
        type: 'resource',
        actionId: input.action.id,
        title: 'Resource workflow output',
        intro:
          input.action.id === 'save_as_context'
            ? 'Canvy is preserving this scan as reusable source context for later coursework.'
            : input.action.id === 'extract_notes'
              ? 'Canvy is turning the scan into concise notes you can reuse.'
              : 'Canvy is treating this page as a study resource and summarizing the strongest takeaways.',
        summary:
          input.action.id === 'extract_notes'
            ? trimText(input.latestScan?.summary ?? summary, 220)
            : summary,
        keyPoints:
          input.action.id === 'save_as_context'
            ? unique([prompt, ...supportLines], 4)
            : input.action.id === 'extract_notes'
              ? unique([...(input.latestScan?.detectedSections ?? []), ...supportLines], 5)
              : keyPoints.length
                ? keyPoints
                : supportLines.length
                  ? supportLines
                  : ['Run Scan Page again to pull stronger note candidates from this resource.'],
        suggestedUse: applyInstructions(
          input.action.id === 'save_as_context'
            ? 'Use this page as background context, source material, or evidence when you open an assignment or discussion workflow next.'
            : input.action.id === 'extract_notes'
              ? 'Use these notes as a study sheet or reference before drafting, discussing, or reviewing quiz concepts.'
              : 'Use this summary to understand the page quickly, then switch to notes or saved context if this source will matter later.',
          instructions
        ),
        updatedAt
      } satisfies ResourceOutputShell;
      console.info('[Canvy workflow] Output shell built.', { ...logContext, outputType: resourceShell.type });
      return resourceShell;
    }

    case 'file_assignment': {
      const fileAssignmentShell = {
        type: 'file_assignment',
        actionId: input.action.id,
        title: 'Assignment helper output',
        intro:
          input.action.id === 'apply_instructions'
            ? 'Canvy stored your extra assignment requirements and rebuilt the working shell around them.'
            : 'Canvy is organizing the visible assignment into a task-first workspace.',
        task: prompt,
        draftAnswer: applyInstructions(
          input.action.id === 'apply_instructions'
            ? `Restate the assignment in your own words, then draft against these checkpoints: ${unique([
                prompt,
                ...supportLines,
                ...(input.taskClassification?.metadata.submissionTypeHints ?? [])
              ], 4).join(' | ')}.`
            : `Start with a task restatement, then build sections for the core deliverable, required evidence, and final submission check. Use these anchors: ${unique([
                ...supportLines,
                ...(input.taskClassification?.metadata.submissionTypeHints ?? [])
              ], 4).join(' | ') || 'prompt, rubric, supporting details'}.`,
          instructions
        ),
        explanation: applyInstructions(
          input.action.id === 'start_assignment_help'
            ? `Detected task: ${prompt || 'No clear assignment block was extracted yet'}. Focus on requirements, deliverable format, and any visible due-date or rubric cues before drafting.`
            : 'The assignment shell now includes your saved requirements, so the next drafting pass should follow those constraints instead of only the scanned prompt.',
          instructions
        ),
        updatedAt
      } satisfies FileAssignmentOutputShell;
      console.info('[Canvy workflow] Output shell built.', { ...logContext, outputType: fileAssignmentShell.type });
      return fileAssignmentShell;
    }

    case 'discussion_post': {
      const discussionShell = {
        type: 'discussion_post',
        actionId: input.action.id,
        title: 'Discussion workflow output',
        intro:
          input.action.id === 'apply_instructions'
            ? 'Canvy stored your discussion instructions and refreshed the response shell.'
            : 'Canvy is turning the visible discussion context into a reply-ready workflow shell.',
        prompt,
        draftResponse: applyInstructions(
          input.action.id === 'draft_response'
            ? `Open with a direct answer to the prompt, connect one idea from the page, and close with a class-friendly follow-up. Pull from: ${unique([prompt, ...supportLines], 4).join(' | ') || 'prompt, supporting point, follow-up question'}.`
            : `Keep the response aligned with your saved requirements while still answering the detected prompt directly: ${prompt || 'discussion prompt not clearly extracted yet'}.`,
          instructions
        ),
        notes: unique([
          ...(input.workflowClassification.reasons ?? []),
          ...supportLines,
          ...(instructions.trim() ? [`Active instructions: ${trimText(instructions, 120)}`] : [])
        ], 4).join(' | '),
        updatedAt
      } satisfies DiscussionOutputShell;
      console.info('[Canvy workflow] Output shell built.', { ...logContext, outputType: discussionShell.type });
      return discussionShell;
    }

    case 'quiz': {
      const quizShell = {
        type: 'quiz',
        actionId: input.action.id,
        title: 'Quiz-support output',
        intro:
          input.action.id === 'apply_instructions'
            ? 'Canvy stored your study instructions and kept the workflow in quiz-safe support mode.'
            : 'Canvy is staying in quiz-safe mode and focusing on explanation, study support, and concept review.',
        questionSupport: prompt || summary,
        answer: applyInstructions(
          input.action.id === 'prepare_quiz_support'
            ? `Study the concept behind this question before answering. Focus on these cues: ${unique([prompt, ...supportLines], 4).join(' | ') || 'question stem, tested concept, supporting notes'}.`
            : 'Your study instructions are active. Keep the help focused on reasoning, definitions, and what to review before answering on your own.',
          instructions
        ),
        explanation: applyInstructions(
          supportLines.join(' | ') || explainNextStep(input, 'Review the concepts, terms, and question framing before moving forward.'),
          instructions
        ),
        updatedAt
      } satisfies QuizOutputShell;
      console.info('[Canvy workflow] Output shell built.', { ...logContext, outputType: quizShell.type });
      return quizShell;
    }

    default: {
      const generalShell = {
        type: 'general',
        actionId: input.action.id,
        title: 'General page output',
        intro:
          input.action.id === 'extract_key_points'
            ? 'Canvy is focusing on the most useful takeaways from the current scan.'
            : input.action.id === 'explain_page'
              ? 'Canvy is reframing the page in simpler, more actionable terms.'
              : 'Canvy is using the latest page scan to summarize and organize the current page.',
        summary:
          input.action.id === 'explain_page'
            ? trimText(`This page mainly centers on ${prompt.toLowerCase()}. ${summary}`, 260)
            : summary,
        keyPoints:
          input.action.id === 'extract_key_points'
            ? supportLines.length
              ? supportLines
              : ['Scan the page again to pull cleaner key points.']
            : unique([...(input.analysis?.keyTopics ?? []), ...keyPoints], 4),
        suggestedNextStep: applyInstructions(
          input.action.id === 'summarize_page'
            ? 'Turn the page into a short summary and keep the strongest ideas for later reference.'
            : input.action.id === 'explain_page'
              ? 'Explain the most important part of the page in simpler language before moving into notes or drafting.'
              : 'Use the extracted key points to decide whether this page should stay in general mode or become supporting context.',
          instructions
        ),
        updatedAt
      } satisfies GeneralOutputShell;
      console.info('[Canvy workflow] Output shell built.', { ...logContext, outputType: generalShell.type });
      return generalShell;
    }
  }
}
