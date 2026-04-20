import type {
  AnalysisApiResponse,
  AnalysisCacheStatus,
  AnalysisChart,
  AnalysisFailureResponse,
  AnalysisResponseMeta,
  AnalysisRunPhase,
  AnalysisStreamEvent,
  AnalysisTimingMetrics,
  AnalysisMode,
  AnalysisRequestPayload,
  AnalysisSuccessResponse,
  StructuredAnalysisOutput
} from '../types/analysis';

export type {
  AnalysisApiResponse,
  AnalysisCacheStatus,
  AnalysisChart,
  AnalysisFailureResponse,
  AnalysisResponseMeta,
  AnalysisRunPhase,
  AnalysisStreamEvent,
  AnalysisTimingMetrics,
  AnalysisMode,
  AnalysisRequestPayload,
  AnalysisSuccessResponse,
  StructuredAnalysisOutput
} from '../types/analysis';

export type CanvasPageKind =
  | 'assignment'
  | 'discussion'
  | 'file'
  | 'quiz'
  | 'quiz_review'
  | 'course_home'
  | 'module'
  | 'reference'
  | 'unknown';

export type QuizSafetyMode = 'none' | 'active_attempt' | 'review' | 'study';
export type BackendConnectionState = 'unknown' | 'connected' | 'degraded' | 'offline';
export type ApiBaseUrlSource = 'env' | 'storage' | 'default';
export type RequestFailureCategory =
  | 'backend_offline'
  | 'wrong_api_url'
  | 'cors_blocked'
  | 'message_channel_closed'
  | 'timeout'
  | 'cancelled'
  | 'http_error'
  | 'invalid_json'
  | 'invalid_response'
  | 'network_error';

export type CanvyTaskKind =
  | 'analyze_assignment'
  | 'build_draft'
  | 'explain_page'
  | 'summarize_reading'
  | 'discussion_post'
  | 'quiz_assist';

export type SidebarMode = 'general' | 'canvas';
export type AssistantSurfaceMode = SidebarMode | 'unsupported';
export type PageSurfaceType = 'canvas' | 'docs' | 'generic';
export type ScanSourceMode = 'dom' | 'docs_dom' | 'image_ocr';
export type ScanStatus = 'idle' | 'scanning' | 'scanned' | 'analyzing' | 'ready' | 'error' | 'stale';
export type AttachStatus = 'ready' | 'attached_after_injection' | 'attach_failed' | 'unsupported';
export type TaskType =
  | 'general_page'
  | 'canvas_course_page'
  | 'file_assignment'
  | 'discussion_post'
  | 'quiz'
  | 'resource_page'
  | 'unknown';
export type TaskPlatform = 'canvas' | 'general_web' | 'unknown';
export type WorkflowRouteId =
  | 'general_analysis_ready'
  | 'course_context_ready'
  | 'file_assignment_ready'
  | 'discussion_workflow_ready'
  | 'quiz_workflow_ready'
  | 'resource_context_ready'
  | 'manual_review_needed';
export type WorkflowActionId =
  | 'summarize_page'
  | 'explain_page'
  | 'extract_key_points'
  | 'summarize_resource'
  | 'extract_notes'
  | 'save_as_context'
  | 'start_assignment_help'
  | 'draft_response'
  | 'prepare_quiz_support'
  | 'apply_instructions';
export type WorkflowType = 'general' | 'resource' | 'file_assignment' | 'discussion_post' | 'quiz';
export type PageSubType =
  | 'article'
  | 'conversation'
  | 'documentation'
  | 'study_resource'
  | 'tool_interface'
  | 'reference_page'
  | 'assignment_prompt'
  | 'unknown';
export type ContentPattern = 'instructional' | 'conversational' | 'article_like' | 'tool_like' | 'mixed' | 'unknown';

export type OpenCanvyFailureReason =
  | 'no_active_tab'
  | 'unsupported_page'
  | 'attach_failed'
  | 'content_unavailable'
  | 'open_timeout'
  | 'open_failed';

export interface CanvasAttachment {
  label: string;
  url: string;
}

