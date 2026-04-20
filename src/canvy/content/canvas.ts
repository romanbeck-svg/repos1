import { isCanvasUrl } from '../shared/lms';
import type { CanvasAttachment, CanvasContext, CanvasPageKind, QuizSafetyMode } from '../shared/types';

function collapseWhitespace(value: string | null | undefined) {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function textFromSelectors(selectors: string[], limit = 8000) {
  const values = selectors
    .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
    .map((element) => collapseWhitespace(element.textContent))
    .filter(Boolean);

  return Array.from(new Set(values)).join('\n\n').slice(0, limit);
}

function listFromSelectors(selectors: string[], limit = 10) {
  const values = selectors
    .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
    .map((element) => collapseWhitespace(element.textContent))
    .filter(Boolean);

  return Array.from(new Set(values)).slice(0, limit);
}

function collectLinks(selectors: string[], limit = 8): CanvasAttachment[] {
  const links = selectors.flatMap((selector) => Array.from(document.querySelectorAll<HTMLAnchorElement>(selector)));

  const unique = new Map<string, CanvasAttachment>();
  links.forEach((link) => {
    const href = link.href?.trim();
    const label = collapseWhitespace(link.textContent) || href;
    if (!href || !label || unique.has(href)) {
      return;
    }
    unique.set(href, { label, url: href });
  });

  return Array.from(unique.values()).slice(0, limit);
}

function detectCanvasPageKind(url: string): CanvasPageKind {
  if (/\/assignments\/\d+/.test(url)) {
    return 'assignment';
  }
  if (/\/discussion_topics\/\d+/.test(url)) {
    return 'discussion';
  }
  if (/\/files\/\d+/.test(url)) {
    return 'file';
  }
  if (/\/quizzes\/\d+/.test(url)) {
    return url.includes('/history') ? 'quiz_review' : 'quiz';
  }
  if (/\/modules/.test(url)) {
    return 'module';
  }
  if (/\/courses\/\d+\/?$/.test(url)) {
    return 'course_home';
  }
  return 'unknown';
}

function detectQuizSafetyMode(pageKind: CanvasPageKind): QuizSafetyMode {
  if (pageKind !== 'quiz' && pageKind !== 'quiz_review') {
    return 'none';
  }

  const pageText = collapseWhitespace(document.body?.innerText).toLowerCase();
  const hasSubmitButton = Array.from(document.querySelectorAll('button, input[type="submit"]')).some((element) =>
    collapseWhitespace(element.textContent || (element as HTMLInputElement).value).toLowerCase().includes('submit quiz')
  );

  if (pageKind === 'quiz_review' || pageText.includes('correct answer') || pageText.includes('quiz results')) {
    return 'review';
  }

  if (hasSubmitButton || pageText.includes('time running') || pageText.includes('time remaining')) {
    return 'active_attempt';
  }

  return 'study';
}

function readCourseName() {
  return (
    collapseWhitespace(document.querySelector('#breadcrumbs li:nth-last-child(2) a')?.textContent) ||
    collapseWhitespace(document.querySelector('.course-title')?.textContent) ||
    collapseWhitespace(document.querySelector('.ic-app-course-menu a.active')?.textContent) ||
    'Canvas course'
  );
}

function readTitle(pageKind: CanvasPageKind) {
  const selectors =
    pageKind === 'discussion'
      ? ['h1.discussion-title', '.discussion-title', 'h1']
      : pageKind === 'assignment'
        ? ['.assignment-title', 'h1.title', 'h1']
        : ['h1', '.page-title', 'title'];

  return selectors
    .map((selector) =>
      selector === 'title'
        ? collapseWhitespace(document.title)
        : collapseWhitespace(document.querySelector(selector)?.textContent)
    )
    .find(Boolean) || 'Current page';
}

function readPromptText(pageKind: CanvasPageKind) {
  const selectorsByKind: Record<CanvasPageKind, string[]> = {
    assignment: ['.assignment-description', '.user_content', '#assignment_show .description', 'main'],
    discussion: ['.discussion_topic', '.discussion-entry-reply-area', '.message.user_content', 'main'],
    file: ['.ef-item-row', '.user_content', 'main'],
    quiz: ['.quiz_description', '.question_text', '.user_content', 'main'],
    quiz_review: ['.quiz_description', '.question_text', '.user_content', 'main'],
    course_home: ['.ic-Layout-contentMain', 'main'],
    module: ['.context_module_items', '.ic-Layout-contentMain', 'main'],
    reference: ['article', 'main'],
    unknown: ['main', '#content']
  };

  return textFromSelectors(selectorsByKind[pageKind], pageKind === 'assignment' ? 9000 : 7000);
}

function readPointsPossible() {
  return (
    collapseWhitespace(
      document.querySelector(
        '[data-testid="assignment-points"], .points_possible, .assignment-details .points, .details .points_possible, .points'
      )?.textContent
    ) || undefined
  );
}

function detectSubmissionTypeHints(pageKind: CanvasPageKind) {
  const pageText = collapseWhitespace(document.body?.innerText).toLowerCase();
  const hints = new Set<string>();

  if (pageKind === 'assignment') {
    if (document.querySelector('input[type="file"], .file_upload, [data-testid*="upload"]') || /upload|file submission/.test(pageText)) {
      hints.add('file_upload');
    }

    if (document.querySelector('textarea, [contenteditable="true"], .ic-RichContentEditor') || /text entry|website url/.test(pageText)) {
      hints.add('text_entry');
    }
  }

  if (pageKind === 'discussion') {
    if (document.querySelector('textarea, [contenteditable="true"], .discussion-reply-form') || /reply|post reply/.test(pageText)) {
      hints.add('discussion_reply');
    }
  }

  if (pageKind === 'quiz' || pageKind === 'quiz_review') {
    hints.add('quiz_attempt');
  }

  return Array.from(hints);
}

export function extractCanvasContext(): CanvasContext | null {
  const url = window.location.href;
  if (!isCanvasUrl(url)) {
    return null;
  }

  const pageKind = detectCanvasPageKind(url);
  const promptText = readPromptText(pageKind);
  const attachments = collectLinks(['a[href*="/files/"]', '.attachments a', '.assignment-details a[href*="/files/"]']);
  const linkedReferences = collectLinks(['.assignment-description a[href^="http"]', '.discussion_topic a[href^="http"]']);
  const teacherInstructions = listFromSelectors(
    ['.details li', '.assignment-details li', '.syllabus_assignment li', '.discussion_topic li'],
    8
  );
  const rubricItems = listFromSelectors(['.rubric .criterion .description', '.rubric tr', '.rubric_container li'], 10);
  const dueAtText =
    collapseWhitespace(
      document.querySelector('[data-testid="due-date"], .assignment-date-due, .details .due_date, .due_date')?.textContent
    ) || undefined;
  const pointsPossible = readPointsPossible();
  const quizSafetyMode = detectQuizSafetyMode(pageKind);
  const submissionTypeHints = detectSubmissionTypeHints(pageKind);

  const inaccessibleReason =
    promptText.length < 80 && attachments.length === 0 && linkedReferences.length === 0
      ? document.querySelector('iframe')
        ? 'This Canvas page looks embedded or locked, so I may need you to open the source and use Scan Page.'
        : 'I could not find enough readable assignment content on this page.'
      : undefined;

  return {
    pageKind,
    quizSafetyMode,
    sourceUrl: url,
    title: readTitle(pageKind),
    courseName: readCourseName(),
    courseId: url.match(/\/courses\/(\d+)/)?.[1],
    assignmentId: url.match(/\/(?:assignments|discussion_topics|quizzes|files)\/(\d+)/)?.[1],
    dueAtText,
    pointsPossible,
    submissionTypeHints,
    promptText,
    teacherInstructions,
    rubricItems,
    attachments,
    linkedReferences,
    inaccessibleReason,
    extractedAt: new Date().toISOString()
  };
}
