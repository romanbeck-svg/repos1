import { extractCanvasMetadata } from '../canvas/extractCanvasMetadata';
import { isCanvasUrl } from '../shared/lms';
import type {
  AssignmentMetadata,
  CanvasContext,
  ContentPattern,
  PageContextSummary,
  PageSubType,
  ScanPagePayload,
  SidebarMode,
  TaskClassification,
  TaskPlatform,
  TaskType
} from '../shared/types';
import { findMatchingSignals, hasAnySignal, TEXT_SIGNAL_RULES, URL_SIGNAL_RULES } from './taskRules';

interface ClassifyTaskTypeInput {
  assistantMode: SidebarMode;
  pageContext: PageContextSummary | null;
  latestScan?: ScanPagePayload;
  canvasContext: CanvasContext | null;
  currentUrl: string;
  currentTitle: string;
}

function cleanText(value: string | null | undefined) {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function toConfidence(value: number) {
  return Math.max(0.2, Math.min(0.99, Number(value.toFixed(2))));
}

function detectPlatform(input: ClassifyTaskTypeInput): TaskPlatform {
  if (input.assistantMode === 'canvas' || input.canvasContext || isCanvasUrl(input.currentUrl)) {
    return 'canvas';
  }

  return /^https?:/i.test(input.currentUrl) ? 'general_web' : 'unknown';
}

function buildGeneralMetadata(input: ClassifyTaskTypeInput): AssignmentMetadata {
  return {
    sourcePageTitle: input.latestScan?.pageTitle ?? input.pageContext?.title ?? input.currentTitle,
    resourceTitle: input.latestScan?.pageTitle ?? input.pageContext?.title ?? input.currentTitle,
    instructionsText: input.latestScan?.keyText ?? input.pageContext?.previewText,
    submissionTypeHints: []
  };
}

function reasonForSignal(signal: string) {
  const signalReasonMap: Record<string, string> = {
    assignment_path: 'The URL contains an assignments route.',
    discussion_path: 'The URL contains a discussion_topics route.',
    quiz_path: 'The URL contains a quizzes route.',
    module_path: 'The URL contains a modules route.',
    page_path: 'The URL contains a pages route.',
    file_path: 'The URL contains a files route.',
    file_upload_control: 'A file upload control or upload language is visible.',
    editor_present: 'A visible editor or rich text input is present.',
    discussion_reply_ui: 'Reply or discussion UI elements are visible.',
    quiz_ui: 'Quiz-like question or answer controls are visible.',
    due_date_text: 'Due date language is visible on the page.',
    points_text: 'Points-related language is visible on the page.',
    resource_layout: 'The page layout looks like a reading, resource, or module page.',
    canvas_shell: 'Canvas page structure was detected.',
    submit_assignment_text: 'Visible text mentions submitting an assignment.',
    upload_text: 'Visible text mentions uploading work.',
    discussion_text: 'Visible text mentions discussion context.',
    reply_text: 'Visible text mentions replying or posting.',
    quiz_text: 'Visible text mentions quiz/question language.',
    due_text: 'Visible text mentions a due date.',
    instructions_text: 'Visible text mentions instructions or guidelines.',
    module_text: 'Visible text mentions a module.',
    resource_text: 'Visible text looks like reading or resource content.'
  };

  return signalReasonMap[signal] ?? `Matched signal: ${signal}.`;
}

function recommendedNextAction(taskType: TaskType) {
  switch (taskType) {
    case 'file_assignment':
      return 'Review the assignment details, then move into the workspace to prepare a file-assignment flow.';
    case 'discussion_post':
      return 'Review the prompt and reply context, then prepare a discussion workflow in the workspace.';
    case 'quiz':
      return 'Stay in quiz-safe mode and focus on concept explanation or study help instead of direct answer generation.';
    case 'resource_page':
      return 'Use this page as supporting context and keep it available for summaries, notes, or later assignment work.';
    case 'canvas_course_page':
      return 'Open a specific assignment, discussion, quiz, or module item to unlock a more targeted workflow.';
    case 'general_page':
      return 'Use Analyze This Page or Scan Page to keep building context from the current tab.';
    default:
      return 'Refresh the page context or run Scan Page to gather stronger routing signals.';
  }
}

function detectSections(input: ClassifyTaskTypeInput) {
  return Array.from(
    new Set([
      ...(input.latestScan?.detectedSections ?? []),
      ...(input.pageContext?.headings ?? []),
      ...cleanText(input.latestScan?.keyText ?? input.pageContext?.previewText)
        .split(/\n{2,}/)
        .map((block) => cleanText(block))
        .filter((block) => block.length > 24)
        .slice(0, 3)
    ])
  ).slice(0, 6);
}

function detectContentPattern(textSource: string, assignmentSignals: string[], input: ClassifyTaskTypeInput): ContentPattern {
  const lowered = textSource.toLowerCase();

  if (hasAnySignal(assignmentSignals, ['discussion_reply_ui', 'discussion_text', 'reply_text']) || /conversation|chat|assistant/.test(lowered)) {
    return 'conversational';
  }

  if (hasAnySignal(assignmentSignals, ['instructions_text', 'module_text']) || /guide|tutorial|how to|documentation|api|reference|instructions/.test(lowered)) {
    return 'instructional';
  }

  if (/workspace|tool|dashboard|prompt|input|model|assistant/.test(lowered) || /chatgpt|claude|notion|canvas/i.test(input.currentUrl)) {
    return 'tool_like';
  }

  if (/article|chapter|reading|lesson|study|module/.test(lowered) || input.pageContext?.pageType === 'docs') {
    return 'article_like';
  }

  return lowered.length > 0 ? 'mixed' : 'unknown';
}

function detectPageSubType(
  taskType: TaskType,
  pattern: ContentPattern,
  textSource: string,
  input: ClassifyTaskTypeInput
): PageSubType {
  const lowered = textSource.toLowerCase();

  if (taskType === 'file_assignment' || /assignment prompt|submit assignment/.test(lowered)) {
    return 'assignment_prompt';
  }

  if (taskType === 'discussion_post' || pattern === 'conversational') {
    return 'conversation';
  }

  if (/documentation|api|reference|sdk|manual/.test(lowered)) {
    return 'documentation';
  }

  if (/article|blog|chapter|reading/.test(lowered)) {
    return 'article';
  }

  if (/study|lesson|notes|module/.test(lowered) || input.pageContext?.pageType === 'docs') {
    return 'study_resource';
  }

  if (pattern === 'tool_like') {
    return 'tool_interface';
  }

  if (taskType === 'resource_page') {
    return 'reference_page';
  }

  return 'unknown';
}

function describeResourceUsefulness(taskType: TaskType, pageSubType: PageSubType, pattern: ContentPattern) {
  if (taskType !== 'resource_page' && taskType !== 'general_page') {
    return undefined;
  }

  if (pageSubType === 'documentation' || pattern === 'instructional') {
    return 'High for step-by-step explanation, summarization, and pulling supporting details into later school workflows.';
  }

  if (pageSubType === 'conversation' || pattern === 'conversational') {
    return 'Useful for extracting discussion points, tool outputs, and follow-up questions worth carrying into the workspace.';
  }

  if (pageSubType === 'study_resource' || pageSubType === 'article') {
    return 'Useful as supporting source context for summaries, study notes, and assignment prep.';
  }

  return 'Useful as supporting context, but it may need a fresher scan or a more specific page section for stronger workflow routing.';
}

export function classifyTaskType(input: ClassifyTaskTypeInput): TaskClassification {
  const platform = detectPlatform(input);
  const metadata =
    platform === 'canvas'
      ? extractCanvasMetadata(input.canvasContext, input.pageContext, input.latestScan)
      : buildGeneralMetadata(input);

  const textSource = [
    input.latestScan?.keyText,
    input.latestScan?.readableText,
    input.pageContext?.previewText,
    input.canvasContext?.promptText,
    input.currentTitle
  ]
    .map((value) => cleanText(value))
    .filter(Boolean)
    .join('\n');

  const urlSignals = Array.from(
    new Set([...(input.latestScan?.urlSignals ?? []), ...findMatchingSignals(input.currentUrl, URL_SIGNAL_RULES)])
  );
  const domSignals = input.latestScan?.domSignals ?? [];
  const textSignals = findMatchingSignals(textSource, TEXT_SIGNAL_RULES);
  const assignmentSignals = Array.from(new Set([...urlSignals, ...domSignals, ...textSignals]));
  const courseSignals = Array.from(
    new Set(
      [
        input.canvasContext?.courseName ? 'course_name_visible' : null,
        input.canvasContext?.pageKind === 'course_home' ? 'course_home_kind' : null,
        input.canvasContext?.pageKind === 'module' ? 'module_kind' : null,
        urlSignals.includes('course_path') ? 'course_path' : null,
        domSignals.includes('canvas_shell') ? 'canvas_shell' : null
      ].filter(Boolean) as string[]
    )
  );

  const reasons = new Set<string>();
  const reasonDetails = new Set<string>();
  const addReason = (message: string | undefined) => {
    if (message) {
      reasons.add(message);
    }
  };
  const addReasonDetail = (message: string | undefined) => {
    if (message) {
      reasonDetails.add(message);
    }
  };

  let taskType: TaskType = 'unknown';
  let confidence = 0.34;

  if (platform === 'canvas') {
    if (
      input.canvasContext?.pageKind === 'quiz' ||
      input.canvasContext?.pageKind === 'quiz_review' ||
      hasAnySignal(assignmentSignals, ['quiz_path', 'quiz_ui', 'quiz_text'])
    ) {
      taskType = 'quiz';
      confidence = input.canvasContext?.pageKind === 'quiz' || input.canvasContext?.pageKind === 'quiz_review' ? 0.95 : 0.84;
    } else if (
      input.canvasContext?.pageKind === 'discussion' ||
      hasAnySignal(assignmentSignals, ['discussion_path', 'discussion_reply_ui', 'discussion_text', 'reply_text'])
    ) {
      taskType = 'discussion_post';
      confidence = input.canvasContext?.pageKind === 'discussion' ? 0.94 : 0.82;
    } else if (
      input.canvasContext?.pageKind === 'assignment' ||
      hasAnySignal(assignmentSignals, ['assignment_path', 'file_upload_control', 'submit_assignment_text', 'upload_text'])
    ) {
      taskType = 'file_assignment';
      confidence = input.canvasContext?.pageKind === 'assignment' ? 0.93 : 0.8;
    } else if (
      input.canvasContext?.pageKind === 'file' ||
      input.canvasContext?.pageKind === 'module' ||
      hasAnySignal(assignmentSignals, ['file_path', 'page_path', 'module_path', 'resource_layout', 'resource_text', 'module_text'])
    ) {
      taskType = 'resource_page';
      confidence = input.canvasContext?.pageKind === 'file' || input.canvasContext?.pageKind === 'module' ? 0.86 : 0.72;
    } else if (courseSignals.length || input.canvasContext?.pageKind === 'course_home') {
      taskType = 'canvas_course_page';
      confidence = 0.76;
    } else {
      taskType = 'unknown';
      confidence = 0.42;
    }
  } else if (platform === 'general_web') {
    if (hasAnySignal(assignmentSignals, ['resource_layout', 'resource_text']) || input.pageContext?.pageType === 'docs') {
      taskType = 'resource_page';
      confidence = input.pageContext?.pageType === 'docs' ? 0.88 : 0.73;
    } else if ((input.latestScan?.readableText.length ?? input.pageContext?.textLength ?? 0) > 140) {
      taskType = 'general_page';
      confidence = 0.68;
    } else {
      taskType = 'unknown';
      confidence = 0.35;
    }
  }

  assignmentSignals.forEach((signal) => addReason(reasonForSignal(signal)));
  assignmentSignals.forEach((signal) => addReasonDetail(`Signal matched: ${signal}.`));

  if (input.canvasContext?.pageKind && input.canvasContext.pageKind !== 'unknown') {
    addReason(`Canvas page kind was detected as ${input.canvasContext.pageKind.replace(/_/g, ' ')}.`);
    addReasonDetail(`Canvas DOM extraction reported the page kind as ${input.canvasContext.pageKind.replace(/_/g, ' ')}.`);
  }

  if (input.latestScan?.canvasEnhancedRelevant) {
    addReason('The latest scan indicates Canvas-enhanced context is relevant here.');
  }

  const detectedSections = detectSections(input);
  const contentPattern = detectContentPattern(textSource, assignmentSignals, input);
  const pageSubType = detectPageSubType(taskType, contentPattern, textSource, input);
  const resourceUsefulness = describeResourceUsefulness(taskType, pageSubType, contentPattern);

  if (detectedSections.length) {
    addReasonDetail(`Detected sections: ${detectedSections.join(', ')}.`);
  }

  addReasonDetail(`Page subtype inferred as ${pageSubType.replace(/_/g, ' ')} with a ${contentPattern.replace(/_/g, ' ')} content pattern.`);

  if (resourceUsefulness) {
    addReasonDetail(resourceUsefulness);
  }

  if (!reasons.size) {
    addReason('Only limited routing signals were available from the current page context.');
  }

  return {
    taskType,
    platform,
    mode: platform === 'canvas' ? 'canvas' : 'general',
    confidence: toConfidence(confidence),
    pageSubType,
    contentPattern,
    detectedSections,
    resourceUsefulness,
    reasons: Array.from(reasons).slice(0, 6),
    reasonDetails: Array.from(reasonDetails).slice(0, 8),
    assignmentSignals,
    courseSignals,
    metadata,
    recommendedNextAction: recommendedNextAction(taskType),
    classifiedAt: new Date().toISOString()
  };
}
