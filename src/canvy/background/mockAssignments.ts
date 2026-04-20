import type { CanvasApiSummary, CanvasContext, CanvasUpcomingAssignment } from '../shared/types';

function addDays(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function normalizeCourseName(courseName?: string) {
  return courseName?.trim() || 'Canvas course';
}

export function buildMockAssignments(context: CanvasContext | null): CanvasUpcomingAssignment[] {
  const courseName = normalizeCourseName(context?.courseName);
  const courseId = context?.courseId ?? 'demo-course';

  return [
    {
      id: `${courseId}-outline`,
      title: context?.title ? `${context.title} response outline` : 'Essay response outline',
      dueAt: context?.dueAtText || addDays(1),
      courseId,
      courseName,
      submissionTypes: ['online_upload']
    },
    {
      id: `${courseId}-discussion`,
      title: `${courseName} discussion follow-up`,
      dueAt: addDays(2),
      courseId,
      courseName,
      submissionTypes: ['discussion_topic']
    },
    {
      id: `${courseId}-reflection`,
      title: 'Weekly reflection draft',
      dueAt: addDays(3),
      courseId,
      courseName,
      submissionTypes: ['online_text_entry']
    }
  ];
}

export function buildMockCanvasSummary(context: CanvasContext | null): CanvasApiSummary {
  return {
    source: 'mock',
    courseName: normalizeCourseName(context?.courseName),
    currentUserName: 'Student',
    upcomingAssignments: buildMockAssignments(context)
  };
}
