import type {
  ApiError,
  HealthResponse,
  MissionEvent,
  MissionState,
  Vec3,
} from "../../shared/contract";
import {
  CounterwhorlApiClient,
  CounterwhorlApiError,
  type PeerLedgerEntry,
} from "./api";
import {
  ESCAPE_NORM,
  formatVec3,
  navigatorField,
  norm,
  perpendicular,
  rescuerField,
  scale,
  sphericalDegToVec3,
  unit,
  vec3ToSphericalDeg,
} from "./sphere-math";
import {
  SphereVisualizer,
  type CameraPreset,
  type ProjectionMode,
} from "./sphere-view";
import {
  deriveTelemetry,
  type ProtocolTimelineEntry,
  type RecoveryChecklistStep,
  type TelemetrySnapshot,
} from "./telemetry";

const STORAGE_RUN_KEY = "counterwhorl.activeRunId";
const RECOVERY_WATCH_TIMEOUT_MS = 35_000;

interface ScenarioPreset {
  position: Vec3;
  goal: Vec3;
}

const PRESETS: Record<string, ScenarioPreset> = {
  default: { position: [1, 0, 0], goal: [0, 0, 1] },
  north: { position: [0, 0, -1], goal: [0, 1, 0] },
  oblique: {
    position: [-1, 0, 0],
    goal: unit([1, 1, 1]),
  },
  dusk: { position: [1, 0, 0], goal: [0, -1, 0] },
  antipode_start: { position: [0, 0, -1], goal: [0, 0, 1] },
};

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing DOM element #${id}`);
  return node as T;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function shortId(id: string, max = 14): string {
  if (id.length <= max) return id;
  return `${id.slice(0, 7)}…${id.slice(-4)}`;
}

function fmtClockCompact(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 11);
  return d.toISOString().slice(11, 22);
}

class CounterwhorlApp {
  private api = new CounterwhorlApiClient();
  private sphere: SphereVisualizer;

  private generation = 0;
  private booting = true;
  private busyAction = false;

  private health: HealthResponse | null = null;
  private activeRunId: string | null = null;
  private mission: MissionState | null = null;
  private events: MissionEvent[] = [];
  private eventCursor = 0;
  private peerLedger: PeerLedgerEntry[] = [];

  private stagedPosition: Vec3 = [1, 0, 0];
  private stagedGoal: Vec3 = [0, 0, 1];
  private drawerOpen = false;

  private lastError: ApiError | null = null;
  private alertDismissedForMessage: string | null = null;

  private recoveryWatchArmedAt: number | null = null;
  private recoveryWatchStartRevision = 0;
  private recoveryWatchFailedReason: string | null = null;

  private prevRenderedRevision = -1;
  private lastChecklistHtml = "";
  private lastTimelineHtml = "";
  private lastSparklineSnap: TelemetrySnapshot | null = null;
  private pollTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    const sphereCanvas = el<HTMLCanvasElement>("sphere-canvas");
    this.sphere = new SphereVisualizer(sphereCanvas);

    this.sphere.onPickDestination = (pickedGoal) => {
      this.setStagedGoal(pickedGoal);
      this.clearPresetHighlight();
    };

    this.sphere.onCameraPresetChanged = (preset) => {
      this.syncCameraToolbarButtons(preset);
    };

