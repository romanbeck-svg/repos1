export const ANALYSIS_MODES = ['answer', 'summary', 'quick_summary', 'chart', 'send_to_doc'] as const;

export type AnalysisMode = (typeof ANALYSIS_MODES)[number];
export type AnalysisCacheStatus = 'hit' | 'miss';
export type AnalysisRunPhase =
  | 'idle'
  | 'collecting_context'
  | 'cache_hit'
  | 'requesting_backend'
  | 'streaming'
  | 'completed'
  | 'error'
  | 'cancelled';

export interface AnalysisChartDataset {
  label: string;
  data: number[];
}

export interface AnalysisChart {
  type: 'bar' | 'line' | 'pie' | 'table';
  title: string;
  labels: string[];
  datasets: AnalysisChartDataset[];
}

export interface StructuredAnalysisOutput {
  title: string;
  text: string;
  bullets: string[];
  chart: AnalysisChart | null;
  actions: string[];
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

export interface AnalysisPagePayload {
  url: string;
  title: string;
  text: string;
}

export interface AnalyzeRequestBody {
  mode: AnalysisMode;
  instruction: string;
  page: AnalysisPagePayload;
  screenshotBase64: string | null;
}

export interface AnalysisResponseMeta {
  requestId?: string;
  timings?: AnalysisTimingMetrics;
  cacheStatus?: AnalysisCacheStatus;
}

export interface AnalyzeSuccessResponse {
  ok: true;
  mode: AnalysisMode;
  output: StructuredAnalysisOutput;
  meta?: AnalysisResponseMeta;
}

export interface AnalyzeFailureResponse {
  ok: false;
  error: string;
}

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
}

export type AnalysisStreamEvent =
  | AnalysisStreamStatusEvent
  | AnalysisStreamDeltaEvent
  | AnalysisStreamCompleteEvent
  | AnalysisStreamErrorEvent;
