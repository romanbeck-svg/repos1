import { createDefaultPageState } from '../shared/constants';
import type {
  AssignmentSessionState,
  PageStateCurrentPage,
  PageStatePatch,
  PageStateSnapshot,
  PageSurfaceType,
  SidebarMode,
  TaskPlatform
} from '../shared/types';

function hasOwn<T extends object>(value: T, key: keyof any) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function detectPlatform(
  assistantMode: SidebarMode,
  url?: string,
  pageType?: PageSurfaceType,
  fallback?: TaskPlatform
): TaskPlatform {
  if (fallback) {
    return fallback;
  }

  if (assistantMode === 'canvas' || pageType === 'canvas') {
    return 'canvas';
  }

  return /^https?:/i.test(url ?? '') ? 'general_web' : 'unknown';
}

function buildCurrentPage(
  session: Partial<AssignmentSessionState>,
  base: PageStateSnapshot
): PageStateCurrentPage {
  const pageContext = session.pageContext ?? base.pageContext;
  const latestScan = session.latestScan ?? base.scan;
  const assistantMode = session.assistantMode ?? base.currentPage.assistantMode ?? 'general';
  const url = pageContext?.url ?? latestScan?.url ?? base.currentPage.url;
  const pageType = pageContext?.pageType ?? latestScan?.pageType ?? base.currentPage.pageType;

  return {
    ...base.currentPage,
    url,
    title: pageContext?.title ?? latestScan?.pageTitle ?? base.currentPage.title,
    domain: pageContext?.domain ?? latestScan?.hostname ?? base.currentPage.domain,
    pageType,
    assistantMode,
    platform: detectPlatform(assistantMode, url, pageType, session.latestClassification?.platform ?? base.classification?.platform)
  };
}

export function mergePageState(current: PageStateSnapshot, patch?: PageStatePatch): PageStateSnapshot {
  if (!patch) {
    return current;
  }

  const next: PageStateSnapshot = {
    ...current,
    currentPage: {
      ...current.currentPage,
      ...(patch.currentPage ?? {})
    },
    uiStatus: {
      ...current.uiStatus,
      ...(patch.uiStatus ?? {})
    },
    timestamps: {
      ...current.timestamps,
      ...(patch.timestamps ?? {})
    },
    errors: {
      ...current.errors,
      ...(patch.errors ?? {})
    }
  };

  if (hasOwn(patch, 'pageContext')) {
    next.pageContext = patch.pageContext;
  }
  if (hasOwn(patch, 'scan')) {
    next.scan = patch.scan;
  }
  if (hasOwn(patch, 'classification')) {
    next.classification = patch.classification;
  }
  if (hasOwn(patch, 'workflowRoute')) {
    next.workflowRoute = patch.workflowRoute;
  }
  if (hasOwn(patch, 'analysis')) {
    next.analysis = patch.analysis;
  }

  next.timestamps.lastUpdatedAt = patch.timestamps?.lastUpdatedAt ?? new Date().toISOString();

  return next;
}

export function hydratePageState(session: Partial<AssignmentSessionState>): PageStateSnapshot {
  const seeded = mergePageState(createDefaultPageState(), session.pageState);
  const currentPage = buildCurrentPage(session, seeded);

  const lifecycle = seeded.uiStatus.lifecycle ?? session.scanStatus ?? 'idle';
  const message =
    seeded.uiStatus.message ||
    session.scanError ||
    (lifecycle === 'ready'
      ? 'Page context is ready.'
      : lifecycle === 'stale'
        ? 'Results are stale because the page changed.'
        : lifecycle === 'error'
          ? 'Mako IQ could not finish reading this page.'
          : 'No page scan yet.');

  return mergePageState(seeded, {
    currentPage,
    pageContext: hasOwn(session, 'pageContext') ? session.pageContext : seeded.pageContext,
    scan: hasOwn(session, 'latestScan') ? session.latestScan : seeded.scan,
    classification: hasOwn(session, 'latestClassification') ? session.latestClassification : seeded.classification,
    workflowRoute: hasOwn(session, 'latestWorkflowRoute') ? session.latestWorkflowRoute : seeded.workflowRoute,
    analysis: hasOwn(session, 'lastAnalysis') ? session.lastAnalysis : seeded.analysis,
    uiStatus: {
      lifecycle,
      message,
      lastAction: seeded.uiStatus.lastAction ?? 'bootstrap'
    },
    timestamps: {
      pageCapturedAt: session.pageContext?.capturedAt ?? seeded.pageContext?.capturedAt ?? seeded.timestamps.pageCapturedAt,
      scannedAt: session.latestScan?.scannedAt ?? seeded.scan?.scannedAt ?? seeded.timestamps.scannedAt,
      analyzedAt: session.lastAnalysis?.generatedAt ?? seeded.analysis?.generatedAt ?? seeded.timestamps.analyzedAt,
      classifiedAt: session.latestClassification?.classifiedAt ?? seeded.classification?.classifiedAt ?? seeded.timestamps.classifiedAt,
      routedAt: session.latestWorkflowRoute?.routedAt ?? seeded.workflowRoute?.routedAt ?? seeded.timestamps.routedAt,
      lastUpdatedAt: session.updatedAt ?? seeded.timestamps.lastUpdatedAt
    },
    errors: {
      pageContext: seeded.errors.pageContext,
      scan: session.scanError ?? seeded.errors.scan,
      analysis: seeded.errors.analysis,
      classification: seeded.errors.classification
    }
  });
}

export function normalizeSessionState(session: AssignmentSessionState): AssignmentSessionState {
  const pageState = hydratePageState(session);

  return {
    ...session,
    assistantMode: pageState.currentPage.assistantMode,
    pageState,
    pageContext: pageState.pageContext,
    scanStatus: pageState.uiStatus.lifecycle,
    scanError: pageState.errors.scan ?? pageState.errors.analysis ?? pageState.errors.classification ?? pageState.errors.pageContext,
    latestScan: pageState.scan,
    latestClassification: pageState.classification,
    latestWorkflowRoute: pageState.workflowRoute,
    lastAnalysis: pageState.analysis,
    updatedAt: pageState.timestamps.lastUpdatedAt
  };
}

export function createStalePageState(
  current: PageStateSnapshot,
  currentPage: Partial<PageStateCurrentPage>,
  message = 'Results are stale because the page changed.'
) {
  const now = new Date().toISOString();

  return mergePageState(current, {
    currentPage,
    pageContext: undefined,
    scan: undefined,
    classification: undefined,
    workflowRoute: undefined,
    analysis: undefined,
    uiStatus: {
      lifecycle: 'stale',
      message,
      lastAction: 'page_change'
    },
    timestamps: {
      staleAt: now,
      lastUpdatedAt: now
    },
    errors: {
      scan: undefined,
      analysis: undefined,
      classification: undefined
    }
  });
}

export function pageUrlsMatch(left?: string, right?: string) {
  return Boolean(left && right && left === right);
}

export function hasFreshScan(pageState: PageStateSnapshot) {
  return Boolean(pageState.scan && pageUrlsMatch(pageState.scan.url, pageState.currentPage.url) && pageState.uiStatus.lifecycle !== 'stale');
}
