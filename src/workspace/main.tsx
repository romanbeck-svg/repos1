import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from '../sidepanel/App';
import '../shared/styles.css';

class WorkspaceErrorBoundary extends React.Component<React.PropsWithChildren, { hasError: boolean; message: string }> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error) {
    return {
      hasError: true,
      message: error.message || 'Walt could not render this workspace.'
    };
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="app-shell">
          <section className="hero-card stack">
            <span className="label">Walt</span>
            <h1 className="headline">Workspace failed to render</h1>
            <p className="subtle">{this.state.message}</p>
          </section>
        </div>
      );
    }

    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WorkspaceErrorBoundary>
      <App surface="page" />
    </WorkspaceErrorBoundary>
  </React.StrictMode>
);
