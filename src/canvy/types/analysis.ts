export const ANALYSIS_MODES = ['answer', 'summary', 'quick_summary', 'chart', 'send_to_doc'] as const;

export type AnalysisMode = (typeof ANALYSIS_MODES)[number];
export type AnalysisCacheStatus = 'hit' | 'miss';
export type AnalysisResultState =
  | 'success'
  | 'no_questions'
  | 'insufficient_context'
  | 'invalid_ai_output'
  | 'transport_error';
export type AnalysisAiTag = 'success' | 'no_questions' | 'insufficient_context' | 'error';
export type AnalysisExtractionMode = 'dom' | 'vision' | 'hybrid';
export type AnalysisQuestionStatus = 'answered' | 'insufficient_context';
export type AnalysisRunPhase =
  | 'idle'
  | 'collecting_context'
  | 'cache_hit'
  | 'requesting_backend'
  | 'streaming'
  | 'completed'
  | 'error'
  | 'cancelled';

export interface AnalysisQuestionCandidate {
  id: string;
  question: string;
  sectionLabel?: string;
  nearbyText: string[];
  answerChoices: string[];
  sourceAnchor: string;
  selectorHint?: string;
}

export interface AnalysisPagePayload {
  url: string;
  title: string;
  text: string;
  headings: string[];
  blocks: string[];
  questionCandidates: AnalysisQuestionCandidate[];
  extractionNotes?: string[];
}

export interface AnalysisRequestPayload {
  mode: AnalysisMode;
  instruction: string;
  page: AnalysisPagePayload;
  screenshotBase64: string | null;
}

export interface AnalysisQuestionResult {
  id: string;
  question: string;
  answer: string;
  context: string;
  answered: boolean;
  status: AnalysisQuestionStatus;
  confidence: number;
  evidence: string[];
  source_anchor: string;
}

export interface AnalysisValidationSummary {
  modelCallSucceeded: boolean;
  finishReason: string;
  parseSuccess: boolean;
  schemaValid: boolean;
  echoGuardHit: boolean;
  candidateQuestionCount: number;
  answeredQuestionCount: number;
}

export interface StructuredAnalysisOutput {
  resultState: Exclude<AnalysisResultState, 'transport_error'>;
  ai_tag: AnalysisAiTag;
  extraction_mode: AnalysisExtractionMode;
  questions: AnalysisQuestionResult[];
  aiTaggedSuccessfully: boolean;
  validation: AnalysisValidationSummary;
  message: string;
}

export interface AnalysisTimingMetrics {
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  contextMs?: number;
  cacheMs?: number;
  serializationMs?: number;
  normalizationMs?: number;
  backendMs?: number;
  modelMs?: number;
  firstChunkMs?: number;
  totalMs?: number;
  renderMs?: number;
  retryCount?: number;
}

export interface AnalysisResponseMeta {
  requestId?: string;
  timings?: AnalysisTimingMetrics;
  cacheStatus?: AnalysisCacheStatus;
}

export interface AnalysisSuccessResponse {
  ok: true;
  mode: AnalysisMode;
  output: StructuredAnalysisOutput;
  meta?: AnalysisResponseMeta;
}

export interface AnalysisFailureResponse {
  ok: false;
  error: string;
  resultState: 'transport_error';
  meta?: AnalysisResponseMeta;
}

export type AnalysisApiResponse = AnalysisSuccessResponse | AnalysisFailureResponse;

export interface AnalysisStreamStatusEvent {
  type: 'status';
  requestId: string;
  phase: Exclude<AnalysisRunPhase, 'idle' | 'completed' | 'error' | 'cancelled'>;
  message: string;
  timings?: Partial<AnalysisTimingMetrics>;
  cacheStatus?: AnalysisCacheStatus;
}

export interface AnalysisStreamDeltaEvent {
  type: 'delta';
  requestId: string;
  chunk: string;
  accumulatedText: string;
}

export interface AnalysisStreamCompleteEvent {
  type: 'complete';
  requestId: string;
  mode: AnalysisMode;
  output: StructuredAnalysisOutput;
  meta?: AnalysisResponseMeta;
}

export interface AnalysisStreamErrorEvent {
  type: 'error';
  requestId: string;
  error: string;
  resultState?: 'transport_error';
}

export type AnalysisStreamEvent =
  | AnalysisStreamStatusEvent
  | AnalysisStreamDeltaEvent
  | AnalysisStreamCompleteEvent
  | AnalysisStreamErrorEvent;
