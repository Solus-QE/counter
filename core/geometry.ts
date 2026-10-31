import type { Vec3 } from "../shared/contract";

export const UNIT_TOLERANCE = 1e-8;
export const ARRIVAL_ANGLE = 1e-4;
export const STALL_NORM = 1e-7;
export const ESCAPE_NORM = 0.5;
export const MAX_ALPHA = 0.35;
export const STEP_ALPHA = 0.2;
export const dot = (a: Vec3, b: Vec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const norm = (v: Vec3): number => Math.hypot(...v);
export const scale = (v: Vec3, n: number): Vec3 => [
  v[0] * n,
  v[1] * n,
  v[2] * n,
];
export const add = (a: Vec3, b: Vec3): Vec3 => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const angle = (a: Vec3, b: Vec3): number =>
  Math.atan2(norm(cross(a, b)), dot(a, b));
export const field = (x: Vec3, axis: Vec3): Vec3 =>
  add(axis, scale(x, -dot(axis, x)));
export const navigatorField = (x: Vec3, g: Vec3): Vec3 => field(x, g);
export const rescuerField = (x: Vec3, b: Vec3): Vec3 => field(x, b);
export const arrived = (x: Vec3, g: Vec3): boolean =>
  angle(x, g) <= ARRIVAL_ANGLE;
export const stalled = (x: Vec3, g: Vec3): boolean =>
  !arrived(x, g) && dot(x, g) < 0 && norm(navigatorField(x, g)) <= STALL_NORM;
export const escaped = (x: Vec3, g: Vec3): boolean =>
  norm(navigatorField(x, g)) >= ESCAPE_NORM;
export function unit(v: Vec3): Vec3 {
  const length = norm(v);
  if (!Number.isFinite(length) || length < 1e-14)
    throw new Error("Cannot normalize zero or non-finite vector");
  return scale(v, 1 / length);
}
export function isUnit(v: unknown): v is Vec3 {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((n) => typeof n === "number" && Number.isFinite(n)) &&
    Math.abs(norm(v as unknown as Vec3) - 1) <= UNIT_TOLERANCE
  );
}
export function perpendicular(g: Vec3): Vec3 {
  const i = [0, 1, 2].reduce(
    (best, i) => (Math.abs(g[i]) < Math.abs(g[best]) ? i : best),
    0,
  );
  const axis: Vec3 = i === 0 ? [1, 0, 0] : i === 1 ? [0, 1, 0] : [0, 0, 1];
  return unit(field(g, axis));
}
/** Exponential map: callers validate unit x, unit tangent u, and alpha. */
export function sphericalMove(x: Vec3, u: Vec3, alpha: number): Vec3 {
  return unit(add(scale(x, Math.cos(alpha)), scale(u, Math.sin(alpha))));
}
export function steering(
  x: Vec3,
  axis: Vec3,
): { tangent: Vec3; alpha: number } | null {
  if (arrived(x, axis)) return null;
  const v = field(x, axis);
  if (norm(v) <= STALL_NORM) return null;
  return { tangent: unit(v), alpha: Math.min(STEP_ALPHA, angle(x, axis)) };
}
