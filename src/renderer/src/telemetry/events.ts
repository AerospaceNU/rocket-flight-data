import type { ImportedDataset } from '../importTypes';
import {
  autoDetectEnabled,
  getColumnIndex,
  getColumnIndexByAliases,
  parseNumber,
  type AutoDetectOptions
} from './core';
import { getEventProfile } from './profiles';

// State-name maps now live with their per-altimeter profiles; re-export for
// any callers that still reference them by their historic location.
export { FLIGHT_STATE_NAMES, EASYMINI_STATE_NAMES, FCB_STATE_NAMES } from './profiles';

export type EventMarker = {
  label: string;
  time: number;
  rowIndex: number;
  color: string;
};

export type EventWindow = {
  events: EventMarker[];
  launchTime: number | null;
  flightStartTime: number;
  flightEndTime: number;
};

const MAX_EVENT_MARKERS = 200;

export function getImporterId(dataset: ImportedDataset) {
  return dataset.attributes.find((attribute) => attribute.key === 'importer_id')?.value ??
    dataset.summary.attributes.importer_id ??
    '';
}

export function estimateLaunchTimeFromAltitude(
  dataset: ImportedDataset,
  xValues: number[],
  options?: AutoDetectOptions
) {
  if (!autoDetectEnabled(options) || dataset.rows.length < 5 || dataset.rows.length !== xValues.length) {
    return null;
  }

  const altitudeIndex = getColumnIndexByAliases(dataset.headers, [
    'altitude',
    'altitude_m',
    'height',
    'height_m',
    'altitudem',
    'gps_alt'
  ]);
  const velocityIndex = getColumnIndexByAliases(dataset.headers, [
    'velocity_m_s',
    'velocity',
    'vertical_velocity',
    'speed_m_s'
  ]);
  if (altitudeIndex === null) {
    return null;
  }

  const altitudes = dataset.rows.map((row) => parseNumber(row[altitudeIndex]));
  const baselineSample = altitudes
    .slice(0, Math.min(30, Math.max(5, Math.floor(altitudes.length * 0.1))))
    .filter((value): value is number => value !== null);

  if (baselineSample.length < 5) {
    return null;
  }

  const sortedBaseline = [...baselineSample].sort((left, right) => left - right);
  const baseline = sortedBaseline[Math.floor(sortedBaseline.length / 2)] ?? baselineSample[0];

  if (velocityIndex !== null) {
    for (let index = 0; index < altitudes.length; index += 1) {
      const altitude = altitudes[index];
      const velocity = parseNumber(dataset.rows[index]?.[velocityIndex]);
      if (altitude === null || velocity === null || altitude < baseline + 0.25 || velocity < 5) {
        continue;
      }

      const nextRows = dataset.rows.slice(index, Math.min(index + 7, dataset.rows.length));
      let lastAltitude: number | null = null;
      const sustained = nextRows.filter((row) => {
        const nextAltitude = parseNumber(row[altitudeIndex]);
        const nextVelocity = parseNumber(row[velocityIndex]);
        if (nextAltitude !== null) {
          lastAltitude = nextAltitude;
        }
        return nextAltitude !== null && nextVelocity !== null && nextAltitude >= baseline + 0.25 && nextVelocity > 2;
      });

      if (sustained.length >= 4 && lastAltitude !== null && lastAltitude >= baseline + 8) {
        return xValues[index] ?? null;
      }
    }
  }

  for (let index = 0; index < altitudes.length; index += 1) {
    const altitude = altitudes[index];
    const velocity = velocityIndex === null ? null : parseNumber(dataset.rows[index]?.[velocityIndex]);
    if (altitude === null || altitude < baseline + 8 || (velocity !== null && velocity < 2)) {
      continue;
    }

    const nextRows = dataset.rows.slice(index, Math.min(index + 5, dataset.rows.length));
    const sustained = nextRows.filter((row) => {
      const nextAltitude = parseNumber(row[altitudeIndex]);
      const nextVelocity = velocityIndex === null ? null : parseNumber(row[velocityIndex]);
      return nextAltitude !== null && nextAltitude >= baseline + 8 && (nextVelocity === null || nextVelocity > 0);
    });

    if (sustained.length >= 3) {
      return xValues[index] ?? null;
    }
  }

  return null;
}

