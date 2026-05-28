import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlightViewer } from './FlightViewer';
import { ImportWorkflow } from './ImportWorkflow';
import type { FlightSummary, ImportConfig, SaveImportResult } from './importTypes';

type BaseTab = {
  id: string;
  title: string;
  kind: 'home' | 'import' | 'viewer';
};

type HomeTab = BaseTab & {
  kind: 'home';
};

type ImportTab = BaseTab & {
  kind: 'import';
  files: string[];
};

type ViewerTab = BaseTab & {
  kind: 'viewer';
  flightDirectoryName: string;
  selectedAltimeterDirectory?: string;
};

type AppTab = HomeTab | ImportTab | ViewerTab;

const HOME_TAB_ID = 'home';

export function App() {
  const [tabs, setTabs] = useState<AppTab[]>([
    { id: HOME_TAB_ID, title: 'Overview', kind: 'home' }
  ]);
  const [activeTabId, setActiveTabId] = useState<string>(HOME_TAB_ID);
  const [outputDirectory, setOutputDirectory] = useState('');
  const [config, setConfig] = useState<ImportConfig | null>(null);
  const [flights, setFlights] = useState<FlightSummary[]>([]);

  const refreshFlights = useCallback(async () => {
    const nextFlights = await window.appBridge.listFlights();
    setFlights(nextFlights);
    return nextFlights;
  }, []);

  useEffect(() => {
    window.appBridge.getImportConfig().then(setConfig);
    window.appBridge.getOutputDirectory().then(setOutputDirectory);
    refreshFlights();
  }, [refreshFlights]);

  useEffect(() => {
    const removeImportListener = window.appBridge.onImportRequested((files) => {
      setTabs((currentTabs) => {
        const newTab: ImportTab = {
          id: `import-${Date.now()}`,
          title: `Import ${currentTabs.filter((tab) => tab.kind === 'import').length + 1}`,
          kind: 'import',
          files
        };

        setActiveTabId(newTab.id);
        return [...currentTabs, newTab];
      });
    });

    const removeDirectoryListener = window.appBridge.onOutputDirectoryChanged((directory) => {
      setOutputDirectory(directory);
      refreshFlights();
    });

    return () => {
      removeImportListener();
      removeDirectoryListener();
    };
  }, [refreshFlights]);

  const closeTab = (tabId: string) => {
    setTabs((currentTabs) => {
      const tabIndex = currentTabs.findIndex((tab) => tab.id === tabId);
      const nextTabs = currentTabs.filter((tab) => tab.id !== tabId);

      if (activeTabId === tabId) {
        setActiveTabId(nextTabs[Math.max(0, tabIndex - 1)]?.id ?? HOME_TAB_ID);
      }

      return nextTabs.length > 0 ? nextTabs : [{ id: HOME_TAB_ID, title: 'Overview', kind: 'home' }];
    });
  };

  const openFlight = useCallback((flight: {
    directoryName: string;
    selectedAltimeterDirectory?: string;
  }) => {
    setTabs((currentTabs) => {
      const existingTab = currentTabs.find(
        (tab): tab is ViewerTab =>
          tab.kind === 'viewer' && tab.flightDirectoryName === flight.directoryName
      );

      if (existingTab) {
        setActiveTabId(existingTab.id);
        return currentTabs.map((tab) =>
          tab.id === existingTab.id
            ? {
                ...tab,
                selectedAltimeterDirectory:
                  flight.selectedAltimeterDirectory ?? existingTab.selectedAltimeterDirectory
              }
            : tab
        );
      }

      const newTab: ViewerTab = {
        id: `viewer-${Date.now()}`,
        title: flight.directoryName,
        kind: 'viewer',
        flightDirectoryName: flight.directoryName,
        selectedAltimeterDirectory: flight.selectedAltimeterDirectory
      };

      setActiveTabId(newTab.id);
      return [...currentTabs, newTab];
    });
  }, []);

  const handleImportSaved = async (importTabId: string, result: SaveImportResult) => {
    await refreshFlights();
    setTabs((currentTabs) => currentTabs.filter((tab) => tab.id !== importTabId));
    openFlight({
      directoryName: result.dataset.flightDirectoryName,
      selectedAltimeterDirectory: result.dataset.altimeterDirectory
    });
  };

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0],
    [activeTabId, tabs]
  );

  const renderTabContent = (tab: AppTab, isActive: boolean) => {
    if (tab.kind === 'home') {
      return (
        <section className="home-panel">
          <h2>Overview</h2>
          <div className="summary-grid">
            <div>
              <span className="summary-label">Directory</span>
              <span className="summary-value">{outputDirectory}</span>
            </div>
            <div>
              <span className="summary-label">Imported flights</span>
              <span className="summary-value">{flights.length}</span>
            </div>
          </div>
          <div className="flight-list">
            {flights.map((flight) => (
              <section className="flight-group" key={flight.directoryName}>
                <div className="flight-group-header">
                  <div>
                    <h3>{flight.directoryName}</h3>
                    <span>{flight.location || 'No location set'}</span>
                  </div>
                  <button
                    className="small-button"
                    onClick={() => openFlight({ directoryName: flight.directoryName })}
                    type="button"
                  >
                    Open
                  </button>
                </div>
                <div className="dataset-list">
                  {flight.altimeters.map((altimeter) => (
                    <button
                      className="dataset-row"
                      key={altimeter.id}
                      onClick={() =>
                        openFlight({
                          directoryName: flight.directoryName,
                          selectedAltimeterDirectory: altimeter.altimeterDirectory
                        })
                      }
                      type="button"
                    >
                      <span>{altimeter.altimeterDirectoryName}</span>
                      <span>{altimeter.rowCount} rows</span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
            {flights.length === 0 ? (
              <div className="muted-text">No imported flights in this directory.</div>
            ) : null}
          </div>
        </section>
      );
    }

    if (tab.kind === 'import') {
      return (
        <ImportWorkflow
          config={config}
          files={tab.files}
          flights={flights}
          onSaved={(result) => handleImportSaved(tab.id, result)}
          outputDirectory={outputDirectory}
        />
      );
    }

    return (
      <FlightViewer
        flight={flights.find((flight) => flight.directoryName === tab.flightDirectoryName) ?? null}
        isActive={isActive}
        onDatasetUpdated={refreshFlights}
        selectedAltimeterDirectory={tab.selectedAltimeterDirectory}
      />
    );
  };

  return (
    <main className="app-shell">
      <nav className="tabbar" aria-label="Primary tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`tab ${tab.id === activeTab?.id ? 'active' : ''}`}
            onClick={() => setActiveTabId(tab.id)}
            type="button"
          >
            <span>{tab.title}</span>
            {tab.kind !== 'home' ? (
              <span
                aria-label={`Close ${tab.title}`}
                className="tab-close"
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.id);
                }}
                role="button"
                title={`Close ${tab.title}`}
              >
                x
              </span>
            ) : null}
          </button>
        ))}
      </nav>
      <section className="tab-content">
        {tabs.map((tab) => (
          <div
            className={`tab-panel ${tab.kind === 'viewer' ? 'viewer-tab-panel' : ''}`}
            hidden={tab.id !== activeTab?.id}
            key={tab.id}
          >
            {renderTabContent(tab, tab.id === activeTab?.id)}
          </div>
        ))}
      </section>
    </main>
  );
}
