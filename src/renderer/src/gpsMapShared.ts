/*
 * Shared GPS-map types, style, and geometry used by both the single-flight
 * GpsMapView and the multi-flight CompareGpsMapView so the two don't duplicate
 * the basemap style and bounds/bearing math.
 */
import type maplibregl from 'maplibre-gl';

export type GpsMapPoint = {
  latitude: number;
  longitude: number;
  altitude: number;
  height: number;
  time: number;
};

export type GpsEventMarker = GpsMapPoint & {
  label: string;
  sourceLabel: string;
  color: [number, number, number, number];
  labelOffsetY: number;
};

export type MapPosition = [number, number, number];

export type Bounds = {
  west: number;
  east: number;
  south: number;
  north: number;
};

export const SATELLITE_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    satellite: {
      type: 'raster',
      tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      attribution:
        'Imagery Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community'
    }
  },
  layers: [
    {
      id: 'satellite',
      type: 'raster',
      source: 'satellite'
    }
  ]
};

export function computeBounds(points: GpsMapPoint[]): Bounds | null {
  if (points.length === 0) return null;

  let west = points[0].longitude;
  let east = points[0].longitude;
  let south = points[0].latitude;
  let north = points[0].latitude;

  for (const point of points) {
    if (point.longitude < west) west = point.longitude;
    if (point.longitude > east) east = point.longitude;
    if (point.latitude < south) south = point.latitude;
    if (point.latitude > north) north = point.latitude;
  }

  return { west, east, south, north };
}

export function computeBearing(points: GpsMapPoint[]): number {
  if (points.length < 2) return 0;

  const first = points[0];
  const last = points[points.length - 1];
  const dx = last.longitude - first.longitude;
  const dy = last.latitude - first.latitude;

  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) {
    return 0;
  }

  return (Math.atan2(dx, dy) * 180) / Math.PI;
}
