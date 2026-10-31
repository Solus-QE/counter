import type {
  PilotId,
  TrajectoryPoint,
  Vec3,
} from "../../shared/contract";
import {
  add,
  angle,
  buildCameraBasis,
  cross,
  dot,
  ESCAPE_NORM,
  formatVec3,
  lookAtAngles,
  navigatorField,
  norm,
  perpendicular,
  project3D,
  rescuerField,
  sampleGeodesicArc,
  scale,
  slerp,
  smallCircleOnSphere,
  unit,
  unprojectSphereClick,
  type CameraBasis,
} from "./sphere-math";
import type { UiLifecycleState } from "./telemetry";

export type ProjectionMode = "3d" | "2d";
export type CameraPreset = "orbit" | "follow" | "blind" | "goal" | "rescue";
export type FieldOverlayMode = "nav" | "res" | "both" | "off";

export interface SphereRenderState {
  lifecycle: UiLifecycleState;
  activePilot: PilotId;
  hasActiveMission: boolean;
  position: Vec3;
  goal: Vec3;
  rescueAxis: Vec3;
  stagedGoal: Vec3 | null;
  trajectory: TrajectoryPoint[];
  handoffPoints?: Array<{ revision: number; position: Vec3 }>;
  isStalled: boolean;
  isEscaped: boolean;
}

const DEFAULT_KEEP_OUT_AXIS: Vec3 = [Math.sin(0.7), 0, -Math.cos(0.7)];
const DEFAULT_KEEP_OUT_HALF_ANGLE = 0.05;

// Restrained scientific palette matching styles.css
const COL_NAV = "#38bdf8";
const COL_RES = "#a78bfa";
const COL_RED = "#f43f5e";
const COL_GREEN = "#34d399";
const COL_AMBER = "#f59e0b";
const COL_TEXT = "#eceef2";
const COL_SUB = "#9299a5";
const COL_HALO = "rgba(8, 9, 11, 0.92)";

const FONT_LABEL =
  '500 11px "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const FONT_MONO =
  '500 10px "JetBrains Mono", "SF Mono", "DejaVu Sans Mono", monospace';

/** Precomputed Fibonacci lattice on S² for uniform tangent vector field needles */
function createFibonacciSphere(count: number): Vec3[] {
  const pts: Vec3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const z = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const theta = golden * i;
    pts.push([Math.cos(theta) * r, Math.sin(theta) * r, z]);
  }
  return pts;
}

const LATTICE_POINTS = createFibonacciSphere(104);

export class SphereVisualizer {
  private ctx: CanvasRenderingContext2D;
  private width = 800;
  private height = 600;
  private dpr = 1;

  private projectionMode: ProjectionMode = "3d";
  private cameraPreset: CameraPreset = "orbit";
  private fieldMode: FieldOverlayMode = "nav";
  private pickingEnabled = false;

  // Camera spherical coordinates (radians) + smooth tracking
  private yaw = 0.54;
  private pitch = 0.06;
  private targetYaw = 0.54;
  private targetPitch = 0.06;
  private velYaw = 0;
  private velPitch = 0;
  private zoom = 1.0;

  // Pointer interaction state
  private dragging = false;
  private dragMoved = false;
  private lastPointerX = 0;
  private lastPointerY = 0;

  // Smooth SLERP spacecraft attitude animation state
  private animatedPos: Vec3 = [1, 0, 0];
  private animFrom: Vec3 = [1, 0, 0];
  private animTo: Vec3 = [1, 0, 0];
  private animStartMs = 0;
  private animDurationMs = 360;

  private state: SphereRenderState = {
    lifecycle: "connecting",
    activePilot: "navigator",
    hasActiveMission: false,
    position: [1, 0, 0],
    goal: [0, 0, 1],
    rescueAxis: [1, 0, 0],
    stagedGoal: null,
    trajectory: [],
    isStalled: false,
    isEscaped: true,
  };

