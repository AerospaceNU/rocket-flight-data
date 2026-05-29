import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { OBJLoader } from '@loaders.gl/obj';
import { SATELLITE_STYLE, type GpsEventMarker, type GpsMapPoint } from './GpsMapView';

export type RocketPosePoint = GpsMapPoint & {
  qX: number;
  qY: number;
  qZ: number;
  qW: number;
  northCorrectionDeg: number;
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

function makeRocketObj() {
  const segments = 18;
  const radius = 0.42;
  const bodyBottom = -2.4;
  const bodyTop = 1.8;
  const noseTip = 3.0;
  const lines: string[] = ['o replay_rocket'];

  for (let index = 0; index < segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2;
    const y = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    lines.push(`v ${bodyBottom} ${y.toFixed(5)} ${z.toFixed(5)}`);
    lines.push(`v ${bodyTop} ${y.toFixed(5)} ${z.toFixed(5)}`);
  }

  const bottomCenterIndex = segments * 2 + 1;
  const topCenterIndex = bottomCenterIndex + 1;
  const noseTipIndex = topCenterIndex + 1;
  lines.push(`v ${bodyBottom} 0 0`);
  lines.push(`v ${bodyTop} 0 0`);
  lines.push(`v ${noseTip} 0 0`);

  for (let index = 0; index < segments; index += 1) {
    const next = (index + 1) % segments;
    const bottomA = index * 2 + 1;
    const topA = bottomA + 1;
    const bottomB = next * 2 + 1;
    const topB = bottomB + 1;
    lines.push(`f ${bottomA} ${bottomB} ${topB} ${topA}`);
    lines.push(`f ${topA} ${topB} ${noseTipIndex}`);
    lines.push(`f ${bottomCenterIndex} ${bottomB} ${bottomA}`);
  }

  const finStart = noseTipIndex + 1;
  const fins = [
    [
      [bodyBottom + 0.2, radius, 0],
      [bodyBottom + 1.1, radius, 0],
      [bodyBottom - 0.35, radius + 0.9, 0]
    ],
    [
      [bodyBottom + 0.2, -radius, 0],
      [bodyBottom + 1.1, -radius, 0],
      [bodyBottom - 0.35, -radius - 0.9, 0]
    ],
    [
      [bodyBottom + 0.2, 0, radius],
      [bodyBottom + 1.1, 0, radius],
      [bodyBottom - 0.35, 0, radius + 0.9]
    ],
    [
      [bodyBottom + 0.2, 0, -radius],
      [bodyBottom + 1.1, 0, -radius],
      [bodyBottom - 0.35, 0, -radius - 0.9]
    ]
  ];

  for (const fin of fins) {
    for (const vertex of fin) {
      lines.push(`v ${vertex[0]} ${vertex[1]} ${vertex[2]}`);
    }
  }

  for (let index = 0; index < fins.length; index += 1) {
    const first = finStart + index * 3;
    lines.push(`f ${first} ${first + 1} ${first + 2}`);
  }

  return `data:text/plain;charset=utf-8,${encodeURIComponent(lines.join('\n'))}`;
}

const ROCKET_MESH_URL = makeRocketObj();

function normalizeQuaternion(point: Pick<RocketPosePoint, 'qX' | 'qY' | 'qZ' | 'qW'>) {
  const magnitude = Math.hypot(point.qX, point.qY, point.qZ, point.qW);
  if (!Number.isFinite(magnitude) || magnitude < 1e-9) {
    return null;
  }

  return {
    qX: point.qX / magnitude,
    qY: point.qY / magnitude,
    qZ: point.qZ / magnitude,
    qW: point.qW / magnitude
  };
}

function slerpQuaternion(
  left: Pick<RocketPosePoint, 'qX' | 'qY' | 'qZ' | 'qW'>,
  right: Pick<RocketPosePoint, 'qX' | 'qY' | 'qZ' | 'qW'>,
  ratio: number
) {
  const start = normalizeQuaternion(left);
  const end = normalizeQuaternion(right);
  if (!start || !end) return start ?? end;

  let endX = end.qX;
  let endY = end.qY;
  let endZ = end.qZ;
  let endW = end.qW;
  let dot = start.qX * endX + start.qY * endY + start.qZ * endZ + start.qW * endW;

  if (dot < 0) {
    dot = -dot;
    endX = -endX;
    endY = -endY;
    endZ = -endZ;
    endW = -endW;
  }

  if (dot > 0.9995) {
    return normalizeQuaternion({
      qX: start.qX + (endX - start.qX) * ratio,
      qY: start.qY + (endY - start.qY) * ratio,
      qZ: start.qZ + (endZ - start.qZ) * ratio,
      qW: start.qW + (endW - start.qW) * ratio
    });
  }

  const theta = Math.acos(Math.max(-1, Math.min(1, dot)));
  const sinTheta = Math.sin(theta);
  const startScale = Math.sin((1 - ratio) * theta) / sinTheta;
  const endScale = Math.sin(ratio * theta) / sinTheta;

  return {
    qX: start.qX * startScale + endX * endScale,
    qY: start.qY * startScale + endY * endScale,
    qZ: start.qZ * startScale + endZ * endScale,
    qW: start.qW * startScale + endW * endScale
  };
}

function quaternionToTransformMatrix(point: RocketPosePoint) {
  const quaternion = normalizeQuaternion(point);
  if (!quaternion) return [];

  const { qX: x, qY: y, qZ: z, qW: w } = quaternion;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;

  const r00 = 1 - 2 * (yy + zz);
  const r01 = 2 * (xy - wz);
  const r02 = 2 * (xz + wy);
  const r10 = 2 * (xy + wz);
  const r11 = 1 - 2 * (xx + zz);
  const r12 = 2 * (yz - wx);
  const r20 = 2 * (xz - wy);
  const r21 = 2 * (yz + wx);
  const r22 = 1 - 2 * (xx + yy);
  const correctionRad = (point.northCorrectionDeg * Math.PI) / 180;
  const correctionCos = Math.cos(correctionRad);
  const correctionSin = Math.sin(correctionRad);

  const c00 = correctionCos * r00 - correctionSin * r10;
  const c01 = correctionCos * r01 - correctionSin * r11;
  const c02 = correctionCos * r02 - correctionSin * r12;
  const c10 = correctionSin * r00 + correctionCos * r10;
  const c11 = correctionSin * r01 + correctionCos * r11;
  const c12 = correctionSin * r02 + correctionCos * r12;

  return [
    c00, c10, r20, 0,
    c01, c11, r21, 0,
    c02, c12, r22, 0,
    0, 0, 0, 1
  ];
}

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
    const quaternion = slerpQuaternion(current, next, ratio) ?? current;

    return {
      latitude: current.latitude + (next.latitude - current.latitude) * ratio,
      longitude: current.longitude + (next.longitude - current.longitude) * ratio,
      altitude: current.altitude + (next.altitude - current.altitude) * ratio,
      height: current.height + (next.height - current.height) * ratio,
      time: targetTime,
      qX: quaternion.qX,
      qY: quaternion.qY,
      qZ: quaternion.qZ,
      qW: quaternion.qW,
      northCorrectionDeg: current.northCorrectionDeg
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
        new SimpleMeshLayer<RocketPosePoint>({
          id: 'rocket-replay-mesh',
          data: rocketData,
          mesh: ROCKET_MESH_URL,
          loaders: [OBJLoader],
          getPosition: (point) => [point.longitude, point.latitude, point.height],
          getTransformMatrix: (point) => quaternionToTransformMatrix(point),
          getColor: [245, 247, 251, 255],
          sizeScale: 11,
          pickable: true
        })
      ],
      getTooltip: ({ object, layer }) => {
        if (!object || !layer) return null;
        if (String(layer.id) === 'rocket-replay-mesh') {
          const point = object as RocketPosePoint;
          return {
            text:
              `Rocket\n` +
              `Time: ${point.time.toFixed(2)} s\n` +
              `Height: ${point.height.toFixed(1)} m\n` +
              `q: ${point.qX.toFixed(4)}, ${point.qY.toFixed(4)}, ${point.qZ.toFixed(4)}, ${point.qW.toFixed(4)}\n` +
              `North correction: ${point.northCorrectionDeg.toFixed(1)} deg`
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
