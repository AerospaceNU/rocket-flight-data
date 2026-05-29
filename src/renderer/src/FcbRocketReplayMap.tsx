import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { IconLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { SATELLITE_STYLE, type GpsEventMarker, type GpsMapPoint } from './GpsMapView';

export type RocketPosePoint = GpsMapPoint & {
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
};

type FcbRocketReplayMapProps = {
  eventMarkers: GpsEventMarker[];
  isActive: boolean;
  samples: RocketPosePoint[];
};

type FlightPath = {
  path: RocketPosePoint[];
};

type MapPosition = [number, number, number];

const ROCKET_ICON_ID = 'rocket';
const ROCKET_ICON_ATLAS =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">' +
      '<path d="M48 6 C37 18 31 33 31 50 L20 68 L34 63 L39 86 L48 75 L57 86 L62 63 L76 68 L65 50 C65 33 59 18 48 6 Z" fill="#f5f7fb" stroke="#111820" stroke-width="4" stroke-linejoin="round"/>' +
      '<path d="M48 13 C42 23 39 35 39 50 L48 58 L57 50 C57 35 54 23 48 13 Z" fill="#ff9f43"/>' +
      '<circle cx="48" cy="38" r="7" fill="#58c4ff" stroke="#111820" stroke-width="3"/>' +
      '<path d="M40 76 L48 88 L56 76 Z" fill="#ff5d5d"/>' +
    '</svg>'
  );

const ROCKET_ICON_MAPPING = {
  [ROCKET_ICON_ID]: {
    x: 0,
    y: 0,
    width: 96,
    height: 96,
    anchorX: 48,
    anchorY: 48,
    mask: false
  }
};