  private rafId = 0;
  private resizeObserver?: ResizeObserver;
  onPickDestination?: (goal: Vec3) => void;
  onCameraPresetChanged?: (preset: CameraPreset) => void;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    this.bindEvents();
    this.resize();
    this.startLoop();
  }

  setState(next: SphereRenderState): void {
    const dist = angle(this.animTo, next.position);
    if (dist > 1e-5) {
      this.animFrom = this.animatedPos;
      this.animTo = next.position;
      this.animStartMs = performance.now();
      this.animDurationMs = dist > 1.2 ? 500 : 340;
    } else if (!this.state.hasActiveMission && next.hasActiveMission) {
      this.animatedPos = next.position;
      this.animFrom = next.position;
      this.animTo = next.position;
    }
    this.state = next;
    this.updatePresetAngles();
  }

  setProjectionMode(mode: ProjectionMode): void {
    this.projectionMode = mode;
  }

  setCameraPreset(preset: CameraPreset): void {
    this.cameraPreset = preset;
    this.velYaw = 0;
    this.velPitch = 0;
    this.updatePresetAngles();
  }

  cycleFieldMode(): FieldOverlayMode {
    const order: FieldOverlayMode[] = ["nav", "res", "both", "off"];
    const next = order[(order.indexOf(this.fieldMode) + 1) % order.length];
    this.fieldMode = next;
    return next;
  }

  setPickingEnabled(enabled: boolean): void {
    this.pickingEnabled = enabled;
    this.canvas.classList.toggle("picking-cursor", enabled);
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    this.resizeObserver?.disconnect();
  }

  private updatePresetAngles(): void {
    if (this.cameraPreset === "orbit") return;
    if (this.cameraPreset === "follow") {
      const a = lookAtAngles(this.animTo);
      this.targetYaw = a.yaw;
      this.targetPitch = a.pitch;
    } else if (this.cameraPreset === "blind") {
      const a = lookAtAngles(scale(this.state.goal, -1));
      this.targetYaw = a.yaw + 0.18;
      this.targetPitch = Math.max(-1.25, Math.min(1.25, a.pitch + 0.22));
    } else if (this.cameraPreset === "goal") {
      const a = lookAtAngles(this.state.goal);
      this.targetYaw = a.yaw + 0.18;
      this.targetPitch = Math.max(-1.25, Math.min(1.25, a.pitch - 0.18));
    } else if (this.cameraPreset === "rescue") {
      const normal = unit(cross(this.state.rescueAxis, this.state.goal));
      const viewDir = unit(
        add(
          add(scale(normal, 0.72), scale(this.state.rescueAxis, 0.52)),
          scale(this.state.goal, -0.25),
        ),
      );
      const a = lookAtAngles(viewDir);
      this.targetYaw = a.yaw;
      this.targetPitch = a.pitch;
    }
  }

  private bindEvents(): void {
    this.resizeObserver = new ResizeObserver(() => this.resize());
    if (this.canvas.parentElement) {
      this.resizeObserver.observe(this.canvas.parentElement);
    }

    this.canvas.addEventListener("pointerdown", (e: PointerEvent) => {
      this.dragging = true;
      this.dragMoved = false;
      this.lastPointerX = e.clientX;
      this.lastPointerY = e.clientY;
      this.velYaw = 0;
      this.velPitch = 0;
      this.canvas.setPointerCapture(e.pointerId);
    });

    this.canvas.addEventListener("pointermove", (e: PointerEvent) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastPointerX;
      const dy = e.clientY - this.lastPointerY;
      if (Math.hypot(dx, dy) > 3) this.dragMoved = true;
      this.lastPointerX = e.clientX;
      this.lastPointerY = e.clientY;

      if (this.projectionMode === "3d" && this.dragMoved) {
        if (this.cameraPreset !== "orbit") {
          this.cameraPreset = "orbit";
          this.onCameraPresetChanged?.("orbit");
        }
        const sens = 0.0068;
        this.yaw -= dx * sens;
        this.pitch = Math.max(-1.46, Math.min(1.46, this.pitch + dy * sens));
        this.targetYaw = this.yaw;
        this.targetPitch = this.pitch;
        this.velYaw = -dx * sens * 0.25;
        this.velPitch = dy * sens * 0.25;
      }
    });

    const endDrag = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      if (this.canvas.hasPointerCapture(e.pointerId)) {
        this.canvas.releasePointerCapture(e.pointerId);
      }
      if (!this.dragMoved && this.pickingEnabled && this.onPickDestination) {
        const rect = this.canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const picked = this.pickPoint(px, py);
        if (picked) this.onPickDestination(picked);
      }
    };

    this.canvas.addEventListener("pointerup", endDrag);
    this.canvas.addEventListener("pointercancel", endDrag);

    this.canvas.addEventListener(
      "wheel",
      (e: WheelEvent) => {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 0.93 : 1.075;
        this.zoom = Math.max(0.68, Math.min(1.65, this.zoom * factor));
      },
      { passive: false },
    );
  }

  private pickPoint(px: number, py: number): Vec3 | null {
    if (this.projectionMode === "3d") {
      const { cx, cy, radius } = this.globeMetrics();
      const basis = buildCameraBasis(this.yaw, this.pitch);
      return unprojectSphereClick(px, py, basis, cx, cy, radius);
    }
    const { leftCx, rightCx, cy, hemiR } = this.hemiMetrics();
    const pickHemi = (centerAxis: Vec3, hcx: number): Vec3 | null => {
      const nx = (px - hcx) / hemiR;
      const ny = (cy - py) / hemiR;
      const r2 = nx * nx + ny * ny;
      if (r2 > 1) return null;
      const rho = Math.sqrt(r2) * Math.SQRT2;
      const c = 2 * Math.asin(Math.min(1, rho / 2));
      const u1 = perpendicular(centerAxis);
      const u2 = unit(cross(centerAxis, u1));
      if (rho < 1e-6) return centerAxis;
      const dir = unit(add(scale(u1, nx), scale(u2, ny)));
      return unit(add(scale(centerAxis, Math.cos(c)), scale(dir, Math.sin(c))));
    };
    return (
      pickHemi(this.state.goal, leftCx) ??
      pickHemi(scale(this.state.goal, -1), rightCx)
    );
  }

  private resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    this.width = Math.max(320, Math.floor(rect.width));
    this.height = Math.max(320, Math.floor(rect.height));
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
  }

  private globeMetrics() {
    const cx = this.width * 0.5;
    const cy = this.height * 0.515;
    const baseR = Math.min(this.width * 0.35, this.height * 0.388);
    return { cx, cy, radius: Math.max(108, baseR) * this.zoom };
  }

  private hemiMetrics() {
    const hemiR = Math.min(this.width * 0.21, this.height * 0.33) * this.zoom;
    const cy = this.height * 0.51;
    const leftCx = this.width * 0.285;
    const rightCx = this.width * 0.715;
    return { leftCx, rightCx, cy, hemiR };
  }

  private startLoop(): void {
    const frame = (now: number) => {
      this.stepAnimation(now);
      this.render(now);
      this.rafId = requestAnimationFrame(frame);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  private stepAnimation(now: number): void {
    const elapsed = now - this.animStartMs;
    if (elapsed < this.animDurationMs) {
      const rawT = Math.max(0, Math.min(1, elapsed / this.animDurationMs));
      const eased = 1 - Math.pow(1 - rawT, 3);
      this.animatedPos = slerp(this.animFrom, this.animTo, eased);
    } else {
      this.animatedPos = this.animTo;
    }

    if (this.cameraPreset !== "orbit") {
      if (this.cameraPreset === "follow") {
        const a = lookAtAngles(this.animatedPos);
        this.targetYaw = a.yaw;
        this.targetPitch = a.pitch;
      }
      let dYaw = this.targetYaw - this.yaw;
      while (dYaw > Math.PI) dYaw -= Math.PI * 2;
      while (dYaw < -Math.PI) dYaw += Math.PI * 2;
      this.yaw += dYaw * 0.085;
      this.pitch += (this.targetPitch - this.pitch) * 0.085;
    } else if (!this.dragging) {
      this.yaw += this.velYaw;
      this.pitch = Math.max(-1.46, Math.min(1.46, this.pitch + this.velPitch));
      this.velYaw *= 0.92;
      this.velPitch *= 0.92;
      if (
        Math.abs(this.velYaw) < 0.00008 &&
        Math.abs(this.velPitch) < 0.00008 &&
        !this.pickingEnabled
      ) {
        // Calm sidereal rotation (NASA Eyes feel)
        this.yaw += 0.00032;
      }
    }
  }

  private render(now: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, this.width, this.height);

    if (this.projectionMode === "3d") {
      this.render3DGlobe(ctx, now);
    } else {
      this.render2DHemispheres(ctx, now);
    }

    ctx.restore();
  }

  private render3DGlobe(ctx: CanvasRenderingContext2D, now: number): void {
    const { cx, cy, radius } = this.globeMetrics();
    const basis = buildCameraBasis(this.yaw, this.pitch);
    const s = this.state;
    const antipode = scale(s.goal, -1);
    const escapeAngle = Math.asin(ESCAPE_NORM); // π/6 = 30°

    // 1. Subtle neutral limb separation (zero neon aura)
    const rimShadow = ctx.createRadialGradient(
      cx,
      cy,
      radius * 0.94,
      cx,
      cy,
      radius * 1.07,
    );
    rimShadow.addColorStop(0, "rgba(255, 255, 255, 0.03)");
    rimShadow.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = rimShadow;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 1.07, 0, Math.PI * 2);
    ctx.fill();

    // 2. Matte neutral graphite sphere body
    const sphereGrad = ctx.createRadialGradient(
      cx - radius * 0.34,
      cy - radius * 0.36,
      radius * 0.05,
      cx,
      cy,
      radius,
    );
    sphereGrad.addColorStop(0, "#171b24");
    sphereGrad.addColorStop(0.56, "#0d1016");
    sphereGrad.addColorStop(1, "#07090d");
    ctx.fillStyle = sphereGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();

    // 3. Back-hemisphere cartographic graticule & reference arcs
    this.drawGraticule3D(ctx, basis, cx, cy, radius, false);
    this.drawCurve3D(
      ctx,
      smallCircleOnSphere(antipode, escapeAngle, 72),
      basis,
      cx,
      cy,
      radius,
      false,
      "rgba(244, 63, 94, 0.14)",
      0.85,
      [3, 4],
    );
    this.drawRescueReferenceMeridian(ctx, basis, cx, cy, radius, false);
    this.drawTrajectory3D(ctx, basis, cx, cy, radius, false);

    // 4. Subtle radial attitude spoke from sphere origin to x
    const originP = project3D([0, 0, 0], basis, cx, cy, radius);
    const satP = project3D(this.animatedPos, basis, cx, cy, radius);
    const goalP = project3D(s.goal, basis, cx, cy, radius);
    const antiP = project3D(antipode, basis, cx, cy, radius);
    const rescueP = project3D(s.rescueAxis, basis, cx, cy, radius);

    ctx.save();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
    ctx.lineWidth = 0.85;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(originP.x, originP.y);
    ctx.lineTo(satP.x, satP.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
    ctx.beginPath();
    ctx.arc(originP.x, originP.y, 1.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 5. Front-hemisphere cartographic graticule & non-overlapping inertial axes
    this.drawGraticule3D(ctx, basis, cx, cy, radius, true);
    this.drawPrincipalAxes3D(ctx, basis, cx, cy, radius, [
      satP,
      goalP,
      antiP,
      rescueP,
    ]);

    // 6. Surface tangent vector field overlay
    if (this.fieldMode !== "off") {
      this.drawVectorField3D(ctx, basis, cx, cy, radius);
    }

    // 7. Front-hemisphere Rescue meridian, Keep-Out cone, and 30° Escape ring
    this.drawRescueReferenceMeridian(ctx, basis, cx, cy, radius, true);

    if (dot(s.goal, [0, 0, 1]) > 0.995) {
      this.drawCurve3D(
        ctx,
        smallCircleOnSphere(
          DEFAULT_KEEP_OUT_AXIS,
          DEFAULT_KEEP_OUT_HALF_ANGLE,
          40,
        ),
        basis,
        cx,
        cy,
        radius,
        true,
        "rgba(245, 158, 11, 0.65)",
        1.1,
        [2, 2],
      );
      const koP = project3D(DEFAULT_KEEP_OUT_AXIS, basis, cx, cy, radius);
      if (koP.front) {
        this.drawTextHalo(
          ctx,
          "Keep-out",
          koP.x - 6,
          koP.y + 3,
          "rgba(251, 191, 36, 0.82)",
          FONT_MONO,
          "right",
        );
      }
    }

    const escapeRingPts = smallCircleOnSphere(antipode, escapeAngle, 72);
    this.drawCurve3D(
      ctx,
      escapeRingPts,
      basis,
      cx,
      cy,
      radius,
      true,
      s.lifecycle === "stalled" || s.lifecycle === "recovering"
        ? "rgba(244, 63, 94, 0.72)"
        : "rgba(244, 63, 94, 0.38)",
      1.15,
      [4, 4],
    );

    let bestRingLabelPt: ReturnType<typeof project3D> | null = null;
    for (const rpt of escapeRingPts) {
      const proj = project3D(rpt, basis, cx, cy, radius);
      if (proj.front && (!bestRingLabelPt || proj.x > bestRingLabelPt.x)) {
        bestRingLabelPt = proj;
      }
    }
    if (bestRingLabelPt) {
      const nearRight = bestRingLabelPt.x + 150 > this.width - 14;
      this.drawTextHalo(
        ctx,
        "30° escape cone (||v_nav|| = 0.50)",
        nearRight ? bestRingLabelPt.x - 8 : bestRingLabelPt.x + 8,
        bestRingLabelPt.y + 3,
        "rgba(251, 113, 133, 0.78)",
        FONT_MONO,
        nearRight ? "right" : "left",
      );
    }

    // 8. Front-hemisphere geodesic trajectory
    this.drawTrajectory3D(ctx, basis, cx, cy, radius, true);

    // 9. Crisp 1px directional anodized sphere limb
    ctx.save();
    if (s.lifecycle === "stalled") {
      ctx.strokeStyle = "rgba(244, 63, 94, 0.38)";
    } else if (s.lifecycle === "recovering") {
      ctx.strokeStyle = "rgba(167, 139, 250, 0.34)";
    } else {
      const limbGrad = ctx.createLinearGradient(
        cx - radius,
        cy - radius,
        cx + radius,
        cy + radius,
      );
      limbGrad.addColorStop(0, "rgba(255, 255, 255, 0.24)");
      limbGrad.addColorStop(0.55, "rgba(255, 255, 255, 0.13)");
      limbGrad.addColorStop(1, "rgba(255, 255, 255, 0.06)");
      ctx.strokeStyle = limbGrad;
    }
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // 10. Markers & scientific leader-line callouts (collision-aware)
    const nearGoal = Math.hypot(satP.x - goalP.x, satP.y - goalP.y) < 30;
    const nearBlind = Math.hypot(satP.x - antiP.x, satP.y - antiP.y) < 30;

    this.drawRescueAxisMarker(ctx, basis, cx, cy, radius, satP);
    this.drawBlindSpotMarker(
      ctx,
      antipode,
      basis,
      cx,
      cy,
      radius,
      now,
      nearBlind ? 18 : 13,
    );
    this.drawGoalMarker(
      ctx,
      s.goal,
      basis,
      cx,
      cy,
      radius,
      nearGoal ? -12 : -10,
    );

    if (s.stagedGoal && angle(s.stagedGoal, s.goal) > 1e-3) {
      this.drawStagedPreview(ctx, s.stagedGoal, basis, cx, cy, radius);
    }

    // 11. Live tangent steering vectors at x
    this.drawSteeringVectors3D(ctx, basis, cx, cy, radius);

    // 12. Spacecraft attitude reticle & callout
    const satDy = nearGoal ? 16 : nearBlind ? -16 : -12;
    this.drawSatelliteReticle(ctx, satP, satDy);
  }

  private drawGraticule3D(
    ctx: CanvasRenderingContext2D,
    basis: CameraBasis,
    cx: number,
    cy: number,
    radius: number,
    frontPass: boolean,
  ): void {
    const stroke = frontPass
      ? "rgba(255, 255, 255, 0.065)"
      : "rgba(255, 255, 255, 0.02)";
    const equatorStroke = frontPass
      ? "rgba(255, 255, 255, 0.12)"
      : "rgba(255, 255, 255, 0.032)";

    for (const latDeg of [-60, -30, 0, 30, 60]) {
      const lat = (latDeg * Math.PI) / 180;
      const cosL = Math.cos(lat);
      const sinL = Math.sin(lat);
      const pts: Vec3[] = [];
      for (let i = 0; i <= 72; i++) {
        const lon = (i / 72) * Math.PI * 2;
        pts.push([cosL * Math.cos(lon), cosL * Math.sin(lon), sinL]);
      }
      this.drawCurve3D(
        ctx,
        pts,
        basis,
        cx,
        cy,
        radius,
        frontPass,
        latDeg === 0 ? equatorStroke : stroke,
        latDeg === 0 ? 0.9 : 0.7,
      );
    }

    for (let lonDeg = 0; lonDeg < 180; lonDeg += 30) {
      const lon = (lonDeg * Math.PI) / 180;
      const pts: Vec3[] = [];
      for (let i = 0; i <= 72; i++) {
        const a = (i / 72) * Math.PI * 2;
        pts.push([
          Math.cos(a) * Math.cos(lon),
          Math.cos(a) * Math.sin(lon),
          Math.sin(a),
        ]);
      }
      this.drawCurve3D(ctx, pts, basis, cx, cy, radius, frontPass, stroke, 0.7);
    }
  }

  private drawPrincipalAxes3D(
    ctx: CanvasRenderingContext2D,
    basis: CameraBasis,
    cx: number,
    cy: number,
    radius: number,
    occupied: Array<{ x: number; y: number }>,
  ): void {
    const axes: Array<{ v: Vec3; label: string }> = [
      { v: [1, 0, 0], label: "+X" },
      { v: [0, 1, 0], label: "+Y" },
      { v: [0, 0, 1], label: "+Z" },
    ];
    ctx.save();
    for (const ax of axes) {
      const p = project3D(ax.v, basis, cx, cy, radius);
      if (!p.front) continue;
      const crowded = occupied.some(
        (o) => Math.hypot(o.x - p.x, o.y - p.y) < 24,
      );
      if (crowded) continue;
      ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
      ctx.fill();
      this.drawTextHalo(
        ctx,
        ax.label,
        p.x + 5,
        p.y - 4,
        "rgba(146, 153, 165, 0.65)",
        FONT_MONO,
      );
    }
    ctx.restore();
  }

  private drawRescueReferenceMeridian(
    ctx: CanvasRenderingContext2D,
    basis: CameraBasis,
    cx: number,
    cy: number,
    radius: number,
    frontPass: boolean,
  ): void {
    const antipode = scale(this.state.goal, -1);
    const arc1 = sampleGeodesicArc(antipode, this.state.rescueAxis, 32);
    const arc2 = sampleGeodesicArc(this.state.rescueAxis, this.state.goal, 32);
    this.drawCurve3D(
      ctx,
      [...arc1, ...arc2],
      basis,
      cx,
      cy,
      radius,
      frontPass,
      frontPass
        ? "rgba(167, 139, 250, 0.22)"
        : "rgba(167, 139, 250, 0.06)",
      0.9,
      [3, 5],
    );
  }

  private drawVectorField3D(
    ctx: CanvasRenderingContext2D,
    basis: CameraBasis,
    cx: number,
    cy: number,
    radius: number,
  ): void {
    const satScreen = project3D(this.animatedPos, basis, cx, cy, radius);
    const drawField = (axis: Vec3, color: string) => {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 0.85;
      for (const pt of LATTICE_POINTS) {
        const p0 = project3D(pt, basis, cx, cy, radius);
        if (p0.z < 0.08) continue;
        if (
          satScreen.front &&
          Math.hypot(p0.x - satScreen.x, p0.y - satScreen.y) < 28
        ) {
          continue;
        }
        const v =
          axis === this.state.goal
            ? navigatorField(pt, axis)
            : rescuerField(pt, axis);
        const m = norm(v);
        if (m < 0.03) continue;
        const tipWorld = unit(add(pt, scale(v, 0.1)));
        const p1 = project3D(tipWorld, basis, cx, cy, radius);
        ctx.globalAlpha = 0.1 + 0.28 * m * p0.z;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();

        const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(
          p1.x - 3.2 * Math.cos(ang - 0.48),
          p1.y - 3.2 * Math.sin(ang - 0.48),
        );
        ctx.lineTo(
          p1.x - 3.2 * Math.cos(ang + 0.48),
          p1.y - 3.2 * Math.sin(ang + 0.48),
        );
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    };

    if (this.fieldMode === "nav" || this.fieldMode === "both") {
      drawField(this.state.goal, COL_NAV);
    }
    if (this.fieldMode === "res" || this.fieldMode === "both") {
      drawField(this.state.rescueAxis, COL_RES);
    }
  }

  private drawTrajectory3D(
    ctx: CanvasRenderingContext2D,
    basis: CameraBasis,
    cx: number,
    cy: number,
    radius: number,
    frontPass: boolean,
  ): void {
    const traj = this.state.trajectory;
    if (traj.length < 2) return;

    for (let i = 1; i < traj.length; i++) {
      const prev = traj[i - 1];
      const curr = traj[i];
      const isLast = i === traj.length - 1;
      const endPos = isLast ? this.animatedPos : curr.position;

      if (curr.kind === "challenge") {
        const pts = sampleGeodesicArc(prev.position, endPos, 36);
        this.drawCurve3D(
          ctx,
          pts,
          basis,
          cx,
          cy,
          radius,
          frontPass,
          frontPass ? "rgba(244, 63, 94, 0.65)" : "rgba(244, 63, 94, 0.18)",
          1.35,
          [4, 4],
        );
      } else {
        const pts = sampleGeodesicArc(prev.position, endPos, 18);
        const isRescuer = curr.pilot === "rescuer";
        const color = isRescuer
          ? frontPass
            ? COL_RES
            : "rgba(167, 139, 250, 0.22)"
          : frontPass
            ? COL_NAV
            : "rgba(56, 189, 248, 0.22)";
        this.drawCurve3D(
          ctx,
          pts,
          basis,
          cx,
          cy,
          radius,
          frontPass,
          color,
          frontPass ? 2.1 : 1.0,
          frontPass ? undefined : [3, 3],
        );
      }
    }

    if (frontPass) {
      for (let i = 0; i < traj.length; i++) {
        const wp = traj[i];
        const p = project3D(wp.position, basis, cx, cy, radius);
        if (!p.front) continue;
        ctx.fillStyle =
          wp.kind === "challenge"
            ? COL_RED
            : wp.pilot === "rescuer"
              ? COL_RES
              : COL_NAV;
        ctx.beginPath();
        ctx.arc(p.x, p.y, wp.kind === "start" ? 2.8 : 2.0, 0, Math.PI * 2);
        ctx.fill();
      }

      if (this.state.handoffPoints && this.state.handoffPoints.length > 0) {
        const satScreen = project3D(this.animatedPos, basis, cx, cy, radius);
        const goalScreen = project3D(this.state.goal, basis, cx, cy, radius);
        for (const hp of this.state.handoffPoints) {
          const p = project3D(hp.position, basis, cx, cy, radius);
          if (!p.front) continue;
          ctx.save();
          ctx.strokeStyle = COL_NAV;
          ctx.lineWidth = 1.25;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 5.5, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = COL_RES;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2.4, 0, Math.PI * 2);
          ctx.fill();
          if (
            Math.hypot(p.x - satScreen.x, p.y - satScreen.y) > 26 &&
            Math.hypot(p.x - goalScreen.x, p.y - goalScreen.y) > 26
          ) {
            this.drawTextHalo(
              ctx,
              `Handoff r${hp.revision}`,
              p.x + 8,
              p.y + 3,
              COL_NAV,
              FONT_MONO,
            );
          }
          ctx.restore();
        }
      }
    }
  }

  private drawRescueAxisMarker(
    ctx: CanvasRenderingContext2D,
    basis: CameraBasis,
    cx: number,
    cy: number,
    radius: number,
    satP: { x: number; y: number },
  ): void {
    const p = project3D(this.state.rescueAxis, basis, cx, cy, radius);
    ctx.save();
    ctx.globalAlpha = p.front ? 0.88 : 0.28;
    ctx.strokeStyle = "rgba(167, 139, 250, 0.65)";
    ctx.fillStyle = COL_RES;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
    ctx.fill();

    // Avoid label collision when spacecraft starts right on +X = +b
    if (Math.hypot(p.x - satP.x, p.y - satP.y) > 22) {
      this.drawTextHalo(
        ctx,
        "Rescue +b",
        p.x + 8,
        p.y + 3,
        "rgba(196, 181, 253, 0.85)",
        FONT_MONO,
      );
    }
    ctx.restore();
  }

  private drawBlindSpotMarker(
    ctx: CanvasRenderingContext2D,
    antipode: Vec3,
    basis: CameraBasis,
    cx: number,
    cy: number,
    radius: number,
    now: number,
    leaderDy: number,
  ): void {
    const p = project3D(antipode, basis, cx, cy, radius);
    const activeStall =
      this.state.lifecycle === "stalled" || this.state.isStalled;
    const pulse = 0.5 + 0.5 * Math.sin(now * 0.005);

    ctx.save();
    ctx.globalAlpha = p.front ? 1 : 0.34;

    if (activeStall) {
      ctx.strokeStyle = `rgba(244, 63, 94, ${0.55 - pulse * 0.25})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 12 + pulse * 5, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.strokeStyle = "rgba(244, 63, 94, 0.72)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 7.5, 0, Math.PI * 2);
    ctx.stroke();

    // Precision crosshair
    ctx.beginPath();
    ctx.moveTo(p.x - 5.5, p.y);
    ctx.lineTo(p.x + 5.5, p.y);
    ctx.moveTo(p.x, p.y - 5.5);
    ctx.lineTo(p.x, p.y + 5.5);
    ctx.stroke();

    ctx.fillStyle = COL_RED;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2);
    ctx.fill();

    this.drawLeaderCallout(
      ctx,
      p.x,
      p.y,
      15,
      leaderDy,
      "Blind spot −g",
      activeStall ? "Gradient 0" : null,
      COL_RED,
    );
    ctx.restore();
  }

  private drawGoalMarker(
    ctx: CanvasRenderingContext2D,
    goal: Vec3,
    basis: CameraBasis,
    cx: number,
    cy: number,
    radius: number,
    leaderDy: number,
  ): void {
    const p = project3D(goal, basis, cx, cy, radius);
    const completed = this.state.lifecycle === "completed";

    ctx.save();
    ctx.globalAlpha = p.front ? 1 : 0.35;

    ctx.strokeStyle = completed ? COL_GREEN : "rgba(52, 211, 153, 0.7)";
    ctx.lineWidth = completed ? 1.5 : 1;
    ctx.beginPath();
    ctx.arc(p.x, p.y, completed ? 10 : 7.5, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = COL_GREEN;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fill();

    this.drawLeaderCallout(
      ctx,
      p.x,
      p.y,
      15,
      leaderDy,
      "Target +g",
      completed ? "Locked" : null,
      COL_GREEN,
    );
    ctx.restore();
  }

  private drawStagedPreview(
    ctx: CanvasRenderingContext2D,
    stagedGoal: Vec3,
    basis: CameraBasis,
    cx: number,
    cy: number,
    radius: number,
  ): void {
    const gp = project3D(stagedGoal, basis, cx, cy, radius);
    const ap = project3D(scale(stagedGoal, -1), basis, cx, cy, radius);

    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1.1;

    if (gp.front) {
      ctx.strokeStyle = COL_GREEN;
      ctx.beginPath();
      ctx.arc(gp.x, gp.y, 7.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      this.drawLeaderCallout(
        ctx,
        gp.x,
        gp.y,
        14,
        -10,
        "Staged +g",
        "preview",
        COL_GREEN,
      );
      ctx.setLineDash([3, 3]);
    }

    if (ap.front) {
      ctx.strokeStyle = COL_RED;
      ctx.beginPath();
      ctx.arc(ap.x, ap.y, 7, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawSteeringVectors3D(
    ctx: CanvasRenderingContext2D,
    basis: CameraBasis,
    cx: number,
    cy: number,
    radius: number,
  ): void {
    const x = this.animatedPos;
    const p0 = project3D(x, basis, cx, cy, radius);
    const vNav = navigatorField(x, this.state.goal);
    const navMag = norm(vNav);
    const vRes = rescuerField(x, this.state.rescueAxis);
    const resMag = norm(vRes);

    const pRes =
      resMag > 1e-4
        ? project3D(add(x, scale(vRes, 0.38)), basis, cx, cy, radius)
        : null;
    const pNav =
      navMag > 1e-5
        ? project3D(add(x, scale(vNav, 0.42)), basis, cx, cy, radius)
        : null;
    const tipsClose =
      pRes && pNav && Math.hypot(pRes.x - pNav.x, pRes.y - pNav.y) < 34;

    // 1. Rescuer tangent vector (Violet)
    if (pRes) {
      const isResActive =
        this.state.activePilot === "rescuer" || this.state.isStalled;
      this.drawArrow2D(
        ctx,
        p0.x,
        p0.y,
        pRes.x,
        pRes.y,
        COL_RES,
        isResActive ? 2.2 : 1.35,
        p0.front ? (isResActive ? 0.96 : 0.55) : 0.28,
        `v_res ${resMag.toFixed(2)}`,
        tipsClose ? -7 : 0,
      );
    }

    // 2. Navigator tangent vector (Cyan — or subtle zero-gradient note when stalled)
    if (pNav) {
      const isNavActive = this.state.activePilot === "navigator";
      this.drawArrow2D(
        ctx,
        p0.x,
        p0.y,
        pNav.x,
        pNav.y,
        COL_NAV,
        isNavActive ? 2.3 : 1.4,
        p0.front ? (isNavActive ? 0.98 : 0.55) : 0.28,
        `v_nav ${navMag.toFixed(2)}`,
        tipsClose ? 9 : 0,
      );
    } else if (this.state.lifecycle !== "completed") {
      this.drawTextHalo(
        ctx,
        "v_nav = 0.00",
        p0.x - 14,
        p0.y + 4,
        COL_NAV,
        FONT_MONO,
        "right",
      );
    }
  }

  private drawSatelliteReticle(
    ctx: CanvasRenderingContext2D,
    p: { x: number; y: number; front: boolean },
    leaderDy = -12,
  ): void {
    const s = this.state;
    const authColor =
      s.lifecycle === "completed"
        ? COL_GREEN
        : s.lifecycle === "stalled" || s.lifecycle === "failed"
          ? COL_RED
          : s.activePilot === "rescuer"
            ? COL_RES
            : COL_NAV;

    ctx.save();
    ctx.globalAlpha = p.front ? 1 : 0.38;

    // Precision aerospace reticle ring + 4 cardinal ticks (no shadowBlur)
    const r = 9;
    ctx.strokeStyle = authColor;
    ctx.lineWidth = 1.35;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(p.x - r - 2.5, p.y);
    ctx.lineTo(p.x - r + 1.5, p.y);
    ctx.moveTo(p.x + r - 1.5, p.y);
    ctx.lineTo(p.x + r + 2.5, p.y);
    ctx.moveTo(p.x, p.y - r - 2.5);
    ctx.lineTo(p.x, p.y - r + 1.5);
    ctx.moveTo(p.x, p.y + r - 1.5);
    ctx.lineTo(p.x, p.y + r + 2.5);
    ctx.stroke();

    ctx.fillStyle = COL_TEXT;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.2, 0, Math.PI * 2);
    ctx.fill();

    const sub =
      s.lifecycle === "completed"
        ? "Arrived"
        : s.isStalled || s.lifecycle === "stalled"
          ? "Stalled"
          : s.activePilot === "rescuer"
            ? "Rescuer"
            : "Navigator";

    this.drawLeaderCallout(
      ctx,
      p.x,
      p.y,
      16,
      leaderDy,
      "Spacecraft x",
      sub,
      COL_TEXT,
    );
    ctx.restore();
  }

  private render2DHemispheres(ctx: CanvasRenderingContext2D, _now: number): void {
    const { leftCx, rightCx, cy, hemiR } = this.hemiMetrics();
    const goal = this.state.goal;
    const antipode = scale(goal, -1);

    this.drawSingleHemisphere2D(
      ctx,
      goal,
      leftCx,
      cy,
      hemiR,
      "Target hemisphere (+g)",
      COL_GREEN,
    );
    this.drawSingleHemisphere2D(
      ctx,
      antipode,
      rightCx,
      cy,
      hemiR,
      "Antipodal hemisphere (−g)",
      COL_RED,
    );
  }

  private drawSingleHemisphere2D(
    ctx: CanvasRenderingContext2D,
    centerAxis: Vec3,
    cx: number,
    cy: number,
    r: number,
    title: string,
    accent: string,
  ): void {
    const u1 = perpendicular(centerAxis);
    const u2 = unit(cross(centerAxis, u1));

    const projectHemi = (
      v: Vec3,
    ): { x: number; y: number; inside: boolean } => {
      const c = dot(v, centerAxis);
      const inside = c >= -1e-5;
      const k = Math.sqrt(1 / Math.max(1e-6, 1 + Math.max(-0.999, c)));
      const px = dot(v, u1) * k;
      const py = dot(v, u2) * k;
      return {
        x: cx + px * r,
        y: cy - py * r,
        inside,
      };
    };

    ctx.save();
    ctx.fillStyle = "#0d1016";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Concentric angular circles (30°, 60°) & crosshairs
    ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
    ctx.lineWidth = 0.75;
    for (const deg of [30, 60]) {
      const rad = (deg * Math.PI) / 180;
      const rr = Math.sqrt(1 - Math.cos(rad)) * r;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.moveTo(cx - r, cy);
    ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx, cy + r);
    ctx.stroke();

    this.drawTextHalo(
      ctx,
      title,
      cx,
      cy - r - 12,
      COL_SUB,
      FONT_LABEL,
      "center",
    );

    // 30° escape boundary on the −g hemisphere
    if (dot(centerAxis, scale(this.state.goal, -1)) > 0.99) {
      const escR = Math.sqrt(1 - Math.cos(Math.asin(ESCAPE_NORM))) * r;
      ctx.save();
      ctx.strokeStyle = "rgba(244, 63, 94, 0.65)";
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.15;
      ctx.beginPath();
      ctx.arc(cx, cy, escR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      this.drawTextHalo(
        ctx,
        "30° escape",
        cx + escR * 0.74,
        cy - escR * 0.74,
        "rgba(251, 113, 133, 0.85)",
        FONT_MONO,
      );
      ctx.restore();
    }

    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(cx, cy, 3.2, 0, Math.PI * 2);
    ctx.fill();

    // Trajectory inside hemisphere
    const traj = this.state.trajectory;
    for (let i = 1; i < traj.length; i++) {
      const prev = traj[i - 1];
      const curr = traj[i];
      const endPos = i === traj.length - 1 ? this.animatedPos : curr.position;
      const pts = sampleGeodesicArc(prev.position, endPos, 20);
      ctx.strokeStyle =
        curr.kind === "challenge"
          ? "rgba(244, 63, 94, 0.65)"
          : curr.pilot === "rescuer"
            ? COL_RES
            : COL_NAV;
      ctx.lineWidth = 2.0;
      ctx.setLineDash(curr.kind === "challenge" ? [4, 4] : []);
      ctx.beginPath();
      let penDown = false;
      for (const pt of pts) {
        const p = projectHemi(pt);
        if (!p.inside) {
          penDown = false;
          continue;
        }
        if (!penDown) {
          ctx.moveTo(p.x, p.y);
          penDown = true;
        } else {
          ctx.lineTo(p.x, p.y);
        }
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);

    if (this.state.handoffPoints) {
      for (const hp of this.state.handoffPoints) {
        const p = projectHemi(hp.position);
        if (!p.inside) continue;
        ctx.strokeStyle = COL_NAV;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = COL_RES;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const sat = projectHemi(this.animatedPos);
    if (sat.inside) {
      const vNav = navigatorField(this.animatedPos, this.state.goal);
      const vRes = rescuerField(this.animatedPos, this.state.rescueAxis);
      const navM = norm(vNav);
      const resM = norm(vRes);
      const tipRes =
        resM > 1e-4
          ? projectHemi(unit(add(this.animatedPos, scale(unit(vRes), 0.14 + 0.28 * resM))))
          : null;
      const tipNav =
        navM > 1e-4
          ? projectHemi(unit(add(this.animatedPos, scale(unit(vNav), 0.12 + 0.24 * navM))))
          : null;
      const close2D =
        tipRes &&
        tipNav &&
        Math.hypot(tipRes.x - tipNav.x, tipRes.y - tipNav.y) < 42;

      if (tipRes) {
        this.drawArrow2D(
          ctx,
          sat.x,
          sat.y,
          tipRes.x,
          tipRes.y,
          COL_RES,
          1.9,
          0.9,
          `v_res ${resM.toFixed(2)}`,
          close2D ? 11 : 0,
        );
      }
      if (tipNav) {
        this.drawArrow2D(
          ctx,
          sat.x,
          sat.y,
          tipNav.x,
          tipNav.y,
          COL_NAV,
          2.1,
          0.95,
          `v_nav ${navM.toFixed(2)}`,
          close2D ? -8 : 0,
        );
      }
      this.drawSatelliteReticle(ctx, { x: sat.x, y: sat.y, front: true }, -16);
    }

    ctx.restore();
  }

  private drawCurve3D(
    ctx: CanvasRenderingContext2D,
    points: Vec3[],
    basis: CameraBasis,
    cx: number,
    cy: number,
    radius: number,
    frontPass: boolean,
    color: string,
    lineWidth: number,
    dash?: number[],
  ): void {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    if (dash) ctx.setLineDash(dash);

    ctx.beginPath();
    let drawing = false;
    for (const pt of points) {
      const p = project3D(pt, basis, cx, cy, radius);
      const match = frontPass ? p.z >= -0.01 : p.z < 0.01;
      if (!match) {
        drawing = false;
        continue;
      }
      if (!drawing) {
        ctx.moveTo(p.x, p.y);
        drawing = true;
      } else {
        ctx.lineTo(p.x, p.y);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawArrow2D(
    ctx: CanvasRenderingContext2D,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: string,
    width: number,
    alpha: number,
    label?: string,
    labelOffsetY = 0,
  ): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 3) return;

    const ang = Math.atan2(dy, dx);
    const headLen = Math.min(9, Math.max(6, len * 0.22));

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;

    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(
      x1 - headLen * Math.cos(ang - 0.42),
      y1 - headLen * Math.sin(ang - 0.42),
    );
    ctx.lineTo(
      x1 - headLen * Math.cos(ang + 0.42),
      y1 - headLen * Math.sin(ang + 0.42),
    );
    ctx.closePath();
    ctx.fill();

    if (label) {
      const sideBias = Math.abs(Math.cos(ang)) < 0.35 ? 8 : 0;
      const lx = x1 + 7 * Math.cos(ang) + sideBias;
      const ly = y1 + 6 * Math.sin(ang) + (sideBias ? 1 : 3) + labelOffsetY;
      this.drawTextHalo(
        ctx,
        label,
        lx,
        ly,
        color,
        FONT_MONO,
        Math.cos(ang) < -0.35 ? "right" : "left",
      );
    }
    ctx.restore();
  }

  private drawLeaderCallout(
    ctx: CanvasRenderingContext2D,
    anchorX: number,
    anchorY: number,
    dx: number,
    dy: number,
    title: string,
    subtitle: string | null,
    accent: string,
  ): void {
    ctx.save();
    ctx.font = FONT_LABEL;
    const fullText = subtitle ? `${title} · ${subtitle}` : title;
    const textW = ctx.measureText(fullText).width;

    // Flip to left side if close to right viewport edge
    const flipLeft = anchorX + dx + 10 + textW > this.width - 14;
    const effDx = flipLeft ? -Math.abs(dx) : dx;
    const signX = effDx >= 0 ? 1 : -1;
    const signY = dy >= 0 ? 1 : -1;

    const startX = anchorX + signX * 7;
    const startY = anchorY + signY * 5;
    const elbowX = anchorX + effDx;
    const elbowY = Math.max(16, Math.min(this.height - 16, anchorY + dy));
    const shelfEnd = elbowX + signX * 7;

    ctx.strokeStyle = "rgba(255, 255, 255, 0.24)";
    ctx.lineWidth = 0.85;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(elbowX, elbowY);
    ctx.lineTo(shelfEnd, elbowY);
    ctx.stroke();

    const textX = shelfEnd + signX * 4;
    const textY = elbowY + 3.5;

    if (!subtitle) {
      this.drawTextHalo(
        ctx,
        title,
        textX,
        textY,
        accent,
        FONT_LABEL,
        flipLeft ? "right" : "left",
      );
    } else if (!flipLeft) {
      this.drawTextHalo(ctx, title, textX, textY, accent, FONT_LABEL, "left");
      const titleW = ctx.measureText(title).width;
      this.drawTextHalo(
        ctx,
        ` · ${subtitle}`,
        textX + titleW,
        textY,
        COL_SUB,
        FONT_LABEL,
        "left",
      );
    } else {
      const subStr = ` · ${subtitle}`;
      const subW = ctx.measureText(subStr).width;
      this.drawTextHalo(ctx, subStr, textX, textY, COL_SUB, FONT_LABEL, "right");
      this.drawTextHalo(
        ctx,
        title,
        textX - subW,
        textY,
        accent,
        FONT_LABEL,
        "right",
      );
    }
    ctx.restore();
  }

  private drawTextHalo(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    fill: string,
    font: string,
    align: CanvasTextAlign = "left",
  ): void {
    ctx.save();
    ctx.font = font;
    ctx.textAlign = align;
    ctx.lineJoin = "round";
    ctx.lineWidth = 3.2;
    ctx.strokeStyle = COL_HALO;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
    ctx.restore();
  }
}
