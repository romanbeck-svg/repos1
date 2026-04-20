import type {
  ApiTaskRequest,
  ScanPagePayload,
  TaskOutput,
  ToneProfile,
  ToneProfileResponse
} from '../shared/types';

function wordCount(value: string) {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function averageSentenceLength(text: string) {
  const sentences = text
    .split(/[.!?]+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  if (!sentences.length) {
    return 0;
  }

  return sentences.reduce((sum, sentence) => sum + wordCount(sentence), 0) / sentences.length;
}

function deriveToneProfile(samples: ScanPagePayload[]): ToneProfile {
  const joined = samples.map((sample) => sample.readableText).join('\n\n');
  const avgSentenceLength = averageSentenceLength(joined);
  const paragraphCount = joined.split(/\n{2,}/).filter(Boolean).length;
  const bulletCount = (joined.match(/(^|\n)[-\u2022*]/g) ?? []).length;
  const citationSignals = (joined.match(/\([A-Z][A-Za-z]+,\s*\d{4}\)|works cited|references/gi) ?? []).length;
  const formalSignals = (joined.match(/\bhowever\b|\btherefore\b|\bmoreover\b|\bfurthermore\b/gi) ?? []).length;

  return {
    sentenceLengthTendency: avgSentenceLength > 22 ? 'long' : avgSentenceLength < 12 ? 'short' : 'balanced',
    formality: formalSignals > 3 ? 'formal' : formalSignals > 0 ? 'balanced' : 'conversational',
    structurePreference: paragraphCount > bulletCount * 2 ? 'prefers sectioned paragraphs with clear transitions' : 'uses list-driven organization when useful',
    citationTendency: citationSignals > 0 ? 'often adds citation markers or reference sections' : 'usually writes without explicit citations unless requested',
    compositionPreference: bulletCount > paragraphCount ? 'bullets' : bulletCount > 0 ? 'mixed' : 'paragraphs',
    evidence: samples.slice(0, 3).map((sample) => `${sample.title}: ${sample.readableText.slice(0, 90)}...`),
    generatedAt: new Date().toISOString()
  };
}

function buildChecklist(request: ApiTaskRequest) {
  const rubricChecklist = request.context?.rubricItems.slice(0, 4).map((item) => `Address rubric item: ${item}.`) ?? [];
  const attachmentChecklist =
    request.context?.attachments.slice(0, 2).map((attachment) => `Review attached file: ${attachment.label}.`) ?? [];

  const checklist = [
    request.context?.title ? `Confirm the prompt focus for "${request.context.title}".` : 'Confirm the core assignment goal.',
    request.context?.dueAtText ? `Double-check the due date: ${request.context.dueAtText}.` : 'Verify the submission deadline inside Canvas.',
    ...rubricChecklist,
    ...attachmentChecklist
  ];

  if (request.extraInstructions.trim()) {
    checklist.push(`Apply the extra instruction: ${request.extraInstructions.trim()}.`);
  }

  if (!checklist.length) {
    checklist.push('Open the full prompt or a reference page and run Scan Page if more context is needed.');
  }

  return checklist.slice(0, 6);
}

function buildStructure(request: ApiTaskRequest) {
  if (request.task === 'discussion_post') {
    return ['Opening claim', 'Evidence or course reference', 'Response to the prompt', 'Closing thought or follow-up question'];
  }

  if (request.task === 'summarize_reading') {
    return ['Core thesis', 'Key supporting points', 'Important terminology', 'Questions to review later'];
  }

  if (request.task === 'quiz_assist') {
    return ['Concept being tested', 'How to reason through it', 'What to review next'];
  }

  return ['Introduction', 'Point 1', 'Point 2', 'Point 3 or reflection', 'Conclusion'];
}

function buildDraft(request: ApiTaskRequest) {
  const title = request.context?.title ?? 'this assignment';
  const promptSnippet = request.context?.promptText.slice(0, 260) ?? 'the visible Canvas instructions';
  const toneLead =
    request.toneProfile?.formality === 'formal'
      ? 'This draft uses a more formal academic register.'
      : request.toneProfile?.formality === 'conversational'
        ? 'This draft keeps a clearer and more conversational tone.'
        : 'This draft stays balanced and classroom-appropriate.';

  if (request.task === 'discussion_post') {
    return [
      `${toneLead}`,
      '',
      `After reviewing ${title}, my main takeaway is that ${promptSnippet.toLowerCase()}.`,
      '',
      'One point that stands out is how the assignment expects the writer to connect course ideas to a clear example or interpretation. That makes the response stronger because it shows understanding rather than summary alone.',
      '',
      'If I were posting this in class, I would make sure the final version uses one concrete reference from the reading or prompt before submitting.'
    ].join('\n');
  }

  if (request.task === 'quiz_assist') {
    return [
      'Study hint:',
      'Start by identifying the concept behind the question instead of chasing a fast answer.',
      'Then compare each option against the definition, formula, or reading concept the page is emphasizing.'
    ].join('\n');
  }

  return [
    `${toneLead}`,
    '',
    `This working draft responds to ${title} by focusing on ${promptSnippet.toLowerCase()}.`,
    '',
    'The introduction should frame the core question in direct language and set up the response structure. From there, each body section should connect a single claim to evidence from the assignment materials, class readings, or the student\'s own interpretation.',
    '',
    'The final paragraph should not just repeat the introduction. It should show what the assignment proves, why it matters, and what still deserves review before turning it in.'
  ].join('\n');
}

export function buildLocalToneProfileResponse(samples: ScanPagePayload[]): ToneProfileResponse {
  const usableSamples = samples.filter((sample) => sample.readableText.trim().length > 120);
  const toneProfile = deriveToneProfile(usableSamples.length ? usableSamples : samples);

  return {
    toneProfile,
    message: usableSamples.length
      ? 'Okay, I\'ve got a good sense of your style. What are we working on today?'
      : 'I created a starter tone profile from the visible page. For a stronger profile, scan one or two prior papers or discussion posts next.'
  };
}

export function buildLocalTaskOutput(request: ApiTaskRequest): TaskOutput {
  const sources = request.scannedPages.slice(-2).map((page) => page.title).join(', ');

  return {
    summary:
      request.context?.title
        ? `I reviewed ${request.context.title}${sources ? ` and also used ${sources}` : ''}.`
        : 'I reviewed the visible page and built a starter response.',
    checklist: buildChecklist(request),
    proposedStructure: buildStructure(request),
    draft: buildDraft(request),
    explanation:
      request.context?.quizSafetyMode === 'active_attempt'
        ? 'This page appears to be an active assessment, so I stayed in study-support mode and focused on concepts rather than direct answer injection.'
        : `I used the visible prompt, any rubric clues, and your extra instructions${sources ? ` plus scanned references from ${sources}` : ''} to build an editable first pass rather than a ready-to-submit final answer.`,
    reviewAreas: [
      'Check every factual claim against the actual assignment prompt or reading.',
      'Replace placeholders with your own examples, evidence, or citations.',
      'Make sure the final tone still sounds like you before submitting.'
    ],
    alternateVersion:
      request.task === 'discussion_post'
        ? 'Shorter version: I think the strongest reading of this prompt is the one that connects the main concept to a concrete course example, because that shows both understanding and reflection.'
        : undefined,
    citationPlaceholders:
      request.task === 'discussion_post' || request.task === 'build_draft'
        ? ['[Add source or reading citation here]', '[Add instructor-approved evidence here]']
        : undefined
  };
}
