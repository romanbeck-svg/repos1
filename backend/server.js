import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import OpenAI from 'openai';

const app = express();
const port = process.env.PORT || 3001;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = 'gpt-4.1-mini';

const SCREENSHOT_PROMPT = `You are analyzing a screenshot the user took because something is wrong or confusing.
Identify the likely problem shown in the screenshot.
Explain the cause briefly.
Give the clearest steps to fix it.
Be specific, practical, and concise.
If the screenshot is ambiguous, say what is most likely and what to check next.
Output only the answer for the user, with no preamble.`;

const TASK_ACTION_PROMPT = `You convert natural-language task commands into JSON actions.
Return valid JSON only.
Return an object with exactly one top-level key: "actions".
"actions" must be an array.
Allowed action types are:
- add_task: { "type": "add_task", "title": string, "notes"?: string, "dueAt"?: string, "priority"?: "high" | "medium" | "low", "workflowState"?: "today" | "next" | "later" | "waiting" | "done" }
- update_task: { "type": "update_task", "id": string, "title"?: string, "notes"?: string, "dueAt"?: string, "priority"?: "high" | "medium" | "low", "workflowState"?: "today" | "next" | "later" | "waiting" | "done" }
- delete_task: { "type": "delete_task", "id": string }
- complete_task: { "type": "complete_task", "id": string, "completed"?: boolean }
Only refer to task ids that exist in the provided task list.
Do not include explanations, markdown, comments, or extra keys.
If the request is ambiguous, return the safest reasonable action or an empty actions array.`;

const ESSAY_REVIEW_PROMPT = `You are an essay proofreader and writing coach.
Evaluate the user's writing using the essay text plus any context they provide.
Return valid JSON only.
Return an object with exactly these keys:
- overallScore: integer from 1 to 10
- verdict: short string summarizing how well the essay works for the stated context
- strengths: array of 2 to 4 concise strings
- issues: array of 2 to 5 concise strings
- nextSteps: array of 3 to 5 practical revision steps in priority order
- suggestedRevision: short optional rewritten sample paragraph or excerpt when helpful
Judge clarity, structure, tone, grammar, and persuasiveness when relevant.
Be specific and practical, not generic.
Base the evaluation on the user's stated context whenever possible.
Do not include markdown, code fences, or any extra keys.`;

const CAPTURE_CLASSIFIER_PROMPT = `You classify a browser page capture for a productivity extension.
Return valid JSON only.
Return an object with exactly these keys:
- kind: one of "task", "reference", "chat_context", "doc_input"
- title: short specific title
- summary: concise 1-2 sentence summary
- suggestedTaskTitle: optional short task title if the capture likely implies an action
- note: optional brief note about why this classification fits
Favor "task" when the page likely contains a concrete action item.
Favor "reference" for informational pages the user may want to keep.
Favor "chat_context" for chat or conversational context.
Favor "doc_input" for material likely to be rewritten, outlined, or proofread.
Do not include extra keys or markdown.`;

const PROMPT_BUILDER_PROMPT = `You improve a browser-context prompt for a productivity assistant.
Return valid JSON only.
Return an object with exactly these keys:
- title: short title for the generated prompt
- prompt: the final prompt text
Make the prompt specific, practical, and ready to send to another AI system.
Preserve the user's intent, but tighten the structure and clarity.
Do not include markdown fences or extra keys.`;

const SESSION_SUMMARY_PROMPT = `You summarize what a user is doing across browser tabs for a local-first workspace tool.
Return valid JSON only.
Return an object with exactly these keys:
- summary: 2-4 sentences explaining the current work session
- nextStep: one concrete next step
- suggestedWorkspaceName: a short workspace name like "Job Search" or "Research Sprint"
Use the visible tabs, page context, and tasks to infer the workflow.
Be practical and concise.
Do not include extra keys or markdown.`;

const PAGE_TASK_EXTRACTION_PROMPT = `You extract practical tasks from a browser page capture.
Return valid JSON only.
Return an object with exactly one top-level key: "actions".
"actions" must be an array of add_task actions only.
Each action must use this shape:
{ "type": "add_task", "title": string, "notes"?: string, "dueAt"?: string, "priority"?: "high" | "medium" | "low", "workflowState"?: "today" | "next" | "later" | "waiting" | "done" }
Only create tasks when there is a clear action worth tracking.
Keep tasks concrete and concise.
If there are no clear tasks, return { "actions": [] }.
Do not include markdown, comments, or extra keys.`;

