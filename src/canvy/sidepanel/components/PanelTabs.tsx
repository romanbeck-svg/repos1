export type PanelTabId = 'overview' | 'analyze' | 'canvas' | 'workspace' | 'settings';

interface PanelTabsProps {
  activeTab: PanelTabId;
  onChange: (tab: PanelTabId) => void;
}

const TABS: Array<{ id: PanelTabId; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'analyze', label: 'Analyze' },
  { id: 'canvas', label: 'Canvas' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'settings', label: 'Settings' }
];

export function PanelTabs({ activeTab, onChange }: PanelTabsProps) {
  return (
    <nav className="canvy-panel-tabs" aria-label="Canvy workspace tabs">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={`canvy-panel-tab ${activeTab === tab.id ? 'canvy-panel-tab-active' : ''}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
