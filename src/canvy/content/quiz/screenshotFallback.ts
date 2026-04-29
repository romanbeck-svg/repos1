import type { QuizQuestionExtraction } from '../../shared/quizTypes';

const MULTIPLE_CHOICE_PATTERN = /\b(which of the following|choose|select|answer choices|option)\b/i;
const VISUAL_CONTEXT_PATTERN = /\b(shown in the image|shown in the graph|shown in the diagram|graph|diagram|figure|table|chart|image below|picture)\b/i;

export function getScreenshotFallbackReason(extraction: QuizQuestionExtraction) {
  if (!extraction.found) {
    return 'no-question-detected';
  }

  if (extraction.needsScreenshot) {
    return 'extractor-requested-screenshot';
  }

  if (extraction.confidence < 0.65) {
    return 'low-confidence-dom-extraction';
  }

  if ((extraction.hasImages || extraction.hasCanvas || extraction.hasSvg) && extraction.questionText.length < 120) {
    return 'visual-question-with-incomplete-dom-text';
  }

  if (MULTIPLE_CHOICE_PATTERN.test(extraction.questionText) && extraction.answerChoices.length === 0) {
    return 'missing-answer-choices';
  }

  if (VISUAL_CONTEXT_PATTERN.test(extraction.questionText) && (extraction.hasImages || extraction.hasCanvas || extraction.hasSvg)) {
    return 'question-references-visual-content';
  }

  return '';
}

export function shouldUseScreenshotFallback(extraction: QuizQuestionExtraction) {
  return Boolean(getScreenshotFallbackReason(extraction));
}
