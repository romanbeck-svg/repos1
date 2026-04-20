export const URL_SIGNAL_RULES: Array<{ signal: string; pattern: RegExp }> = [
  { signal: 'course_path', pattern: /\/courses\//i },
  { signal: 'assignment_path', pattern: /\/assignments\//i },
  { signal: 'discussion_path', pattern: /\/discussion_topics\//i },
  { signal: 'quiz_path', pattern: /\/quizzes\//i },
  { signal: 'module_path', pattern: /\/modules/i },
  { signal: 'page_path', pattern: /\/pages\//i },
  { signal: 'file_path', pattern: /\/files\//i }
];

export const TEXT_SIGNAL_RULES: Array<{ signal: string; pattern: RegExp }> = [
  { signal: 'submit_assignment_text', pattern: /submit assignment|submission details|submission type/i },
  { signal: 'upload_text', pattern: /upload|file submission|attach/i },
  { signal: 'discussion_text', pattern: /discussion|discussion topic/i },
  { signal: 'reply_text', pattern: /reply|post reply|add a reply/i },
  { signal: 'quiz_text', pattern: /quiz|questions?|answer choice|submit quiz/i },
  { signal: 'due_text', pattern: /\bdue\b|due date/i },
  { signal: 'points_text', pattern: /\bpoints?\b|pts\b/i },
  { signal: 'instructions_text', pattern: /instructions|guidelines|requirements/i },
  { signal: 'module_text', pattern: /\bmodule\b/i },
  { signal: 'resource_text', pattern: /reading|article|resource|page/i }
];

export function findMatchingSignals(source: string, rules: Array<{ signal: string; pattern: RegExp }>) {
  return rules.filter((rule) => rule.pattern.test(source)).map((rule) => rule.signal);
}

export function hasAnySignal(signals: string[], expected: string[]) {
  return expected.some((signal) => signals.includes(signal));
}
