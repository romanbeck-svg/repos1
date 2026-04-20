import { env, flags } from '../config/env.js';
import type { CanvasApiContextRequest, CanvasApiSummary, CanvasUpcomingAssignment } from '../types/api.js';

interface CanvasUser {
  id: number;
  name: string;
}

interface CanvasCourse {
  id: number;
  name: string;
}

interface CanvasUpcomingEvent {
  id: string | number;
  title?: string;
  assignment?: {
    id?: number;
    name?: string;
    submission_types?: string[];
    html_url?: string;
    due_at?: string | null;
    course_id?: number;
  };
  html_url?: string;
  all_day_date?: string | null;
  end_at?: string | null;
  context_code?: string;
}

function deriveCanvasBaseUrl(sourceUrl: string) {
  if (env.canvasApiBaseUrl) {
    return env.canvasApiBaseUrl.replace(/\/$/, '');
  }

  return new URL(sourceUrl).origin;
}

async function canvasFetch<T>(baseUrl: string, path: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${env.canvasApiToken}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Canvas API request failed with ${response.status}`);
  }

  return (await response.json()) as T;
}

function normalizeUpcomingAssignments(events: CanvasUpcomingEvent[], courseName?: string, courseId?: string) {
  return events
    .filter((event) => !courseId || event.assignment?.course_id?.toString() === courseId || event.context_code === `course_${courseId}`)
    .map<CanvasUpcomingAssignment>((event) => ({
      id: String(event.assignment?.id ?? event.id),
      title: event.assignment?.name || event.title || 'Upcoming assignment',
      dueAt: event.assignment?.due_at || event.end_at || event.all_day_date || undefined,
      htmlUrl: event.assignment?.html_url || event.html_url || undefined,
      courseId: event.assignment?.course_id?.toString() ?? courseId,
      courseName,
      submissionTypes: event.assignment?.submission_types ?? []
    }))
    .slice(0, 5);
}

export async function fetchCanvasApiSummary(request: CanvasApiContextRequest): Promise<CanvasApiSummary> {
  if (!flags.canvasConfigured || !request.sourceUrl) {
    return {
      source: 'unavailable',
      upcomingAssignments: []
    };
  }

  const baseUrl = deriveCanvasBaseUrl(request.sourceUrl);
  const [user, course, upcomingEvents] = await Promise.all([
    canvasFetch<CanvasUser>(baseUrl, '/api/v1/users/self'),
    request.courseId ? canvasFetch<CanvasCourse>(baseUrl, `/api/v1/courses/${request.courseId}`) : Promise.resolve(null),
    canvasFetch<CanvasUpcomingEvent[]>(baseUrl, '/api/v1/users/self/upcoming_events')
  ]);

  return {
    source: 'canvas_api',
    currentUserName: user.name,
    courseName: course?.name,
    upcomingAssignments: normalizeUpcomingAssignments(upcomingEvents, course?.name, request.courseId)
  };
}
