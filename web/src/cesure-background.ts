/**
 * Canvas background ported from Solus-QE/cesure, js/main.js:
 * makeNoise() and initParticleField(), commit fc8c8b638fd9fc1dcf2f59c981aa3c76258389a5.
 * The seeded noise, de Jong coefficients, clustered wisps and paper wash are
 * Cesure's original algorithms. Scroll input is replaced by a decorative phase
 * value. Drawing density, cadence and palette are reduced for this instrument.
 */
const TAU = Math.PI * 2;

export function makeNoise(seed: number) {
  const perm = new Uint8Array(512);
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0;
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const fade = (t: number) => t * t * (3 - 2 * t);
  const grad = (h: number, x: number, y: number, z: number) => {
    switch (h & 7) {
      case 0:
        return x + y;
      case 1:
        return -x + y;
      case 2:
        return x - y;
      case 3:
        return -x - y;
      case 4:
        return x + z;
      case 5:
        return -x + z;
      case 6:
        return y - z;
      default:
        return -y - z;
    }
  };
  const lerp = (t: number, a: number, b: number) => a + t * (b - a);
  return (x: number, y: number, z: number) => {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const Z = Math.floor(z) & 255;
    x -= Math.floor(x);
    y -= Math.floor(y);
    z -= Math.floor(z);
    const u = fade(x),
      v = fade(y),
      w = fade(z);
    const A = perm[X] + Y,
      AA = perm[A] + Z,
      AB = perm[A + 1] + Z;
    const B = perm[X + 1] + Y,
      BA = perm[B] + Z,
      BB = perm[B + 1] + Z;
    return lerp(
      w,
      lerp(
        v,
        lerp(u, grad(perm[AA], x, y, z), grad(perm[BA], x - 1, y, z)),
        lerp(u, grad(perm[AB], x, y - 1, z), grad(perm[BB], x - 1, y - 1, z)),
      ),
      lerp(
        v,
        lerp(
          u,
          grad(perm[AA + 1], x, y, z - 1),
          grad(perm[BA + 1], x - 1, y, z - 1),
        ),
        lerp(
          u,
          grad(perm[AB + 1], x, y - 1, z - 1),
          grad(perm[BB + 1], x - 1, y - 1, z - 1),
        ),
      ),
    );
  };
}

export type BackgroundPhase = "idle" | "stalled" | "recovering" | "completed";
interface Wisp {
  x: number;
  y: number;
  px: number;
  py: number;
  life: number;
}
interface BackgroundOptions {
  paper?: string;
  ink?: readonly [number, number, number];
  intensity?: number;
}
const PHASE_PROGRESS: Record<BackgroundPhase, number> = {
  idle: 0.12,
  stalled: 0.2,
  recovering: 0.32,
  completed: 0.45,
};