export interface CanvasContext {
  pageKind: CanvasPageKind;
  quizSafetyMode: QuizSafetyMode;
  sourceUrl: string;
  title: string;
  courseName: string;
  courseId?: string;
  assignmentId?: string;
  dueAtText?: string;
  pointsPossible?: string;
  submissionTypeHints: string[];
  promptText: string;
  teacherInstructions: string[];
  rubricItems: string[];
  attachments: CanvasAttachment[];
  linkedReferences: CanvasAttachment[];
  inaccessibleReason?: string;
  extractedAt: string;
}

export interface ScanPagePayload {
  pageTitle: string;
  title: string;
  url: string;
  hostname: string;
  mode: SidebarMode;
  readableText: string;
  keyText: string;
  headings: string[];
  detectedSections: string[];
  sourceType: 'reference' | 'tone_sample';
  scanSource: 'manual_scan' | 'tone_sample_capture';
  pageType?: PageSurfaceType;
  sourceMode?: ScanSourceMode;
  urlSignals: string[];
  domSignals: string[];
  summary: string;
  keyTopics: string[];
  importantDetails: string[];
  suggestedNextActions: string[];
  canvasEnhancedRelevant: boolean;
  canvasDetails?: {
    courseName?: string;
    pageKind?: CanvasPageKind;
    courseId?: string;
    assignmentId?: string;
    dueAtText?: string;
  };
  extractionNotes?: string[];
  errors: string[];
  scannedAt: string;
}

export interface ImageScanRequest {
  title: string;
  url: string;
  imageDataUrl: string;
  sourceType: 'reference' | 'tone_sample';
  pageType: PageSurfaceType;
}

export interface ToneProfile {
  sentenceLengthTendency: 'short' | 'balanced' | 'long';
  formality: 'conversational' | 'balanced' | 'formal';
  structurePreference: string;
  citationTendency: string;
  compositionPreference: 'bullets' | 'paragraphs' | 'mixed';
  evidence: string[];
  generatedAt: string;
}

export interface PageContextSummary {
  title: string;
  url: string;
  domain: string;
  pageType: PageSurfaceType;
  headings: string[];
  previewText: string;
  priorityText: string;
  textLength: number;
  contentFingerprint: string;
  extractionNotes?: string[];
  capturedAt: string;
}

export interface PageAnalysisResult {
  title: string;
  text: string;
  bullets: string[];
  chart: AnalysisChart | null;
  actions: string[];
  sourceTitle: string;
  sourceUrl: string;
  assistantMode: SidebarMode;
  mode: AnalysisMode;
  pageSummary: string;
  keyTopics: string[];
  importantDetails: string[];
  suggestedNextActions: string[];
  likelyUseCase: string;
  canvasEnhancedAvailable: boolean;
  extractedPreview: string;
  generatedAt: string;
  requestId?: string;
  timings?: AnalysisTimingMetrics;
  cacheStatus?: AnalysisCacheStatus;
}

export interface AnalysisContextCacheEntry {
  key: string;
  pageUrl: string;
  pageTitle: string;
  mode: AnalysisMode;
  instruction: string;
  fingerprint: string;
  analysis: PageAnalysisResult;
  createdAt: string;
  lastUsedAt: string;
}

export interface AnalysisRunSnapshot {
  requestId: string;
  tabId?: number;
  pageUrl?: string;
  pageTitle?: string;
  mode: AnalysisMode;
  instruction: string;
  phase: AnalysisRunPhase;
  statusLabel: string;
  partialText: string;
  partialTitle?: string;
  error?: string;
  cacheKey?: string;
  cacheStatus?: AnalysisCacheStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  result?: PageAnalysisResult;
  timings: AnalysisTimingMetrics;
}

export interface AnalysisProgressEvent {
  type: 'snapshot' | 'cancelled';
  snapshot: AnalysisRunSnapshot | null;
}

export interface AssignmentMetadata {
  courseName?: string;
  assignmentTitle?: string;
  dueAt?: string;
  pointsPossible?: string;
  instructionsText?: string;
  submissionTypeHints: string[];
  discussionTitle?: string;
  discussionPrompt?: string;
  quizTitle?: string;
  quizInstructions?: string;
  resourceTitle?: string;
  sourcePageTitle?: string;
}

