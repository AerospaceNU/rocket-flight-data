// Re-export the shared, process-agnostic telemetry math so renderer modules can
// keep importing from './core' while the single definition lives in src/shared.
export {
  axisRange,
  getColumnIndex,
  getColumnIndexByAliases,
  isMeaningfulGpsCoordinate,
  isValidLatitude,
  isValidLongitude,
  median,
  normalizedHeader,
  parseNumber
} from '../../../shared/telemetryMath';

/**
 * Controls the renderer-side automatic *detection* heuristics (time-axis unit
 * detection, GPS column auto-selection, launch/event estimation). This is
 * independent of main-side parser *sanitization* (the `sanitize` ParseOption),
 * which blanks out-of-range values. The two are surfaced as separate toggles.
 */
export type AutoDetectOptions = {
  autoDetect?: boolean;
};

export function autoDetectEnabled(options?: AutoDetectOptions) {
  return options?.autoDetect !== false;
}
