export {};

import type {
  FlightSummary,
  ImportedDataset,
  ImportConfig,
  ImportPreview,
  CustomAttribute,
  AltimeterDetectionResult,
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
      listFlights: () => Promise<FlightSummary[]>;
      detectAltimeter: (filePaths: string[]) => Promise<AltimeterDetectionResult>;
      readDataset: (datasetDirectory: string) => Promise<ImportedDataset>;
      saveDatasetAttributes: (request: {
        datasetDirectory: string;
        attributes: CustomAttribute[];
      }) => Promise<ImportedDataset>;
      previewImport: (request: {
        altimeterId: string;
        filePaths: string[];
      }) => Promise<ImportPreview>;
      saveImport: (request: SaveImportRequest) => Promise<SaveImportResult>;
      onImportRequested: (callback: (paths: string[]) => void) => () => void;
      onOutputDirectoryChanged: (callback: (path: string) => void) => () => void;
    };
  }
}
