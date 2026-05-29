export type CommonAttributeDefinition = {
  key: string;
  label: string;
  required: boolean;
};

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

export const COMMON_ATTRIBUTES: CommonAttributeDefinition[] = [
  {
    key: 'altimeter_name',
    label: 'Altimeter name',
    required: true
  },
  {
    key: 'flight_location',
    label: 'Flight location',
    required: true
  }
];

export const ALTIMETERS: AltimeterDefinition[] = [
  {
    id: 'sillygoose',
    name: 'SillyGoose',
    importerId: 'sillygoose',
    standardColumns: {
      altitudeMeters: { column: 'altitudeM' },
      velocityMetersPerSecond: { column: 'velocityMS' },
      accelerationMetersPerSecondSquared: { column: 'accelerationMSS' }
    }
  },
  {
    id: 'easymini',
    name: 'EasyMini',
    importerId: 'easymini',
    standardColumns: {
      altitudeMeters: { column: 'height' },
      velocityMetersPerSecond: { column: 'speed' },
      accelerationMetersPerSecondSquared: { column: 'acceleration' }
    }
  },
  {
    id: 'stratologgercf',
    name: 'StratoLoggerCF',
    importerId: 'stratologgercf',
    standardColumns: {
      altitudeMeters: { column: 'altitudeFt', scaleToStandard: 0.3048 },
      velocityMetersPerSecond: { column: 'velocityFtS', scaleToStandard: 0.3048 }
    }
  },
  {
    id: 'rawgpsdata',
    name: 'RawGPSData',
    importerId: 'rawgpsdata',
    standardColumns: {
      altitudeMeters: { column: 'altitude' }
    }
  },
  {
    id: 'fcb',
    name: 'FCB',
    importerId: 'fcb',
    standardColumns: {
      altitudeMeters: { column: 'pos_z' },
      velocityMetersPerSecond: { column: 'vel_z' },
      accelerationMetersPerSecondSquared: { column: 'acc_z' }
    }
  }
];

export function getStandardColumnsForImporter(importerId: string): StandardColumnMapping | null {
  const altimeter = ALTIMETERS.find((entry) => entry.importerId === importerId);
  return altimeter?.standardColumns ?? null;
}
