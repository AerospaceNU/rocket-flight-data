/**
 * Pick a (lat, lon, alt?) trio from a column set. Returns null if no usable pair is found.
 * Prefers rocket-side coordinates over ground-station coordinates.
 */
export function findGpsPair(
  columns: string[]
): { lat: string; lon: string; alt: string | null } | null {
  const has = (c: string) => columns.includes(c);
  // Ordered by preference.
  const pairs: { lat: string; lon: string; alt: string | null }[] = [
    { lat: 'gps_lat', lon: 'gps_long', alt: 'gps_alt' },
    { lat: 'gps_lat', lon: 'gps_lon', alt: 'gps_alt' },
    { lat: 'fcb_latitude', lon: 'fcb_longitude', alt: 'gps_alt' },
    { lat: 'latitude', lon: 'longitude', alt: 'altitude' },
    // Ground-station last (the rocket-side pair above wasn't present).
    { lat: 'gs_lat', lon: 'gs_lon', alt: 'gs_alt' },
  ];
  for (const p of pairs) {
    if (has(p.lat) && has(p.lon)) {
      return { lat: p.lat, lon: p.lon, alt: p.alt && has(p.alt) ? p.alt : null };
    }
  }
  return null;
}
