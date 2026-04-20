import type { AssignmentMetadata, CanvasContext, PageContextSummary, ScanPagePayload } from '../shared/types';

export function extractCanvasMetadata(
  context: CanvasContext | null,
  pageContext: PageContextSummary | null,
  latestScan?: ScanPagePayload
): AssignmentMetadata {
  const sourcePageTitle = latestScan?.pageTitle ?? pageContext?.title;

  if (!context) {
    return {
      sourcePageTitle,
      resourceTitle: sourcePageTitle,
      submissionTypeHints: latestScan?.canvasDetails?.pageKind ? [latestScan.canvasDetails.pageKind] : []
    };
  }

  const metadata: AssignmentMetadata = {
    courseName: context.courseName,
    dueAt: context.dueAtText,
    pointsPossible: context.pointsPossible,
    instructionsText: context.promptText || latestScan?.keyText,
    submissionTypeHints: context.submissionTypeHints,
    sourcePageTitle
  };

  if (context.pageKind === 'assignment') {
    metadata.assignmentTitle = context.title;
  }

  if (context.pageKind === 'discussion') {
    metadata.discussionTitle = context.title;
    metadata.discussionPrompt = context.promptText;
  }

  if (context.pageKind === 'quiz' || context.pageKind === 'quiz_review') {
    metadata.quizTitle = context.title;
    metadata.quizInstructions = context.promptText;
  }

  if (context.pageKind === 'file' || context.pageKind === 'module' || context.pageKind === 'course_home') {
    metadata.resourceTitle = context.title;
  }

  return metadata;
}