export function estimateGpsLaunchTime(
  rows: string[][],
  xValues: number[],
  altitudeIndex: number,
  velocityIndex: number | null = null,
  options?: AutoDetectOptions
): number | null {
  if (!autoDetectEnabled(options) || rows.length < 5 || xValues.length !== rows.length) {
    return null;
  }

  const altitudes = rows.map((row) => parseNumber(row[altitudeIndex]));
  const velocities = velocityIndex === null ? null : rows.map((row) => parseNumber(row[velocityIndex]));
  const baselineSample = altitudes
    .slice(0, Math.min(30, Math.max(5, Math.floor(altitudes.length * 0.1))))
    .filter((value): value is number => value !== null);

  if (baselineSample.length < 5) {
    return null;
  }

  const sortedBaseline = [...baselineSample].sort((left, right) => left - right);
  const baseline = sortedBaseline[Math.floor(sortedBaseline.length / 2)] ?? baselineSample[0];

  if (velocities) {
    for (let index = 0; index < altitudes.length; index += 1) {
      const altitude = altitudes[index];
      const velocity = velocities[index];
      if (altitude === null || velocity === null || altitude < baseline + 0.25 || velocity < 5) {
        continue;
      }

      const lookaheadEnd = Math.min(index + 7, altitudes.length);
      let sustainedCount = 0;
      let lastAltitude: number | null = null;

      for (let lookahead = index; lookahead < lookaheadEnd; lookahead += 1) {
        const nextAltitude = altitudes[lookahead];
        const nextVelocity = velocities[lookahead];
        if (nextAltitude !== null) {
          lastAltitude = nextAltitude;
        }
        if (nextAltitude !== null && nextVelocity !== null && nextAltitude >= baseline + 0.25 && nextVelocity > 2) {
          sustainedCount += 1;
        }
      }

      if (sustainedCount >= 4 && lastAltitude !== null && lastAltitude >= baseline + 8) {
        return xValues[index] ?? null;
      }
    }
  }

  const threshold = baseline + 15;

  for (let index = 0; index < altitudes.length; index += 1) {
    const altitude = altitudes[index];
    if (altitude === null || altitude < threshold) {
      continue;
    }

    const nextAltitudes = altitudes
      .slice(index, Math.min(index + 4, altitudes.length))
      .filter((value): value is number => value !== null);

    if (nextAltitudes.length >= 3 && nextAltitudes.every((value) => value >= baseline + 10)) {
      return xValues[index] ?? null;
    }
  }

  return null;
}

