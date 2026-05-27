export interface FlightSummary {
  id: string; // folder name
  date: string | null;
  name: string;
}

export interface AltimeterSummary {
  id: string; // folder name (under flight)
  flightId: string;
  board: string;
}

export interface AttributeRow {
  key: string;
  value: string;
  source: string; // 'derived' | 'log' | 'user' | ...
}

export interface FlightEvent {
  /** Time in seconds, relative to the start of the data. */
  timeS: number;
  label: string;
  /** Plotly-compatible color string. */
  color: string;
}

export interface FlightData {
  /** Header column names. */
  columns: string[];
  /** Row data as array of arrays (string or number). */
  rows: (string | number)[][];
  /** Whether this looks like parsed numeric telemetry vs. a raw text log. */
  isTelemetry: boolean;
  /** Time column name from attributes if present. */
  timeColumn: string | null;
  /** Multiplier to convert the time column to seconds (1 for seconds, 0.001 for ms, etc.). */
  timeScaleToSeconds: number;
  /** Numeric columns (subset of columns) suitable for plotting on Y axis. */
  numericColumns: string[];
  /** Total row count. */
  rowCount: number;
  /** Flight events detected from state/pyro columns. Times are in seconds, t0-relative. */
  events: FlightEvent[];
  /** Trim window in seconds (t0-relative) inferred from flightState/state. */
  flightWindowS: { startS: number; endS: number } | null;
}

export interface ApiSurface {
  listFlights: () => Promise<FlightSummary[]>;
  listAltimeters: (flightId: string) => Promise<AltimeterSummary[]>;
  getAttributes: (flightId: string, altimeterId: string) => Promise<AttributeRow[]>;
  saveAttributes: (
    flightId: string,
    altimeterId: string,
    rows: AttributeRow[]
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  getData: (flightId: string, altimeterId: string) => Promise<FlightData>;
}

declare global {
  interface Window {
    api: ApiSurface;
  }
}
