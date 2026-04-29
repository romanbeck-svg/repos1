export type QuizQuestionType = 'multiple_choice' | 'multi_select' | 'short_answer' | 'dropdown' | 'unknown';
export type QuizAnswerInputType = 'radio' | 'checkbox' | 'text' | 'select' | 'button' | 'button_or_card' | 'unknown';
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

export interface QuizAnswerChoice {
  id: string;
  index: number;
  label: string;
  text: string;
  inputType: QuizAnswerInputType;
  selected: boolean;
  disabled: boolean;
}

export interface QuizAnalyzeRequestBody {
  mode: 'quiz-prefetch';
  requestId: string;
  questionHash: string;
  pageUrl: string;
  pageTitle?: string;
  question: {
    questionText: string;
    instructions: string;
    answerChoices: QuizAnswerChoice[];
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
