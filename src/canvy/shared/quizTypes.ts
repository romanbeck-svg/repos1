import type { ScreenQuestionAnchor, ScreenViewport } from './types';

export type QuizModeControllerState =
  | 'OFF'
  | 'OBSERVING'
  | 'DIRTY'
  | 'EXTRACTING'
  | 'PREFETCHING'
  | 'READY'
  | 'ERROR';

export type QuizAnswerInputType = 'radio' | 'checkbox' | 'text' | 'select' | 'button' | 'button_or_card' | 'unknown';
export type QuizQuestionType = 'multiple_choice' | 'multi_select' | 'short_answer' | 'dropdown' | 'unknown';
export type QuizAnalyzeStatus = 'answered' | 'no_question' | 'needs_more_context' | 'error';
export type QuizFailReason =
  | 'NO_QUESTION_FOUND'
  | 'LOW_CONFIDENCE_EXTRACTION'
  | 'EMPTY_ANSWER_CHOICES'
  | 'BACKEND_UNREACHABLE'
  | 'BACKEND_4XX'
  | 'BACKEND_5XX'
  | 'AI_TIMEOUT'
  | 'AI_JSON_PARSE_ERROR'
  | 'STALE_RESPONSE'
  | 'PERMISSION_MISSING'
  | 'SCREENSHOT_FALLBACK_FAILED';

export interface QuizBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface QuizAnswerChoice {
  id: string;
  index: number;
  label: string;
  text: string;
  inputType: QuizAnswerInputType;
  selected: boolean;
  disabled: boolean;
  bbox: QuizBoundingBox;
}

export interface QuizQuestionExtraction {
  found: boolean;
  confidence: number;
  method: 'dom' | 'screenshot' | 'hybrid';
  questionHash: string;
  pageUrl: string;
  pageTitle: string;
  questionText: string;
  instructions: string;
  answerChoices: QuizAnswerChoice[];
  questionType: QuizQuestionType;
  bbox: QuizBoundingBox;
  anchor?: ScreenQuestionAnchor;
  viewport: ScreenViewport;
  hasImages: boolean;
  hasCanvas: boolean;
  hasSvg: boolean;
  needsScreenshot: boolean;
  debug: {
    candidateSelector: string;
    textLength: number;
    choiceCount: number;
    reasons: string[];
  };
}

export interface QuizAnalyzeRequestPayload {
  mode: 'quiz-prefetch';
  requestId: string;
  questionHash: string;
  pageUrl: string;
  pageTitle?: string;
  question: {
    questionText: string;
    instructions: string;
    answerChoices: Array<Pick<QuizAnswerChoice, 'id' | 'index' | 'label' | 'text' | 'inputType' | 'selected' | 'disabled'>>;
    questionType: QuizQuestionType;
  };
  extraction: {
    confidence: number;
    method: 'dom' | 'screenshot' | 'hybrid';
    needsScreenshot: boolean;
    debugReasons: string[];
  };
  screenshot: {
    included: boolean;
    mimeType?: 'image/jpeg' | 'image/png';
    data?: string;
  };
}

export interface QuizAnalyzeResponse {
  status: QuizAnalyzeStatus;
  requestId: string;
  questionHash: string;
  answer: string;
  answerLabel: string | null;
  answerIndex: number | null;
  answerIndexes: number[];
  confidence: number;
  explanation: string;
  evidence: string;
  shouldDisplay: boolean;
}

export interface QuizPrefetchRequestMessage {
  type: 'QUIZ_PREFETCH_ANSWER';
  requestId: string;
  reason: string;
  questionHash: string;
  startedAt: number;
  extraction: QuizQuestionExtraction;
}

export interface QuizPrefetchResponse {
  ok: boolean;
  requestId: string;
  status: QuizAnalyzeStatus | 'cached' | 'stale' | 'disabled';
  message: string;
  rendered?: boolean;
  questionHash?: string;
  usedScreenshot?: boolean;
  failReason?: QuizFailReason;
  error?: string;
}
