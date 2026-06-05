export type DisplayUnitSystem = 'metric' | 'imperial';

export type UnitFamily =
  | 'time'
  | 'length'
  | 'velocity'
  | 'acceleration'
  | 'temperature'
  | 'pressure'
  | 'voltage'
  | 'angle'
  | 'angularVelocity'
  | 'dimensionless'
  | 'other';

export type ColumnUnit = {
  family: UnitFamily;
  unit: string;
};

export type ColumnUnitMap = Record<string, ColumnUnit>;

const FEET_PER_METER = 3.280839895013123;

function normalizedUnit(unit: string) {
  return unit.toLowerCase().replace(/\s+/g, '');
}

export function displayUnitFor(columnUnit: ColumnUnit | undefined, displayUnits: DisplayUnitSystem) {
  if (!columnUnit) return { unit: '', factor: 1 };

  const unit = normalizedUnit(columnUnit.unit);

  if (columnUnit.family === 'length') {
    if (displayUnits === 'imperial') {
      return {
        unit: 'ft',
        factor: unit === 'ft' || unit === 'feet' ? 1 : FEET_PER_METER
      };
    }

    return {
      unit: 'm',
      factor: unit === 'ft' || unit === 'feet' ? 1 / FEET_PER_METER : 1
    };
  }

  if (columnUnit.family === 'velocity') {
    if (displayUnits === 'imperial') {
      return {
        unit: 'ft/s',
        factor: unit === 'ft/s' || unit === 'fps' ? 1 : FEET_PER_METER
      };
    }

    return {
      unit: 'm/s',
      factor: unit === 'ft/s' || unit === 'fps' ? 1 / FEET_PER_METER : 1
    };
  }

  if (columnUnit.family === 'acceleration') {
    if (displayUnits === 'imperial') {
      return {
        unit: 'ft/s^2',
        factor: unit === 'ft/s^2' || unit === 'ft/s2' ? 1 : FEET_PER_METER
      };
    }

    return {
      unit: 'm/s^2',
      factor: unit === 'ft/s^2' || unit === 'ft/s2' ? 1 / FEET_PER_METER : 1
    };
  }

  return { unit: columnUnit.unit, factor: 1 };
}

export function convertDisplayValue(
  value: number,
  columnUnit: ColumnUnit | undefined,
  displayUnits: DisplayUnitSystem
) {
  return value * displayUnitFor(columnUnit, displayUnits).factor;
}

export function displayUnitLabel(columnUnit: ColumnUnit | undefined, displayUnits: DisplayUnitSystem) {
  return displayUnitFor(columnUnit, displayUnits).unit;
}
