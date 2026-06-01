import { useEffect, useMemo, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import {
  computeBearing,
  computeBounds,
  SATELLITE_STYLE,
  type GpsMapPoint,
  type MapPosition
} from './gpsMapShared';

type CompareMapMode = 'map2d' | 'map3d';

export type CompareGpsTrack = {
  id: string;
  label: string;
  color: [number, number, number, number];
  points: GpsMapPoint[];
};

type CompareGpsMapViewProps = {
  isActive: boolean;
  mode: CompareMapMode;
  tracks: CompareGpsTrack[];
};

type TrackPath = {
  track: CompareGpsTrack;
  path: GpsMapPoint[];
};

type EndpointPoint = GpsMapPoint & {
  trackLabel: string;
  color: [number, number, number, number];
  isLaunch: boolean;
};

type LabelPoint = GpsMapPoint & {
  label: string;
  color: [number, number, number, number];
};

function allPoints(tracks: CompareGpsTrack[]) {
  return tracks.flatMap((track) => track.points);
}

export function CompareGpsMapView({ isActive, mode, tracks }: CompareGpsMapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const points = useMemo(() => allPoints(tracks), [tracks]);
  const bounds = useMemo(() => computeBounds(points), [points]);
  const bearing = useMemo(() => computeBearing(points), [points]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isActive || points.length < 2) return;

    const map = new maplibregl.Map({
      container,
      style: SATELLITE_STYLE,
      center: [points[0].longitude, points[0].latitude],
      zoom: mode === 'map3d' ? 12 : 13,
      pitch: mode === 'map3d' ? 68 : 0,
      bearing: mode === 'map3d' ? bearing : 0
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(container);

    const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
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
            padding: 56,
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
  }, [bearing, bounds, isActive, mode, points]);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;

    const pathData: TrackPath[] = tracks
      .filter((track) => track.points.length >= 2)
      .map((track) => ({ track, path: track.points }));
    const endpoints: EndpointPoint[] = tracks.flatMap((track) => {
      if (track.points.length === 0) return [];
      const last = track.points[track.points.length - 1];
      return [
        { ...track.points[0], trackLabel: track.label, color: track.color, isLaunch: true },
        { ...last, trackLabel: track.label, color: track.color, isLaunch: false }
      ];
    });
    const labels: LabelPoint[] = tracks
      .filter((track) => track.points.length > 0)
      .map((track) => ({
        ...track.points[track.points.length - 1],
        label: track.label,
        color: track.color
      }));

    overlay.setProps({
      layers: [
        new PathLayer<TrackPath>({
          id: `compare-paths-${mode}`,
          data: pathData,
          getPath: (entry): MapPosition[] =>
            entry.path.map((point): MapPosition => [
              point.longitude,
              point.latitude,
              mode === 'map3d' ? point.height : 0
            ]),
          getColor: (entry) => entry.track.color,
          getWidth: mode === 'map3d' ? 2 : 3,
          widthUnits: 'pixels',
          capRounded: false,
          jointRounded: false,
          pickable: true
        }),
        new PathLayer<TrackPath>({
          id: `compare-ground-paths-${mode}`,
          data: mode === 'map3d' ? pathData : [],
          getPath: (entry): MapPosition[] =>
            entry.path.map((point): MapPosition => [point.longitude, point.latitude, 0]),
          getColor: (entry) => [entry.track.color[0], entry.track.color[1], entry.track.color[2], 115],
          getWidth: 1.5,
          widthUnits: 'pixels',
          capRounded: false,
          jointRounded: false
        }),
        new ScatterplotLayer<EndpointPoint>({
          id: `compare-endpoints-${mode}`,
          data: endpoints,
          getPosition: (point) => [
            point.longitude,
            point.latitude,
            mode === 'map3d' ? point.height : 0
          ],
          getRadius: 7,
          radiusUnits: 'pixels',
          stroked: true,
          filled: true,
          lineWidthUnits: 'pixels',
          getLineWidth: 1.5,
          getFillColor: (point) => (point.isLaunch ? point.color : [255, 110, 110, 245]),
          getLineColor: [255, 255, 255, 230],
          pickable: true
        }),
        new TextLayer<LabelPoint>({
          id: `compare-labels-${mode}`,
          data: labels,
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
          getPixelOffset: [0, -10]
        })
      ],
      getTooltip: ({ object, layer }) => {
        if (!object || !layer) return null;
        if (String(layer.id).startsWith('compare-endpoints-')) {
          const point = object as EndpointPoint;
          return {
            text:
              `${point.trackLabel}\n` +
              `${point.isLaunch ? 'Launch' : 'End'}\n` +
              `Time: ${point.time.toFixed(2)} s\n` +
              `Height: ${point.height.toFixed(1)} m`
          };
        }
        if (String(layer.id).startsWith('compare-paths-')) {
          const entry = object as TrackPath;
          return { text: entry.track.label };
        }
        return null;
      }
    });
  }, [mode, tracks]);

  if (points.length < 2) {
    return (
      <div className="viewer-panel">
        <h2>{mode === 'map3d' ? 'Flight Map 3D' : 'Flight Map'}</h2>
        <p>Select at least one altimeter with GPS data.</p>
      </div>
    );
  }

  return (
    <div className="map-surface">
      <div className="map-surface-inner" ref={containerRef} />
    </div>
  );
}
