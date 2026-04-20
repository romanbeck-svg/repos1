import type {
  AIProvider,
  AIWorkflowInput,
  AIWorkflowResult,
  AutofillSuggestion,
  FormFieldInfo,
  ProviderMode,
  SuggestedTask,
  WorkflowIntent
} from './types';

function compactText(input: AIWorkflowInput) {
  return [
    input.userPrompt,
    input.pageContext.selectedText,
    input.screenshot?.ocrText,
    input.pageContext.excerpt
  ]
    .filter(Boolean)
    .join('\n')
    .trim();
}

function splitLines(text: string) {
  return text
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function unique<T>(values: T[]) {
  return Array.from(new Set(values));
}

function collectKeyLines(input: AIWorkflowInput) {
  const lines = splitLines(compactText(input));
  const scored = lines.map((line) => {
    let score = 0;
    if (/error|warning|failed|required|deadline|due|urgent|review|submit|fix|todo|follow up|action/i.test(line)) score += 4;
    if (/headings:|alerts:|buttons:|list items:/i.test(line)) score += 3;
    if (line.length > 35 && line.length < 220) score += 2;
    if (/https?:\/\//i.test(line)) score -= 2;
    return { line, score };
  });

  return scored
    .sort((left, right) => right.score - left.score)
    .map((item) => item.line)
    .filter((line, index, all) => all.indexOf(line) === index)
    .slice(0, 8);
}

function inferPageState(input: AIWorkflowInput) {
  const text = compactText(input).toLowerCase();
  const keyLines = collectKeyLines(input);
  const firstAlert = keyLines.find((line) => /error|warning|failed|required|notice/i.test(line));
  const hasForm = input.pageContext.siteKind === 'form' || input.pageContext.formFields.length > 0;

  return {
    hasForm,
    hasScreenshot: Boolean(input.screenshot),
    firstAlert: firstAlert ?? '',
    likelyProblem:
      firstAlert ||
      (text.includes('deadline') ? 'A deadline or time-sensitive item is visible.' : '') ||
      (text.includes('submit') ? 'There appears to be a submission or completion step on the page.' : '') ||
      (text.includes('review') ? 'The page is asking for review or follow-up work.' : '') ||
      ''
  };
}

function buildSummaryResult(input: AIWorkflowInput): AIWorkflowResult {
  const keyLines = collectKeyLines(input);
  const pageState = inferPageState(input);
  const bullets = unique([
    pageState.likelyProblem || '',
    keyLines[0] || '',
    keyLines[1] || '',
    input.pageContext.formFields.length ? `Detected ${input.pageContext.formFields.length} visible form field${input.pageContext.formFields.length === 1 ? '' : 's'}.` : '',
    input.screenshot ? 'A screenshot was captured for this run.' : ''
  ].filter(Boolean)).slice(0, 5);

  const summary =
    pageState.likelyProblem ||
    keyLines[0] ||
    `${input.pageContext.title} appears to be a ${input.pageContext.siteKind} page with visible actionable content.`;

  return {
    title: 'Quick summary',
    summary,
    bullets,
    providerNotes: [
      'Local mode used structured page heuristics instead of a cloud model.',
      'TODO: replace this with browser-native on-device summarization when available.'
    ]
  };
}

function buildAnswerResult(input: AIWorkflowInput): AIWorkflowResult {
  const keyLines = collectKeyLines(input);
  const pageState = inferPageState(input);
  const bullets = [
    pageState.likelyProblem || 'The visible content does not show a clear failure, so Walt focused on the most concrete next action it could infer.',
    input.pageContext.selectedText
      ? 'Selected text was treated as the highest-priority context.'
      : 'Walt used visible headings, alerts, buttons, and page text to infer what is happening.',
    pageState.hasForm
      ? 'This page includes form-like elements, so a likely next step is to review fields before submitting.'
      : 'This page looks more informational than form-driven.'
  ];

  let summary = '';
  if (input.intent === 'what_should_i_do') {
    if (pageState.hasForm) {
      summary = 'Review the visible form fields, confirm any required inputs, and only submit after checking the alert or instruction text shown on the page.';
    } else if (pageState.likelyProblem) {
      summary = `Start with the issue Walt detected: ${pageState.likelyProblem} Then capture the next concrete fix or follow-up task.`;
    } else {
      summary = `Review the main visible section of ${input.pageContext.title}, identify the next concrete action, and save it as a task or doc draft if it needs follow-up.`;
    }
  } else {
    summary = pageState.likelyProblem
      ? `Walt’s best local read is: ${pageState.likelyProblem}`
      : keyLines[0] || `${input.pageContext.title} appears to be about ${input.pageContext.siteKind} work on the current page.`;
  }

  return {
    title: input.intent === 'what_should_i_do' ? 'What should I do?' : 'Give me an answer',
    summary,
    bullets: unique([...bullets, ...keyLines.slice(0, 2)]).slice(0, 5)
  };
}

function normalizeTaskTitle(line: string) {
  return line
    .replace(/^headings:\s*/i, '')
    .replace(/^alerts:\s*/i, '')
    .replace(/^buttons:\s*/i, '')
    .replace(/^list items:\s*/i, '')
    .replace(/^[-*•\d.\s]+/, '')
    .trim()
    .slice(0, 90);
}

function extractCandidateTasks(input: AIWorkflowInput): SuggestedTask[] {
  const lines = collectKeyLines(input);
  const taskish = lines.filter((line) =>
    /(need to|todo|follow up|send|review|fix|update|create|finish|draft|email|call|schedule|submit|check|required|complete|respond|approve|sign)/i.test(line)
  );

  const derived = taskish.map((line) => ({
    title: normalizeTaskTitle(line),
    notes: `Captured from page context: ${line}`,
    source: input.screenshot ? 'screenshot' : 'page'
  })) as SuggestedTask[];

  const pageState = inferPageState(input);
  const fallbacks: SuggestedTask[] = [];

  if (input.pageContext.siteKind === 'form') {
    fallbacks.push({
      title: `Review and complete form on ${input.pageContext.title}`,
      notes: 'Walt detected a form page but could not find a more explicit task line.',
      source: input.screenshot ? 'screenshot' : 'page'
    });
  }

  if (pageState.firstAlert) {
    fallbacks.push({
      title: `Investigate visible issue on ${input.pageContext.title}`,
      notes: pageState.firstAlert,
      source: input.screenshot ? 'screenshot' : 'page'
    });
  }

  const headingTask = lines.find((line) => /headings:/i.test(line) || /alerts:/i.test(line));
  if (headingTask) {
    fallbacks.push({
      title: `Review main context on ${input.pageContext.title}`,
      notes: headingTask,
      source: input.screenshot ? 'screenshot' : 'page'
    });
  }

  const buttonTask = lines.find((line) => /buttons:/i.test(line));
  if (buttonTask) {
    fallbacks.push({
      title: `Check available actions on ${input.pageContext.title}`,
      notes: buttonTask,
      source: input.screenshot ? 'screenshot' : 'page'
    });
  }

  if (!fallbacks.length) {
    fallbacks.push({
      title: `Review ${input.pageContext.title}`,
      notes: 'Walt could not find an explicit action line, so it created a conservative review task from the page context.',
      source: input.screenshot ? 'screenshot' : 'page'
    });
  }

  return unique(
    [...derived, ...fallbacks]
      .map((task) => JSON.stringify(task))
  )
    .map((task) => JSON.parse(task) as SuggestedTask)
    .slice(0, 6);
}

function suggestValues(fields: FormFieldInfo[], text: string): AutofillSuggestion[] {
  const emailMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? '';
  const phoneMatch = text.match(/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?){2}\d{4}/)?.[0] ?? '';
  const firstSentence = splitLines(text)[0] ?? '';

  return fields.slice(0, 8).map((field) => {
    const label = `${field.label} ${field.name} ${field.placeholder}`.toLowerCase();
    let value = '';
    let reason = 'No strong suggestion was found from the visible page context.';

    if (label.includes('email') && emailMatch) {
      value = emailMatch;
      reason = 'An email address was found in the current page context.';
    } else if ((label.includes('phone') || label.includes('mobile') || label.includes('tel')) && phoneMatch) {
      value = phoneMatch;
      reason = 'A phone number was found in the current page context.';
    } else if (label.includes('message') || label.includes('details') || label.includes('notes')) {
      value = firstSentence.slice(0, 180);
      reason = 'Walt used the leading visible sentence as a draft message suggestion.';
    } else if (label.includes('name')) {
      value = 'Review name before filling';
      reason = 'This looks like a name field, but Walt does not infer personal names locally.';
    }

    return {
      fieldId: field.id,
      fieldLabel: field.label || field.name || field.placeholder || 'Unnamed field',
      value,
      reason
    };
  });
}

class LocalProvider implements AIProvider {
  async summarize(input: AIWorkflowInput): Promise<AIWorkflowResult> {
    return buildSummaryResult(input);
  }

  async answer(input: AIWorkflowInput): Promise<AIWorkflowResult> {
    return buildAnswerResult(input);
  }

  async extractTasks(input: AIWorkflowInput): Promise<AIWorkflowResult> {
    const suggestedTasks = extractCandidateTasks(input);
    return {
      title: 'Task extraction',
      summary: `Walt extracted ${suggestedTasks.length} concise next-step task${suggestedTasks.length === 1 ? '' : 's'} from the current ${input.screenshot ? 'screenshot and page' : 'page'} context.`,
      bullets: suggestedTasks.map((task) => `${task.title}: ${task.notes}`),
      suggestedTasks
    };
  }

  async classifyIntent(input: AIWorkflowInput) {
    const prompt = `${input.userPrompt ?? ''}\n${input.pageContext.selectedText}\n${input.pageContext.excerpt}`.toLowerCase();
    const matches: Array<{ intent: WorkflowIntent; keywords: string[] }> = [
      { intent: 'extract_tasks', keywords: ['task', 'todo', 'follow up', 'action item', 'what needs doing'] },
      { intent: 'send_to_doc', keywords: ['doc', 'document', 'notes', 'write this up'] },
      { intent: 'quick_summary', keywords: ['summary', 'summarize', 'tl;dr'] },
      { intent: 'autofill_suggestions', keywords: ['form', 'fill', 'autofill', 'populate'] },
      { intent: 'page_understanding', keywords: ['understand', 'what is this page', 'what is happening'] },
      { intent: 'answer', keywords: ['answer', 'solve', 'explain'] },
      { intent: 'what_should_i_do', keywords: ['what should i do', 'next step', 'help me', 'what now'] }
    ];

    const hit = matches.find((entry) => entry.keywords.some((keyword) => prompt.includes(keyword)));
    return {
      intent: hit?.intent ?? input.intent,
      confidence: hit ? 0.86 : 0.58,
      reason: hit ? `Matched local keywords for ${hit.intent}.` : 'No strong keyword match was found, so Walt kept the requested workflow.'
    };
  }
}

class GoogleConnectedProvider implements AIProvider {
  constructor(private readonly localProvider: LocalProvider) {}

  summarize(input: AIWorkflowInput) {
    return this.localProvider.summarize(input);
  }

  answer(input: AIWorkflowInput) {
    return this.localProvider.answer(input);
  }

  extractTasks(input: AIWorkflowInput) {
    return this.localProvider.extractTasks(input);
  }

  classifyIntent(input: AIWorkflowInput) {
    return this.localProvider.classifyIntent(input);
  }
}

class BackendStubProvider implements AIProvider {
  private buildStub(intent: WorkflowIntent): AIWorkflowResult {
    return {
      title: 'Backend mode stub',
      summary: `Backend mode is reserved for future cloud models and is not implemented yet for ${intent}.`,
      bullets: [
        'Switch to Local mode for stronger built-in heuristics right now.',
        'Use Google mode when you need Docs, Gmail, or Calendar routing.',
        'TODO: wire this provider to a real hosted model once your backend is ready.'
      ]
    };
  }

  async summarize(input: AIWorkflowInput) {
    return this.buildStub(input.intent);
  }

  async answer(input: AIWorkflowInput) {
    return this.buildStub(input.intent);
  }

  async extractTasks(input: AIWorkflowInput) {
    return this.buildStub(input.intent);
  }

  async classifyIntent(input: AIWorkflowInput) {
    return {
      intent: input.intent,
      confidence: 0.3,
      reason: 'Backend mode is stubbed, so Walt kept the requested workflow.'
    };
  }
}

export async function buildPageUnderstanding(input: AIWorkflowInput): Promise<AIWorkflowResult> {
  const keyLines = collectKeyLines(input);
  const pageState = inferPageState(input);

  return {
    title: 'Page understanding',
    summary: pageState.likelyProblem || `${input.pageContext.title} appears to be a ${input.pageContext.siteKind} page with visible actionable content.`,
    bullets: unique([
      `Page type: ${input.pageContext.siteKind}`,
      pageState.firstAlert || '',
      input.pageContext.selectedText ? 'Selected text is available and can be used as the main working context.' : 'No selected text is currently available.',
      input.pageContext.formFields.length
        ? `Detected ${input.pageContext.formFields.length} form field${input.pageContext.formFields.length === 1 ? '' : 's'}.`
        : '',
      ...keyLines.slice(0, 3)
    ].filter(Boolean)).slice(0, 6)
  };
}

export async function buildAutofillSuggestions(input: AIWorkflowInput): Promise<AIWorkflowResult> {
  const text = compactText(input);
  const suggestions = suggestValues(input.pageContext.formFields, text);
  return {
    title: 'Auto form fill suggestions',
    summary: suggestions.length
      ? `Walt prepared ${suggestions.length} field suggestion${suggestions.length === 1 ? '' : 's'} from the current page context.`
      : 'No fillable fields were detected on this page.',
    bullets: suggestions.length
      ? suggestions.map((suggestion) => `${suggestion.fieldLabel}: ${suggestion.value || 'No strong suggestion'}`)
      : ['Open a page with visible form inputs to get fill suggestions.'],
    autofillSuggestions: suggestions
  };
}

const localProvider = new LocalProvider();

export function getProvider(mode: ProviderMode): AIProvider {
  if (mode === 'google') {
    return new GoogleConnectedProvider(localProvider);
  }
  if (mode === 'backend') {
    return new BackendStubProvider();
  }
  return localProvider;
}
