import type { CanvasApiSummary, CanvasContext, PageContextSummary, ScanPagePayload, SidebarMode } from '../../shared/types';

interface ContextSnapshotProps {
  context: CanvasContext | null;
  canvasApiSummary?: CanvasApiSummary;
  pageContext?: PageContextSummary | null;
  latestScan?: ScanPagePayload;
  mode: SidebarMode;
}

function formatScanTime(value?: string) {
  if (!value) {
    return 'No recent scan';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

export function ContextSnapshot({ context, canvasApiSummary, pageContext, latestScan, mode }: ContextSnapshotProps) {
  if (!context && mode === 'general') {
    return (
      <section className="canvy-card">
        <div className="canvy-eyebrow">Page Context Detected</div>
        <h3>{pageContext?.title ?? 'Current page'}</h3>
        <p>
          <strong>{pageContext?.domain ?? 'Website'}</strong>
          {pageContext?.url ? ` - ${pageContext.url}` : ''}
        </p>
        <div className="canvy-chip-row">
          <span className="canvy-chip">general page</span>
          {pageContext?.headings.length ? <span className="canvy-chip">{pageContext.headings.length} heading(s)</span> : null}
          {pageContext?.textLength ? <span className="canvy-chip">{pageContext.textLength} chars</span> : null}
          {latestScan?.scannedAt ? <span className="canvy-chip">Scanned {formatScanTime(latestScan.scannedAt)}</span> : null}
        </div>
        <p className="canvy-muted">
          {pageContext?.previewText
            ? `${pageContext.previewText.slice(0, 260)}${pageContext.previewText.length > 260 ? '...' : ''}`
            : 'Mako IQ is ready to read the title, URL, and visible page text here.'}
        </p>
        {latestScan ? (
          <div className="canvy-panel-inline-result">
            <div className="canvy-eyebrow">Latest scan summary</div>
            <p className="canvy-copy-block">{latestScan.summary}</p>
          </div>
        ) : null}
      </section>
    );
  }

  if (!context) {
    return (
      <section className="canvy-card">
        <div className="canvy-eyebrow">Canvas Context</div>
        <h3>{latestScan?.title ?? 'Open a Canvas page to unlock enhanced workflows'}</h3>
        <p>
          {latestScan
            ? `Mako IQ scanned this ${latestScan.pageType ?? 'page'} using ${latestScan.sourceMode ?? 'dom'} extraction.`
            : 'Mako IQ looks for course, assignment, discussion, file, and quiz-review context on the page you have open.'}
        </p>
        {latestScan?.extractionNotes?.length ? (
        <div className="canvy-chip-row">
          {latestScan.extractionNotes.slice(0, 2).map((note) => (
            <span key={note} className="canvy-chip">
              {note}
            </span>
          ))}
          <span className="canvy-chip">Scanned {formatScanTime(latestScan.scannedAt)}</span>
        </div>
      ) : null}
    </section>
  );
}

  return (
    <section className="canvy-card">
      <div className="canvy-eyebrow">Detected Context</div>
      <h3>{context.title}</h3>
      <p>
        <strong>{context.courseName}</strong>
        {context.dueAtText ? ` - ${context.dueAtText}` : ''}
      </p>
      <div className="canvy-chip-row">
        <span className="canvy-chip">{context.pageKind.replace('_', ' ')}</span>
        {context.quizSafetyMode !== 'none' ? <span className="canvy-chip">{context.quizSafetyMode.replace('_', ' ')}</span> : null}
        {context.attachments.length ? <span className="canvy-chip">{context.attachments.length} attachment(s)</span> : null}
        {canvasApiSummary?.source === 'canvas_api' ? <span className="canvy-chip">Canvas API connected</span> : null}
        {canvasApiSummary?.source === 'mock' ? <span className="canvy-chip">Mock assignment feed</span> : null}
        {latestScan?.scannedAt ? <span className="canvy-chip">Scanned {formatScanTime(latestScan.scannedAt)}</span> : null}
      </div>
      {context.inaccessibleReason ? <div className="canvy-inline-warning">{context.inaccessibleReason}</div> : null}
      <p className="canvy-muted">
        {context.promptText
          ? `${context.promptText.slice(0, 220)}${context.promptText.length > 220 ? '...' : ''}`
          : 'Mako IQ found limited prompt text on this page.'}
      </p>
      {latestScan ? (
        <div className="canvy-panel-inline-result">
          <div className="canvy-eyebrow">Latest scan summary</div>
          <p className="canvy-copy-block">{latestScan.summary}</p>
        </div>
      ) : null}
      {canvasApiSummary?.upcomingAssignments.length ? (
        <div className="canvy-chip-row">
          {canvasApiSummary.upcomingAssignments.slice(0, 3).map((assignment) => (
            <span key={assignment.id} className="canvy-chip">
              {assignment.title}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}