const PAGE_SUMMARY_PROMPT = `You summarize a browser page for a daily-work dashboard.
Return valid JSON only.
Return an object with exactly one key:
- summary: a concise 2-3 sentence summary of what the page is and why it might matter for regular workload
Be practical, not generic.
Do not include markdown or extra keys.`;

const NEXT_TASK_PROMPT = `You choose the single best next task from a task list for a daily work dashboard.
Return valid JSON only.
Return an object with exactly these keys:
- taskId: string or null
- reason: short string
Prefer tasks in workflowState "today", then "next".
Within that, prefer higher priority and nearer due date.
Never pick completed or done tasks.
If there is no good next task, return null for taskId with a short reason.
Do not include markdown or extra keys.`;

const DOCS_TRANSFORM_PROMPT = `You are a writing helper for a browser extension.
Return valid JSON only.
Return an object with exactly these keys:
- output: the transformed writing
- notes: an array of 2 to 4 concise notes describing what changed or what to watch
Supported modes are:
- outline: turn the input into a clean outline
- rewrite: rewrite for clarity and flow
- tone_shift: adjust tone to fit the supplied context
- condense: make it shorter and tighter
- expand: add useful detail without becoming bloated
Be practical and readable.
Do not include markdown fences or extra keys.`;

const TI84_PROGRAM_PROMPT = `You are a TI-84 Plus CE BASIC program generator.
Generate a complete TI-BASIC program for the requested subject.
Return only raw TI-BASIC code.
Do not use markdown, code fences, commentary, or explanations.
All strings must be uppercase ASCII only.
Keep Disp and Menu option strings short enough for a TI-84 screen.
Use only normal TI-BASIC commands like ClrHome, Disp, Pause, Input, Menu(, Lbl, Goto, Stop, If, Then, Else, End, For(, While, Return, Output(.
Use valid labels only, and make sure every Menu option target and every Goto has a matching Lbl.
Include a terms menu and include formula solvers only when the subject genuinely has numeric formulas.
The output must be calculator-ready TI-BASIC code only.`;

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function deriveTi84ProgramName(subject) {
  const upper = String(subject ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  const firstLetter = upper.search(/[A-Z]/);
  const normalized = firstLetter >= 0 ? upper.slice(firstLetter) : 'PROG';
  return normalized.slice(0, 8) || 'PROG';
}

function sanitizeTi84Code(rawText) {
  return rawText
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```$/i, '')
    .replace(/\r\n/g, '\n')
    .trim();
}

async function createJsonResponse(systemPrompt, payload) {
  const response = await openai.responses.create({
    model: MODEL,
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: systemPrompt
          }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: JSON.stringify(payload)
          }
        ]
      }
    ]
  });

  const rawText = response.output_text?.trim();
  if (!rawText) {
    throw new Error('Model returned no JSON output.');
  }

  return JSON.parse(rawText);
}

app.use(cors());
app.use(express.json({ limit: '15mb' }));

app.post('/analyze-screenshot', async (req, res) => {
  try {
    const { screenshot } = req.body ?? {};

    if (typeof screenshot !== 'string' || !screenshot.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Expected a base64 data URL screenshot.' });
    }

    const response = await openai.responses.create({
      model: MODEL,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: SCREENSHOT_PROMPT
            },
            {
              type: 'input_image',
              image_url: screenshot,
              detail: 'high'
            }
          ]
        }
      ]
    });

    const answer = response.output_text?.trim();

    if (!answer) {
      return res.status(502).json({ error: 'Model returned no answer.' });
    }

    return res.json({ answer });
  } catch (error) {
    console.error('analyze-screenshot failed:', error);
    return res.status(500).json({ error: 'Screenshot analysis failed.' });
  }
});

app.post('/task-actions', async (req, res) => {
  try {
    const { command, tasks } = req.body ?? {};

    if (typeof command !== 'string' || !command.trim()) {
      return res.status(400).json({ error: 'Expected a non-empty command string.' });
    }

    if (!Array.isArray(tasks)) {
      return res.status(400).json({ error: 'Expected a tasks array.' });
    }

    const parsed = await createJsonResponse(TASK_ACTION_PROMPT, { command, tasks });
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.actions)) {
      return res.status(502).json({ error: 'Model JSON did not match the task action contract.' });
    }

    return res.json({ actions: parsed.actions });
  } catch (error) {
    console.error('task-actions failed:', error);
    return res.status(500).json({ error: 'Task command parsing failed.' });
  }
});

app.post('/classify-capture', async (req, res) => {
  try {
    const { context, note } = req.body ?? {};

    if (!context || typeof context !== 'object') {
      return res.status(400).json({ error: 'Expected page context.' });
    }

    const parsed = await createJsonResponse(CAPTURE_CLASSIFIER_PROMPT, {
      note: typeof note === 'string' ? note : '',
      context
    });

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !['task', 'reference', 'chat_context', 'doc_input'].includes(parsed.kind) ||
      typeof parsed.title !== 'string' ||
      typeof parsed.summary !== 'string' ||
      (parsed.suggestedTaskTitle !== undefined && typeof parsed.suggestedTaskTitle !== 'string') ||
      (parsed.note !== undefined && typeof parsed.note !== 'string')
    ) {
      return res.status(502).json({ error: 'Model JSON did not match the capture contract.' });
    }

    return res.json({
      kind: parsed.kind,
      title: parsed.title.trim(),
      summary: parsed.summary.trim(),
      suggestedTaskTitle: typeof parsed.suggestedTaskTitle === 'string' ? parsed.suggestedTaskTitle.trim() : undefined,
      note: typeof parsed.note === 'string' ? parsed.note.trim() : undefined
    });
  } catch (error) {
    console.error('classify-capture failed:', error);
    return res.status(500).json({ error: 'Capture classification failed.' });
  }
});

app.post('/generate-prompt', async (req, res) => {
  try {
    const { templateTitle, template, pageContext, tasks } = req.body ?? {};

    if (typeof templateTitle !== 'string' || typeof template !== 'string' || !pageContext) {
      return res.status(400).json({ error: 'Expected template and page context.' });
    }

    const parsed = await createJsonResponse(PROMPT_BUILDER_PROMPT, {
      templateTitle,
      template,
      pageContext,
      tasks: Array.isArray(tasks) ? tasks : []
    });

    if (!parsed || typeof parsed !== 'object' || typeof parsed.title !== 'string' || typeof parsed.prompt !== 'string') {
      return res.status(502).json({ error: 'Model JSON did not match the prompt contract.' });
    }

    return res.json({
      title: parsed.title.trim(),
      prompt: parsed.prompt.trim()
    });
  } catch (error) {
    console.error('generate-prompt failed:', error);
    return res.status(500).json({ error: 'Prompt generation failed.' });
  }
});

app.post('/summarize-session', async (req, res) => {
  try {
    const { nameHint, pageContext, tasks, tabs } = req.body ?? {};

    const parsed = await createJsonResponse(SESSION_SUMMARY_PROMPT, {
      nameHint: typeof nameHint === 'string' ? nameHint : '',
      pageContext,
      tasks: Array.isArray(tasks) ? tasks : [],
      tabs: Array.isArray(tabs) ? tabs : []
    });

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.summary !== 'string' ||
      typeof parsed.nextStep !== 'string' ||
      typeof parsed.suggestedWorkspaceName !== 'string'
    ) {
      return res.status(502).json({ error: 'Model JSON did not match the session summary contract.' });
    }

    return res.json({
      summary: parsed.summary.trim(),
      nextStep: parsed.nextStep.trim(),
      suggestedWorkspaceName: parsed.suggestedWorkspaceName.trim()
    });
  } catch (error) {
    console.error('summarize-session failed:', error);
    return res.status(500).json({ error: 'Session summarization failed.' });
  }
});

app.post('/extract-page-tasks', async (req, res) => {
  try {
    const { context } = req.body ?? {};

    if (!context || typeof context !== 'object') {
      return res.status(400).json({ error: 'Expected page context.' });
    }

    const parsed = await createJsonResponse(PAGE_TASK_EXTRACTION_PROMPT, { context });
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.actions)) {
      return res.status(502).json({ error: 'Model JSON did not match the page task contract.' });
    }

    return res.json({ actions: parsed.actions });
  } catch (error) {
    console.error('extract-page-tasks failed:', error);
    return res.status(500).json({ error: 'Page task extraction failed.' });
  }
});

app.post('/summarize-page', async (req, res) => {
  try {
    const { context } = req.body ?? {};

    if (!context || typeof context !== 'object') {
      return res.status(400).json({ error: 'Expected page context.' });
    }

    const parsed = await createJsonResponse(PAGE_SUMMARY_PROMPT, { context });
    if (!parsed || typeof parsed !== 'object' || typeof parsed.summary !== 'string') {
      return res.status(502).json({ error: 'Model JSON did not match the page summary contract.' });
    }

    return res.json({ summary: parsed.summary.trim() });
  } catch (error) {
    console.error('summarize-page failed:', error);
    return res.status(500).json({ error: 'Page summary failed.' });
  }
});

app.post('/suggest-next-task', async (req, res) => {
  try {
    const { tasks } = req.body ?? {};

    if (!Array.isArray(tasks)) {
      return res.status(400).json({ error: 'Expected a tasks array.' });
    }

    const parsed = await createJsonResponse(NEXT_TASK_PROMPT, { tasks });
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !(typeof parsed.taskId === 'string' || parsed.taskId === null) ||
      typeof parsed.reason !== 'string'
    ) {
      return res.status(502).json({ error: 'Model JSON did not match the next task contract.' });
    }

    return res.json({
      taskId: parsed.taskId,
      reason: parsed.reason.trim()
    });
  } catch (error) {
    console.error('suggest-next-task failed:', error);
    return res.status(500).json({ error: 'Next task suggestion failed.' });
  }
});

app.post('/proofread-essay', async (req, res) => {
  try {
    const { essay, context } = req.body ?? {};

    if (typeof essay !== 'string' || !essay.trim()) {
      return res.status(400).json({ error: 'Expected non-empty essay text.' });
    }

    const parsed = await createJsonResponse(ESSAY_REVIEW_PROMPT, {
      context: typeof context === 'string' ? context : '',
      essay
    });

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Number.isInteger(parsed.overallScore) ||
      parsed.overallScore < 1 ||
      parsed.overallScore > 10 ||
      typeof parsed.verdict !== 'string' ||
      !isStringArray(parsed.strengths) ||
      !isStringArray(parsed.issues) ||
      !isStringArray(parsed.nextSteps) ||
      (parsed.suggestedRevision !== undefined && typeof parsed.suggestedRevision !== 'string')
    ) {
      return res.status(502).json({ error: 'Model JSON did not match the essay review contract.' });
    }

    return res.json({
      overallScore: parsed.overallScore,
      verdict: parsed.verdict.trim(),
      strengths: parsed.strengths.map((item) => item.trim()).filter(Boolean),
      issues: parsed.issues.map((item) => item.trim()).filter(Boolean),
      nextSteps: parsed.nextSteps.map((item) => item.trim()).filter(Boolean),
      suggestedRevision: typeof parsed.suggestedRevision === 'string' ? parsed.suggestedRevision.trim() : undefined
    });
  } catch (error) {
    console.error('proofread-essay failed:', error);
    return res.status(500).json({ error: 'Essay proofreading failed.' });
  }
});

app.post('/transform-writing', async (req, res) => {
  try {
    const { mode, text, context } = req.body ?? {};

    if (!['outline', 'rewrite', 'tone_shift', 'condense', 'expand'].includes(mode)) {
      return res.status(400).json({ error: 'Expected a supported transform mode.' });
    }

    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'Expected text to transform.' });
    }

    const parsed = await createJsonResponse(DOCS_TRANSFORM_PROMPT, {
      mode,
      text,
      context: typeof context === 'string' ? context : ''
    });

    if (!parsed || typeof parsed !== 'object' || typeof parsed.output !== 'string' || !isStringArray(parsed.notes)) {
      return res.status(502).json({ error: 'Model JSON did not match the docs transform contract.' });
    }

    return res.json({
      output: parsed.output.trim(),
      notes: parsed.notes.map((item) => item.trim()).filter(Boolean)
    });
  } catch (error) {
    console.error('transform-writing failed:', error);
    return res.status(500).json({ error: 'Docs transform failed.' });
  }
});

app.post('/generate-ti84-program', async (req, res) => {
  try {
    const { subject } = req.body ?? {};

    if (typeof subject !== 'string' || !subject.trim()) {
      return res.status(400).json({ error: 'Expected a non-empty subject.' });
    }

    const response = await openai.responses.create({
      model: MODEL,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: TI84_PROGRAM_PROMPT
            }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: subject.trim()
            }
          ]
        }
      ]
    });

    const code = sanitizeTi84Code(response.output_text ?? '');
    if (!code) {
      return res.status(502).json({ error: 'Model returned no TI-BASIC code.' });
    }

    return res.json({
      programName: deriveTi84ProgramName(subject),
      code
    });
  } catch (error) {
    console.error('generate-ti84-program failed:', error);
    return res.status(500).json({ error: 'TI-84 generation failed.' });
  }
});

app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});
