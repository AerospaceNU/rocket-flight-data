import React, { useEffect, useMemo, useState } from 'react';
import type { AltimeterSummary, FlightData, FlightSummary } from '../shared/types';
import { Plot2D } from './Plot2D';
import { Plot3D } from './Plot3D';
import { RawData } from './RawData';
import { Attributes } from './Attributes';
import { findGpsPair } from './gps';

type TabId = '2d' | '3d' | 'raw' | 'attrs' | 'import';

export function App() {
  const [flights, setFlights] = useState<FlightSummary[]>([]);
  const [selectedFlight, setSelectedFlight] = useState<string | null>(null);

  const [altimeters, setAltimeters] = useState<AltimeterSummary[]>([]);
  const [selectedAlt, setSelectedAlt] = useState<string | null>(null);

  const [data, setData] = useState<FlightData | null>(null);
  const [loadingData, setLoadingData] = useState(false);

  const [tab, setTab] = useState<TabId>('2d');

  // Load flight list once.
  useEffect(() => {
    window.api.listFlights().then(setFlights).catch((e) => {
      console.error('listFlights failed', e);
    });
  }, []);

  // Load altimeters when flight changes.
  useEffect(() => {
    if (!selectedFlight) {
      setAltimeters([]);
      setSelectedAlt(null);
      return;
    }
    window.api
      .listAltimeters(selectedFlight)
      .then((list) => {
        setAltimeters(list);
        setSelectedAlt(list[0]?.id ?? null);
      })
      .catch((e) => console.error('listAltimeters failed', e));
  }, [selectedFlight]);

  // Load data when altimeter changes.
  useEffect(() => {
    if (!selectedFlight || !selectedAlt) {
      setData(null);
      return;
    }
    setLoadingData(true);
    setData(null);
    window.api
      .getData(selectedFlight, selectedAlt)
      .then(setData)
      .catch((e) => console.error('getData failed', e))
      .finally(() => setLoadingData(false));
  }, [selectedFlight, selectedAlt]);

  const hasGps = useMemo(() => {
    if (!data) return false;
    const pair = findGpsPair(data.columns);
    if (!pair) return false;
    const iLat = data.columns.indexOf(pair.lat);
    const iLon = data.columns.indexOf(pair.lon);
    for (const row of data.rows) {
      const lat = Number(row[iLat]);
      const lon = Number(row[iLon]);
      if (lat !== 0 && lon !== 0 && Number.isFinite(lat) && Number.isFinite(lon)) return true;
    }
    return false;
  }, [data]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">Flights ({flights.length})</div>
        <ul className="flight-list">
          {flights.map((f) => (
            <li
              key={f.id}
              className={'flight-item' + (f.id === selectedFlight ? ' active' : '')}
              onClick={() => setSelectedFlight(f.id)}
            >
              <div>{f.name}</div>
              {f.date && <div className="date">{f.date}</div>}
            </li>
          ))}
        </ul>
      </aside>

      <main className="main">
        <div className="toolbar">
          <span className="title">
            {selectedFlight
              ? flights.find((f) => f.id === selectedFlight)?.name ?? selectedFlight
              : 'No flight selected'}
          </span>
          {altimeters.length > 0 && (
            <select
              value={selectedAlt ?? ''}
              onChange={(e) => setSelectedAlt(e.target.value)}
            >
              {altimeters.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.board} — {a.id}
                </option>
              ))}
            </select>
          )}
          <span className="spacer" />
          {loadingData && <span style={{ color: 'var(--text-dim)' }}>loading…</span>}
        </div>

        <div className="tabs">
          <div
            className={'tab' + (tab === '2d' ? ' active' : '')}
            onClick={() => setTab('2d')}
          >
            2D Plot
          </div>
          <div
            className={
              'tab' + (tab === '3d' ? ' active' : '') + (hasGps ? '' : ' disabled')
            }
            onClick={() => hasGps && setTab('3d')}
            title={hasGps ? '' : 'No GPS data in this file'}
          >
            3D GPS
          </div>
          <div
            className={'tab' + (tab === 'raw' ? ' active' : '')}
            onClick={() => setTab('raw')}
          >
            Raw Data
          </div>
          <div
            className={'tab' + (tab === 'attrs' ? ' active' : '')}
            onClick={() => setTab('attrs')}
          >
            Attributes
          </div>
          <div
            className={'tab' + (tab === 'import' ? ' active' : '')}
            onClick={() => setTab('import')}
          >
            Import
          </div>
        </div>

        <div className="content">
          {!selectedFlight && (
            <div className="placeholder">Pick a flight from the left.</div>
          )}
          {selectedFlight && !selectedAlt && (
            <div className="placeholder">No altimeter folders in this flight.</div>
          )}
          {selectedFlight && selectedAlt && (
            <>
              {tab === '2d' && <Plot2D data={data} />}
              {tab === '3d' && <Plot3D data={data} />}
              {tab === 'raw' && <RawData data={data} />}
              {tab === 'attrs' && (
                <Attributes
                  flightId={selectedFlight}
                  altimeterId={selectedAlt}
                  key={`${selectedFlight}/${selectedAlt}`}
                />
              )}
              {tab === 'import' && (
                <div className="placeholder">Import — coming later.</div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
