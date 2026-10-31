import type {
  ApiError,
  HealthResponse,
  MissionEvent,
  MissionState,
  Vec3,
} from "../../shared/contract";
import type { PeerLedgerEntry } from "./api";
import {
  angle,
  arrived,
  dot,
  ESCAPE_NORM,
  escaped,
  navigatorField,
  norm,
  perpendicular,
  rescuerField,
  scale,
  stalled,
  steering,
} from "./sphere-math";

export type UiLifecycleState =
  | "connecting"
  | "waiting"
  | "navigating"
  | "stalled"
  | "recovering"
  | "failed"
  | "completed";

export type HandoffPipelineStage =
  | "idle"
  | "stalled"
  | "requested"
  | "granted"
  | "escaping"
  | "confirmed";

export type RecoveryStepStatus =
  | "pending"
  | "active"
  | "alert"
  | "completed"
  | "skipped";

export type RecoveryStepId =
  | "navigator_active"
  | "blind_spot_detected"
  | "recovery_requested"
  | "rescuer_accepts"
  | "terse_authorizes"
  | "navigator_resumes"
  | "mission_completed";

export interface RecoveryChecklistStep {
  id: RecoveryStepId;
  title: string;
  detail: string;
  badge?: string;
  status: RecoveryStepStatus;
}

export interface ProtocolTimelineEntry {
  key: string;
  timestamp: string;
  revision: number | null;
  revisionLabel: string;
  controlEpoch: number | null;
  authorityLabel: string;
  authorityTone: "navigator" | "rescuer" | "coordinator" | "alert" | "ok";
  summary: string;
  relayMessageId: string | null;
  transportLabel: string;
  sortOrder: number;
  stepCount?: number;
}

export interface RelayTranscriptItem {
  messageId: string;
  timestamp: string;
  sender: string;
  recipient: string;
  pilotClass: "navigator" | "rescuer" | "coordinator";
  action: string;
  detail: string;
  revision?: number;
  controlEpoch?: number;
  terseVerified: boolean;
}

export interface DecodedDecision {
  source: "llm" | "deterministic" | "none";
  candidate: "A" | "B" | null;
  stepRad: number | null;
  proposalId: string | null;
  label: string;
}

export interface OutcomeMetrics {
  revision: number;
  controlEpoch: number;
  handoffsRequested: number;
  handoffsGranted: number;
  /** Strictly incremented ONLY when Terse commits `control_returned` */
  terseConfirmedRecoveries: number;
  navigatorMoves: number;
  rescuerMoves: number;
  arcSweptRad: number;
  recoveryLatencyMs: number | null;
  awaitingTerseReturnConfirmation: boolean;
  verifiedRelayCount: number;
}

export interface TelemetrySnapshot {
  lifecycle: UiLifecycleState;
  lifecycleLabel: string;
  lifecycleDetail: string;

  position: Vec3;
  goal: Vec3;
  antipode: Vec3;
  rescueAxis: Vec3;

  navVector: Vec3;
  navNorm: number;
  navTangent: Vec3 | null;
  navStepAlpha: number;
  navGoalAngleRad: number;
  navDot: number;
  isStalled: boolean;
  isEscaped: boolean;
  isArrived: boolean;

  resVector: Vec3;
  resNorm: number;
  resTangent: Vec3 | null;
  resStepAlpha: number;
  escapeProgressPct: number;

  complementarySupremum: number;

  navigatorStatusPill: string;
  rescuerStatusPill: string;
  decision: DecodedDecision;

  handoffStage: HandoffPipelineStage;
  handoffGateLabel: string;
  handoffGateNote: string;

  recoverySteps: RecoveryChecklistStep[];
  protocolTimeline: ProtocolTimelineEntry[];
  relayTranscript: RelayTranscriptItem[];
  outcomes: OutcomeMetrics;
}

export interface TelemetryInput {
  booting: boolean;
  health: HealthResponse | null;
  mission: MissionState | null;
  events: MissionEvent[];
  peerLedger?: PeerLedgerEntry[];
  stagedPosition: Vec3;
  stagedGoal: Vec3;
  lastError: ApiError | null;
  recoveryWatchFailedReason?: string | null;
}

function compactId(id: string, max = 14): string {
  if (id.length <= max) return id;
  return `${id.slice(0, 7)}…${id.slice(-4)}`;
}

export function decodeProposalDecision(
  events: MissionEvent[],
  pendingProposalId?: string,
): DecodedDecision {
  const grantEvents = events.filter((e) => e.type === "handoff_granted");
  const latestProposal =
    pendingProposalId ?? grantEvents.at(-1)?.detail ?? null;
  if (!latestProposal) {
    return {
      source: "none",
      candidate: null,
      stepRad: null,
      proposalId: null,
      label: "Standby",
    };
  }
  const match = /^(llm|det)-([AB])-/.exec(latestProposal);
  if (!match) {
    return {
      source: "deterministic",
      candidate: null,
      stepRad: null,
      proposalId: latestProposal,
      label: latestProposal,
    };
  }
  const isLlm = match[1] === "llm";
  const candidate = match[2] as "A" | "B";
  const stepRad = candidate === "A" ? 0.2 : 0.35;
  return {
    source: isLlm ? "llm" : "deterministic",
    candidate,
    stepRad,
    proposalId: latestProposal,
    label: `${isLlm ? "LLM" : "Deterministic"} · Cand ${candidate} (${stepRad.toFixed(2)} rad)`,
  };
}

