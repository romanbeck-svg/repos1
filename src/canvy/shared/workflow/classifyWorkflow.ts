import type { WorkflowClassification, WorkflowType } from '../types';
import type { WorkflowClassificationInput } from './types';

type WorkflowRuleName = Exclude<WorkflowType, 'general'>;

interface WorkflowRuleDefinition {
  textPatterns: RegExp[];
  titlePatterns: RegExp[];
  urlPatterns: RegExp[];
  headingPatterns: RegExp[];
  signalMatches: string[];
  taskTypeMatches: string[];
  minScore: number;
  actionVerbs: string[];
}

interface WorkflowRuleResult {
  workflowType: WorkflowRuleName;
  score: number;
  reasons: string[];
  detectedSignals: string[];
}

const WORKFLOW_RULES: Record<WorkflowRuleName, WorkflowRuleDefinition> = {
  discussion_post: {
    textPatterns: [
      /\bdiscussion\b/i,
      /\breply\b/i,
      /\brespond to classmates\b/i,
      /\binitial post\b/i,
      /\bpeer response\b/i,
      /\bthread\b/i,
      /\bdiscussion board\b/i,
      /\bpost your response\b/i
    ],
    titlePatterns: [/\bdiscussion\b/i, /\breply\b/i, /\bthread\b/i, /\bresponse\b/i],
    headingPatterns: [/\bdiscussion prompt\b/i, /\binitial post\b/i, /\bpeer response\b/i, /\brespond to classmates\b/i],
    urlPatterns: [/\/discussion_topics\//i, /discussion/i],
    signalMatches: ['discussion_path', 'discussion_reply_ui', 'discussion_text', 'reply_text', 'editor_present'],
    taskTypeMatches: ['discussion_post'],
    minScore: 42,
    actionVerbs: ['discuss', 'respond', 'reply', 'post']
  },
  quiz: {
    textPatterns: [
      /\bquiz\b/i,
      /\bquestion\s*\d+\b/i,
      /\battempt\b/i,
      /\bsubmit quiz\b/i,
      /\bmultiple choice\b/i,
      /\btrue or false\b/i,
      /\bselect the best answer\b/i,
      /\bnext question\b/i
    ],
    titlePatterns: [/\bquiz\b/i, /\bquestion\b/i, /\battempt\b/i],
    headingPatterns: [/\bquestion\s*\d+\b/i, /\bmultiple choice\b/i, /\btrue or false\b/i],
    urlPatterns: [/\/quizzes\//i, /quiz/i],
    signalMatches: ['quiz_path', 'quiz_ui', 'quiz_text'],
    taskTypeMatches: ['quiz'],
    minScore: 40,
    actionVerbs: ['answer', 'select', 'choose', 'review']
  },
  file_assignment: {
    textPatterns: [
      /\bupload\b/i,
      /\battach file\b/i,
      /\bsubmit assignment\b/i,
      /\bdocument\b/i,
      /\bworksheet\b/i,
      /\bturn in\b/i,
      /\bfile submission\b/i,
      /\bassignment instructions\b/i,
      /\brubric\b/i,
      /\bdue date\b/i
    ],
    titlePatterns: [/\bassignment\b/i, /\bworksheet\b/i, /\brubric\b/i, /\bsubmit\b/i],
    headingPatterns: [/\bassignment instructions\b/i, /\bsubmit assignment\b/i, /\bturn in\b/i, /\bwhat to submit\b/i],
    urlPatterns: [/\/assignments\//i, /assignment/i, /submission/i],
    signalMatches: [
      'assignment_path',
      'file_upload_control',
      'submit_assignment_text',
      'upload_text',
      'due_date_text',
      'points_text'
    ],
    taskTypeMatches: ['file_assignment'],
    minScore: 40,
    actionVerbs: ['write', 'complete', 'submit', 'upload', 'analyze']
  },
  resource: {
    textPatterns: [
      /\barticle\b/i,
      /\breading\b/i,
      /\bchapter\b/i,
      /\bmodule\b/i,
      /\blesson\b/i,
      /\bnotes\b/i,
      /\bresource\b/i,
      /\bsupporting material\b/i,
      /\breference\b/i,
      /\bdocumentation\b/i
    ],
    titlePatterns: [/\barticle\b/i, /\breading\b/i, /\bmodule\b/i, /\blesson\b/i, /\bguide\b/i, /\breference\b/i],
    headingPatterns: [/\bchapter\b/i, /\blesson\b/i, /\bnotes\b/i, /\bkey terms\b/i, /\blearning objectives\b/i],
    urlPatterns: [/\/modules/i, /\/pages\//i, /\/files\//i, /docs\.google\.com\/document/i],
    signalMatches: ['module_path', 'page_path', 'file_path', 'resource_layout', 'resource_text', 'document_editor'],
    taskTypeMatches: ['resource_page', 'canvas_course_page'],
    minScore: 28,
    actionVerbs: ['read', 'review', 'reference', 'study']
  }
};

function cleanText(value: string | null | undefined) {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function unique(items: string[]) {
  return Array.from(new Set(items.map((item) => cleanText(item)).filter(Boolean)));
}

function buildTextBuckets(input: WorkflowClassificationInput) {
  const headings = unique([...(input.pageContext?.headings ?? []), ...(input.latestScan?.headings ?? [])]);
  const headingText = headings.join('\n');
  const contentText = unique([
    input.pageContext?.previewText ?? '',
    input.latestScan?.summary ?? '',
    input.latestScan?.keyText ?? '',
    input.latestScan?.readableText ?? '',
    input.taskClassification?.metadata.instructionsText ?? '',
    input.taskClassification?.metadata.discussionPrompt ?? '',
    input.taskClassification?.metadata.quizInstructions ?? '',
    input.taskClassification?.metadata.assignmentTitle ?? '',
    input.taskClassification?.metadata.resourceTitle ?? ''
  ]).join('\n');

  return {
    titleText: cleanText([input.currentTitle, input.pageContext?.title, input.latestScan?.pageTitle].filter(Boolean).join(' | ')).toLowerCase(),
    headingText: headingText.toLowerCase(),
    contentText: contentText.toLowerCase(),
    urlText: cleanText([input.currentUrl, input.latestScan?.url, input.pageContext?.url].filter(Boolean).join(' | ')).toLowerCase(),
    headings
  };
}

function detectSignals(input: WorkflowClassificationInput, buckets: ReturnType<typeof buildTextBuckets>) {
  const detected = new Set<string>();

  [...(input.taskClassification?.assignmentSignals ?? []), ...(input.taskClassification?.courseSignals ?? [])].forEach((signal) => detected.add(signal));
  [...(input.latestScan?.urlSignals ?? []), ...(input.latestScan?.domSignals ?? [])].forEach((signal) => detected.add(signal));

  if (WORKFLOW_RULES.discussion_post.textPatterns.some((pattern) => pattern.test(buckets.contentText))) {
    detected.add('discussion_language');
  }
  if (WORKFLOW_RULES.quiz.textPatterns.some((pattern) => pattern.test(buckets.contentText))) {
    detected.add('quiz_language');
  }
  if (WORKFLOW_RULES.file_assignment.textPatterns.some((pattern) => pattern.test(buckets.contentText))) {
    detected.add('assignment_language');
  }
  if (WORKFLOW_RULES.resource.textPatterns.some((pattern) => pattern.test(buckets.contentText))) {
    detected.add('resource_language');
  }
  if (input.assistantMode === 'canvas') {
    detected.add('canvas_mode');
  }
  if (input.pageContext?.pageType === 'docs') {
    detected.add('document_editor');
  }

  return Array.from(detected);
}

function scoreRule(
  workflowType: WorkflowRuleName,
  input: WorkflowClassificationInput,
  buckets: ReturnType<typeof buildTextBuckets>,
  detectedSignals: string[]
): WorkflowRuleResult {
  const rule = WORKFLOW_RULES[workflowType];
  const reasons: string[] = [];
  const matchedSignals = new Set<string>();
  let score = 0;

  const matchedUrlPatterns = rule.urlPatterns.filter((pattern) => pattern.test(buckets.urlText));
  if (matchedUrlPatterns.length) {
    score += Math.min(30, matchedUrlPatterns.length * 18);
    reasons.push('The URL structure lines up with this workflow.');
    matchedSignals.add('url_match');
  }

  const matchedSignalNames = rule.signalMatches.filter((signal) => detectedSignals.includes(signal));
  if (matchedSignalNames.length) {
    score += Math.min(36, matchedSignalNames.length * 12);
    matchedSignalNames.forEach((signal) => matchedSignals.add(signal));
    reasons.push('DOM or scan signals support this workflow.');
  }

  const matchedTitlePatterns = rule.titlePatterns.filter((pattern) => pattern.test(buckets.titleText) || pattern.test(buckets.headingText));
  if (matchedTitlePatterns.length) {
    score += Math.min(22, matchedTitlePatterns.length * 8);
    reasons.push('The title or headings read like this workflow.');
    matchedSignals.add('title_heading_match');
  }

  const matchedHeadingPatterns = rule.headingPatterns.filter((pattern) => pattern.test(buckets.headingText));
  if (matchedHeadingPatterns.length) {
    score += Math.min(24, matchedHeadingPatterns.length * 10);
    reasons.push('The page headings point to a workflow-specific task structure.');
    matchedSignals.add('heading_match');
  }

  const matchedTextPatterns = rule.textPatterns.filter((pattern) => pattern.test(buckets.contentText));
  if (matchedTextPatterns.length) {
    score += Math.min(28, matchedTextPatterns.length * 7);
    reasons.push('The extracted page text contains workflow-specific language.');
    matchedSignals.add('content_match');
  }

  if (rule.taskTypeMatches.includes(input.taskClassification?.taskType ?? '')) {
    score += 26;
    reasons.push('The broader page-task classifier agrees with this workflow.');
    matchedSignals.add(`task:${input.taskClassification?.taskType}`);
  }

  if (workflowType === 'resource' && input.pageContext?.pageType === 'docs') {
    score += 16;
    reasons.push('The page is a document-style reading surface.');
    matchedSignals.add('docs_surface');
  }

  if (workflowType === 'resource' && input.assistantMode === 'canvas' && input.taskClassification?.taskType === 'canvas_course_page') {
    score += 8;
    reasons.push('Canvas course context is present, but no more specific task is active.');
    matchedSignals.add('canvas_course_context');
  }

  const actionVerbMatches = rule.actionVerbs.filter((verb) => new RegExp(`\\b${verb}\\b`, 'i').test(buckets.contentText));
  if (actionVerbMatches.length) {
    score += Math.min(14, actionVerbMatches.length * 4);
    reasons.push('The visible instructions use action verbs that fit this workflow.');
    matchedSignals.add('action_language');
  }

  return {
    workflowType,
    score,
    reasons: unique(reasons),
    detectedSignals: Array.from(matchedSignals)
  };
}

function recommendedActionsForWorkflow(workflowType: WorkflowType) {
  switch (workflowType) {
    case 'resource':
      return ['summarize_resource', 'extract_notes', 'save_as_context'];
    case 'file_assignment':
      return ['start_assignment_help', 'apply_instructions'];
    case 'discussion_post':
      return ['draft_response', 'apply_instructions'];
    case 'quiz':
      return ['prepare_quiz_support', 'apply_instructions'];
    default:
      return ['summarize_page', 'explain_page', 'extract_key_points'];
  }
}

function generalReasons(input: WorkflowClassificationInput, detectedSignals: string[]) {
  const reasons = [
    input.taskClassification?.recommendedNextAction,
    input.pageContext?.previewText ? 'The page is still usable for general page-aware help.' : undefined,
    detectedSignals.length ? `Detected signals: ${detectedSignals.slice(0, 4).join(', ')}.` : undefined
  ].filter(Boolean) as string[];

  return reasons.length ? reasons.slice(0, 4) : ['The current page has limited task-specific signals, so Canvy is staying in general mode.'];
}

export function classifyWorkflow(input: WorkflowClassificationInput): WorkflowClassification {
  const buckets = buildTextBuckets(input);
  const detectedSignals = detectSignals(input, buckets);
  const results = (Object.keys(WORKFLOW_RULES) as WorkflowRuleName[]).map((workflowType) =>
    scoreRule(workflowType, input, buckets, detectedSignals)
  );
  const ranked = results.sort((left, right) => right.score - left.score);
  const best = ranked[0];

  const chooseGeneral = !best || best.score < WORKFLOW_RULES[best.workflowType].minScore;
  const workflowType: WorkflowType = chooseGeneral ? 'general' : best.workflowType;
  const confidence = chooseGeneral
    ? Math.max(0.42, Math.min(0.7, Number(((input.taskClassification?.confidence ?? 0.52) * 0.85).toFixed(2))))
    : Math.max(0.58, Math.min(0.97, Number((0.38 + best.score / 100).toFixed(2))));
  const reasons = chooseGeneral ? generalReasons(input, detectedSignals) : best.reasons;
  const workflowDetectedSignals = unique([...(chooseGeneral ? detectedSignals : best.detectedSignals), ...detectedSignals]).slice(0, 10);

  console.info('[Canvy workflow] Workflow classification result.', {
    workflowType,
    confidence,
    reasons,
    detectedSignals: workflowDetectedSignals
  });

  return {
    workflowType,
    confidence,
    reasons,
    recommendedActions: recommendedActionsForWorkflow(workflowType),
    detectedSignals: workflowDetectedSignals
  };
}
