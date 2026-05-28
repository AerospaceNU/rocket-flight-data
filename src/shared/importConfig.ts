export type CommonAttributeDefinition = {
  key: string;
  label: string;
  required: boolean;
};

export type AltimeterDefinition = {
  id: string;
  name: string;
  importerId: string;
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
    importerId: 'sillygoose'
  },
  {
    id: 'easymini',
    name: 'EasyMini',
    importerId: 'easymini'
  },
  {
    id: 'stratologgercf',
    name: 'StratoLoggerCF',
    importerId: 'stratologgercf'
  },
  {
    id: 'rawgpsdata',
    name: 'RawGPSData',
    importerId: 'rawgpsdata'
  }
];