/**
 * Builds the real Agent Relay transcript strictly from:
 * 1) Terse-committed `MissionEvent` records that carry a non-empty `relayMessageId`, and
 * 2) Optional real peer-to-peer ledger entries from `.counterwhorl/agents/ledger.jsonl`.
 * Never fabricates messages. HTTP-only events (`mission_started`, `challenge_forced`) are excluded.
 */
export function buildAuthenticRelayTranscript(
  events: MissionEvent[],
  peerLedger: PeerLedgerEntry[] = [],
): RelayTranscriptItem[] {
  const items: RelayTranscriptItem[] = [];
  const seenPeerMessageIds = new Set<string>();
  const hasTerseControlReturned = events.some(
    (e) => e.type === "control_returned",
  );

  for (const ev of events) {
    if (!ev.relayMessageId) continue;

    let sender = `@${ev.pilot}`;
    let recipient = "@coordinator";
    let pilotClass: RelayTranscriptItem["pilotClass"] =
      ev.pilot === "rescuer" ? "rescuer" : "navigator";
    let action: string = ev.type;
    let detail = ev.detail ?? "";

    switch (ev.type) {
      case "recovery_requested":
        sender = "@navigator";
        recipient = "@rescuer";
        pilotClass = "navigator";
        action = "request_handoff";
        detail = ev.detail ? `handoff=${ev.detail}` : "navigator_stalled";
        break;
      case "handoff_granted":
        sender = "@rescuer";
        recipient = "@coordinator";
        pilotClass = "rescuer";
        action = "propose_recovery → granted";
        detail = ev.detail ?? "validated";
        break;
      case "movement_committed":
        sender = `@${ev.pilot}`;
        recipient = "@coordinator";
        pilotClass = ev.pilot === "rescuer" ? "rescuer" : "navigator";
        action = "commit_movement";
        detail = `e${ev.controlEpoch}`;
        break;
      case "control_returned":
        sender = "@rescuer";
        recipient = "@coordinator";
        pilotClass = "rescuer";
        action = "return_control";
        detail = `confirmed → e${ev.controlEpoch}`;
        break;
      case "mission_completed":
        sender = `@${ev.pilot}`;
        recipient = "@coordinator";
        pilotClass = ev.pilot === "rescuer" ? "rescuer" : "navigator";
        action = "commit_movement (arrival)";
        detail = "θ ≤ 1e−4 rad";
        break;
    }

    items.push({
      messageId: ev.relayMessageId,
      timestamp: ev.timestamp,
      sender,
      recipient,
      pilotClass,
      action,
      detail,
      revision: ev.revision,
      controlEpoch: ev.controlEpoch,
      terseVerified: true,
    });
  }

  for (const entry of peerLedger) {
    if (!entry.messageId || seenPeerMessageIds.has(entry.messageId)) continue;
    const isPeer =
      entry.type === "recovery_request" ||
      entry.type === "recovery_ack" ||
      entry.type === "recovery_rejected" ||
      entry.type === "recovery_complete" ||
      entry.type === "peer_ping" ||
      entry.type === "peer_pong";

    if (!isPeer && entry.dir === "in" && entry.type === "command_result") {
      seenPeerMessageIds.add(entry.messageId);
      items.push({
        messageId: entry.messageId,
        timestamp: entry.at,
        sender: `@${entry.from ?? "coordinator"}`,
        recipient: `@${entry.role}`,
        pilotClass: "coordinator",
        action: `command_result (${entry.ok ? "ok" : "rejected"})`,
        detail: entry.inReplyTo ? `re:${entry.inReplyTo}` : "",
        terseVerified: Boolean(entry.ok),
      });
      continue;
    }

    if (isPeer) {
      // If a Terse event already cites this exact messageId (e.g. recovery_request cited on recovery_requested),
      // only add pure peer messages that aren't already represented or are recovery_complete / recovery_rejected.
      const alreadyCitedInTerse = events.some(
        (e) => e.relayMessageId === entry.messageId,
      );
      if (alreadyCitedInTerse && entry.type === "recovery_request") {
        seenPeerMessageIds.add(entry.messageId);
        continue;
      }

      seenPeerMessageIds.add(entry.messageId);
      const sender =
        entry.dir === "out" ? `@${entry.role}` : `@${entry.from ?? "peer"}`;
      const recipient =
        entry.dir === "out" ? `@${entry.to ?? "peer"}` : `@${entry.role}`;
      const pilotClass: RelayTranscriptItem["pilotClass"] = sender.includes(
        "rescuer",
      )
        ? "rescuer"
        : "navigator";

      let detail = entry.handoffId ? `handoff=${entry.handoffId}` : "peer";
      if (entry.type === "recovery_complete" && !hasTerseControlReturned) {
        detail += " · awaiting Terse control_returned";
      }

      items.push({
        messageId: entry.messageId,
        timestamp: entry.at,
        sender,
        recipient,
        pilotClass,
        action: entry.type,
        detail,
        terseVerified:
          entry.type === "recovery_complete" ? hasTerseControlReturned : false,
      });
    }
  }

  return items.sort((a, b) => {
    const dt = Date.parse(b.timestamp) - Date.parse(a.timestamp);
    if (Math.abs(dt) > 5) return dt;
    return (b.revision ?? 0) - (a.revision ?? 0);
  });
}

/**
 * Builds the unified Live Protocol Timeline combining persisted Terse revisions and
 * authenticated Agent Relay peer messages without ever fabricating Relay message IDs.
 */
