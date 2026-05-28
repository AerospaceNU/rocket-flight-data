import { ALTIMETERS, COMMON_ATTRIBUTES } from '../../shared/importConfig';
import { easyMiniImporter } from './easymini';
import { fcbImporter } from './fcb';
import { rawGpsDataImporter } from './rawgpsdata';
import { sillyGooseImporter } from './sillygoose';
import { stratoLoggerCfImporter } from './stratologgercf';
import type { AltimeterImporter } from './types';

const importers = new Map<string, AltimeterImporter>([
  [sillyGooseImporter.id, sillyGooseImporter],
  [easyMiniImporter.id, easyMiniImporter],
  [stratoLoggerCfImporter.id, stratoLoggerCfImporter],
  [rawGpsDataImporter.id, rawGpsDataImporter],
  [fcbImporter.id, fcbImporter]
]);

export function getImportConfig() {
  return {
    altimeters: ALTIMETERS,
    commonAttributes: COMMON_ATTRIBUTES
  };
}

export function getImporterForAltimeter(altimeterId: string) {
  const altimeter = ALTIMETERS.find((item) => item.id === altimeterId);

  if (!altimeter) {
    throw new Error(`Unknown altimeter: ${altimeterId}`);
  }

  const importer = importers.get(altimeter.importerId);

  if (!importer) {
    throw new Error(`No importer registered for altimeter: ${altimeter.name}`);
  }

  return { altimeter, importer };
}

export function getAltimeterDefinition(altimeterId: string) {
  return ALTIMETERS.find((item) => item.id === altimeterId) ?? null;
}

export function getImporterById(importerId: string) {
  return importers.get(importerId) ?? null;
}
