export type ScreenAnalysisMode = 'questions' | 'find_questions_and_answer';
export type ScreenAnalysisItemType =
  | 'multiple_choice'
  | 'math'
  | 'short_answer'
  | 'reading'
  | 'science'
  | 'general_question'
  | 'task';

export interface ScreenViewport {
  width: number;
  height: number;
  devicePixelRatio: number;
  scrollX?: number;
  scrollY?: number;
}

export interface ScreenImageMetadata {
  format: 'jpeg' | 'png' | 'webp' | 'unknown';
  source?: 'screenshot' | 'dom_context';
  originalWidth?: number;
  originalHeight?: number;
  width?: number;
  height?: number;
  quality?: number;
  originalBytes?: number;
  bytes?: number;
  resized?: boolean;
}

export interface ScreenBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenAnchorRect {
  top: number;
  left: number;
  width: number;
  height: number;
  bottom: number;
  right: number;
}

export interface ScreenQuestionAnchor {
  rect: ScreenAnchorRect;
  viewport: {
    width: number;
    height: number;
  };
  scroll: {
    x: number;
    y: number;
  };
  selector?: string;
}

export type ScreenQuestionType = 'multiple_choice' | 'multi_select' | 'short_answer' | 'unknown';

export interface ScreenStructuredChoice {
  key: string;
  text: string;
}

export interface ScreenQuestionDomHints {
  selector: string;
  hasRadioInputs: boolean;
  hasCheckboxInputs: boolean;
}

export type ScreenQuestionContextExtractionMode = 'dom' | 'screenshot' | 'mixed';

export interface ScreenQuestionContextQuestion {
  id: string;
  questionText: string;
  choices: ScreenStructuredChoice[];
  nearbyText: string;
  elementHints: {
    selector: string;
    hasRadioInputs?: boolean;
    hasCheckboxInputs?: boolean;
    bbox?: ScreenBoundingBox;
  };
}

export interface ScreenQuestionContext {
  pageUrl: string;
  pageTitle: string;
  visibleTextHash: string;
  extractionMode: ScreenQuestionContextExtractionMode;
  questions: ScreenQuestionContextQuestion[];
}

export interface ScreenStructuredQuestion {
  id: string;
  question: string;
  choices: ScreenStructuredChoice[];
  nearbyContext: string;
  questionType: ScreenQuestionType;
  domHints: ScreenQuestionDomHints;
  bbox?: ScreenBoundingBox;
  anchor?: ScreenQuestionAnchor;
  confidence: number;
  extractionStrategy: string;
}

export interface ScreenStructuredExtraction {
  source: {
    url: string;
    title: string;
    host: string;
    pathname: string;
  };
  mode: 'answer_questions';
  extraction: {
    strategy: string;
    confidence: number;
    warnings: string[];
    extractionMs: number;
    inspectedNodeCount: number;
  };
  questions: ScreenStructuredQuestion[];
  visibleTextFallback?: string;
}

export interface ScreenTextContext {
  pageTitle: string;
  pageUrl: string;
  selectedText?: string;
  visibleText: string;
  headings: string[];
  labels: string[];
  questionCandidates: Array<{
    id?: string;
    question: string;
    answerChoices: string[];
    nearbyText: string[];
    bbox?: ScreenBoundingBox;
    anchor?: ScreenQuestionAnchor;
    questionType?: ScreenQuestionType;
    confidence?: number;
    extractionStrategy?: string;
  }>;
  structuredExtraction?: ScreenStructuredExtraction;
  questionContext?: ScreenQuestionContext;
  visibleTextHash?: string;
  extractionMode?: ScreenQuestionContextExtractionMode;
  viewport: ScreenViewport;
  capturedAt: string;
  pageSignature?: string;
}

export interface ScreenAnalysisTiming {
  captureMs?: number;
  preprocessMs?: number;
  uploadMs?: number;
  aiMs?: number;
  aiFirstByteMs?: number;
  aiResponseMs?: number;
  parseMs?: number;
  validationMs?: number;
  renderMs?: number;
  totalMs?: number;
  scanTotalMs?: number;
  domExtractMs?: number;
  screenshotCaptureMs?: number;
  promptBuildMs?: number;
  extensionMessageMs?: number;
  backendRequestMs?: number;
  overlayRenderMs?: number;
  cacheHit?: boolean;
  extractionMode?: ScreenQuestionContextExtractionMode;
  modelUsed?: string;
  inputChars?: number;
  outputChars?: number;
}

export interface ScreenAnalysisItem {
  id: string;
  type: ScreenAnalysisItemType;
  question: string;
  answer: string;
  answerChoice: string | null;
  explanation: string;
  confidence: number;
  bbox?: ScreenBoundingBox;
  anchor?: ScreenQuestionAnchor;
  needsMoreContext: boolean;
}

export interface ScreenAnalyzeRequestBody {
  image: string;
  pageUrl: string;
  pageTitle: string;
  viewport: ScreenViewport;
  mode: ScreenAnalysisMode;
  textContext?: ScreenTextContext;
  imageMeta?: ScreenImageMetadata;
  debug?: boolean;
}

export interface ScreenAnalyzeSuccessResponse {
  ok: true;
  analysisId: string;
  summary: string;
  items: ScreenAnalysisItem[];
  warnings: string[];
  timing?: ScreenAnalysisTiming;
}

export interface ScreenAnalyzeFailureResponse {
  ok: false;
  error: 'SCREEN_ANALYSIS_FAILED';
  message: string;
  timing?: ScreenAnalysisTiming;
}

export type ScreenAnalyzeResponse = ScreenAnalyzeSuccessResponse | ScreenAnalyzeFailureResponse;

export interface ScreenFollowUpRequestBody {
  analysisId: string;
  itemId: string;
  question: string;
  originalQuestion: string;
  originalAnswer: string;
  screenshotContext?: string;
}

export interface ScreenFollowUpSuccessResponse {
  ok: true;
  answer: string;
  explanation?: string;
}

export interface ScreenFollowUpFailureResponse {
  ok: false;
  error: 'SCREEN_FOLLOWUP_FAILED';
  message: string;
}

export type ScreenFollowUpResponse = ScreenFollowUpSuccessResponse | ScreenFollowUpFailureResponse;
