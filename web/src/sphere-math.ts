import type { Vec3 } from "../../shared/contract";
import {
  add,
  angle,
  ARRIVAL_ANGLE,
  arrived,
  cross,
  dot,
  ESCAPE_NORM,
  escaped,
  field,
  isUnit,
  MAX_ALPHA,
  navigatorField,
  norm,
  perpendicular,
  rescuerField,
  scale,
  sphericalMove,
  STALL_NORM,
  stalled,
  steering,
  STEP_ALPHA,
  unit,
} from "../../core/geometry";

export {
  add,
  angle,
  ARRIVAL_ANGLE,
  arrived,
  cross,
  dot,
  ESCAPE_NORM,
  escaped,
  field,
  isUnit,
  MAX_ALPHA,
  navigatorField,
  norm,
  perpendicular,
  rescuerField,
  scale,
  sphericalMove,
  STALL_NORM,
  stalled,
  steering,
  STEP_ALPHA,
  unit,
};

/** Spherical Linear Interpolation on S² between two unit vectors. */
export function slerp(a: Vec3, b: Vec3, t: number): Vec3 {
  const clamped = Math.max(0, Math.min(1, t));
  if (clamped === 0) return a;
  if (clamped === 1) return b;
  const theta = angle(a, b);
  if (theta < 1e-7) return a;
  if (Math.PI - theta < 1e-6) {
    // Near-antipodal interpolation chooses deterministic orthogonal meridian
    const ortho = perpendicular(a);
    return sphericalMove(a, ortho, theta * clamped);
  }
  const sinTheta = Math.sin(theta);
  const wA = Math.sin((1 - clamped) * theta) / sinTheta;
  const wB = Math.sin(clamped * theta) / sinTheta;
  return unit(add(scale(a, wA), scale(b, wB)));
}

/** Samples a geodesic great-circle arc on S² between unit vectors `a` and `b`. */
export function sampleGeodesicArc(a: Vec3, b: Vec3, segments = 24): Vec3[] {
  const theta = angle(a, b);
  const steps = Math.max(2, Math.ceil((theta / (Math.PI / 18)) * 4), segments);
  const pts: Vec3[] = [];
  for (let i = 0; i <= steps; i++) {
    pts.push(slerp(a, b, i / steps));
  }
  return pts;
}

/** Generates points on a small circle of angular radius `halfAngle` (rad) around `axis` on S². */
export function smallCircleOnSphere(
  axis: Vec3,
  halfAngle: number,
  segments = 64,
): Vec3[] {
  const u1 = perpendicular(axis);
  const u2 = unit(cross(axis, u1));
  const cosA = Math.cos(halfAngle);
  const sinA = Math.sin(halfAngle);
  const ring: Vec3[] = [];
  for (let i = 0; i <= segments; i++) {
    const phi = (i / segments) * Math.PI * 2;
    const tangent = add(scale(u1, Math.cos(phi)), scale(u2, Math.sin(phi)));
    ring.push(unit(add(scale(axis, cosA), scale(tangent, sinA))));
  }
  return ring;
}

/** Converts azimuth λ (deg, [-180, 180]) and elevation φ (deg, [-90, 90]) to unit Vec3 (Z-up aerospace convention). */
export function sphericalDegToVec3(azimuthDeg: number, elevationDeg: number): Vec3 {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  const cosEl = Math.cos(el);
  return unit([cosEl * Math.cos(az), cosEl * Math.sin(az), Math.sin(el)]);
}

/** Converts unit Vec3 to { azimuthDeg, elevationDeg } in degrees. */
export function vec3ToSphericalDeg(v: Vec3): {
  azimuthDeg: number;
  elevationDeg: number;
} {
  const u = unit(v);
  const elevationDeg = (Math.asin(Math.max(-1, Math.min(1, u[2]))) * 180) / Math.PI;
  const azimuthDeg = (Math.atan2(u[1], u[0]) * 180) / Math.PI;
  return {
    azimuthDeg: Math.round(azimuthDeg),
    elevationDeg: Math.round(elevationDeg),
  };
}

export interface CameraBasis {
  right: Vec3;
  up: Vec3;
  forward: Vec3; // Points from origin toward viewer
}

/** Builds an orthonormal right-handed camera basis from yaw (azimuth) and pitch (elevation) in radians. */
export function buildCameraBasis(yaw: number, pitch: number): CameraBasis {
  const clampedPitch = Math.max(-Math.PI * 0.48, Math.min(Math.PI * 0.48, pitch));
  const cosP = Math.cos(clampedPitch);
  const sinP = Math.sin(clampedPitch);
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);

  // Viewer direction on Z-up sphere
  const forward: Vec3 = [cosP * cosY, cosP * sinY, sinP];
  const right: Vec3 = [-sinY, cosY, 0];
  const up = cross(forward, right);
  return { right, up, forward };
}

/** Computes yaw/pitch camera angles looking directly at a unit vector `target`. */
export function lookAtAngles(target: Vec3): { yaw: number; pitch: number } {
  const u = unit(target);
  const pitch = Math.asin(Math.max(-0.98, Math.min(0.98, u[2])));
  const yaw = Math.atan2(u[1], u[0]);
  return { yaw, pitch };
}

export interface ProjectedPoint {
  x: number;
  y: number;
  z: number; // > 0 means front hemisphere facing camera
  front: boolean;
  scale: number;
}

/** Projects a 3D point onto 2D screen coordinates with subtle perspective depth cueing. */
export function project3D(
  p: Vec3,
  basis: CameraBasis,
  cx: number,
  cy: number,
  radiusPx: number,
): ProjectedPoint {
  const vx = dot(p, basis.right);
  const vy = dot(p, basis.up);
  const vz = dot(p, basis.forward);
  // Subtle perspective factor (camera at distance D = 4.6 R) keeps outer limb crisp while giving real 3D feel
  const camDist = 4.6;
  const persp = camDist / (camDist - vz * 0.55);
  return {
    x: cx + vx * radiusPx * persp,
    y: cy - vy * radiusPx * persp,
    z: vz,
    front: vz >= -0.06,
    scale: persp,
  };
}

/** Unprojects a 2D canvas click `(px, py)` onto the front hemisphere of the unit sphere. Returns null if outside limb. */
export function unprojectSphereClick(
  px: number,
  py: number,
  basis: CameraBasis,
  cx: number,
  cy: number,
  radiusPx: number,
): Vec3 | null {
  const nx = (px - cx) / radiusPx;
  const ny = (cy - py) / radiusPx;
  const r2 = nx * nx + ny * ny;
  if (r2 > 1.04) return null;
  const clampedR2 = Math.min(1, r2);
  const nz = Math.sqrt(Math.max(0, 1 - clampedR2));
  const world = add(
    add(scale(basis.right, nx), scale(basis.up, ny)),
    scale(basis.forward, nz),
  );
  return unit(world);
}

export function formatVec3(v: Vec3, decimals = 3): string {
  const fmt = (n: number) => {
    const clean = Math.abs(n) < 1e-12 ? 0 : n;
    const sign = clean >= 0 ? "+" : "−";
    return `${sign}${Math.abs(clean).toFixed(decimals)}`;
  };
  return `[${fmt(v[0])}, ${fmt(v[1])}, ${fmt(v[2])}]`;
}
