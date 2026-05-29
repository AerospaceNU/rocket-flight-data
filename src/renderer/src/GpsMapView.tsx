import { useEffect, useMemo, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';

type GpsMapMode = 'map2d' | 'map3d';

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

type GpsMapViewProps = {
  isActive: boolean;
  mode: GpsMapMode;
  points: GpsMapPoint[];
  eventMarkers: GpsEventMarker[];
};

type FlightPath = {
  path: GpsMapPoint[];
};

type EndpointPoint = GpsMapPoint & {
  isLaunch: boolean;
};

type MapPosition = [number, number, number];

type Bounds = {
  west: number;
  east: number;
  south: number;
  north: number;
};

const SATELLITE_STYLE: maplibregl.StyleSpecification = {
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

function computeBounds(points: GpsMapPoint[]): Bounds | null {
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

function computeBearing(points: GpsMapPoint[]) {
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

export function GpsMapView({ isActive, mode, points, eventMarkers }: GpsMapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);

  const bounds = useMemo(() => computeBounds(points), [points]);
  const bearing = useMemo(() => computeBearing(points), [points]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isActive || points.length < 2) {
      return;
    }

    const map = new maplibregl.Map({
      container,
      style: SATELLITE_STYLE,
      center: [points[0].longitude, points[0].latitude],
      zoom: mode === 'map3d' ? 13 : 14,
      pitch: mode === 'map3d' ? 68 : 0,
      bearing: mode === 'map3d' ? bearing : 0
    });
    mapRef.current = map;

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

    const resizeObserver = new ResizeObserver(() => {
      map.resize();
    });
    resizeObserver.observe(container);

    const overlay = new MapboxOverlay({
      interleaved: false,
      layers: [
        new PathLayer<FlightPath>({
          id: `flight-path-${mode}`,
          data: [{ path: points }],
          getPath: (entry): MapPosition[] =>
            entry.path.map(
              (point): MapPosition => [point.longitude, point.latitude, mode === 'map3d' ? point.height : 0]
            ),
          getColor: mode === 'map3d' ? [255, 166, 77, 235] : [74, 214, 193, 245],
          getWidth: mode === 'map3d' ? 2 : 4,
          widthUnits: 'pixels',
          billboard: false,
          capRounded: false,
          jointRounded: false
        }),
        new PathLayer<FlightPath>({
          id: `ground-track-${mode}`,
          data: mode === 'map3d' ? [{ path: points }] : [],
          getPath: (entry): MapPosition[] =>
            entry.path.map((point): MapPosition => [point.longitude, point.latitude, 0]),
          getColor: [120, 235, 201, 170],
          getWidth: 2,
          widthUnits: 'pixels',
          capRounded: true,
          jointRounded: true
        }),
        new ScatterplotLayer<EndpointPoint>({
          id: `flight-points-${mode}`,
          data:
            points.length >= 2
              ? [
                  { ...points[0], isLaunch: true },
                  { ...points[points.length - 1], isLaunch: false }
                ]
              : points.map((point, index) => ({ ...point, isLaunch: index === 0 })),
          getPosition: (point) => [
            point.longitude,
            point.latitude,
            mode === 'map3d' ? point.height : 0
          ],
          getRadius: 10,
          radiusUnits: 'pixels',
          stroked: true,
          filled: true,
          lineWidthUnits: 'pixels',
          getLineWidth: 2,
          getFillColor: (point) => (point.isLaunch ? [101, 194, 255, 245] : [255, 110, 110, 245]),
          getLineColor: [255, 255, 255, 245]
        }),
        new ScatterplotLayer<GpsEventMarker>({
          id: `event-points-${mode}`,
          data: eventMarkers,
          getPosition: (point) => [
            point.longitude,
            point.latitude,
            mode === 'map3d' ? point.height : 0
          ],
          getRadius: 7,
          radiusUnits: 'pixels',
          filled: true,
          stroked: true,
          lineWidthUnits: 'pixels',
          getLineWidth: 1.5,
          getFillColor: (point) => point.color,
          getLineColor: [255, 255, 255, 230]
        }),
        new TextLayer<GpsEventMarker>({
          id: `event-labels-${mode}`,
          data: eventMarkers,
          pickable: false,
          getPosition: (point) => [
            point.longitude,
            point.latitude,
            mode === 'map3d' ? point.height : 0
          ],
          getText: (point) => point.label,
          getColor: [244, 247, 251, 240],
          getSize: 12,
          sizeUnits: 'pixels',
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'bottom',
          getPixelOffset: (point) => [0, point.labelOffsetY]
        })
      ],
      getTooltip: ({ object, layer }) => {
        if (!object || !layer) {
          return null;
        }

        if (String(layer.id).startsWith('event-points-')) {
          const point = object as GpsEventMarker;
          return {
            text:
              `${point.label}\n` +
              `Source: ${point.sourceLabel}\n` +
              `Time: ${point.time.toFixed(2)} s\n` +
              `Lat: ${point.latitude.toFixed(6)}\n` +
              `Lon: ${point.longitude.toFixed(6)}\n` +
              `Height: ${point.height.toFixed(1)} m`
          };
        }

        if (String(layer.id).startsWith('flight-points-')) {
          const point = object as EndpointPoint;
          const label = point.isLaunch ? 'Launch' : 'Landing';
          return {
            text:
              `${label}\n` +
              `Time: ${point.time.toFixed(2)} s\n` +
              `Lat: ${point.latitude.toFixed(6)}\n` +
              `Lon: ${point.longitude.toFixed(6)}\n` +
              `Height: ${point.height.toFixed(1)} m`
          };
        }

        return null;
      }
    });
    overlayRef.current = overlay;
    map.addControl(overlay as unknown as maplibregl.IControl);

    map.once('load', () => {
      if (bounds) {
        map.fitBounds(
          [
            [bounds.west, bounds.south],
            [bounds.east, bounds.north]
          ],
          {
            padding: { top: 48, right: 48, bottom: 48, left: 48 },
            duration: 0,
            maxZoom: mode === 'map3d' ? 15 : 16
          }
        );
      }
      map.resize();
    });

    return () => {
      resizeObserver.disconnect();
      overlay.finalize();
      overlayRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, [bearing, bounds, eventMarkers, isActive, mode, points]);

  if (points.length < 2) {
    return (
      <div className="viewer-panel">
        <h2>{mode === 'map2d' ? 'Flight Map' : 'Flight Map 3D'}</h2>
        <p>Not enough GPS samples are available to draw a flight path.</p>
      </div>
    );
  }

  return (
    <div className="map-surface">
      <div className="map-surface-inner" ref={containerRef} />
    </div>
  );
}