export function buildEventMarkers(
  dataset: ImportedDataset,
  xValues: number[],
  options?: AutoDetectOptions
): EventWindow {
  const attributes = dataset.attributes.reduce<Record<string, string>>((record, attribute) => {
    record[attribute.key] = attribute.value;
    return record;
  }, {});
  const importerId = attributes.importer_id ?? '';
  const profile = getEventProfile(importerId);
  const stateProfile = profile?.state ?? null;
  // Unreliable state columns (e.g. ground-station relay with spurious PostFlight
  // transitions) are only trusted when auto-detect is off; with auto-detect on we
  // ignore them and let altitude-based estimation find launch/end instead.
  const useStateColumn =
    stateProfile !== null && (!profile?.unreliableStates || !autoDetectEnabled(options));
  const stateIndex = useStateColumn ? getColumnIndex(dataset.headers, stateProfile.stateColumn) : null;
  const stateNameIndex = getColumnIndex(dataset.headers, 'state_name');
  const drogueFiredIndex = getColumnIndex(dataset.headers, 'drogueFired');
  const mainFiredIndex = getColumnIndex(dataset.headers, 'mainFired');
  const events: EventMarker[] = [];
  let launchTime: number | null = null;
  let flightEndTime: number | null = null;

  for (let index = 1; index < dataset.rows.length; index += 1) {
    if (stateIndex !== null && stateProfile !== null) {
      const previousState = Number.parseInt(dataset.rows[index - 1]?.[stateIndex] ?? '', 10);
      const currentState = Number.parseInt(dataset.rows[index]?.[stateIndex] ?? '', 10);

      if (Number.isFinite(previousState) && Number.isFinite(currentState) && previousState !== currentState) {
        const previousName =
          stateNameIndex !== null
            ? dataset.rows[index - 1]?.[stateNameIndex]
            : stateProfile.stateNames[previousState];
        const currentName =
          stateNameIndex !== null
            ? dataset.rows[index]?.[stateNameIndex]
            : stateProfile.stateNames[currentState];
        const hasKnownState =
          Boolean(previousName) || Boolean(currentName) || stateNameIndex !== null;

        if (hasKnownState) {
          events.push({
            label: `${previousName ?? previousState} -> ${currentName ?? currentState}`,
            time: xValues[index],
            rowIndex: index,
            color: '#74c69d'
          });
        }

        if (hasKnownState && launchTime === null && stateProfile.isLaunchTransition(previousState, currentState)) {
          launchTime = xValues[index];
        }

        if (hasKnownState && stateProfile.isEndTransition(previousState, currentState)) {
          flightEndTime = xValues[index];
        }
      }
    }

    if (
      drogueFiredIndex !== null &&
      dataset.rows[index - 1]?.[drogueFiredIndex] === '0' &&
      dataset.rows[index]?.[drogueFiredIndex] === '1'
    ) {
      events.push({
        label: 'DROGUE FIRED',
        time: xValues[index],
        rowIndex: index,
        color: '#b07cff'
      });
    }

    if (
      mainFiredIndex !== null &&
      dataset.rows[index - 1]?.[mainFiredIndex] === '0' &&
      dataset.rows[index]?.[mainFiredIndex] === '1'
    ) {
      events.push({
        label: 'MAIN FIRED',
        time: xValues[index],
        rowIndex: index,
        color: '#69a7ff'
      });
    }
  }

  const drogueAt = parseNumber(attributes.drogue_at?.replace(/[^0-9.+-]/g, ''));
  const mainAt = parseNumber(attributes.main_at?.replace(/[^0-9.+-]/g, ''));

  if (drogueAt !== null) {
    events.push({
      label: 'DROGUE',
      time: drogueAt,
      rowIndex: xValues.findIndex((time) => time >= drogueAt),
      color: '#b07cff'
    });
  }

  if (mainAt !== null) {
    events.push({
      label: 'MAIN',
      time: mainAt,
      rowIndex: xValues.findIndex((time) => time >= mainAt),
      color: '#69a7ff'
    });
  }

  const sortedEvents = events
    .sort((left, right) => left.time - right.time)
    .slice(0, MAX_EVENT_MARKERS);
  const firstEventTime = sortedEvents[0]?.time ?? xValues[0] ?? 0;
  const lastEventTime = sortedEvents[sortedEvents.length - 1]?.time ?? xValues[xValues.length - 1] ?? 0;

  return {
    events: sortedEvents,
    launchTime,
    flightStartTime: launchTime ?? firstEventTime,
    flightEndTime: flightEndTime ?? lastEventTime
  };
}

export function buildEventWindow(dataset: ImportedDataset, xValues: number[], options?: AutoDetectOptions) {
  const eventData = buildEventMarkers(dataset, xValues, options);
  let launchTime = eventData.launchTime;
  const first = xValues[0] ?? 0;
  const last = xValues[xValues.length - 1] ?? first;

  if (launchTime === null) {
    launchTime = estimateLaunchTimeFromAltitude(dataset, xValues, options);
  }

  const start = launchTime ?? first;
  const end = eventData.flightEndTime ?? last;
  return { launchOffset: launchTime ?? 0, start, end };
}

export function buildWindow(xValues: number[], flightStartTime: number, flightEndTime: number) {
  const minTime = xValues[0] ?? 0;
  const maxTime = xValues[xValues.length - 1] ?? minTime;

  return {
    start: Math.max(minTime, flightStartTime - 20),
    end: Math.min(maxTime, flightEndTime + 20)
  };
}

export function normalizeEventLabel(label: string) {
  const normalized = label.trim().toUpperCase();
  if (normalized.includes('DROGUE')) return 'DROGUE';
  if (normalized.includes('MAIN')) return 'MAIN';
  if (normalized.includes('LAND') || normalized.includes('POST_FLIGHT')) return 'LANDING';
  if (normalized.includes('COAST')) return 'COAST';
  if (normalized.includes('BOOST')) return 'BOOST';
  if (normalized.includes('ASCENT')) return 'ASCENT';
  if (normalized.includes('DESCENT')) return 'DESCENT';
  return normalized;
}