export function buildProtocolTimeline(
  events: MissionEvent[],
  peerLedger: PeerLedgerEntry[] = [],
): ProtocolTimelineEntry[] {
  const entries: ProtocolTimelineEntry[] = [];
  const hasTerseControlReturned = events.some(
    (e) => e.type === "control_returned",
  );

  for (const ev of events) {
    let authorityLabel = "Coordinator";
    let authorityTone: ProtocolTimelineEntry["authorityTone"] = "coordinator";
    let summary: string = ev.type;

    switch (ev.type) {
      case "mission_started":
        authorityLabel = "Terse · Judge";
        authorityTone = "coordinator";
        summary = "Mission initialized toward target +g";
        break;
      case "challenge_forced":
        authorityLabel = "Terse · Judge";
        authorityTone = "alert";
        summary = "Spacecraft forced onto antipodal blind spot (−g)";
        break;
      case "recovery_requested":
        authorityLabel = "Navigator";
        authorityTone = "navigator";
        summary = `Stall handoff requested${ev.detail ? ` (${compactId(ev.detail, 12)})` : ""}`;
        break;
      case "handoff_granted": {
        authorityLabel = "Terse → Rescuer";
        authorityTone = "rescuer";
        const dec = decodeProposalDecision([ev], ev.detail);
        summary = `Movement authorized · ${dec.label} (epoch e${ev.controlEpoch})`;
        break;
      }
      case "movement_committed":
        authorityLabel = ev.pilot === "rescuer" ? "Rescuer" : "Navigator";
        authorityTone = ev.pilot === "rescuer" ? "rescuer" : "navigator";
        summary =
          ev.pilot === "rescuer"
            ? "Orthogonal escape step committed"
            : "Geodesic steering step committed";
        break;
      case "control_returned":
        authorityLabel = "Rescuer → Nav";
        authorityTone = "ok";
        summary = `Escape confirmed · Navigator authority restored (epoch e${ev.controlEpoch})`;
        break;
      case "mission_completed":
        authorityLabel = "Navigator";
        authorityTone = "ok";
        summary = "Target attitude +g locked (θ ≤ 10⁻⁴ rad)";
        break;
    }

    const relayId = ev.relayMessageId ?? null;
    const transportLabel = relayId
      ? relayId
      : ev.type === "mission_started" || ev.type === "challenge_forced"
        ? "HTTP · Judge"
        : "HTTP · Pilot API";

    const prev = entries.at(-1);
    if (
      ev.type === "movement_committed" &&
      !relayId &&
      prev &&
      prev.stepCount !== undefined &&
      prev.relayMessageId === null &&
      prev.controlEpoch === ev.controlEpoch &&
      prev.authorityLabel === authorityLabel
    ) {
      const nextCount = prev.stepCount + 1;
      prev.key = `terse:${prev.revision}-${ev.revision}`;
      prev.timestamp = ev.timestamp;
      prev.revisionLabel = `r${prev.revision}–r${ev.revision} · e${ev.controlEpoch}`;
      prev.summary =
        ev.pilot === "rescuer"
          ? `${nextCount} orthogonal escape steps committed`
          : `${nextCount} geodesic steering steps committed`;
      prev.sortOrder = ev.revision * 10;
      prev.stepCount = nextCount;
      continue;
    }

    entries.push({
      key: `terse:${ev.revision}`,
      timestamp: ev.timestamp,
      revision: ev.revision,
      revisionLabel: `r${ev.revision} · e${ev.controlEpoch}`,
      controlEpoch: ev.controlEpoch,
      authorityLabel,
      authorityTone,
      summary,
      relayMessageId: relayId,
      transportLabel,
      sortOrder: ev.revision * 10,
      stepCount: ev.type === "movement_committed" && !relayId ? 1 : undefined,
    });
  }

  // Include real peer-to-peer Agent Relay DMs from ledger (deduplicated by messageId)
  const seenLedgerIds = new Set<string>();
  for (const entry of peerLedger) {
    if (!entry.messageId || seenLedgerIds.has(entry.messageId)) continue;
    if (
      entry.type !== "recovery_request" &&
      entry.type !== "recovery_complete" &&
      entry.type !== "recovery_rejected"
    ) {
      continue;
    }
    // Prefer outbound record when both agents log the same DM locally
    seenLedgerIds.add(entry.messageId);

    // If recovery_request is already cited on Terse recovery_requested, also surface the peer DM only if recovery_requested hasn't committed yet
    const citedOnRequest = events.some(
      (e) =>
        e.type === "recovery_requested" &&
        e.relayMessageId === entry.messageId,
    );
    if (citedOnRequest && entry.type === "recovery_request") continue;

    let authorityLabel = "Agent Relay";
    let authorityTone: ProtocolTimelineEntry["authorityTone"] = "navigator";
    let summary = entry.type;

    if (entry.type === "recovery_request") {
      authorityLabel = "Nav → Rescuer";
      authorityTone = "navigator";
      summary = `Relay DM recovery_request${entry.handoffId ? ` (${compactId(entry.handoffId, 12)})` : ""}`;
    } else if (entry.type === "recovery_complete") {
      authorityLabel = "Rescuer → Nav";
      authorityTone = hasTerseControlReturned ? "ok" : "rescuer";
      summary = hasTerseControlReturned
        ? "Relay DM recovery_complete delivered to @navigator"
        : "Relay DM recovery_complete (awaiting Terse control_returned)";
    } else if (entry.type === "recovery_rejected") {
      authorityLabel = "Rescuer → Nav";
      authorityTone = "alert";
      summary = "Relay DM recovery_rejected";
    }

    entries.push({
      key: `peer:${entry.messageId}`,
      timestamp: entry.at,
      revision: null,
      revisionLabel: "Relay DM",
      controlEpoch: null,
      authorityLabel,
      authorityTone,
      summary,
      relayMessageId: entry.messageId,
      transportLabel: entry.messageId,
      sortOrder: (events.at(-1)?.revision ?? 0) * 10 + 5,
    });
  }

  return entries.sort((a, b) => {
    const ta = Date.parse(a.timestamp);
    const tb = Date.parse(b.timestamp);
    if (Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(tb - ta) > 5) {
      return tb - ta;
    }
    return b.sortOrder - a.sortOrder;
  });
}

