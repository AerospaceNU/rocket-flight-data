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
  const [searchKeyword, setSearchKeyword] = useState('');
  const [altimeterTypeFilter, setAltimeterTypeFilter] = useState('');
  const [altitudeMinInput, setAltitudeMinInput] = useState('');
  const [altitudeMaxInput, setAltitudeMaxInput] = useState('');
  const [velocityMinInput, setVelocityMinInput] = useState('');
  const [velocityMaxInput, setVelocityMaxInput] = useState('');
  const [accelerationMinInput, setAccelerationMinInput] = useState('');
  const [accelerationMaxInput, setAccelerationMaxInput] = useState('');

  const filteredFlights = useMemo(() => {
    const keyword = searchKeyword.trim().toLowerCase();

    const inRange = (value: number | null, min: string, max: string) => {
      const minNum = Number.parseFloat(min);
      const maxNum = Number.parseFloat(max);
      const hasMin = Number.isFinite(minNum);
      const hasMax = Number.isFinite(maxNum);
      if (!hasMin && !hasMax) return true;
      if (value === null) return false;
      if (hasMin && value < minNum) return false;
      if (hasMax && value > maxNum) return false;
      return true;
    };

    return flights.filter((flight) => {
      if (!inRange(flight.peakAltitudeMeters, altitudeMinInput, altitudeMaxInput)) return false;
      if (!inRange(flight.peakVelocityMs, velocityMinInput, velocityMaxInput)) return false;
      if (!inRange(flight.peakAccelerationMss, accelerationMinInput, accelerationMaxInput)) return false;
      if (altimeterTypeFilter) {
        const hasMatch = flight.altimeters.some(
          (altimeter) => altimeter.altimeterName === altimeterTypeFilter
        );
        if (!hasMatch) return false;
      }
      if (keyword) {
        const haystacks: string[] = [
          flight.directoryName,
          flight.name,
          flight.location,
          ...flight.altimeters.flatMap((altimeter) => [
            altimeter.altimeterDirectoryName,
            ...Object.values(altimeter.attributes)
          ])
        ];
        const matches = haystacks.some((value) => value?.toLowerCase().includes(keyword));
        if (!matches) return false;
      }
      return true;
    });
  }, [
    flights,
    searchKeyword,
    altimeterTypeFilter,
    altitudeMinInput,
    altitudeMaxInput,
    velocityMinInput,
    velocityMaxInput,
    accelerationMinInput,
    accelerationMaxInput
  ]);

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
              <span className="summary-value">
                {filteredFlights.length}
                {filteredFlights.length !== flights.length ? ` / ${flights.length}` : ''}
              </span>
            </div>
          </div>
          <div className="flight-filters">
            <label className="filter-wide">
              <span className="summary-label">Search</span>
              <input
                type="search"
                value={searchKeyword}
                onChange={(event) => setSearchKeyword(event.target.value)}
                placeholder="Name, location, motor, altimeter, notes..."
              />
            </label>
            <label>
              <span className="summary-label">Altimeter</span>
              <select
                value={altimeterTypeFilter}
                onChange={(event) => setAltimeterTypeFilter(event.target.value)}
              >
                <option value="">All</option>
                {config?.altimeters.map((altimeter) => (
                  <option key={altimeter.id} value={altimeter.name}>
                    {altimeter.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="summary-label">Min altitude (m)</span>
              <input
                type="number"
                value={altitudeMinInput}
                onChange={(event) => setAltitudeMinInput(event.target.value)}
                placeholder="Any"
              />
            </label>
            <label>
              <span className="summary-label">Max altitude (m)</span>
              <input
                type="number"
                value={altitudeMaxInput}
                onChange={(event) => setAltitudeMaxInput(event.target.value)}
                placeholder="Any"
              />
            </label>
            <label>
              <span className="summary-label">Min velocity (m/s)</span>
              <input
                type="number"
                value={velocityMinInput}
                onChange={(event) => setVelocityMinInput(event.target.value)}
                placeholder="Any"
              />
            </label>
            <label>
              <span className="summary-label">Max velocity (m/s)</span>
              <input
                type="number"
                value={velocityMaxInput}
                onChange={(event) => setVelocityMaxInput(event.target.value)}
                placeholder="Any"
              />
            </label>
            <label>
              <span className="summary-label">Min accel (m/s&sup2;)</span>
              <input
                type="number"
                value={accelerationMinInput}
                onChange={(event) => setAccelerationMinInput(event.target.value)}
                placeholder="Any"
              />
            </label>
            <label>
              <span className="summary-label">Max accel (m/s&sup2;)</span>
              <input
                type="number"
                value={accelerationMaxInput}
                onChange={(event) => setAccelerationMaxInput(event.target.value)}
                placeholder="Any"
              />
            </label>
          </div>
          <div className="flight-list">
            {filteredFlights.map((flight) => {
              const metaParts = [flight.location || 'No location set'];
              if (flight.peakAltitudeMeters !== null) {
                metaParts.push(`${Math.round(flight.peakAltitudeMeters).toLocaleString()} m`);
              }
              if (flight.peakVelocityMs !== null) {
                metaParts.push(`${Math.round(flight.peakVelocityMs).toLocaleString()} m/s`);
              }
              if (flight.peakAccelerationMss !== null) {
                metaParts.push(`${Math.round(flight.peakAccelerationMss).toLocaleString()} m/s²`);
              }
              const handleOpen = () => openFlight({ directoryName: flight.directoryName });
              return (
                <div
                  className="flight-row"
                  key={flight.directoryName}
                  role="button"
                  tabIndex={0}
                  onClick={handleOpen}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      handleOpen();
                    }
                  }}
                >
                  <div className="flight-row-main">
                    <h3>{flight.directoryName}</h3>
                    <span className="flight-row-meta">{metaParts.join(' · ')}</span>
                  </div>
                  <div className="flight-row-altimeters">
                    {flight.altimeters.map((altimeter) => (
                      <button
                        className="altimeter-chip"
                        key={altimeter.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          openFlight({
                            directoryName: flight.directoryName,
                            selectedAltimeterDirectory: altimeter.altimeterDirectory
                          });
                        }}
                        type="button"
                      >
                        {altimeter.altimeterDirectoryName}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
            {filteredFlights.length === 0 ? (
              <div className="muted-text">
                {flights.length === 0
                  ? 'No imported flights in this directory.'
                  : 'No flights match the current filters.'}
              </div>
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
