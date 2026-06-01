export type CommonAttributeDefinition = {
  key: string;
  label: string;
  required: boolean;
};

export type ThemeId = 'default-dark' | 'slate-light' | 'forest-dark' | 'amber-dark';

export type StandardColumnRef = {
  column: string;
  scaleToStandard?: number;
};

export type StandardColumnMapping = {
  altitudeMeters?: StandardColumnRef;
  velocityMetersPerSecond?: StandardColumnRef;
  accelerationMetersPerSecondSquared?: StandardColumnRef;
};

export type AltimeterDefinition = {
  id: string;
  name: string;
  importerId: string;
  standardColumns: StandardColumnMapping;
};

export type ImportConfig = {
  altimeters: AltimeterDefinition[];
  commonAttributes: CommonAttributeDefinition[];
};

export type FlightSummary = {
  directoryName: string;
  path: string;
  date: string;
  name: string;
  location: string;
  altimeterCount: number;
  hasGpsData: boolean;
  peakAltitudeMeters: number | null;
  peakVelocityMs: number | null;
  peakAccelerationMss: number | null;
  altimeters: ImportedAltimeterSummary[];
};

export type ImportedAltimeterSummary = {
  id: string;
  flightDirectoryName: string;
  flightDate: string;
  rocketName: string;
  flightLocation: string;
  altimeterDirectoryName: string;
  altimeterDirectory: string;
  altimeterName: string;
  altimeterNote: string;
  motor: string;
  flightNotes: string;
  hasGpsData: boolean;
  peakAltitudeMeters: number | null;
  peakVelocityMs: number | null;
  peakAccelerationMss: number | null;
  rowCount: number;
  attributes: Record<string, string>;
};

export type ImportedDataset = {
  summary: ImportedAltimeterSummary;
  attributes: CustomAttribute[];
  headers: string[];
  rows: string[][];
};

export type ImportPreview = {
  headers: string[];
  rowCount: number;
  attributes: Record<string, string>;
  warnings: string[];
  sourceFiles: string[];
};

export type AltimeterDetectionResult = {
  altimeterId: string | null;
  confidence: 'high' | 'medium' | 'low' | 'none';
  reason: string;
};

export type CustomAttribute = {
  key: string;
  value: string;
};

export type SaveImportRequest = {
  altimeterId: string;
  filePaths: string[];
  flightMode: 'new' | 'existing';
  newFlight?: {
    date: string;
    name: string;
    location: string;
  };
  existingFlightDirectoryName?: string;
  flightLocation: string;
  altimeterNote: string;
  customAttributes: CustomAttribute[];
};

export type SaveImportResult = {
  outputDirectory: string;
  flightDirectory: string;
  altimeterDirectory: string;
  attributesPath: string;
  rowsWritten: number;
  dataset: ImportedAltimeterSummary;
};