export interface TaskClassification {
  taskType: TaskType;
  platform: TaskPlatform;
  mode: SidebarMode;
  confidence: number;
  pageSubType: PageSubType;
  contentPattern: ContentPattern;
  detectedSections: string[];
  resourceUsefulness?: string;
  reasons: string[];
  reasonDetails: string[];
  assignmentSignals: string[];
  courseSignals: string[];
  metadata: AssignmentMetadata;
  recommendedNextAction: string;
  classifiedAt: string;
}

export interface WorkflowRoute {
  route: WorkflowRouteId;
  primaryMessage: string;
  recommendedActions: string[];
  statusLevel: 'info' | 'success' | 'warning';
  routedAt: string;
}

export interface WorkflowClassification {
  workflowType: WorkflowType;
  confidence: number;
  reasons: string[];
  recommendedActions: string[];
  detectedSignals: string[];
}

export interface PromptExtraction {
  promptText: string | null;
  promptType: 'assignment' | 'discussion' | 'quiz' | 'resource' | 'unknown';
  source: 'title' | 'heading' | 'body' | 'mixed' | 'none';
  confidence: number;
}

export interface WorkflowActionCard {
  id: WorkflowActionId;
  task: CanvyTaskKind;
  label: string;
  description: string;
  emphasis?: 'primary' | 'secondary';
}

export interface WorkflowOutputSection {
  title: string;
  content: string;
}

export interface WorkflowOutputShellBase {
  type: WorkflowType;
  actionId: WorkflowActionId;
  title: string;
  intro: string;
  chart?: AnalysisChart | null;
  actions?: string[];
  updatedAt: string;
}

export interface GeneralOutputShell extends WorkflowOutputShellBase {
  type: 'general';
  summary: string;
  keyPoints: string[];
  suggestedNextStep: string;
}

export interface ResourceOutputShell extends WorkflowOutputShellBase {
  type: 'resource';
  summary: string;
  keyPoints: string[];
  suggestedUse: string;
}

export interface FileAssignmentOutputShell extends WorkflowOutputShellBase {
  type: 'file_assignment';
  task: string;
  draftAnswer: string;
  explanation: string;
}

export interface DiscussionOutputShell extends WorkflowOutputShellBase {
  type: 'discussion_post';
  prompt: string;
  draftResponse: string;
  notes: string;
}

export interface QuizOutputShell extends WorkflowOutputShellBase {
  type: 'quiz';
  questionSupport: string;
  answer: string;
  explanation: string;
}

export type WorkflowOutputShell =
  | GeneralOutputShell
  | ResourceOutputShell
  | FileAssignmentOutputShell
  | DiscussionOutputShell
  | QuizOutputShell;

export interface WorkflowState {
  currentWorkflow: WorkflowType;
  classification: WorkflowClassification | null;
  promptExtraction: PromptExtraction | null;
  latestScanId: string | null;
  currentAction: WorkflowActionId | null;
  currentActionLabel?: string;
  currentActionTask?: CanvyTaskKind;
  lastUpdatedAt: number | null;
  workflowType: WorkflowType;
  confidence: number;
  reasons: string[];
  recommendedAction: string;
  assistantPrompt: string;
  extraInstructions: string;
  selectedTask?: CanvyTaskKind;
  actionCards: WorkflowActionCard[];
  outputShell: WorkflowOutputShell | null;
  sourceTitle: string;
  sourceUrl?: string;
  updatedAt: string;
}

export type OverlayFailureReason =
  | 'no_active_tab'
  | 'unsupported_page'
  | 'content_script_not_attached'
  | 'overlay_root_creation_failed'
  | 'overlay_render_failed'
  | 'message_passing_failed'
  | 'no_output_payload'
  | 'unknown';

export interface OverlayUpdateResponse {
  ok: boolean;
  visible: boolean;
  reason?: OverlayFailureReason;
  message: string;
  hostState?: 'created' | 'reused';
}

export interface OverlayStatus {
  state: 'idle' | 'shown' | 'hidden' | 'error';
  reason?: OverlayFailureReason;
  message: string;
  requestId?: string;
  source?: string;
  tabId?: number;
  actionId?: WorkflowActionId | null;
  updatedAt: string;
}

