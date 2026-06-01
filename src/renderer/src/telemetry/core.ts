// Re-export the shared, process-agnostic telemetry math so renderer modules can
// keep importing from './core' while the single definition lives in src/shared.
export {
  axisRange,
  getColumnIndex,
  getColumnIndexByAliases,
  isValidLatitude,
  isValidLongitude,
  median,
  normalizedHeader,
  parseNumber
} from '../../../shared/telemetryMath';

export type AutomaticCheckOptions = {
  automaticChecks?: boolean;
};

export function automaticChecksEnabled(options?: AutomaticCheckOptions) {
  return options?.automaticChecks !== false;
}
