import { useEffect, useMemo, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import {
  computeBearing,
  computeBounds,
  SATELLITE_STYLE,
  type GpsEventMarker,
  type GpsMapPoint,
  type MapPosition
} from './gpsMapShared';

// Re-export so the many modules importing these from './GpsMapView' keep working.
export { SATELLITE_STYLE };
export type { GpsEventMarker, GpsMapPoint };

type GpsMapMode = 'map2d' | 'map3d';

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
