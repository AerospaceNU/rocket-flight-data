/*
 * Pure, dependency-free telemetry math + column helpers.
 *
 * Lives in src/shared so the main process (importers, sanitization) and the
 * renderer (telemetry modules) use a single definition instead of duplicating
 * these tiny functions on each side of the process boundary. Must stay free of
 * node/browser-only APIs so it bundles safely into both.
 */

export function parseNumber(value: string | undefined): number | null {
  const number = Number.parseFloat(value ?? '');
  return Number.isFinite(number) ? number : null;
}

export function normalizedHeader(header: string): string {
  return header.trim().toLowerCase();
}

export function getColumnIndex(headers: string[], name: string): number | null {
  const index = headers.indexOf(name);
  return index >= 0 ? index : null;
}

export function getColumnIndexByAliases(headers: string[], aliases: string[]): number | null {
  const normalizedHeaders = headers.map(normalizedHeader);

  for (const alias of aliases) {
    const index = normalizedHeaders.indexOf(alias.toLowerCase());
    if (index >= 0) {
      return index;
    }
  }

  return null;
}

export function axisRange(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  return Math.max(0, max - min);
}

export function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

export function isValidLatitude(value: number | null): value is number {
  return value !== null && value >= -90 && value <= 90;
}

export function isValidLongitude(value: number | null): value is number {
  return value !== null && value >= -180 && value <= 180;
}