    this.bindControls();
    this.restoreRunIdFromUrlOrSession();
    this.syncDestinationDrawerPreview();
    this.renderAll();
    void this.pollLoop();
  }

  private restoreRunIdFromUrlOrSession(): void {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("runId");
    const fromStorage = sessionStorage.getItem(STORAGE_RUN_KEY);
    const candidate = fromUrl || fromStorage;
    if (candidate && /^[a-zA-Z0-9_.-]{1,128}$/.test(candidate)) {
      this.activeRunId = candidate;
    }
  }

  private persistActiveRunId(runId: string | null): void {
    this.activeRunId = runId;
    const url = new URL(window.location.href);
    if (runId) {
      url.searchParams.set("runId", runId);
      sessionStorage.setItem(STORAGE_RUN_KEY, runId);
    } else {
      url.searchParams.delete("runId");
      sessionStorage.removeItem(STORAGE_RUN_KEY);
    }
    window.history.replaceState({}, "", url.toString());
  }

  private bindControls(): void {
    // Secondary action: Start Mission
    el<HTMLButtonElement>("btn-start").addEventListener("click", () => {
      void this.handleStartMission();
    });

    // Secondary action: Change Target popover
    el<HTMLButtonElement>("btn-destination").addEventListener("click", () => {
      this.toggleDestinationDrawer(!this.drawerOpen);
    });
    el<HTMLButtonElement>("btn-close-drawer").addEventListener("click", () => {
      this.toggleDestinationDrawer(false);
    });
    el<HTMLButtonElement>("btn-apply-destination").addEventListener(
      "click",
      () => {
        void this.handleApplyDestination();
      },
    );

    // Close target popover on Escape or outside click (except sphere picking)
    document.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape" && this.drawerOpen) {
        this.toggleDestinationDrawer(false);
      }
    });
    document.addEventListener("pointerdown", (e: PointerEvent) => {
      if (!this.drawerOpen) return;
      const target = e.target as Node | null;
      if (!target) return;
      const anchor = document.querySelector(".popover-anchor");
      const canvas = document.getElementById("sphere-canvas");
      if (anchor?.contains(target) || canvas === target) return;
      this.toggleDestinationDrawer(false);
    });

    // Secondary action: Reset
    el<HTMLButtonElement>("btn-reset").addEventListener("click", () => {
      void this.handleResetExperiment();
    });

    // Primary action: Break Navigator
    el<HTMLButtonElement>("btn-break").addEventListener("click", () => {
      void this.handleBreakNavigator();
    });

    // Copy Run ID inside Technical Inspection
    el<HTMLButtonElement>("meta-run-btn").addEventListener("click", () => {
      if (!this.mission?.runId) return;
      void navigator.clipboard?.writeText(this.mission.runId);
      const label = el("meta-run-id");
      const prev = label.textContent;
      label.textContent = "Copied";
      setTimeout(() => {
        if (label.textContent === "Copied") {
          label.textContent = prev;
        }
      }, 900);
    });

    // Copy Relay Message ID chip inside Live Protocol Timeline
    el("protocol-timeline-list").addEventListener("click", (e: MouseEvent) => {
      const target = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>(
        ".relay-chip",
      );
      if (!target) return;
      const fullId = target.dataset.relayId;
      if (!fullId) return;
      void navigator.clipboard?.writeText(fullId);
      const prev = target.textContent;
      target.textContent = "Copied ID";
      setTimeout(() => {
        if (target.isConnected && target.textContent === "Copied ID") {
          target.textContent = prev;
        }
      }, 850);
    });

    // Redraw sparkline cleanly when collapsible Technical Inspection opens
    el<HTMLDetailsElement>("tech-inspection").addEventListener("toggle", () => {
      if (el<HTMLDetailsElement>("tech-inspection").open && this.lastSparklineSnap) {
        requestAnimationFrame(() => {
          if (this.lastSparklineSnap) {
            this.drawSparkline(this.lastSparklineSnap);
          }
        });
      }
    });

    // Dismiss error strip
    el<HTMLButtonElement>("btn-dismiss-alert").addEventListener("click", () => {
      const currentMsg = el("alert-message").textContent ?? "";
      this.alertDismissedForMessage = currentMsg;
      el("alert-banner").hidden = true;
    });

    // Destination preset chips
    document
      .querySelectorAll<HTMLButtonElement>(".preset-chip")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const key = btn.dataset.preset ?? "default";
          const preset = PRESETS[key];
          if (!preset) return;
          document
            .querySelectorAll(".preset-chip")
            .forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          if (!this.mission) {
            this.stagedPosition = preset.position;
          }
          this.setStagedGoal(preset.goal);
        });
      });

    // Azimuth & Elevation sliders
    const azInput = el<HTMLInputElement>("dest-az");
    const elInput = el<HTMLInputElement>("dest-el");
    const onSlider = () => {
      this.clearPresetHighlight();
      const az = Number(azInput.value);
      const elev = Number(elInput.value);
      this.stagedGoal = sphericalDegToVec3(az, elev);
      this.syncDestinationDrawerPreview(false);
      this.renderAll();
    };
    azInput.addEventListener("input", onSlider);
    elInput.addEventListener("input", onSlider);

    // Projection & Camera controls
    document
      .querySelectorAll<HTMLButtonElement>("[data-proj]")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const mode = (btn.dataset.proj as ProjectionMode) || "3d";
          document
            .querySelectorAll("[data-proj]")
            .forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          this.sphere.setProjectionMode(mode);
        });
      });

    document
      .querySelectorAll<HTMLButtonElement>("[data-cam]")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const preset = (btn.dataset.cam as CameraPreset) || "orbit";
          this.syncCameraToolbarButtons(preset);
          this.sphere.setCameraPreset(preset);
        });
      });

    el<HTMLButtonElement>("btn-field-mode").addEventListener("click", () => {
      const mode = this.sphere.cycleFieldMode();
      const labels: Record<typeof mode, string> = {
        nav: "Field: Nav",
        res: "Field: Res",
        both: "Field: Both",
        off: "Field: Off",
      };
      el("btn-field-mode").textContent = labels[mode];
    });
  }

  private syncCameraToolbarButtons(preset: CameraPreset): void {
    document.querySelectorAll<HTMLButtonElement>("[data-cam]").forEach((b) => {
      b.classList.toggle("active", b.dataset.cam === preset);
    });
  }

  private clearPresetHighlight(): void {
    document
      .querySelectorAll(".preset-chip")
      .forEach((b) => b.classList.remove("active"));
  }

  private setStagedGoal(goal: Vec3): void {
    this.stagedGoal = unit(goal);
    this.syncDestinationDrawerPreview(true);
    this.renderAll();
  }

  private syncDestinationDrawerPreview(syncSliders = true): void {
    const rescue = perpendicular(this.stagedGoal);
    const antipode = scale(this.stagedGoal, -1);

    el("preview-goal").textContent = formatVec3(this.stagedGoal, 3);
    el("preview-antipode").textContent = formatVec3(antipode, 3);
    el("preview-rescue").textContent = formatVec3(rescue, 3);

    const deg = vec3ToSphericalDeg(this.stagedGoal);
    el("dest-az-out").textContent = `${deg.azimuthDeg >= 0 ? "+" : ""}${deg.azimuthDeg}°`;
    el("dest-el-out").textContent = `${deg.elevationDeg >= 0 ? "+" : ""}${deg.elevationDeg}°`;

    if (syncSliders) {
      el<HTMLInputElement>("dest-az").value = String(deg.azimuthDeg);
      el<HTMLInputElement>("dest-el").value = String(deg.elevationDeg);
    }

    el("btn-apply-destination").textContent = this.mission
      ? "Retarget active mission"
      : "Set target +g";
  }

  private toggleDestinationDrawer(open: boolean): void {
    this.drawerOpen = open;
    el("destination-drawer").hidden = !open;
    el("picking-banner").hidden = !open;
    el("btn-destination").setAttribute("aria-expanded", String(open));
    this.sphere.setPickingEnabled(open);
    this.syncDestinationDrawerPreview(true);
    this.renderAll();
  }

  private mergeEvents(incoming: MissionEvent[]): void {
    if (incoming.length === 0) return;
    const byRev = new Map<number, MissionEvent>();
    for (const e of this.events) byRev.set(e.revision, e);
    for (const e of incoming) byRev.set(e.revision, e);
    this.events = [...byRev.values()].sort((a, b) => a.revision - b.revision);
    this.eventCursor = this.events.at(-1)?.revision ?? this.eventCursor;
  }

  private adoptNewMission(state: MissionState): void {
    this.persistActiveRunId(state.runId);
    this.mission = state;
    this.events = [...state.events].sort((a, b) => a.revision - b.revision);
    this.eventCursor = state.revision;
    this.peerLedger = [];
    this.lastError = null;
    this.alertDismissedForMessage = null;
    this.recoveryWatchArmedAt = null;
    this.recoveryWatchFailedReason = null;
    this.stagedGoal = state.goal;
    this.syncDestinationDrawerPreview(true);
  }

  private async handleStartMission(): Promise<void> {
    if (this.busyAction) return;
    this.busyAction = true;
    const gen = ++this.generation;
    this.renderAll();
    try {
      const state = await this.api.startMission({
        position: this.stagedPosition,
        goal: this.stagedGoal,
      });
      if (gen !== this.generation) return;
      this.adoptNewMission(state);
      if (this.drawerOpen) this.toggleDestinationDrawer(false);
    } catch (error) {
      if (gen !== this.generation) return;
      this.captureError(error);
    } finally {
      this.busyAction = false;
      this.renderAll();
    }
  }

  private async handleApplyDestination(): Promise<void> {
    if (!this.mission) {
      this.toggleDestinationDrawer(false);
      return;
    }
    if (this.busyAction) return;
    this.busyAction = true;
    const gen = ++this.generation;
    this.renderAll();
    try {
      const state = await this.api.startMission({
        position: this.mission.position,
        goal: this.stagedGoal,
      });
      if (gen !== this.generation) return;
      this.adoptNewMission(state);
      this.toggleDestinationDrawer(false);
    } catch (error) {
      if (gen !== this.generation) return;
      this.captureError(error);
    } finally {
      this.busyAction = false;
      this.renderAll();
    }
  }

  private async handleBreakNavigator(): Promise<void> {
    if (this.busyAction) return;
    this.busyAction = true;
    const gen = ++this.generation;
    if (this.drawerOpen) this.toggleDestinationDrawer(false);
    this.renderAll();
    try {
      const health = await this.api.getHealth();
      if (gen !== this.generation) return;
      this.health = health;

      let targetRunId = this.mission?.runId ?? null;
      if (!this.mission || this.mission.phase === "completed") {
        const started = await this.api.startMission({
          position: this.stagedPosition,
          goal: this.stagedGoal,
        });
        if (gen !== this.generation) return;
        this.adoptNewMission(started);
        targetRunId = started.runId;
      }
      if (!targetRunId) return;

      const challenged = await this.api.forceChallenge(targetRunId);
      if (gen !== this.generation) return;
      this.mission = challenged;
      this.mergeEvents(challenged.events);
      this.lastError = null;
      this.alertDismissedForMessage = null;
      this.recoveryWatchFailedReason = null;

      if (health.relay) {
        this.recoveryWatchArmedAt = Date.now();
        this.recoveryWatchStartRevision = challenged.revision;
      } else {
        this.recoveryWatchArmedAt = null;
      }
    } catch (error) {
      if (gen !== this.generation) return;
      this.captureError(error);
    } finally {
      this.busyAction = false;
      this.renderAll();
    }
  }

  private async handleResetExperiment(): Promise<void> {
    this.generation++;
    this.persistActiveRunId(null);
    this.mission = null;
    this.events = [];
    this.eventCursor = 0;
    this.peerLedger = [];
    this.lastError = null;
    this.alertDismissedForMessage = null;
    this.recoveryWatchArmedAt = null;
    this.recoveryWatchFailedReason = null;
    this.prevRenderedRevision = -1;
    this.stagedPosition = [1, 0, 0];
    this.stagedGoal = [0, 0, 1];
    document
      .querySelectorAll(".preset-chip")
      .forEach((b) =>
        b.classList.toggle(
          "active",
          (b as HTMLElement).dataset.preset === "default",
        ),
      );
    if (this.drawerOpen) this.toggleDestinationDrawer(false);
    this.sphere.setCameraPreset("orbit");
    this.syncCameraToolbarButtons("orbit");
    this.syncDestinationDrawerPreview(true);
    this.renderAll();
    await this.pollOnce();
  }

  private captureError(error: unknown): void {
    if (error instanceof CounterwhorlApiError) {
      this.lastError = { code: error.code, message: error.message };
    } else {
      this.lastError = {
        code: "UNAVAILABLE",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    this.alertDismissedForMessage = null;
  }

  private async pollLoop(): Promise<void> {
    await this.pollOnce();
    const fast =
      this.mission &&
      (this.mission.phase !== "completed" || this.recoveryWatchArmedAt !== null);
    const delay = fast ? 380 : 1400;
    this.pollTimer = setTimeout(() => void this.pollLoop(), delay);
  }

  private async pollOnce(): Promise<void> {
    const gen = this.generation;
    try {
      const health = await this.api.getHealth();
      if (gen !== this.generation) return;
      this.health = health;
      this.booting = false;
      if (this.lastError?.code === "UNAVAILABLE" && health.terse) {
        this.lastError = null;
      }
    } catch (error) {
      if (gen !== this.generation) return;
      this.booting = false;
      this.health = {
        terse: false,
        relay: false,
        relayError: "API unreachable",
      };
      this.captureError(error);
      this.renderAll();
      return;
    }

    if (this.activeRunId) {
      try {
        const [snapshot, delta, ledger] = await Promise.all([
          this.api.getMission(this.activeRunId),
          this.api.getEvents(this.activeRunId, this.eventCursor),
          this.api.getPeerLedger(this.activeRunId),
        ]);
        if (gen !== this.generation) return;
        this.mission = snapshot;
        if (this.events.length === 0) {
          this.mergeEvents(snapshot.events);
        }
        this.mergeEvents(delta.events);
        this.peerLedger = ledger;

        if (this.recoveryWatchArmedAt !== null) {
          const hasReturned = this.events.some(
            (e) =>
              e.type === "control_returned" &&
              e.revision > this.recoveryWatchStartRevision,
          );
          if (hasReturned || snapshot.phase === "completed") {
            this.recoveryWatchArmedAt = null;
            this.recoveryWatchFailedReason = null;
          } else if (!this.health?.relay) {
            this.recoveryWatchFailedReason = `RELAY_UNAVAILABLE: Agent Relay disconnected during recovery (${this.health?.relayError ?? "transport lost"}).`;
            this.recoveryWatchArmedAt = null;
          } else if (
            Date.now() - this.recoveryWatchArmedAt > RECOVERY_WATCH_TIMEOUT_MS &&
            snapshot.revision === this.recoveryWatchStartRevision
          ) {
            this.recoveryWatchFailedReason =
              "AGENT_TIMEOUT: No autonomous @navigator / @rescuer handoff received over Agent Relay within 35s. Ensure agent worker processes are running.";
            this.recoveryWatchArmedAt = null;
          }
        }
      } catch (error) {
        if (gen !== this.generation) return;
        if (
          error instanceof CounterwhorlApiError &&
          error.code === "NOT_FOUND"
        ) {
          this.persistActiveRunId(null);
          this.mission = null;
          this.events = [];
          this.eventCursor = 0;
        } else {
          this.captureError(error);
        }
      }
    }

    this.renderAll();
  }

  private renderAll(): void {
    const snap = deriveTelemetry({
      booting: this.booting,
      health: this.health,
      mission: this.mission,
      events: this.events,
      peerLedger: this.peerLedger,
      stagedPosition: this.stagedPosition,
      stagedGoal: this.stagedGoal,
      lastError: this.lastError,
      recoveryWatchFailedReason: this.recoveryWatchFailedReason,
    });
    this.lastSparklineSnap = snap;

    document.body.dataset.lifecycle = snap.lifecycle;

    // 1. Header status & subsystem health links
    const badge = el("lifecycle-badge");
    badge.className = `status-indicator state-${snap.lifecycle}`;
    el("lifecycle-label").textContent = snap.lifecycleLabel;
    el("lifecycle-detail").textContent = snap.lifecycleDetail;

    this.renderHealthLink(
      "health-terse",
      "health-terse-val",
      this.health?.terse,
      "online",
      "offline",
    );
    this.renderHealthLink(
      "health-relay",
      "health-relay-val",
      this.health?.relay,
      "connected",
      "offline",
      this.health?.relayError,
    );

    // Header button states
    el<HTMLButtonElement>("btn-start").disabled = this.busyAction;
    el<HTMLButtonElement>("btn-destination").disabled = this.busyAction;
    el<HTMLButtonElement>("btn-reset").disabled = this.busyAction;
    el<HTMLButtonElement>("btn-break").disabled = this.busyAction;

    // Slim diagnostic strip
    this.renderAlertBanner();

    // 2. 7-stage Recovery State Checklist
    this.renderRecoveryChecklist(snap.recoverySteps, snap);

    // 3. Autonomous Agents Summary & Technical Inspection
    this.renderAgentsAndTechnical(snap);

    // 4. Globe HUD & 3D Attitude Visualizer
    this.renderSphereHud(snap);
    const handoffPoints = this.events
      .filter((e) => e.type === "control_returned")
      .map((e) => ({ revision: e.revision, position: e.position }));

    this.sphere.setState({
      lifecycle: snap.lifecycle,
      activePilot: this.mission?.activePilot ?? "navigator",
      hasActiveMission: Boolean(this.mission),
      position: snap.position,
      goal: snap.goal,
      rescueAxis: snap.rescueAxis,
      stagedGoal: this.drawerOpen ? this.stagedGoal : null,
      trajectory: this.mission?.trajectory ?? [
        {
          revision: 0,
          position: snap.position,
          pilot: "coordinator",
          kind: "start",
        },
      ],
      handoffPoints,
      isStalled: snap.isStalled,
      isEscaped: snap.isEscaped,
    });

    // 5. Prominent Live Protocol Timeline
    this.renderProtocolTimeline(snap.protocolTimeline, snap);
  }

  private renderHealthLink(
    chipId: string,
    valId: string,
    ok: boolean | undefined,
    okText: string,
    badText: string,
    errorTooltip?: string,
  ): void {
    const chip = el(chipId);
    const val = el(valId);
    if (ok === undefined) {
      chip.className = "link-item link-unknown";
      val.textContent = "sync";
      return;
    }
    chip.className = `link-item ${ok ? "health-ok" : "health-bad"}`;
    val.textContent = ok ? okText : badText;
    if (errorTooltip && !ok) {
      chip.title = errorTooltip;
    }
  }

  private renderAlertBanner(): void {
    const banner = el("alert-banner");
    let code = "";
    let msg = "";

    if (this.recoveryWatchFailedReason) {
      const idx = this.recoveryWatchFailedReason.indexOf(":");
      code =
        idx > 0
          ? this.recoveryWatchFailedReason.slice(0, idx)
          : "RECOVERY_FAILED";
      msg =
        idx > 0
          ? this.recoveryWatchFailedReason.slice(idx + 1).trim()
          : this.recoveryWatchFailedReason;
    } else if (this.lastError) {
      code = this.lastError.code;
      msg = this.lastError.message;
    } else if (this.health && !this.health.relay && this.mission) {
      code = "RELAY_OFFLINE";
      msg = `${this.health.relayError ?? "Agent Relay disconnected"} — Terse HTTP challenge succeeded, but autonomous @navigator / @rescuer handoff requires Agent Relay.`;
    }

    if (!msg || this.alertDismissedForMessage === msg) {
      banner.hidden = true;
      return;
    }
    el("alert-code").textContent = code;
    el("alert-message").textContent = msg;
    banner.hidden = false;
  }

  private renderRecoveryChecklist(
    steps: RecoveryChecklistStep[],
    snap: TelemetrySnapshot,
  ): void {
    const gatePill = el("recovery-gate-pill");
    gatePill.textContent = snap.handoffGateLabel;
    gatePill.className = `state-tag mono ${
      snap.handoffStage === "confirmed"
        ? "tag-green"
        : snap.handoffStage === "escaping" || snap.handoffStage === "granted"
          ? "tag-violet"
          : snap.handoffStage === "stalled" || snap.handoffStage === "requested"
            ? "tag-red"
            : "tag-neutral"
    }`;

    const gateNote = el("terse-gate-note");
    gateNote.textContent = snap.handoffGateNote;
    gateNote.className = `handoff-caption ${
      snap.handoffStage === "confirmed"
        ? "gate-confirmed"
        : snap.outcomes.awaitingTerseReturnConfirmation
          ? "gate-awaiting"
          : ""
    }`;

    const html = steps
      .map((step, idx) => {
        const markerSymbol =
          step.status === "completed"
            ? "✓"
            : step.status === "alert"
              ? "!"
              : step.status === "skipped"
                ? "–"
                : String(idx + 1);
        const badgeHtml = step.badge
          ? `<span class="r-badge">${escapeHtml(step.badge)}</span>`
          : "";
        return `<li class="r-step is-${step.status}" data-step-id="${step.id}" title="${escapeHtml(`${step.title} — ${step.detail}`)}">
          <span class="r-marker" aria-hidden="true">${markerSymbol}</span>
          <div class="r-copy">
            <span class="r-title">${escapeHtml(step.title)}</span>
            <span class="r-detail">${escapeHtml(step.detail)}</span>
          </div>
          ${badgeHtml}
        </li>`;
      })
      .join("");

    if (this.lastChecklistHtml !== html) {
      this.lastChecklistHtml = html;
      el("recovery-checklist").innerHTML = html;
    }
  }

  private renderAgentsAndTechnical(snap: TelemetrySnapshot): void {
    const authEl = el("meta-authority");
    if (!this.mission) {
      authEl.textContent = "Standby";
      authEl.className = "state-tag tag-neutral";
    } else if (this.mission.activePilot === "rescuer") {
      authEl.textContent = "@rescuer authorized";
      authEl.className = "state-tag tag-violet";
    } else if (snap.isStalled) {
      authEl.textContent = "@navigator stalled";
      authEl.className = "state-tag tag-red";
    } else {
      authEl.textContent = "@navigator authorized";
      authEl.className = "state-tag tag-cyan";
    }

    // @navigator compact summary
    const navPill = el("nav-status-pill");
    navPill.textContent = snap.navigatorStatusPill;
    navPill.className = `state-tag ${
      snap.isStalled || snap.lifecycle === "stalled"
        ? "tag-red"
        : snap.lifecycle === "completed"
          ? "tag-green"
          : this.mission && this.mission.activePilot === "navigator"
            ? "tag-cyan"
            : "tag-neutral"
    }`;

    const deg = (snap.navGoalAngleRad * 180) / Math.PI;
    const gradPct = Math.round(snap.navNorm * 100);
    el("nav-summary").textContent = snap.isStalled
      ? "0% (blind spot −g)"
      : `${gradPct}% · ${deg.toFixed(1)}° to +g`;
    el("nav-summary").className = `pm-val mono ${
      snap.isStalled ? "text-red" : ""
    }`;

    const navBar = el("gauge-nav-bar");
    navBar.style.width = `${Math.max(snap.isStalled ? 2 : 0, Math.min(100, snap.navNorm * 100))}%`;
    navBar.className = `meter-fill ${snap.isStalled ? "fill-red" : "fill-cyan"}`;

    const stallBanner = el("nav-stall-banner");
    stallBanner.hidden = !snap.isStalled;
    el("nav-stall-text").textContent = snap.isStalled
      ? "Gradient vanishes at exact antipode (−g); autonomous handoff required."
      : "";

    // @rescuer compact summary
    const resPill = el("res-status-pill");
    resPill.textContent = snap.rescuerStatusPill;
    resPill.className = `state-tag ${
      snap.lifecycle === "recovering"
        ? "tag-violet"
        : snap.outcomes.terseConfirmedRecoveries > 0
          ? "tag-green"
          : "tag-neutral"
    }`;

    el("res-escape-readout").textContent =
      snap.navDot >= 0
        ? "Clear (+g hemisphere)"
        : `${snap.navNorm.toFixed(2)} / ${ESCAPE_NORM.toFixed(2)} norm`;

    const escFill = el("res-escape-fill");
    escFill.style.width =
      snap.navDot >= 0 ? "100%" : `${Math.min(100, snap.navNorm * 100)}%`;
    escFill.className = `meter-fill ${
      snap.navDot >= 0 || snap.isEscaped ? "fill-green" : "fill-violet"
    }`;

    const decEl = el("res-decision");
    decEl.textContent = snap.decision.label;
    decEl.className = `pm-val mono ${
      snap.decision.source === "llm" ? "text-violet" : ""
    }`;

    // Technical inspection fields (live-updated even while collapsed)
    el("meta-run-id").textContent = this.mission
      ? shortId(this.mission.runId, 16)
      : "—";
    el("meta-run-btn").title = this.mission
      ? `Run ID: ${this.mission.runId} (click to copy)`
      : "No active run";

    const reqId =
      this.mission?.pendingRecovery?.requestId ??
      [...this.events]
        .reverse()
        .find((e) => e.type === "recovery_requested")?.detail ??
      "—";
    const propId = snap.decision.proposalId ?? "—";
    el("res-req-id").textContent = reqId === "—" ? "—" : shortId(reqId, 12);
    el("res-prop-id").textContent = propId === "—" ? "—" : shortId(propId, 14);

    el("metric-recoveries").textContent = String(
      snap.outcomes.terseConfirmedRecoveries,
    );
    el("metric-moves").textContent = `${snap.outcomes.navigatorMoves} / ${snap.outcomes.rescuerMoves}`;
    el("metric-arc").textContent = `${snap.outcomes.arcSweptRad.toFixed(3)} rad`;

    el("hud-pos").textContent = formatVec3(snap.position, 4);
    el("hud-goal").textContent = formatVec3(snap.goal, 4);
    el("hud-blind").textContent = formatVec3(snap.antipode, 4);
    el("res-axis").textContent = formatVec3(snap.rescueAxis, 3);
    el("nav-tangent").textContent = snap.navTangent
      ? formatVec3(snap.navTangent, 3)
      : "undefined (0)";

    el("nav-norm").textContent = snap.navNorm.toFixed(6);
    el("nav-norm").className = `row-val mono ${snap.isStalled ? "text-red" : "text-cyan"}`;
    el("res-norm").textContent = snap.resNorm.toFixed(6);
    el("gauge-res-bar").style.width = `${Math.min(100, snap.resNorm * 100)}%`;
    el("gauge-sup-val").textContent = snap.complementarySupremum.toFixed(4);
    el("nav-angle").textContent = `${snap.navGoalAngleRad.toFixed(4)} rad (${deg.toFixed(1)}°)`;
    el("nav-dot").textContent = `${snap.navDot >= 0 ? "+" : "−"}${Math.abs(snap.navDot).toFixed(4)}`;
    el("nav-alpha").textContent = snap.navTangent
      ? `${snap.navStepAlpha.toFixed(4)} rad`
      : "0.0000 rad";

    if (el<HTMLDetailsElement>("tech-inspection").open) {
      this.drawSparkline(snap);
    }
  }

  private renderSphereHud(snap: TelemetrySnapshot): void {
    const authBox = el("hud-authority-box");
    const kicker = el("hud-kicker");
    const authTitle = el("hud-authority-title");
    const authSub = el("hud-authority-sub");
    const deg = ((snap.navGoalAngleRad * 180) / Math.PI).toFixed(1);

    if (snap.lifecycle === "failed") {
      authBox.className = "globe-authority auth-failed";
      kicker.textContent = "SYSTEM DIAGNOSTIC";
      authTitle.textContent = "Transport / Recovery Interrupted";
      authSub.textContent = snap.lifecycleDetail;
    } else if (!this.mission) {
      authBox.className = "globe-authority auth-standby";
      kicker.textContent = "SPATIAL ATTITUDE · S²";
      authTitle.textContent = "Standby — Pre-Launch";
      authSub.textContent =
        this.health && !this.health.relay
          ? "Terse online · Agent Relay disconnected"
          : `Initial attitude ${deg}° from target +g`;
    } else if (snap.lifecycle === "completed") {
      authBox.className = "globe-authority auth-completed";
      kicker.textContent = `TERSE r${this.mission.revision} · EPOCH e${this.mission.controlEpoch}`;
      authTitle.textContent = "Target Attitude +g Locked";
      authSub.textContent =
        snap.outcomes.terseConfirmedRecoveries > 0
          ? `Autonomous Relay + Terse handoff verified (${snap.outcomes.rescuerMoves} rescue steps)`
          : `Nominal geodesic convergence (${snap.outcomes.navigatorMoves} steps)`;
    } else if (snap.lifecycle === "stalled") {
      authBox.className = "globe-authority auth-stalled";
      kicker.textContent = `BLIND SPOT SINGULARITY · r${this.mission.revision}`;
      authTitle.textContent = "Navigator Stalled at −g";
      authSub.textContent =
        this.health && !this.health.relay
          ? "Gradient 0% · Agent Relay offline (handoff blocked)"
          : "Gradient 0% · requesting @rescuer via Agent Relay";
    } else if (this.mission.activePilot === "rescuer") {
      authBox.className = "globe-authority auth-rescuer";
      kicker.textContent = `TERSE EPOCH e${this.mission.controlEpoch} · RESCUER AUTHORITY`;
      authTitle.textContent = "Rescuer Escaping 30° Cone";
      authSub.textContent = snap.outcomes.awaitingTerseReturnConfirmation
        ? "Clearance ≥ 0.50 reached · awaiting Terse control_returned"
        : `${snap.decision.label} · ${deg}° from target`;
    } else {
      authBox.className = "globe-authority auth-navigator";
      kicker.textContent = `TERSE EPOCH e${this.mission.controlEpoch} · NAVIGATOR AUTHORITY`;
      authTitle.textContent =
        snap.outcomes.terseConfirmedRecoveries > 0
          ? "Navigator Resumed Control"
          : "Navigator Geodesic Flight";
      authSub.textContent = `${deg}° to target +g · gradient ${Math.round(snap.navNorm * 100)}%`;
    }
  }

  private renderProtocolTimeline(
    entries: ProtocolTimelineEntry[],
    snap: TelemetrySnapshot,
  ): void {
    // 1. Live protocol summary bar (5 core fields)
    const statusEl = el("tl-status");
    statusEl.textContent = snap.lifecycleLabel;
    statusEl.className = `pk-val ${
      snap.lifecycle === "completed"
        ? "text-green"
        : snap.lifecycle === "recovering"
          ? "text-violet"
          : snap.lifecycle === "stalled" || snap.lifecycle === "failed"
            ? "text-red"
            : snap.lifecycle === "navigating"
              ? "text-cyan"
              : ""
    }`;

    const pilotEl = el("tl-pilot");
    if (!this.mission) {
      pilotEl.textContent = "Standby";
      pilotEl.className = "pk-val";
    } else if (this.mission.activePilot === "rescuer") {
      pilotEl.textContent = "@rescuer";
      pilotEl.className = "pk-val text-violet mono";
    } else if (snap.isStalled) {
      pilotEl.textContent = "@navigator";
      pilotEl.className = "pk-val text-red mono";
    } else {
      pilotEl.textContent = "@navigator";
      pilotEl.className = "pk-val text-cyan mono";
    }

    el("tl-revision").textContent = this.mission
      ? `r${snap.outcomes.revision} · e${snap.outcomes.controlEpoch}`
      : "r0 · e0";

    if (
      this.mission &&
      this.prevRenderedRevision !== -1 &&
      this.mission.revision !== this.prevRenderedRevision
    ) {
      const revCell = el("cell-revision");
      revCell.classList.remove("flash-commit");
      void revCell.offsetWidth;
      revCell.classList.add("flash-commit");
    }
    this.prevRenderedRevision = this.mission ? this.mission.revision : -1;

    const rCount = snap.outcomes.verifiedRelayCount;
    el("tl-relay-count").textContent = `${rCount} msg${rCount === 1 ? "" : "s"}`;

    el("tl-latency").textContent =
      snap.outcomes.recoveryLatencyMs !== null
        ? `${(snap.outcomes.recoveryLatencyMs / 1000).toFixed(2)}s`
        : snap.lifecycle === "failed" || (this.health && !this.health.relay)
          ? "—"
          : snap.handoffStage !== "idle" && snap.handoffStage !== "confirmed"
            ? "In flight…"
            : "—";

    const liveDot = el("protocol-live-dot");
    liveDot.className = `protocol-dot ${
      snap.lifecycle === "completed"
        ? "is-done"
        : snap.lifecycle === "recovering"
          ? "is-rescuing"
          : snap.lifecycle === "stalled" || snap.lifecycle === "failed"
            ? "is-alert"
            : snap.lifecycle === "navigating"
              ? "is-live"
              : ""
    }`;

    // 2. Unified Live Protocol Stream
    const container = el("protocol-timeline-list");
    if (entries.length === 0) {
      const emptyHtml = `<div class="console-empty">No protocol events yet — click <strong>Break Navigator</strong> to observe real Agent Relay handoff and Terse epoch fencing.</div>`;
      if (this.lastTimelineHtml !== emptyHtml) {
        this.lastTimelineHtml = emptyHtml;
        container.innerHTML = emptyHtml;
      }
      return;
    }

    const html = entries
      .slice(0, 80)
      .map((entry) => {
        const revCell = entry.revisionLabel;
        const relayCell = entry.relayMessageId
          ? `<button type="button" class="relay-chip" data-relay-id="${escapeHtml(entry.relayMessageId)}" title="Verified Agent Relay message ID: ${escapeHtml(entry.relayMessageId)} (click to copy)">${escapeHtml(shortId(entry.relayMessageId, 15))}</button>`
          : `<span class="transport-http" title="Direct HTTP request (no Agent Relay message)">${escapeHtml(entry.transportLabel)}</span>`;
        return `<div class="pt-row">
          <span class="pt-rev">${escapeHtml(revCell)}</span>
          <span class="pt-actor tone-${entry.authorityTone}">${escapeHtml(entry.authorityLabel)}</span>
          <span class="pt-summary" title="${escapeHtml(entry.summary)}">${escapeHtml(entry.summary)}</span>
          <span class="pt-relay">${relayCell}</span>
          <span class="pt-time">${escapeHtml(fmtClockCompact(entry.timestamp))}</span>
        </div>`;
      })
      .join("");

    if (this.lastTimelineHtml !== html) {
      this.lastTimelineHtml = html;
      container.innerHTML = html;
    }
  }

  private drawSparkline(snap: TelemetrySnapshot): void {
    const canvas = el<HTMLCanvasElement>("sparkline-canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = canvas.clientWidth || 336;
    const cssH = canvas.clientHeight || 52;
    if (
      canvas.width !== Math.floor(cssW * dpr) ||
      canvas.height !== Math.floor(cssH * dpr)
    ) {
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    const padX = 2;
    const padY = 6;
    const plotW = cssW - padX * 2;
    const plotH = cssH - padY * 2;

    const yZero = padY + plotH;
    const yHalf = padY + plotH * (1 - ESCAPE_NORM);

    ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padX, yZero);
    ctx.lineTo(padX + plotW, yZero);
    ctx.stroke();

    ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padX, yHalf);
    ctx.lineTo(padX + plotW, yHalf);
    ctx.stroke();
    ctx.setLineDash([]);

    const pts = this.mission?.trajectory.map((t) => t.position) ?? [
      snap.position,
    ];
    const samples = pts.length === 1 ? [pts[0], pts[0]] : pts;

    const plotSeries = (values: number[], color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      values.forEach((v, idx) => {
        const x = padX + (idx / Math.max(1, values.length - 1)) * plotW;
        const y = padY + plotH * (1 - Math.max(0, Math.min(1, v)));
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };

    const navSeries = samples.map((p) => norm(navigatorField(p, snap.goal)));
    const resSeries = samples.map((p) =>
      norm(rescuerField(p, snap.rescueAxis)),
    );

    plotSeries(resSeries, "#a78bfa");
    plotSeries(navSeries, "#38bdf8");

    ctx.restore();
  }
}

window.addEventListener("DOMContentLoaded", () => {
  new CounterwhorlApp();
});