/**
 * Builds the 7-stage Autonomous Recovery Panel strictly from real Terse & Relay state.
 */
export function buildRecoveryChecklist(params: {
  health: HealthResponse | null;
  mission: MissionState | null;
  events: MissionEvent[];
  peerLedger: PeerLedgerEntry[];
  isStalled: boolean;
  navGoalAngleRad: number;
  decision: DecodedDecision;
  outcomes: OutcomeMetrics;
}): RecoveryChecklistStep[] {
  const {
    health,
    mission,
    events,
    peerLedger,
    isStalled,
    navGoalAngleRad,
    decision,
    outcomes,
  } = params;

  if (!mission) {
    return [
      {
        id: "navigator_active",
        title: "Navigator active",
        detail: "Autonomous geodesic steering toward target +g",
        status: "pending",
      },
      {
        id: "blind_spot_detected",
        title: "Mathematical blind spot detected",
        detail: "Navigator gradient vanishes at exact antipode (−g)",
        status: "pending",
      },
      {
        id: "recovery_requested",
        title: "Recovery requested via Agent Relay",
        detail: "@navigator dispatches authenticated request to @rescuer",
        status: "pending",
      },
      {
        id: "rescuer_accepts",
        title: "Rescuer accepts responsibility",
        detail: "@rescuer selects orthogonal escape trajectory",
        status: "pending",
      },
      {
        id: "terse_authorizes",
        title: "Terse authorizes movement",
        detail: "Durable actor fences control epoch & validates escape",
        status: "pending",
      },
      {
        id: "navigator_resumes",
        title: "Navigator resumes",
        detail: "Terse commits control_returned past 30° escape cone",
        status: "pending",
      },
      {
        id: "mission_completed",
        title: "Mission completed",
        detail: "Spacecraft attitude locked within 10⁻⁴ rad of target",
        status: "pending",
      },
    ];
  }

  const reqEvent = [...events]
    .reverse()
    .find((e) => e.type === "recovery_requested");
  const grantEvent = [...events]
    .reverse()
    .find((e) => e.type === "handoff_granted");
  const returnEvent = [...events]
    .reverse()
    .find((e) => e.type === "control_returned");
  const peerReq = [...peerLedger]
    .reverse()
    .find((p) => p.type === "recovery_request");
  const relayOffline = Boolean(health && !health.relay);

  const recoveryTriggered =
    isStalled ||
    mission.phase === "awaiting_rescue" ||
    mission.phase === "rescuing" ||
    Boolean(reqEvent || grantEvent || returnEvent) ||
    events.some((e) => e.type === "challenge_forced");

  const relayIdCited = reqEvent?.relayMessageId ?? peerReq?.messageId ?? null;

  // Case A: Mission completed
  if (mission.phase === "completed") {
    if (outcomes.terseConfirmedRecoveries > 0) {
      return [
        {
          id: "navigator_active",
          title: "Navigator active",
          detail: "Initial geodesic flight prior to blind-spot challenge",
          badge: "Done",
          status: "completed",
        },
        {
          id: "blind_spot_detected",
          title: "Mathematical blind spot detected",
          detail: "Antipodal singularity (−g) where ||v_nav|| = 0",
          badge: "−g",
          status: "completed",
        },
        {
          id: "recovery_requested",
          title: "Recovery requested via Agent Relay",
          detail: relayIdCited
            ? `Relay ID ${compactId(relayIdCited, 14)} · Terse r${reqEvent?.revision ?? "—"}`
            : `Recorded at Terse r${reqEvent?.revision ?? "—"}`,
          badge: "Relay",
          status: "completed",
        },
        {
          id: "rescuer_accepts",
          title: "Rescuer accepts responsibility",
          detail: decision.label,
          badge: decision.candidate ? `Cand ${decision.candidate}` : "Planned",
          status: "completed",
        },
        {
          id: "terse_authorizes",
          title: "Terse authorizes movement",
          detail: `Epoch e${grantEvent?.controlEpoch ?? 2} · ${outcomes.rescuerMoves} escape steps committed`,
          badge: `r${grantEvent?.revision ?? "—"}`,
          status: "completed",
        },
        {
          id: "navigator_resumes",
          title: "Navigator resumes",
          detail: `Terse confirmed control_returned at r${returnEvent?.revision ?? "—"}`,
          badge: `e${mission.controlEpoch}`,
          status: "completed",
        },
        {
          id: "mission_completed",
          title: "Mission completed",
          detail: `Target +g locked at r${mission.revision}${
            outcomes.recoveryLatencyMs !== null
              ? ` · ${(outcomes.recoveryLatencyMs / 1000).toFixed(2)}s handoff`
              : ""
          }`,
          badge: `r${mission.revision}`,
          status: "completed",
        },
      ];
    }

    // Completed nominal flight without triggering blind spot
    return [
      {
        id: "navigator_active",
        title: "Navigator active",
        detail: `Nominal geodesic flight (${outcomes.navigatorMoves} steps)`,
        badge: "Done",
        status: "completed",
      },
      {
        id: "blind_spot_detected",
        title: "Mathematical blind spot detected",
        detail: "Not triggered — click Break Navigator to test recovery",
        status: "skipped",
      },
      {
        id: "recovery_requested",
        title: "Recovery requested via Agent Relay",
        detail: "No stall occurred during this run",
        status: "skipped",
      },
      {
        id: "rescuer_accepts",
        title: "Rescuer accepts responsibility",
        detail: "Rescuer remained on standby",
        status: "skipped",
      },
      {
        id: "terse_authorizes",
        title: "Terse authorizes movement",
        detail: "Single-epoch flight (epoch e0)",
        status: "skipped",
      },
      {
        id: "navigator_resumes",
        title: "Navigator resumes",
        detail: "Authority remained with Navigator",
        status: "skipped",
      },
      {
        id: "mission_completed",
        title: "Mission completed",
        detail: `Target +g locked at Terse r${mission.revision}`,
        badge: `r${mission.revision}`,
        status: "completed",
      },
    ];
  }

  // Case B: Navigator resumed after Terse confirmed control_returned
  if (outcomes.terseConfirmedRecoveries > 0 && mission.phase === "navigating") {
    const degLeft = ((navGoalAngleRad * 180) / Math.PI).toFixed(1);
    return [
      {
        id: "navigator_active",
        title: "Navigator active",
        detail: "Initial geodesic flight before challenge",
        badge: "Done",
        status: "completed",
      },
      {
        id: "blind_spot_detected",
        title: "Mathematical blind spot detected",
        detail: "Antipodal singularity (−g) detected",
        badge: "−g",
        status: "completed",
      },
      {
        id: "recovery_requested",
        title: "Recovery requested via Agent Relay",
        detail: relayIdCited
          ? `Relay ID ${compactId(relayIdCited, 14)} · Terse r${reqEvent?.revision ?? "—"}`
          : `Terse r${reqEvent?.revision ?? "—"}`,
        badge: "Relay",
        status: "completed",
      },
      {
        id: "rescuer_accepts",
        title: "Rescuer accepts responsibility",
        detail: decision.label,
        badge: decision.candidate ? `Cand ${decision.candidate}` : "Accepted",
        status: "completed",
      },
      {
        id: "terse_authorizes",
        title: "Terse authorizes movement",
        detail: `${outcomes.rescuerMoves} orthogonal escape steps committed`,
        badge: `r${grantEvent?.revision ?? "—"}`,
        status: "completed",
      },
      {
        id: "navigator_resumes",
        title: "Navigator resumes",
        detail: `Terse r${returnEvent?.revision ?? mission.revision} confirmed · ${degLeft}° to target`,
        badge: `e${mission.controlEpoch}`,
        status: "active",
      },
      {
        id: "mission_completed",
        title: "Mission completed",
        detail: "Converging on target attitude +g…",
        status: "pending",
      },
    ];
  }

  // Case C: Rescuer actively authorized by Terse (phase === "rescuing")
  if (mission.phase === "rescuing") {
    return [
      {
        id: "navigator_active",
        title: "Navigator active",
        detail: "Yielded control at blind spot",
        status: "completed",
      },
      {
        id: "blind_spot_detected",
        title: "Mathematical blind spot detected",
        detail: "Navigator gradient vanished at −g (||v_nav|| = 0)",
        badge: "−g",
        status: "completed",
      },
      {
        id: "recovery_requested",
        title: "Recovery requested via Agent Relay",
        detail: relayIdCited
          ? `Relay ID ${compactId(relayIdCited, 14)} · Terse r${reqEvent?.revision ?? "—"}`
          : `Handoff ${mission.pendingRecovery?.requestId ?? ""} recorded`,
        badge: "Relay",
        status: "completed",
      },
      {
        id: "rescuer_accepts",
        title: "Rescuer accepts responsibility",
        detail: decision.label,
        badge: decision.candidate ? `Cand ${decision.candidate}` : "Accepted",
        status: "completed",
      },
      {
        id: "terse_authorizes",
        title: "Terse authorizes movement",
        detail: outcomes.awaitingTerseReturnConfirmation
          ? `Escaped ≥ 0.50 (${outcomes.rescuerMoves} steps) · awaiting Terse control_returned`
          : `Epoch e${mission.controlEpoch} granted · escaping 30° cone (${outcomes.rescuerMoves} steps)`,
        badge: `e${mission.controlEpoch}`,
        status: "active",
      },
      {
        id: "navigator_resumes",
        title: "Navigator resumes",
        detail: "Gated strictly until Terse commits control_returned",
        status: "pending",
      },
      {
        id: "mission_completed",
        title: "Mission completed",
        detail: "Awaiting final Navigator approach to +g",
        status: "pending",
      },
    ];
  }

  // Case D: Recovery requested, awaiting Rescuer proposal & Terse grant (phase === "awaiting_rescue")
  if (mission.phase === "awaiting_rescue") {
    return [
      {
        id: "navigator_active",
        title: "Navigator active",
        detail: "Halted at antipodal singularity",
        status: "completed",
      },
      {
        id: "blind_spot_detected",
        title: "Mathematical blind spot detected",
        detail: "||v_nav(−g)|| = 0.000 · Navigator unable to steer",
        badge: "−g",
        status: "completed",
      },
      {
        id: "recovery_requested",
        title: "Recovery requested via Agent Relay",
        detail: relayIdCited
          ? `Relay ID ${compactId(relayIdCited, 14)} · Terse r${reqEvent?.revision ?? mission.revision}`
          : `Terse r${mission.revision} (${mission.pendingRecovery?.requestId ?? "pending"})`,
        badge: "Sent",
        status: "completed",
      },
      {
        id: "rescuer_accepts",
        title: "Rescuer accepts responsibility",
        detail: relayOffline
          ? "Blocked — Agent Relay disconnected"
          : "@rescuer evaluating orthogonal candidates A & B…",
        badge: relayOffline ? "Offline" : "Planning",
        status: relayOffline ? "alert" : "active",
      },
      {
        id: "terse_authorizes",
        title: "Terse authorizes movement",
        detail: "Awaiting validated propose_recovery command",
        status: "pending",
      },
      {
        id: "navigator_resumes",
        title: "Navigator resumes",
        detail: "Awaiting escape & Terse control_returned",
        status: "pending",
      },
      {
        id: "mission_completed",
        title: "Mission completed",
        detail: "Awaiting final approach to +g",
        status: "pending",
      },
    ];
  }

  // Case E: Stalled at blind spot −g, before Terse records recovery_requested
  if (recoveryTriggered && isStalled) {
    return [
      {
        id: "navigator_active",
        title: "Navigator active",
        detail: `Interrupted at Terse r${mission.revision}`,
        status: "completed",
      },
      {
        id: "blind_spot_detected",
        title: "Mathematical blind spot detected",
        detail: "At antipode −g: ||v_nav|| = 0.000, ||v_res|| = 1.000",
        badge: "Stalled",
        status: "alert",
      },
      {
        id: "recovery_requested",
        title: "Recovery requested via Agent Relay",
        detail: peerReq
          ? `Relay DM ${compactId(peerReq.messageId, 14)} sent → registering in Terse`
          : relayOffline
            ? "Cannot request handoff — Agent Relay is disconnected"
            : "Awaiting @navigator autonomous recovery_request over Relay…",
        badge: peerReq ? "Relay" : relayOffline ? "Offline" : "Next",
        status: peerReq ? "active" : "pending",
      },
      {
        id: "rescuer_accepts",
        title: "Rescuer accepts responsibility",
        detail: "Standby for @navigator Relay request",
        status: "pending",
      },
      {
        id: "terse_authorizes",
        title: "Terse authorizes movement",
        detail: "Durable actor epoch fence armed",
        status: "pending",
      },
      {
        id: "navigator_resumes",
        title: "Navigator resumes",
        detail: "Gated on Terse control_returned",
        status: "pending",
      },
      {
        id: "mission_completed",
        title: "Mission completed",
        detail: "Target +g arrival pending",
        status: "pending",
      },
    ];
  }

  // Case F: Nominal active navigation (not stalled)
  const deg = ((navGoalAngleRad * 180) / Math.PI).toFixed(1);
  return [
    {
      id: "navigator_active",
      title: "Navigator active",
      detail:
        outcomes.navigatorMoves > 0
          ? `Steering toward +g (${deg}° remaining · Terse r${mission.revision})`
          : relayOffline
            ? `Initialized at r${mission.revision} · Relay offline (click Break Navigator to test stall)`
            : `Initialized at r${mission.revision} · awaiting @navigator step (${deg}° to +g)`,
      badge: `e${mission.controlEpoch}`,
      status: "active",
    },
    {
      id: "blind_spot_detected",
      title: "Mathematical blind spot detected",
      detail: "Click Break Navigator to force antipodal singularity (−g)",
      status: "pending",
    },
    {
      id: "recovery_requested",
      title: "Recovery requested via Agent Relay",
      detail: "Triggered automatically on Navigator stall",
      status: "pending",
    },
    {
      id: "rescuer_accepts",
      title: "Rescuer accepts responsibility",
      detail: "Orthogonal pilot on standby",
      status: "pending",
    },
    {
      id: "terse_authorizes",
      title: "Terse authorizes movement",
      detail: "Epoch fencing ready",
      status: "pending",
    },
    {
      id: "navigator_resumes",
      title: "Navigator resumes",
      detail: "Requires Terse control_returned",
      status: "pending",
    },
    {
      id: "mission_completed",
      title: "Mission completed",
      detail: "Target attitude lock (≤ 10⁻⁴ rad)",
      status: "pending",
    },
  ];
}

