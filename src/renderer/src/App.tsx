import { useCallback, useEffect, useMemo, useState } from 'react';
import logoUrl from './assets/logo.png';
import { CompareView } from './CompareView';
import { DataSubmitView } from './DataSubmitView';
import { FlightViewer } from './FlightViewer';
import { ImportWorkflow } from './ImportWorkflow';
import type { DisplayUnitSystem, FlightSummary, ImportConfig, SaveImportResult, ThemeId } from './importTypes';
import {
  convertDisplayValue,
  displayUnitLabel,
  type ColumnUnit
} from '../../shared/units';

type BaseTab = {
  id: string;
  title: string;
  kind: 'home' | 'compare' | 'import' | 'viewer' | 'submit';
};

type HomeTab = BaseTab & {
  kind: 'home';
};

type CompareTab = BaseTab & {
  kind: 'compare';
};

type SubmitTab = BaseTab & {
  kind: 'submit';
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

type AppTab = HomeTab | CompareTab | SubmitTab | ImportTab | ViewerTab;

const HOME_TAB_ID = 'home';
const COMPARE_TAB_ID = 'compare';
const SUBMIT_TAB_ID = 'submit';
const LENGTH_METERS: ColumnUnit = { family: 'length', unit: 'm' };
const VELOCITY_METERS_PER_SECOND: ColumnUnit = { family: 'velocity', unit: 'm/s' };
const ACCELERATION_METERS_PER_SECOND_SQUARED: ColumnUnit = { family: 'acceleration', unit: 'm/s^2' };

export function App() {
  const [tabs, setTabs] = useState<AppTab[]>([
    { id: HOME_TAB_ID, title: 'Overview', kind: 'home' },
    { id: COMPARE_TAB_ID, title: 'Compare', kind: 'compare' }
  ]);
  const [activeTabId, setActiveTabId] = useState<string>(HOME_TAB_ID);
  const [outputDirectory, setOutputDirectory] = useState('');
  const [config, setConfig] = useState<ImportConfig | null>(null);
  const [flights, setFlights] = useState<FlightSummary[]>([]);
  const [theme, setTheme] = useState<ThemeId>('default-dark');
  const [displayUnits, setDisplayUnits] = useState<DisplayUnitSystem>('metric');
  const [searchKeyword, setSearchKeyword] = useState('');
  const [altimeterTypeFilter, setAltimeterTypeFilter] = useState('');
  const [gpsDataFilter, setGpsDataFilter] = useState<'all' | 'with-gps' | 'without-gps'>('all');
  const [altitudeMinInput, setAltitudeMinInput] = useState('');
  const [altitudeMaxInput, setAltitudeMaxInput] = useState('');
  const [velocityMinInput, setVelocityMinInput] = useState('');
  const [velocityMaxInput, setVelocityMaxInput] = useState('');
  const [accelerationMinInput, setAccelerationMinInput] = useState('');
  const [accelerationMaxInput, setAccelerationMaxInput] = useState('');

  const filteredFlights = useMemo(() => {
    const keyword = searchKeyword.trim().toLowerCase();

    const inRange = (
      value: number | null,
      min: string,
      max: string,
      columnUnit: ColumnUnit
    ) => {
      const minNum = Number.parseFloat(min);
      const maxNum = Number.parseFloat(max);
      const hasMin = Number.isFinite(minNum);
      const hasMax = Number.isFinite(maxNum);
      if (!hasMin && !hasMax) return true;
      if (value === null) return false;
      const displayValue = convertDisplayValue(value, columnUnit, displayUnits);
      if (hasMin && displayValue < minNum) return false;
      if (hasMax && displayValue > maxNum) return false;
      return true;
    };

    return flights.filter((flight) => {
      if (!inRange(flight.peakAltitudeMeters, altitudeMinInput, altitudeMaxInput, LENGTH_METERS)) return false;
      if (!inRange(flight.peakVelocityMs, velocityMinInput, velocityMaxInput, VELOCITY_METERS_PER_SECOND)) return false;
      if (
        !inRange(
          flight.peakAccelerationMss,
          accelerationMinInput,
          accelerationMaxInput,
          ACCELERATION_METERS_PER_SECOND_SQUARED
        )
      ) {
        return false;
      }
      if (altimeterTypeFilter) {
        const hasMatch = flight.altimeters.some(
          (altimeter) => altimeter.altimeterName === altimeterTypeFilter
        );
        if (!hasMatch) return false;
      }
      if (gpsDataFilter === 'with-gps' && !flight.hasGpsData) return false;
      if (gpsDataFilter === 'without-gps' && flight.hasGpsData) return false;
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
    gpsDataFilter,
    altitudeMinInput,
    altitudeMaxInput,
    velocityMinInput,
    velocityMaxInput,
    accelerationMinInput,
    accelerationMaxInput,
    displayUnits
  ]);

  const refreshFlights = useCallback(async () => {
    const nextFlights = await window.appBridge.listFlights();
    setFlights(nextFlights);
    return nextFlights;
  }, []);

  useEffect(() => {
    window.appBridge.getImportConfig().then(setConfig);
    window.appBridge.getOutputDirectory().then(setOutputDirectory);
    window.appBridge.getTheme().then(setTheme);
    refreshFlights();
  }, [refreshFlights]);

  useEffect(() => {
    void window.appBridge.debugLog('renderer:mounted', { userAgent: navigator.userAgent });

    const onError = (event: ErrorEvent) => {
      void window.appBridge.debugLog('renderer:error', {
        message: event.message,
        filename: event.filename,
        line: event.lineno,
        column: event.colno
      });
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      void window.appBridge.debugLog('renderer:unhandled-rejection', {
        reason:
          event.reason instanceof Error
            ? { message: event.reason.message, stack: event.reason.stack }
            : String(event.reason)
      });
    };

    let previousTick = performance.now();
    const watchdog = window.setInterval(() => {
      const now = performance.now();
      const delta = now - previousTick;
      previousTick = now;
      if (delta > 2500) {
        void window.appBridge.debugLog('renderer:event-loop-lag', {
          deltaMs: Math.round(delta)
        });
      }
    }, 1000);

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);

    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      window.clearInterval(watchdog);
    };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const openSubmitData = useCallback(() => {
    setTabs((currentTabs) => {
      if (currentTabs.some((tab) => tab.id === SUBMIT_TAB_ID)) {
        setActiveTabId(SUBMIT_TAB_ID);
        return currentTabs;
      }

      setActiveTabId(SUBMIT_TAB_ID);
      return [...currentTabs, { id: SUBMIT_TAB_ID, title: 'Submit Data', kind: 'submit' }];
    });
  }, []);

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
    const removeSubmitDataListener = window.appBridge.onSubmitDataRequested(openSubmitData);

    const removeDirectoryListener = window.appBridge.onOutputDirectoryChanged((directory) => {
      setOutputDirectory(directory);
      refreshFlights();
    });
    const removeThemeListener = window.appBridge.onThemeChanged((nextTheme) => {
      setTheme(nextTheme);
    });

    return () => {
      removeImportListener();
      removeSubmitDataListener();
      removeDirectoryListener();
      removeThemeListener();
    };
  }, [openSubmitData, refreshFlights]);

  const closeTab = (tabId: string) => {
    setTabs((currentTabs) => {
      const tabIndex = currentTabs.findIndex((tab) => tab.id === tabId);
      const nextTabs = currentTabs.filter((tab) => tab.id !== tabId);

      if (activeTabId === tabId) {
        setActiveTabId(nextTabs[Math.max(0, tabIndex - 1)]?.id ?? HOME_TAB_ID);
      }

      return nextTabs.length > 0
        ? nextTabs
        : [
            { id: HOME_TAB_ID, title: 'Overview', kind: 'home' },
            { id: COMPARE_TAB_ID, title: 'Compare', kind: 'compare' }
          ];
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
              <span className="summary-label">3D data</span>
              <select
                value={gpsDataFilter}
                onChange={(event) =>
                  setGpsDataFilter(event.target.value as 'all' | 'with-gps' | 'without-gps')
                }
              >
                <option value="all">All</option>
                <option value="with-gps">Has GPS / 3D</option>
                <option value="without-gps">No GPS / 3D</option>
              </select>
            </label>
            <label>
              <span className="summary-label">Min altitude ({displayUnitLabel(LENGTH_METERS, displayUnits)})</span>
              <input
                type="number"
                value={altitudeMinInput}
                onChange={(event) => setAltitudeMinInput(event.target.value)}
                placeholder="Any"
              />
            </label>
            <label>
              <span className="summary-label">Max altitude ({displayUnitLabel(LENGTH_METERS, displayUnits)})</span>
              <input
                type="number"
                value={altitudeMaxInput}
                onChange={(event) => setAltitudeMaxInput(event.target.value)}
                placeholder="Any"
              />
            </label>
            <label>
              <span className="summary-label">
                Min velocity ({displayUnitLabel(VELOCITY_METERS_PER_SECOND, displayUnits)})
              </span>
              <input
                type="number"
                value={velocityMinInput}
                onChange={(event) => setVelocityMinInput(event.target.value)}
                placeholder="Any"
              />
            </label>
            <label>
              <span className="summary-label">
                Max velocity ({displayUnitLabel(VELOCITY_METERS_PER_SECOND, displayUnits)})
              </span>
              <input
                type="number"
                value={velocityMaxInput}
                onChange={(event) => setVelocityMaxInput(event.target.value)}
                placeholder="Any"
              />
            </label>
            <label>
              <span className="summary-label">
                Min accel ({displayUnitLabel(ACCELERATION_METERS_PER_SECOND_SQUARED, displayUnits)})
              </span>
              <input
                type="number"
                value={accelerationMinInput}
                onChange={(event) => setAccelerationMinInput(event.target.value)}
                placeholder="Any"
              />
            </label>
            <label>
              <span className="summary-label">
                Max accel ({displayUnitLabel(ACCELERATION_METERS_PER_SECOND_SQUARED, displayUnits)})
              </span>
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
                const value = convertDisplayValue(flight.peakAltitudeMeters, LENGTH_METERS, displayUnits);
                metaParts.push(`${Math.round(value).toLocaleString()} ${displayUnitLabel(LENGTH_METERS, displayUnits)}`);
              }
              if (flight.peakVelocityMs !== null) {
                const value = convertDisplayValue(
                  flight.peakVelocityMs,
                  VELOCITY_METERS_PER_SECOND,
                  displayUnits
                );
                metaParts.push(
                  `${Math.round(value).toLocaleString()} ${displayUnitLabel(VELOCITY_METERS_PER_SECOND, displayUnits)}`
                );
              }
              if (flight.peakAccelerationMss !== null) {
                const value = convertDisplayValue(
                  flight.peakAccelerationMss,
                  ACCELERATION_METERS_PER_SECOND_SQUARED,
                  displayUnits
                );
                metaParts.push(
                  `${Math.round(value).toLocaleString()} ${displayUnitLabel(
                    ACCELERATION_METERS_PER_SECOND_SQUARED,
                    displayUnits
                  )}`
                );
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

    if (tab.kind === 'compare') {
      return (
        <CompareView
          config={config}
          displayUnits={displayUnits}
          flights={flights}
          isActive={isActive}
          theme={theme}
        />
      );
    }

    if (tab.kind === 'submit') {
      return <DataSubmitView />;
    }

    return (
      <FlightViewer
        config={config}
        displayUnits={displayUnits}
        flight={flights.find((flight) => flight.directoryName === tab.flightDirectoryName) ?? null}
        isActive={isActive}
        onDatasetUpdated={refreshFlights}
        selectedAltimeterDirectory={tab.selectedAltimeterDirectory}
        theme={theme}
      />
    );
  };

  return (
    <main className="app-shell">
      <nav className="tabbar" aria-label="Primary tabs">
        <img className="app-logo" src={logoUrl} alt="Rocket Flight Data" />
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`tab ${tab.id === activeTab?.id ? 'active' : ''}`}
            onClick={() => setActiveTabId(tab.id)}
            type="button"
          >
            <span>{tab.title}</span>
            {tab.kind !== 'home' && tab.kind !== 'compare' ? (
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
        <span className="tabbar-spacer" />
        <label className="unit-selector">
          <span>Units</span>
          <select
            value={displayUnits}
            onChange={(event) => setDisplayUnits(event.target.value as DisplayUnitSystem)}
          >
            <option value="metric">Meters</option>
            <option value="imperial">Feet</option>
          </select>
        </label>
      </nav>
      <section className="tab-content">
        {tabs.map((tab) => (
          <div
            className={`tab-panel ${tab.kind === 'viewer' || tab.kind === 'compare' ? 'viewer-tab-panel' : ''}`}
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