export interface OverlayUiState {
  left: number;
  top: number;
  width: number;
  height: number;
  collapsed: boolean;
}

export interface RequestDiagnosticEvent {
  id: string;
  tag: string;
  message: string;
  createdAt: string;
  requestId?: string;
  context?: string;
  source?: string;
  method?: string;
  url?: string;
  status?: number;
  category?: RequestFailureCategory;
  detail?: string;
}

export interface PageStateCurrentPage {
  tabId?: number;
  url?: string;
  title?: string;
  domain?: string;
  pageType?: PageSurfaceType;
  assistantMode: SidebarMode;
  platform: TaskPlatform;
}

export interface PageStateTimestamps {
  lastUpdatedAt: string;
  pageCapturedAt?: string;
  scannedAt?: string;
  analyzedAt?: string;
  classifiedAt?: string;
  routedAt?: string;
  staleAt?: string;
}

export interface PageStateErrors {
  pageContext?: string;
  scan?: string;
  analysis?: string;
  classification?: string;
}

export interface PageUiStatus {
  lifecycle: ScanStatus;
  message: string;
  lastAction?: 'bootstrap' | 'scan' | 'analyze' | 'refresh' | 'page_change';
}

export interface PageStateSnapshot {
  currentPage: PageStateCurrentPage;
  pageContext?: PageContextSummary;
  scan?: ScanPagePayload;
  classification?: TaskClassification;
  workflowRoute?: WorkflowRoute;
  analysis?: PageAnalysisResult;
  uiStatus: PageUiStatus;
  timestamps: PageStateTimestamps;
  errors: PageStateErrors;
}

export interface PageStatePatch {
  currentPage?: Partial<PageStateCurrentPage>;
  pageContext?: PageContextSummary;
  scan?: ScanPagePayload;
  classification?: TaskClassification;
  workflowRoute?: WorkflowRoute;
  analysis?: PageAnalysisResult;
  uiStatus?: Partial<PageUiStatus>;
  timestamps?: Partial<PageStateTimestamps>;
  errors?: Partial<PageStateErrors>;
}

export interface CanvasUpcomingAssignment {
  id: string;
  title: string;
  dueAt?: string;
  htmlUrl?: string;
  courseId?: string;
  courseName?: string;
  submissionTypes: string[];
}

export interface CanvasApiSummary {
  source: 'canvas_api' | 'mock' | 'unavailable';
  currentUserName?: string;
  courseName?: string;
  upcomingAssignments: CanvasUpcomingAssignment[];
}

export interface BackendConnectionStatus {
  state: BackendConnectionState;
  checkedAt: string;
  lastError?: string;
}

export interface TaskOutput {
  summary: string;
  checklist: string[];
  proposedStructure: string[];
  draft: string;
  explanation: string;
  reviewAreas: string[];
  alternateVersion?: string;
  citationPlaceholders?: string[];
}

export interface SessionMessage {
  id: string;
  role: 'assistant' | 'user' | 'system';
  kind: 'status' | 'draft' | 'explanation' | 'checklist' | 'user';
  text: string;
  createdAt: string;
}

export interface AssignmentSessionState {
  id: string;
  assistantMode?: SidebarMode;
  backendConnection?: BackendConnectionStatus;
  activeTask?: CanvyTaskKind;
  analysisRun?: AnalysisRunSnapshot;
  analysisCache?: AnalysisContextCacheEntry[];
  workflowState?: WorkflowState;
  overlayStatus?: OverlayStatus;
  pageState: PageStateSnapshot;
  pageContext?: PageContextSummary;
  context?: CanvasContext;
  canvasApiSummary?: CanvasApiSummary;
  scanStatus: ScanStatus;
  scanError?: string;
  latestScan?: ScanPagePayload;
  latestClassification?: TaskClassification;
  latestWorkflowRoute?: WorkflowRoute;
  lastAnalysis?: PageAnalysisResult;
  scannedPages: ScanPagePayload[];
  lastOutput?: TaskOutput;
  requestDiagnostics?: RequestDiagnosticEvent[];
  messages: SessionMessage[];
  updatedAt: string;
}

