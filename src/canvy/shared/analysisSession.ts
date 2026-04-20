import type {
  AnalysisCacheStatus,
  AnalysisContextCacheEntry,
  AnalysisMode,
  AnalysisRunPhase,
  AnalysisRunSnapshot,
  AnalysisTimingMetrics,
  CanvasContext,
  PageAnalysisResult,
  PageContextSummary,
  ScanPagePayload
} from './types';

const MAX_ANALYSIS_CACHE_ENTRIES = 6;
const ANALYSIS_CACHE_TTL_MS = 30 * 60 * 1000;

function normalizeWhitespace(value: string | undefined | null) {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1).trimEnd()}...` : value;
}

function hashString(value: string) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash).toString(36);
}

function parseTimestamp(value?: string) {
  if (!value) {
    return 0;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function dedupeSections(values: Array<string | undefined | null>) {
  return Array.from(
    new Set(
      values
        .map((value) => normalizeWhitespace(value))
        .filter(Boolean)
    )
  );
}

export function buildPrioritizedAnalysisText(
  pageContext: PageContextSummary | null,
  latestScan?: ScanPagePayload,
  canvasContext?: CanvasContext | null
) {
  const headingBlock = pageContext?.headings.length ? `Headings:\n${pageContext.headings.join('\n')}` : '';
  const scanKeyText = latestScan?.keyText ? `Page excerpt:\n${latestScan.keyText}` : '';
  const scanSections = latestScan?.detectedSections.length ? `Detected sections:\n${latestScan.detectedSections.join('\n')}` : '';
  const canvasPrompt = canvasContext?.promptText ? `Canvas prompt:\n${canvasContext.promptText}` : '';
  const teacherInstructions =
    canvasContext?.teacherInstructions.length ? `Teacher instructions:\n${canvasContext.teacherInstructions.join('\n')}` : '';
  const rubricItems = canvasContext?.rubricItems.length ? `Rubric items:\n${canvasContext.rubricItems.join('\n')}` : '';
  const fallbackPreview = pageContext?.priorityText || pageContext?.previewText || '';
  const baseText = latestScan?.readableText || fallbackPreview;

  return dedupeSections([canvasPrompt, teacherInstructions, rubricItems, headingBlock, scanSections, scanKeyText, baseText]).join('\n\n').slice(0, 8_000);
}

export function createAnalysisFingerprint(
  pageContext: PageContextSummary | null,
  latestScan?: ScanPagePayload,
  canvasContext?: CanvasContext | null
) {
  if (pageContext?.contentFingerprint) {
    return pageContext.contentFingerprint;
  }

  const source = [
    pageContext?.url,
    pageContext?.title,
    pageContext?.previewText,
    pageContext?.headings.join('|'),
    latestScan?.readableText?.slice(0, 800),
    canvasContext?.promptText?.slice(0, 800)
  ]
    .filter(Boolean)
    .join('\n');

  return hashString(source);
}

export function buildAnalysisCacheKey(
  pageContext: PageContextSummary | null,
  mode: AnalysisMode,
  instruction: string,
  latestScan?: ScanPagePayload,
  canvasContext?: CanvasContext | null
) {
  const url = normalizeWhitespace(pageContext?.url) || 'unknown';
  const fingerprint = createAnalysisFingerprint(pageContext, latestScan, canvasContext);
  const normalizedInstruction = normalizeWhitespace(instruction).toLowerCase();
  return `${url}::${mode}::${fingerprint}::${normalizedInstruction}`;
}

export function pruneAnalysisCache(entries: AnalysisContextCacheEntry[] | undefined, now = Date.now()) {
  return (entries ?? [])
    .filter((entry) => now - parseTimestamp(entry.lastUsedAt || entry.createdAt) <= ANALYSIS_CACHE_TTL_MS)
    .sort((left, right) => parseTimestamp(right.lastUsedAt) - parseTimestamp(left.lastUsedAt))
    .slice(0, MAX_ANALYSIS_CACHE_ENTRIES);
}

export function getCachedAnalysis(entries: AnalysisContextCacheEntry[] | undefined, cacheKey: string) {
  const now = Date.now();
  const cache = pruneAnalysisCache(entries, now);
  const hit = cache.find((entry) => entry.key === cacheKey);

  return {
    cache,
    hit
  };
}

export function upsertAnalysisCache(
  entries: AnalysisContextCacheEntry[] | undefined,
  nextEntry: AnalysisContextCacheEntry
) {
  const now = nextEntry.lastUsedAt || new Date().toISOString();
  const merged = [
    {
      ...nextEntry,
      lastUsedAt: now
    },
    ...(entries ?? []).filter((entry) => entry.key !== nextEntry.key)
  ];

  return pruneAnalysisCache(merged);
}

export function createInitialTimingMetrics(startedAt = new Date().toISOString()): AnalysisTimingMetrics {
  return {
    startedAt,
    updatedAt: startedAt,
    retryCount: 0
  };
}

export function createAnalysisRunSnapshot(input: {
  requestId: string;
  pageContext: PageContextSummary | null;
  tabId?: number;
  mode: AnalysisMode;
  instruction: string;
  phase: AnalysisRunPhase;
  statusLabel: string;
  cacheKey?: string;
  cacheStatus?: AnalysisCacheStatus;
  partialText?: string;
  partialTitle?: string;
  result?: PageAnalysisResult;
  timings?: Partial<AnalysisTimingMetrics>;
}) {
  const startedAt = input.timings?.startedAt ?? new Date().toISOString();
  const updatedAt = new Date().toISOString();

  return {
    requestId: input.requestId,
    tabId: input.tabId,
    pageUrl: input.pageContext?.url,
    pageTitle: input.pageContext?.title,
    mode: input.mode,
    instruction: input.instruction,
    phase: input.phase,
    statusLabel: input.statusLabel,
    partialText: input.partialText ?? '',
    partialTitle: input.partialTitle,
    cacheKey: input.cacheKey,
    cacheStatus: input.cacheStatus,
    startedAt,
    updatedAt,
    result: input.result,
    timings: {
      ...createInitialTimingMetrics(startedAt),
      ...input.timings,
      updatedAt
    }
  } satisfies AnalysisRunSnapshot;
}

export function updateAnalysisRunSnapshot(
  current: AnalysisRunSnapshot,
  patch: Partial<Omit<AnalysisRunSnapshot, 'requestId' | 'startedAt' | 'timings'>> & {
    timings?: Partial<AnalysisTimingMetrics>;
  }
) {
  const updatedAt = new Date().toISOString();

  return {
    ...current,
    ...patch,
    updatedAt,
    timings: {
      ...current.timings,
      ...patch.timings,
      startedAt: current.startedAt,
      updatedAt
    }
  } satisfies AnalysisRunSnapshot;
}

export function finalizeAnalysisRunSnapshot(
  current: AnalysisRunSnapshot,
  result: PageAnalysisResult,
  statusLabel: string,
  patch: { cacheStatus?: AnalysisCacheStatus; timings?: Partial<AnalysisTimingMetrics> } = {}
) {
  const completedAt = new Date().toISOString();
  const totalMs = Math.max(0, parseTimestamp(completedAt) - parseTimestamp(current.startedAt));

  return updateAnalysisRunSnapshot(current, {
    phase: 'completed',
    statusLabel,
    partialTitle: result.title,
    partialText: result.text,
    result,
    completedAt,
    cacheStatus: patch.cacheStatus ?? current.cacheStatus,
    timings: {
      completedAt,
      totalMs,
      ...patch.timings
    }
  });
}

export function failAnalysisRunSnapshot(current: AnalysisRunSnapshot, error: string, phase: AnalysisRunPhase = 'error') {
  return updateAnalysisRunSnapshot(current, {
    phase,
    error,
    statusLabel: error,
    completedAt: new Date().toISOString()
  });
}

function decodeJsonStringFragment(value: string) {
  return value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function readPartialField(buffer: string, field: 'title' | 'text', maxLength: number) {
  const match = buffer.match(new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"])*)`, 'is'));
  if (!match?.[1]) {
    return '';
  }

  return truncate(normalizeWhitespace(decodeJsonStringFragment(match[1])), maxLength);
}

export function extractPartialStructuredPreview(buffer: string) {
  const partialTitle = readPartialField(buffer, 'title', 120);
  const partialText = readPartialField(buffer, 'text', 360);

  return {
    partialTitle: partialTitle || undefined,
    partialText
  };
}