export class CesureBackground {
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly motion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  );
  private readonly noise = makeNoise(20260703);
  private readonly paper: string;
  private readonly ink: string;
  private readonly intensity: number;
  private readonly particles: Wisp[] = [];
  private observer?: ResizeObserver;
  private w = 0;
  private h = 0;
  private t = 0;
  private ax = 0.1;
  private ay = 0.1;
  private smooth = PHASE_PROGRESS.idle;
  private target = PHASE_PROGRESS.idle;
  private raf = 0;
  private lastDraw = 0;
  private disposed = false;
  private pagePaused = false;
  private dirty = true;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    options: BackgroundOptions = {},
  ) {
    this.ctx = canvas.getContext("2d", { alpha: true });
    this.paper = options.paper ?? "#0d0e0c";
    this.ink = (options.ink ?? [178, 172, 158]).join(",");
    this.intensity = Math.max(0.05, Math.min(0.6, options.intensity ?? 0.38));
    canvas.style.backgroundColor = this.paper;
    if (!this.ctx) {
      canvas.dataset.motion = "unavailable";
      return;
    }
    canvas.setAttribute("aria-hidden", "true");
    this.motion.addEventListener("change", this.onMotionChange);
    document.addEventListener("visibilitychange", this.syncMotion);
    window.addEventListener("pagehide", this.onPageHide);
    window.addEventListener("pageshow", this.onPageShow);
    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(canvas.parentElement ?? canvas);
    this.resize();
  }

  setPhase(phase: BackgroundPhase): void {
    // Decorative input only. Never changes, infers or commits mission state.
    this.target = PHASE_PROGRESS[phase];
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop("disposed");
    this.observer?.disconnect();
    this.motion.removeEventListener("change", this.onMotionChange);
    document.removeEventListener("visibilitychange", this.syncMotion);
    window.removeEventListener("pagehide", this.onPageHide);
    window.removeEventListener("pageshow", this.onPageShow);
  }

  private readonly onPageHide = (event: PageTransitionEvent) => {
    if (!event.persisted) {
      this.destroy();
      return;
    }
    this.pagePaused = true;
    this.stop("paused");
  };
  private readonly onPageShow = () => {
    this.pagePaused = false;
    this.syncMotion();
  };
  private readonly onMotionChange = () => {
    this.dirty = true;
    this.syncMotion();
  };

  private stop(status: string): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.lastDraw = 0;
    this.canvas.dataset.motion = status;
  }

  private readonly syncMotion = () => {
    if (this.disposed || !this.ctx) return;
    if (document.hidden || this.pagePaused) {
      this.stop("paused");
      return;
    }
    if (this.motion.matches) {
      this.stop("static");
      if (this.dirty) this.drawStatic();
      return;
    }
    this.canvas.dataset.motion = "running";
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  };

  private readonly resize = () => {
    if (this.disposed || !this.ctx) return;
    const rect = (
      this.canvas.parentElement ?? this.canvas
    ).getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    const dpr = Math.min(
      window.devicePixelRatio || 1,
      1.25,
      1600 / Math.max(w, h),
    );
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, w, h);
    this.ax = 0.1;
    this.ay = 0.1;
    this.particles.length = 0;
    const count = Math.min(
      w < 720 ? 96 : 180,
      Math.round(420 * this.intensity),
    );
    for (let i = 0; i < count; i++) {
      const p: Wisp = { x: 0, y: 0, px: 0, py: 0, life: 0 };
      this.spawn(p);
      p.life *= Math.random();
      this.particles.push(p);
    }
    this.dirty = true;
    this.syncMotion();
  };

  private spawn(p: Wisp): void {
    const { w, h, t, noise } = this;
    const cluster = Math.random();
    if (cluster < 0.8) {
      const which = (cluster * 3) | 0;
      const a = noise(t * 0.03 + which * 4.7, which * 7.3, 1.5) * TAU * 2;
      const cx = w * (0.5 + 0.44 * Math.sin(a + t * 0.005 + which * 2.1));
      const cy = h * (0.5 + 0.44 * Math.cos(a * 0.7 - t * 0.004 + which * 1.3));
      p.x = cx + (Math.random() - 0.5) * w * 0.16;
      p.y = cy + (Math.random() - 0.5) * h * 0.16;
    } else {
      p.x = Math.random() * w;
      p.y = Math.random() * h;
    }
    p.px = p.x;
    p.py = p.y;
    p.life = 60 + Math.random() * 200;
  }

  private drawStatic(): void {
    const ctx = this.ctx!;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = `rgba(${this.ink},0.028)`;
    const scale = Math.min(this.w, this.h) * 0.3;
    let ax = 0.1,
      ay = 0.1;
    for (let i = 0; i < 20000; i++) {
      const nx = Math.sin(1.7 * ay) - Math.cos(2.1 * ax);
      const ny = Math.sin(-1.2 * ax) - Math.cos(1.9 * ay);
      ax = nx;
      ay = ny;
      if (i > 20)
        ctx.fillRect(
          this.w * 0.55 + nx * scale * 0.5,
          this.h * 0.45 + ny * scale * 0.5,
          0.7,
          0.7,
        );
    }
    this.dirty = false;
  }

  private readonly frame = (now: number) => {
    this.raf = 0;
    if (
      this.disposed ||
      document.hidden ||
      this.pagePaused ||
      this.motion.matches
    ) {
      this.syncMotion();
      return;
    }
    if (this.lastDraw && now - this.lastDraw < 1000 / 24) {
      this.raf = requestAnimationFrame(this.frame);
      return;
    }
    this.lastDraw = now;
    this.t += 0.65;
    this.smooth += (this.target - this.smooth) * 0.04;
    const { w, h, t, ctx, intensity } = this;
    if (!ctx) return;
    const p = this.smooth;
    const drift = t * 0.0004;

    // Fade back to CSS paper. A dark source-over wash quantizes toward black.
    ctx.globalCompositeOperation = "destination-out";
    ctx.globalAlpha = 0.016;
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    const A = 1.55 + 1.15 * Math.sin(p * 2.9 + drift + 0.4);
    const B = -1.8 + 0.9 * Math.cos(p * 2.2 - drift * 0.7 + 1.7);
    const C = 1.25 + 0.95 * Math.sin(p * 3.6 + drift * 1.3 + 3.1);
    const D = -1.35 + 0.85 * Math.cos(p * 2.6 + drift + 5.2);
    // Frame the original attractor beside the opaque sphere, rather than behind it.
    const cx = w * (0.62 - 0.24 * Math.sin(p * 2.4 + 0.8) - 0.18);
    const cy = h * (0.44 + 0.18 * Math.cos(p * 3.0 + 1.9));
    const scale = Math.min(w, h) * (0.26 + p * 0.16);
    const iters = Math.min(1600, Math.round((1400 + p * 3200) * intensity));
    ctx.fillStyle = `rgba(${this.ink},0.035)`;
    for (let i = 0; i < iters; i++) {
      const nx = Math.sin(A * this.ay) - Math.cos(B * this.ax);
      const ny = Math.sin(C * this.ax) - Math.cos(D * this.ay);
      this.ax = nx;
      this.ay = ny;
      ctx.fillRect(cx + nx * scale * 0.5, cy + ny * scale * 0.5, 0.65, 0.65);
    }

    const wispAlpha = 0.04 * (1 - p * 0.55);
    const fieldScale = 0.0011 - p * 0.0006;
    const step = (1.4 + p * 2.2) * intensity;
    const zDrift = t * 0.0009 + p * 3.1;
    ctx.strokeStyle = `rgba(${this.ink},${wispAlpha})`;
    ctx.lineWidth = 0.55;
    ctx.beginPath();
    for (const q of this.particles) {
      const n = this.noise(q.x * fieldScale, q.y * fieldScale, zDrift);
      const a = n * TAU * 1.9;
      q.px = q.x;
      q.py = q.y;
      q.x += Math.cos(a) * step;
      q.y += Math.sin(a) * step + p * 0.15;
      q.life -= 1;
      if (
        q.life <= 0 ||
        q.x < -20 ||
        q.x > w + 20 ||
        q.y < -20 ||
        q.y > h + 20
      ) {
        this.spawn(q);
        continue;
      }
      ctx.moveTo(q.px, q.py);
      ctx.lineTo(q.x, q.y);
    }
    ctx.stroke();
    this.dirty = false;
    this.raf = requestAnimationFrame(this.frame);
  };
}
