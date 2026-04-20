import { createDefaultPageState } from '../shared/constants';
import type { AssignmentSessionState, PageStateSnapshot, ScanStatus } from '../shared/types';

function relativeTimeLabel(value?: string) {
  if (!value) {
    return '';
  }

  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return '';
  }

  const diffMs = Date.now() - timestamp;
  const diffMinutes = Math.max(0, Math.round(diffMs / 60000));

  if (diffMinutes <= 0) {
    return 'just now';
  }

  if (diffMinutes === 1) {
    return '1 min ago';
  }

  if (diffMinutes < 60) {
    return `${diffMinutes} min ago`;
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours === 1) {
    return '1 hr ago';
  }

  if (diffHours < 24) {
    return `${diffHours} hr ago`;
  }

  const diffDays = Math.round(diffHours / 24);
  return diffDays === 1 ? '1 day ago' : `${diffDays} days ago`;
}

function lifecycleMessage(lifecycle: ScanStatus) {
  switch (lifecycle) {
    case 'scanning':
      return 'Scanning current page';
    case 'scanned':
      return 'Scan captured';
    case 'analyzing':
      return 'Analyzing latest page context';
    case 'ready':
      return 'Results ready';
    case 'error':
      return 'Needs attention';
    case 'stale':
      return 'Results are stale';
    default:
      return 'No page scan yet';
  }
}

export function selectPageState(session?: AssignmentSessionState | null): PageStateSnapshot {
  return session?.pageState ?? createDefaultPageState();
}

export function selectFreshnessLabel(pageState: PageStateSnapshot) {
  if (pageState.uiStatus.lifecycle === 'stale') {
    return 'Results are stale because the page changed';
  }

  if (pageState.uiStatus.lifecycle === 'scanning') {
    return 'Scanning current page';
  }

  if (pageState.uiStatus.lifecycle === 'analyzing') {
    return 'Analyzing latest page context';
  }

  if (pageState.uiStatus.lifecycle === 'error') {
    return 'Scan needs attention';
  }

  if (pageState.scan?.scannedAt) {
    const relative = relativeTimeLabel(pageState.scan.scannedAt);
    return relative ? `Scanned ${relative}` : 'Scanned recently';
  }

  if (pageState.pageContext?.capturedAt) {
    const relative = relativeTimeLabel(pageState.pageContext.capturedAt);
    return relative ? `Context refreshed ${relative}` : 'Context refreshed';
  }

  return 'No page scan yet';
}

export function selectPrimarySummary(pageState: PageStateSnapshot, fallback: string) {
  return (
    pageState.analysis?.pageSummary ||
    pageState.scan?.summary ||
    pageState.workflowRoute?.primaryMessage ||
    pageState.classification?.recommendedNextAction ||
    pageState.pageContext?.previewText ||
    fallback
  );
}

export function selectPrimaryTopics(pageState: PageStateSnapshot) {
  return (
    pageState.analysis?.keyTopics ||
    pageState.scan?.keyTopics ||
    pageState.classification?.detectedSections ||
    pageState.pageContext?.headings ||
    []
  ).slice(0, 6);
}

export function selectPrimaryActions(pageState: PageStateSnapshot) {
  return (
    pageState.workflowRoute?.recommendedActions ||
    pageState.scan?.suggestedNextActions ||
    pageState.analysis?.suggestedNextActions ||
    []
  ).slice(0, 3);
}

export function selectVisiblePreview(pageState: PageStateSnapshot) {
  return pageState.scan?.keyText || pageState.analysis?.extractedPreview || pageState.pageContext?.previewText || '';
}

export function selectStatusCopy(pageState: PageStateSnapshot, fallback: string) {
  return pageState.uiStatus.message || pageState.workflowRoute?.primaryMessage || fallback;
}

export function selectLifecycleLabel(pageState: PageStateSnapshot) {
  return lifecycleMessage(pageState.uiStatus.lifecycle);
}

export function selectIsBusy(pageState: PageStateSnapshot) {
  return pageState.uiStatus.lifecycle === 'scanning' || pageState.uiStatus.lifecycle === 'analyzing';
}

