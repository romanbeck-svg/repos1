import type { TaskClassification, WorkflowRoute } from '../shared/types';

export function routeWorkflow(classification: TaskClassification): WorkflowRoute {
  const routedAt = new Date().toISOString();
  const resourceLabel =
    classification.pageSubType && classification.pageSubType !== 'unknown'
      ? classification.pageSubType.replace(/_/g, ' ')
      : 'supporting resource';

  switch (classification.taskType) {
    case 'file_assignment':
      return {
        route: 'file_assignment_ready',
        primaryMessage: 'This looks like a file-based assignment. Mako IQ is ready to organize requirements and prepare the assignment workflow.',
        recommendedActions: ['Review assignment metadata', 'Summarize instructions', 'Prepare file-assignment helper'],
        statusLevel: 'success',
        routedAt
      };
    case 'discussion_post':
      return {
        route: 'discussion_workflow_ready',
        primaryMessage: 'This looks like a discussion assignment. Mako IQ is ready to break down the prompt and prep a discussion workflow.',
        recommendedActions: ['Review discussion prompt', 'Capture reply context', 'Open discussion workflow'],
        statusLevel: 'success',
        routedAt
      };
    case 'quiz':
      return {
        route: 'quiz_workflow_ready',
        primaryMessage: 'Quiz page detected. Mako IQ will stay in quiz-safe mode and focus on explanation, study hints, and review support.',
        recommendedActions: ['Inspect quiz instructions', 'Explain concepts being tested', 'Stay in study-safe workflow'],
        statusLevel: 'warning',
        routedAt
      };
    case 'resource_page':
      return {
        route: 'resource_context_ready',
        primaryMessage: `This appears to be a ${resourceLabel}. Mako IQ can use it as source context for summaries, notes, and later assignment work.`,
        recommendedActions: ['Keep this page as source context', 'Summarize key sections', 'Send insights to workspace'],
        statusLevel: 'success',
        routedAt
      };
    case 'canvas_course_page':
      return {
        route: 'course_context_ready',
        primaryMessage: 'Canvas course page detected, but no single assignment workflow is active yet.',
        recommendedActions: ['Review course context', 'Open a specific assignment or module item', 'Refresh classification after navigation'],
        statusLevel: 'info',
        routedAt
      };
    case 'general_page':
      return {
        route: 'general_analysis_ready',
        primaryMessage: 'General page mode is ready. Mako IQ can analyze, summarize, and organize the current page context.',
        recommendedActions: ['Run page analysis', 'Scan the current page', 'Open the workspace for follow-up actions'],
        statusLevel: 'info',
        routedAt
      };
    default:
      return {
        route: 'manual_review_needed',
        primaryMessage: 'Mako IQ could not confidently determine the task type yet.',
        recommendedActions: ['Refresh page context', 'Run Scan Page', 'Open a more specific assignment or source page'],
        statusLevel: 'warning',
        routedAt
      };
  }
}