function computeBounds(points: GpsMapPoint[]) {
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

function interpolatePose(samples: RocketPosePoint[], targetTime: number): RocketPosePoint | null {
  if (samples.length === 0) return null;
  if (targetTime <= samples[0].time) return samples[0];
  if (targetTime >= samples[samples.length - 1].time) return samples[samples.length - 1];

  for (let index = 0; index < samples.length - 1; index += 1) {
    const current = samples[index];
    const next = samples[index + 1];
    if (targetTime < current.time || targetTime > next.time) continue;

    const span = next.time - current.time;
    const ratio = span > 0 ? (targetTime - current.time) / span : 0;
    const blendAngle = (left: number, right: number) => {
      let delta = right - left;
      while (delta > 180) delta -= 360;
      while (delta < -180) delta += 360;
      return left + delta * ratio;
    };

    return {
      latitude: current.latitude + (next.latitude - current.latitude) * ratio,
      longitude: current.longitude + (next.longitude - current.longitude) * ratio,
      altitude: current.altitude + (next.altitude - current.altitude) * ratio,
      height: current.height + (next.height - current.height) * ratio,
      time: targetTime,
      yawDeg: blendAngle(current.yawDeg, next.yawDeg),
      pitchDeg: blendAngle(current.pitchDeg, next.pitchDeg),
      rollDeg: blendAngle(current.rollDeg, next.rollDeg)
    };
  }

  return samples[samples.length - 1] ?? null;
}

export function FcbRocketReplayMap({ eventMarkers, isActive, samples }: FcbRocketReplayMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const animationRef = useRef<number | null>(null);
  const animationStartedRef = useRef(0);
  const animationBaseTimeRef = useRef(0);
  const currentTimeRef = useRef(samples[0]?.time ?? 0);
  const [currentTime, setCurrentTime] = useState(samples[0]?.time ?? 0);
  const [isPlaying, setIsPlaying] = useState(false);

  const bounds = useMemo(() => computeBounds(samples), [samples]);
  const bearing = useMemo(() => computeBearing(samples), [samples]);
  const minTime = samples[0]?.time ?? 0;
  const maxTime = samples[samples.length - 1]?.time ?? minTime;
  const currentPose = useMemo(() => interpolatePose(samples, currentTime), [currentTime, samples]);
  const elapsedPercent = maxTime > minTime ? ((currentTime - minTime) / (maxTime - minTime)) * 100 : 0;

  useEffect(() => {
    setCurrentTime(samples[0]?.time ?? 0);
    currentTimeRef.current = samples[0]?.time ?? 0;
    setIsPlaying(false);
  }, [samples]);

  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  useEffect(() => {
    if (!isPlaying || samples.length < 2) {
      if (animationRef.current !== null) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
      return;
    }

    animationStartedRef.current = performance.now();
    animationBaseTimeRef.current = currentTimeRef.current;
    const secondsPerMs = 0.04;

    const step = (now: number) => {
      const nextTime = animationBaseTimeRef.current + (now - animationStartedRef.current) * secondsPerMs;
      if (nextTime >= maxTime) {
        setCurrentTime(maxTime);
        setIsPlaying(false);
        animationRef.current = null;
        return;
      }
      setCurrentTime(nextTime);
      animationRef.current = requestAnimationFrame(step);
    };

    animationRef.current = requestAnimationFrame(step);

    return () => {
      if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    };
  }, [isPlaying, maxTime, samples.length]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isActive || samples.length < 2) return;

    const map = new maplibregl.Map({
      container,
      style: SATELLITE_STYLE,
      center: [samples[0].longitude, samples[0].latitude],
      zoom: 13,
      pitch: 68,
      bearing
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

    const overlay = new MapboxOverlay({ interleaved: false, layers: [] });
    overlayRef.current = overlay;
    map.addControl(overlay as unknown as maplibregl.IControl);

    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(container);

    map.once('load', () => {
      if (bounds) {
        map.fitBounds(
          [
            [bounds.west, bounds.south],
            [bounds.east, bounds.north]
          ],
          {
            padding: { top: 48, right: 48, bottom: 80, left: 48 },
            duration: 0,
            maxZoom: 15
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
  }, [bearing, bounds, isActive, samples]);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay || !currentPose) return;

    const flownPath = samples.filter((point) => point.time <= currentPose.time);
    const rocketData = [currentPose];

    overlay.setProps({
      layers: [
        new PathLayer<FlightPath>({
          id: 'rocket-replay-flight-path',
          data: [{ path: samples }],
          getPath: (entry): MapPosition[] =>
            entry.path.map((point): MapPosition => [point.longitude, point.latitude, point.height]),
          getColor: [255, 166, 77, 95],
          getWidth: 2,
          widthUnits: 'pixels',
          capRounded: false,
          jointRounded: false
        }),
        new PathLayer<FlightPath>({
          id: 'rocket-replay-flown-path',
          data: flownPath.length >= 2 ? [{ path: flownPath }] : [],
          getPath: (entry): MapPosition[] =>
            entry.path.map((point): MapPosition => [point.longitude, point.latitude, point.height]),
          getColor: [255, 210, 125, 245],
          getWidth: 3,
          widthUnits: 'pixels',
          capRounded: false,
          jointRounded: false
        }),
        new ScatterplotLayer<GpsEventMarker>({
          id: 'rocket-replay-events',
          data: eventMarkers,
          getPosition: (point) => [point.longitude, point.latitude, point.height],
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
          id: 'rocket-replay-event-labels',
          data: eventMarkers,
          pickable: false,
          getPosition: (point) => [point.longitude, point.latitude, point.height],
          getText: (point) => point.label,
          getColor: [244, 247, 251, 240],
          getSize: 12,
          sizeUnits: 'pixels',
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'bottom',
          getPixelOffset: (point) => [0, point.labelOffsetY]
        }),
        new IconLayer<RocketPosePoint>({
          id: 'rocket-replay-icon',
          data: rocketData,
          iconAtlas: ROCKET_ICON_ATLAS,
          iconMapping: ROCKET_ICON_MAPPING,
          getIcon: () => ROCKET_ICON_ID,
          getPosition: (point) => [point.longitude, point.latitude, point.height],
          getSize: 46,
          sizeUnits: 'pixels',
          getAngle: (point) => point.yawDeg,
          billboard: true,
          pickable: true
        })
      ],
      getTooltip: ({ object, layer }) => {
        if (!object || !layer) return null;
        if (String(layer.id) === 'rocket-replay-icon') {
          const point = object as RocketPosePoint;
          return {
            text:
              `Rocket\n` +
              `Time: ${point.time.toFixed(2)} s\n` +
              `Height: ${point.height.toFixed(1)} m\n` +
              `Yaw: ${point.yawDeg.toFixed(1)} deg\n` +
              `Pitch: ${point.pitchDeg.toFixed(1)} deg\n` +
              `Roll: ${point.rollDeg.toFixed(1)} deg`
          };
        }
        if (String(layer.id) === 'rocket-replay-events') {
          const point = object as GpsEventMarker;
          return {
            text:
              `${point.label}\n` +
              `Source: ${point.sourceLabel}\n` +
              `Time: ${point.time.toFixed(2)} s\n` +
              `Height: ${point.height.toFixed(1)} m`
          };
        }
        return null;
      }
    });
  }, [currentPose, eventMarkers, samples]);

  if (samples.length < 2) {
    return (
      <div className="viewer-panel">
        <h2>Rocket Replay</h2>
        <p>Not enough FCB GPS and orientation samples are available.</p>
      </div>
    );
  }

  return (
    <div className="rocket-replay">
      <div className="map-surface">
        <div className="map-surface-inner" ref={containerRef} />
      </div>
      <div className="playback-bar">
        <button
          className="small-button"
          onClick={() => {
            if (!isPlaying && currentTime >= maxTime) {
              setCurrentTime(minTime);
            }
            setIsPlaying((current) => !current);
          }}
          type="button"
        >
          {isPlaying ? 'Pause' : 'Play'}
        </button>
        <input
          aria-label="Replay time"
          max={maxTime}
          min={minTime}
          onChange={(event) => {
            setIsPlaying(false);
            setCurrentTime(Number.parseFloat(event.target.value));
          }}
          step="0.01"
          type="range"
          value={currentTime}
        />
        <div className="playback-readout">
          <span>{currentTime.toFixed(2)} s</span>
          <span>{currentPose ? `${currentPose.height.toFixed(1)} m` : '0.0 m'}</span>
          <span>{Math.max(0, Math.min(100, elapsedPercent)).toFixed(0)}%</span>
        </div>
      </div>
    </div>
  );
}
