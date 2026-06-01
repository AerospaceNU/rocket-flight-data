export {};

import type {
  FlightSummary,
  ImportedDataset,
  ImportConfig,
  ImportPreview,
  CustomAttribute,
  AltimeterDetectionResult,
  ThemeId,
  SaveImportRequest,
  SaveImportResult
} from './importTypes';

declare global {
  interface Window {
    appInfo: {
      name: string;
      version: string;
    };
    appBridge: {
      getImportConfig: () => Promise<ImportConfig>;
      getOutputDirectory: () => Promise<string>;
      getTheme: () => Promise<ThemeId>;
      listFlights: () => Promise<FlightSummary[]>;
      detectAltimeter: (filePaths: string[]) => Promise<AltimeterDetectionResult>;
      readDataset: (
        datasetDirectory: string,
        options?: { sanitize?: boolean }
      ) => Promise<ImportedDataset>;
      saveDatasetAttributes: (request: {
        datasetDirectory: string;
        attributes: CustomAttribute[];
      }) => Promise<ImportedDataset>;
      readFlightAttributes: (flightDirectoryName: string) => Promise<CustomAttribute[]>;
      saveFlightAttributes: (request: {
        flightDirectoryName: string;
        attributes: CustomAttribute[];
      }) => Promise<FlightSummary[]>;
      previewImport: (request: {
        altimeterId: string;
        filePaths: string[];
      }) => Promise<ImportPreview>;
      saveImport: (request: SaveImportRequest) => Promise<SaveImportResult>;
      debugLog: (message: string, data?: unknown) => Promise<void>;
      onImportRequested: (callback: (paths: string[]) => void) => () => void;
      onOutputDirectoryChanged: (callback: (path: string) => void) => () => void;
      onThemeChanged: (callback: (theme: ThemeId) => void) => () => void;
    };
  }
}
