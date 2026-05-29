export function parseNumber(value: string | undefined) {
  const number = Number.parseFloat(value ?? '');
  return Number.isFinite(number) ? number : null;
}

export function normalizedHeader(header: string) {
  return header.trim().toLowerCase();
}

export function getColumnIndex(headers: string[], name: string) {
  const index = headers.indexOf(name);
  return index >= 0 ? index : null;
}

export function getColumnIndexByAliases(headers: string[], aliases: string[]) {
  const normalizedHeaders = headers.map(normalizedHeader);

  for (const alias of aliases) {
    const index = normalizedHeaders.indexOf(alias.toLowerCase());
    if (index >= 0) {
      return index;
    }
  }

  return null;
}

export function axisRange(values: number[]) {
  if (values.length === 0) {
    return 0;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  return Math.max(0, max - min);
}

export function isValidLatitude(value: number | null): value is number {
  return value !== null && value >= -90 && value <= 90;
}

export function isValidLongitude(value: number | null): value is number {
  return value !== null && value >= -180 && value <= 180;
}

export type AutomaticCheckOptions = {
  automaticChecks?: boolean;
};

export function automaticChecksEnabled(options?: AutomaticCheckOptions) {
  return options?.automaticChecks !== false;
}