export function computeOutcomeMetrics(
  mission: MissionState | null,
  events: MissionEvent[],
  peerLedger: PeerLedgerEntry[] = [],
): OutcomeMetrics {
  if (!mission) {
    return {
      revision: 0,
      controlEpoch: 0,
      handoffsRequested: 0,
      handoffsGranted: 0,
      terseConfirmedRecoveries: 0,
      navigatorMoves: 0,
      rescuerMoves: 0,
      arcSweptRad: 0,
      recoveryLatencyMs: null,
      awaitingTerseReturnConfirmation: false,
      verifiedRelayCount: 0,
    };
  }

  let handoffsRequested = 0;
  let handoffsGranted = 0;
  let terseConfirmedRecoveries = 0;
  let navigatorMoves = 0;
  let rescuerMoves = 0;

  let lastChallengeOrRequestMs: number | null = null;
  let lastRecoveryLatencyMs: number | null = null;

  const relayIds = new Set<string>();

  for (const e of events) {
    if (e.relayMessageId) relayIds.add(e.relayMessageId);

    if (e.type === "challenge_forced") {
      const t = Date.parse(e.timestamp);
      if (Number.isFinite(t)) lastChallengeOrRequestMs = t;
    } else if (e.type === "recovery_requested") {
      handoffsRequested++;
      if (lastChallengeOrRequestMs === null) {
        const t = Date.parse(e.timestamp);
        if (Number.isFinite(t)) lastChallengeOrRequestMs = t;
      }
    } else if (e.type === "handoff_granted") {
      handoffsGranted++;
    } else if (e.type === "control_returned") {
      terseConfirmedRecoveries++;
      const t = Date.parse(e.timestamp);
      if (lastChallengeOrRequestMs !== null && Number.isFinite(t)) {
        lastRecoveryLatencyMs = Math.max(0, t - lastChallengeOrRequestMs);
        lastChallengeOrRequestMs = null;
      }
    } else if (
      e.type === "movement_committed" ||
      e.type === "mission_completed"
    ) {
      if (e.pilot === "navigator") navigatorMoves++;
      if (e.pilot === "rescuer") rescuerMoves++;
    }
  }

  for (const p of peerLedger) {
    if (p.messageId) relayIds.add(p.messageId);
  }

  let arcSweptRad = 0;
  const traj = mission.trajectory;
  for (let i = 1; i < traj.length; i++) {
    if (traj[i].kind === "movement") {
      arcSweptRad += angle(traj[i - 1].position, traj[i].position);
    }
  }

  const awaitingTerseReturnConfirmation =
    mission.phase === "rescuing" && escaped(mission.position, mission.goal);

  return {
    revision: mission.revision,
    controlEpoch: mission.controlEpoch,
    handoffsRequested,
    handoffsGranted,
    terseConfirmedRecoveries,
    navigatorMoves,
    rescuerMoves,
    arcSweptRad,
    recoveryLatencyMs: lastRecoveryLatencyMs,
    awaitingTerseReturnConfirmation,
    verifiedRelayCount: relayIds.size,
  };
}

