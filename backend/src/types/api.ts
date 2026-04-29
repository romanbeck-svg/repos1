export type TaskKind =
  | 'analyze_assignment'
  | 'build_draft'
  | 'explain_page'
  | 'summarize_reading'
  | 'discussion_post'
  | 'quiz_assist';

export type SubscriptionStatus = 'inactive' | 'trialing' | 'active' | 'past_due' | 'canceled';
export type PageSurfaceType = 'canvas' | 'docs' | 'generic';
export type ScanSourceMode = 'dom' | 'docs_dom' | 'image_ocr';

export interface QuestionCandidate {
  id: string;
  question: string;
  sectionLabel?: string;
  nearbyText: string[];
  answerChoices: string[];
  sourceAnchor: string;
  selectorHint?: string;
}

export interface CanvasAttachment {
  label: string;
  url: string;
}

export interface CanvasContext {
  pageKind: string;
  quizSafetyMode: string;
  sourceUrl: string;
  title: string;
  courseName: string;
  courseId?: string;
  assignmentId?: string;
  dueAtText?: string;
  promptText: string;
  teacherInstructions: string[];
  rubricItems: string[];
  attachments: CanvasAttachment[];
  linkedReferences: CanvasAttachment[];
  inaccessibleReason?: string;
  extractedAt: string;
}

export interface ScanPagePayload {
  title: string;
  url: string;
  readableText: string;
  headings: string[];
  contentBlocks: string[];
  questionCandidates: QuestionCandidate[];
  sourceType: 'reference' | 'tone_sample';
  pageType?: PageSurfaceType;
  sourceMode?: ScanSourceMode;
  extractionNotes?: string[];
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

export interface TaskRequest {
  sessionId: string;
  task: TaskKind;
  context: CanvasContext | null;
  scannedPages: ScanPagePayload[];
  extraInstructions: string;
  toneProfile?: ToneProfile;
  previousOutput?: TaskResponse;
}

export interface TaskResponse {
  summary: string;
  checklist: string[];
  proposedStructure: string[];
  draft: string;
  explanation: string;
  reviewAreas: string[];
  alternateVersion?: string;
  citationPlaceholders?: string[];
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

export interface ExportDocxRequest {
  title: string;
  summary?: string;
  sections: Array<{
    heading: string;
    body: string;
  }>;
}

export interface AuthTokenClaims {
  userId: string;
  email: string;
  subscriptionStatus: SubscriptionStatus;
}

export interface MagicLinkStartRequest {
  email: string;
}

export interface SessionExchangeRequest {
  accessToken: string;
}

export interface CanvasApiContextRequest {
  sourceUrl: string;
  courseId?: string;
  assignmentId?: string;
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
  source: 'canvas_api' | 'unavailable';
  currentUserName?: string;
  courseName?: string;
  upcomingAssignments: CanvasUpcomingAssignment[];
}