export interface CanvySettings {
  apiBaseUrl: string;
  apiBaseUrlSource?: ApiBaseUrlSource;
  configured: boolean;
  toneConsentGranted: boolean;
  backendConnection: BackendConnectionStatus;
  debugMode: boolean;
  motionEnabled: boolean;
  toneProfile?: ToneProfile;
  authToken?: string;
}

export interface ExtensionState {
  settings: CanvySettings;
  session: AssignmentSessionState;
}

export interface PopupStatus {
  isCanvasPage: boolean;
  isConfigured: boolean;
  canScan: boolean;
  isSupportedLaunchPage: boolean;
  assistantMode: AssistantSurfaceMode;
  statusLabel: string;
  launchSupportMessage: string;
  shortcutHint: string;
  pageType: PageSurfaceType;
  attachStatus: AttachStatus;
  pageTitle: string;
  currentUrl: string;
  windowId?: number;
}

export interface LauncherWindowBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface LauncherWindowState extends LauncherWindowBounds {
  windowId?: number;
  pageWindowId?: number;
  lastFocusedAt?: string;
}

export interface LaunchConfigurationStatus {
  popupPath: string;
  launcherPath: string;
  sidePanelPath: string;
  openPanelOnActionClick: boolean;
  launcherWindowId?: number;
  verifiedAt: string;
  reason: string;
}

export interface OpenCanvyResult {
  ok: boolean;
  requestId: string;
  message: string;
  mode?: SidebarMode;
  pageTitle?: string;
  currentUrl?: string;
  reason?: OpenCanvyFailureReason;
}

export interface SidebarOpenAck {
  ok: boolean;
  mounted: boolean;
  requestId: string;
  message: string;
}

export interface PingResponse {
  ok: boolean;
  requestId: string;
  pageType: PageSurfaceType;
  url: string;
}

export interface PageAssistTarget {
  id: string;
  title: string;
  snippet: string;
  kind: 'prompt' | 'question' | 'context';
  stablePlacement: boolean;
  anchorId?: string;
}

export interface PageAssistPayload {
  pageType: PageSurfaceType;
  task: CanvyTaskKind;
  summary: string;
  explanation: string;
  outline: string[];
  reviewAreas: string[];
  targets: PageAssistTarget[];
}

export interface BootstrapPayload {
  settings: CanvySettings;
  session: AssignmentSessionState;
  assistantMode: SidebarMode;
  pageContext: PageContextSummary | null;
  context: CanvasContext | null;
}

export interface ActivePageAnalysisResponse {
  ok: boolean;
  analysis: PageAnalysisResult | null;
  mode: SidebarMode;
  pageSupported: boolean;
  requestId?: string;
  error?: string;
}

export interface StartAnalysisResponse {
  ok: boolean;
  requestId: string;
  message: string;
  analysisRun: AnalysisRunSnapshot | null;
  error?: string;
}

export interface CancelAnalysisResponse {
  ok: boolean;
  requestId?: string;
  message: string;
}

export interface ConfigureResponse {
  ok: boolean;
  message: string;
  toneProfile?: ToneProfile;
}

export interface TaskRunRequest {
  task: CanvyTaskKind;
  extraInstructions: string;
}

export interface ApiTaskRequest {
  sessionId: string;
  task: CanvyTaskKind;
  context: CanvasContext | null;
  toneProfile?: ToneProfile;
  scannedPages: ScanPagePayload[];
  extraInstructions: string;
  previousOutput?: TaskOutput;
}

export interface ApiTaskResponse extends TaskOutput {
  policyNotes?: string[];
}

export interface ToneProfileRequest {
  consentGranted: boolean;
  samples: ScanPagePayload[];
}

export interface ToneProfileResponse {
  toneProfile: ToneProfile;
  message: string;
}

export interface ScanResponse {
  ok: boolean;
  page?: ScanPagePayload;
  message: string;
  attachStatus?: AttachStatus;
}

export interface ReconnectBackendResponse {
  ok: boolean;
  message: string;
  backendConnection: BackendConnectionStatus;
}

export interface ExportDocxResponse {
  fileName: string;
  mimeType: string;
  base64: string;
}

export interface CanvasApiContextRequest {
  sourceUrl: string;
  courseId?: string;
  assignmentId?: string;
}