export function deriveTelemetry(input: TelemetryInput): TelemetrySnapshot {
  const {
    booting,
    health,
    mission,
    events,
    peerLedger = [],
    stagedPosition,
    stagedGoal,
    lastError,
    recoveryWatchFailedReason,
  } = input;

  const position = mission ? mission.position : stagedPosition;
  const goal = mission ? mission.goal : stagedGoal;
  const rescueAxis = mission ? mission.rescueAxis : perpendicular(goal);
  const antipode = scale(goal, -1);

  const navVector = navigatorField(position, goal);
  const navNorm = norm(navVector);
  const navSteer = steering(position, goal);

  const resVector = rescuerField(position, rescueAxis);
  const resNorm = norm(resVector);
  const resSteer = steering(position, rescueAxis);

  const navGoalAngleRad = angle(position, goal);
  const navDot = dot(position, goal);
  const isStalled = stalled(position, goal);
  const isEscaped = escaped(position, goal);
  const isArrived = arrived(position, goal);
  const complementarySupremum = Math.max(navNorm, resNorm);

  const escapeProgressPct =
    navDot >= 0
      ? 100
      : Math.max(0, Math.min(100, (navNorm / ESCAPE_NORM) * 100));

  const outcomes = computeOutcomeMetrics(mission, events, peerLedger);
  const decision = decodeProposalDecision(
    events,
    mission?.pendingRecovery?.proposalId,
  );
  const relayTranscript = buildAuthenticRelayTranscript(events, peerLedger);
  const protocolTimeline = buildProtocolTimeline(events, peerLedger);
  const recoverySteps = buildRecoveryChecklist({
    health,
    mission,
    events,
    peerLedger,
    isStalled,
    navGoalAngleRad,
    decision,
    outcomes,
  });

  // Authoritative lifecycle state
  let lifecycle: UiLifecycleState;
  let lifecycleLabel: string;
  let lifecycleDetail: string;

  if (booting && !health && !lastError) {
    lifecycle = "connecting";
    lifecycleLabel = "Connecting";
    lifecycleDetail = "Connecting to Terse runtime…";
  } else if (!health || !health.terse) {
    lifecycle = "failed";
    lifecycleLabel = "Disconnected";
    lifecycleDetail =
      lastError?.message ?? "Terse Durable Actor runtime unreachable";
  } else if (recoveryWatchFailedReason) {
    lifecycle = "failed";
    lifecycleLabel = "Recovery blocked";
    lifecycleDetail = recoveryWatchFailedReason;
  } else if (lastError && !mission) {
    lifecycle = "failed";
    lifecycleLabel = "Error";
    lifecycleDetail = `${lastError.code}: ${lastError.message}`;
  } else if (!mission) {
    lifecycle = "waiting";
    lifecycleLabel = health.relay ? "Ready" : "Relay offline";
    lifecycleDetail = health.relay
      ? "Click Break Navigator to demonstrate autonomous blind-spot recovery"
      : `Terse online · Agent Relay disconnected (${health.relayError ?? "not configured"})`;
  } else if (mission.phase === "completed") {
    lifecycle = "completed";
    lifecycleLabel = "Mission completed";
    lifecycleDetail =
      outcomes.terseConfirmedRecoveries > 0
        ? `Recovered via Agent Relay & Terse · target locked at r${mission.revision}`
        : `Target locked at Terse r${mission.revision}`;
  } else if (lastError) {
    lifecycle = "failed";
    lifecycleLabel = "Error";
    lifecycleDetail = `${lastError.code}: ${lastError.message}`;
  } else if (mission.phase === "rescuing") {
    lifecycle = "recovering";
    lifecycleLabel = "Rescuer authorized";
    lifecycleDetail = outcomes.awaitingTerseReturnConfirmation
      ? `Escaped blind spot · awaiting Terse control_returned (e${mission.controlEpoch})`
      : `Terse granted epoch e${mission.controlEpoch} · Rescuer escaping −g`;
  } else if (mission.phase === "awaiting_rescue" || isStalled) {
    lifecycle = "stalled";
    lifecycleLabel = "Blind spot stall";
    lifecycleDetail = !health.relay
      ? `Stalled at −g · Agent Relay disconnected (${health.relayError ?? "offline"})`
      : mission.phase === "awaiting_rescue"
        ? `Recovery requested via Agent Relay · awaiting Rescuer proposal`
        : "Navigator gradient vanished at −g · initiating Relay handoff";
  } else if (
    mission.revision <= 1 &&
    !events.some((e) => e.type === "movement_committed")
  ) {
    lifecycle = "waiting";
    lifecycleLabel = "Mission initialized";
    lifecycleDetail = health.relay
      ? `Terse r${mission.revision} · awaiting @navigator autonomous flight`
      : `Terse r${mission.revision} · Agent Relay disconnected`;
  } else {
    lifecycle = "navigating";
    lifecycleLabel =
      outcomes.terseConfirmedRecoveries > 0
        ? "Navigator resumed"
        : "Navigator active";
    lifecycleDetail =
      outcomes.terseConfirmedRecoveries > 0
        ? `Terse confirmed control_returned · steering to target (${((navGoalAngleRad * 180) / Math.PI).toFixed(1)}°)`
        : `Autonomous geodesic flight toward +g (r${mission.revision}, epoch e${mission.controlEpoch})`;
  }

  let navigatorStatusPill = "Standby";
  let rescuerStatusPill = "Standby";

  if (mission) {
    if (mission.phase === "completed") {
      navigatorStatusPill = "Target locked";
      rescuerStatusPill =
        outcomes.terseConfirmedRecoveries > 0 ? "Handoff complete" : "Standby";
    } else if (mission.phase === "rescuing") {
      navigatorStatusPill = "Yielded authority";
      rescuerStatusPill = outcomes.awaitingTerseReturnConfirmation
        ? "Returning control"
        : `Authorized (e${mission.controlEpoch})`;
    } else if (mission.phase === "awaiting_rescue") {
      navigatorStatusPill = "Stalled · Requested";
      rescuerStatusPill = "Planning trajectory";
    } else if (isStalled) {
      navigatorStatusPill = "Blind-spot stall";
      rescuerStatusPill = "Ready (orthogonal)";
    } else {
      navigatorStatusPill =
        outcomes.terseConfirmedRecoveries > 0 ? "Resumed" : "Active";
      rescuerStatusPill =
        outcomes.terseConfirmedRecoveries > 0 ? "Control returned" : "Standby";
    }
  }

  let handoffStage: HandoffPipelineStage = "idle";
  let handoffGateLabel = "Idle";
  let handoffGateNote =
    "Confirmed strictly after Terse commits control_returned.";

  if (mission) {
    if (mission.phase === "rescuing") {
      handoffStage = "escaping";
      handoffGateLabel = outcomes.awaitingTerseReturnConfirmation
        ? "Awaiting Terse"
        : "Rescuing";
      handoffGateNote = outcomes.awaitingTerseReturnConfirmation
        ? "Escape norm ≥ 0.50 reached; unconfirmed until Terse commits control_returned."
        : `Epoch e${mission.controlEpoch} granted (${decision.proposalId ?? "proposal"}); escaping −g.`;
    } else if (mission.phase === "awaiting_rescue") {
      handoffStage = "requested";
      handoffGateLabel = "Requested";
      handoffGateNote = `Handoff ${mission.pendingRecovery?.requestId ?? ""} recorded; awaiting Rescuer proposal.`;
    } else if (isStalled) {
      handoffStage = "stalled";
      handoffGateLabel = "Stalled at −g";
      handoffGateNote =
        "||v_nav|| ≤ 1e−7 at antipode −g; awaiting request_handoff.";
    } else if (outcomes.terseConfirmedRecoveries > 0) {
      handoffStage = "confirmed";
      handoffGateLabel = "Confirmed";
      handoffGateNote = `Terse committed control_returned (${outcomes.terseConfirmedRecoveries}×) · epoch e${mission.controlEpoch}.`;
    }
  }

  return {
    lifecycle,
    lifecycleLabel,
    lifecycleDetail,
    position,
    goal,
    antipode,
    rescueAxis,
    navVector,
    navNorm,
    navTangent: navSteer?.tangent ?? null,
    navStepAlpha: navSteer?.alpha ?? 0,
    navGoalAngleRad,
    navDot,
    isStalled,
    isEscaped,
    isArrived,
    resVector,
    resNorm,
    resTangent: resSteer?.tangent ?? null,
    resStepAlpha: resSteer?.alpha ?? 0,
    escapeProgressPct,
    complementarySupremum,
    navigatorStatusPill,
    rescuerStatusPill,
    decision,
    handoffStage,
    handoffGateLabel,
    handoffGateNote,
    recoverySteps,
    protocolTimeline,
    relayTranscript,
    outcomes,
  };
}
