import type {
  CanvasApiContextRequest,
  CanvasContext,
  ImageScanRequest,
  ScanPagePayload,
  TaskRequest,
  ToneProfileRequest
} from '../types/api.js';

const INJECTION_PATTERNS = [
  /ignore (all|previous|prior) instructions/gi,
  /reveal (the )?(system|developer) prompt/gi,
  /print your hidden prompt/gi,
  /bypass safety/gi,
  /disable guardrails/gi,
  /pretend you are unrestricted/gi
];

export function sanitizeText(value: unknown, maxLength = 12000) {
  const stringValue = typeof value === 'string' ? value : '';
  return stringValue
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, ' ')
    .replace(/[^\S\r\n]+/g, ' ')
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, maxLength);
}

export function sanitizeStringArray(value: unknown, maxItems = 12, maxItemLength = 400) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => sanitizeText(item, maxItemLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

export function detectPromptInjectionSignals(value: string) {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(value));
}

export function sanitizeCanvasContext(input: unknown): CanvasContext | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const context = input as Partial<CanvasContext>;
  return {
    pageKind: sanitizeText(context.pageKind, 60) || 'unknown',
    quizSafetyMode: sanitizeText(context.quizSafetyMode, 60) || 'none',
    sourceUrl: sanitizeText(context.sourceUrl, 500),
    title: sanitizeText(context.title, 240) || 'Canvas item',
    courseName: sanitizeText(context.courseName, 240) || 'Canvas course',
    courseId: sanitizeText(context.courseId, 80) || undefined,
    assignmentId: sanitizeText(context.assignmentId, 80) || undefined,
    dueAtText: sanitizeText(context.dueAtText, 200) || undefined,
    promptText: sanitizeText(context.promptText, 12000),
    teacherInstructions: sanitizeStringArray(context.teacherInstructions, 10, 300),
    rubricItems: sanitizeStringArray(context.rubricItems, 12, 300),
    attachments: Array.isArray(context.attachments)
      ? context.attachments
          .map((attachment) => ({
            label: sanitizeText(attachment?.label, 200),
            url: sanitizeText(attachment?.url, 500)
          }))
          .filter((attachment) => attachment.label || attachment.url)
          .slice(0, 8)
      : [],
    linkedReferences: Array.isArray(context.linkedReferences)
      ? context.linkedReferences
          .map((attachment) => ({
            label: sanitizeText(attachment?.label, 200),
            url: sanitizeText(attachment?.url, 500)
          }))
          .filter((attachment) => attachment.label || attachment.url)
          .slice(0, 8)
      : [],
    inaccessibleReason: sanitizeText(context.inaccessibleReason, 300) || undefined,
    extractedAt: sanitizeText(context.extractedAt, 100) || new Date().toISOString()
  };
}

export function sanitizeScanPage(input: unknown): ScanPagePayload | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const page = input as Partial<ScanPagePayload>;
  return {
    title: sanitizeText(page.title, 240) || 'Scanned page',
    url: sanitizeText(page.url, 500),
    readableText: sanitizeText(page.readableText, 12000),
    headings: sanitizeStringArray(page.headings, 12, 200),
    sourceType: page.sourceType === 'tone_sample' ? 'tone_sample' : 'reference',
    pageType: page.pageType === 'canvas' || page.pageType === 'docs' ? page.pageType : 'generic',
    sourceMode: page.sourceMode === 'docs_dom' || page.sourceMode === 'image_ocr' ? page.sourceMode : 'dom',
    extractionNotes: sanitizeStringArray(page.extractionNotes, 6, 240),
    scannedAt: sanitizeText(page.scannedAt, 100) || new Date().toISOString()
  };
}

export function sanitizeImageScanRequest(input: unknown): ImageScanRequest | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const payload = input as Partial<ImageScanRequest>;
  const imageDataUrl = sanitizeText(payload.imageDataUrl, 5_000_000);
  if (!imageDataUrl.startsWith('data:image/')) {
    return null;
  }

  return {
    title: sanitizeText(payload.title, 240) || 'Scanned page',
    url: sanitizeText(payload.url, 500),
    imageDataUrl,
    sourceType: payload.sourceType === 'tone_sample' ? 'tone_sample' : 'reference',
    pageType: payload.pageType === 'canvas' || payload.pageType === 'docs' ? payload.pageType : 'generic'
  };
}

export function sanitizeTaskRequest(task: TaskRequest['task'], input: unknown): TaskRequest {
  const payload = (input || {}) as Partial<TaskRequest>;
  return {
    sessionId: sanitizeText(payload.sessionId, 120) || crypto.randomUUID(),
    task,
    context: sanitizeCanvasContext(payload.context),
    scannedPages: Array.isArray(payload.scannedPages) ? payload.scannedPages.map(sanitizeScanPage).filter(Boolean) as ScanPagePayload[] : [],
    extraInstructions: sanitizeText(payload.extraInstructions, 2000),
    toneProfile: payload.toneProfile,
    previousOutput: payload.previousOutput
  };
}

export function sanitizeToneProfileRequest(input: unknown): ToneProfileRequest {
  const payload = (input || {}) as Partial<ToneProfileRequest>;
  return {
    consentGranted: Boolean(payload.consentGranted),
    samples: Array.isArray(payload.samples)
      ? (payload.samples.map(sanitizeScanPage).filter(Boolean) as ScanPagePayload[]).slice(0, 1)
      : []
  };
}

export function sanitizeCanvasApiContextRequest(input: unknown): CanvasApiContextRequest {
  const payload = (input || {}) as Partial<CanvasApiContextRequest>;
  return {
    sourceUrl: sanitizeText(payload.sourceUrl, 500),
    courseId: sanitizeText(payload.courseId, 80) || undefined,
    assignmentId: sanitizeText(payload.assignmentId, 80) || undefined
  };
}
