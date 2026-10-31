import type {
  ApiError,
  CommandMeta,
  ErrorCode,
  EventType,
  MissionState,
  MovementCommand,
  Principal,
  RecoveryProposal,
  RecoveryRequest,
  StartMission,
  TrajectoryPoint,
} from "../shared/contract";
import {
  angle,
  arrived,
  dot,
  escaped,
  field,
  isUnit,
  MAX_ALPHA,
  norm,
  perpendicular,
  scale,
  sphericalMove,
  stalled,
  UNIT_TOLERANCE,
  unit,
} from "./geometry";

export class MissionError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}
export function fail(code: ErrorCode, message: string): never {
  throw new MissionError(code, message);
}
export function errorResponse(error: unknown): ApiError {
  if (error instanceof MissionError)
    return { code: error.code, message: error.message };
  const text = error instanceof Error ? error.message : String(error);
  const codes: ErrorCode[] = [
    "UNAUTHORIZED",
    "NOT_FOUND",
    "ALREADY_STARTED",
    "INVALID_COMMAND",
    "INVALID_VECTOR",
    "INVALID_MOVEMENT",
    "STALE_REVISION",
    "STALE_EPOCH",
    "DUPLICATE_COMMAND",
    "INVALID_PHASE",
    "POLICY_VIOLATION",
    "COMPLETED",
  ];
  const code = codes.find((code) => text.includes(`${code}:`));
  return {
    code: code ?? "UNAVAILABLE",
    message: code
      ? text.slice(text.indexOf(`${code}:`))
      : "Actor service unavailable",
  };
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}
function assertUnit(
  v: unknown,
): asserts v is import("../shared/contract").Vec3 {
  if (!isUnit(v)) fail("INVALID_VECTOR", "Expected a finite unit vector");
}
function authorize(actual: Principal, expected: Principal): void {
  if (actual !== expected) fail("UNAUTHORIZED", `Requires ${expected}`);
}
function envelope(s: MissionState, c: CommandMeta): void {
  if (
    !text(c.commandId) ||
    !text(c.runId) ||
    !Number.isSafeInteger(c.expectedRevision) ||
    !Number.isSafeInteger(c.controlEpoch)
  )
    fail("INVALID_COMMAND", "Invalid command envelope");
  if (c.runId !== s.runId) fail("INVALID_COMMAND", "Run mismatch");
  if (s.processedCommandIds.includes(c.commandId))
    fail("DUPLICATE_COMMAND", "Command was already committed");
  if (c.expectedRevision !== s.revision)
    fail(
      "STALE_REVISION",
      "Read authoritative state and retry with a new command ID",
    );
  if (c.controlEpoch !== s.controlEpoch)
    fail("STALE_EPOCH", "Control ownership changed");
  if (s.phase === "completed") fail("COMPLETED", "Mission already completed");
}
function record(
  s: MissionState,
  c: Pick<CommandMeta, "commandId" | "relayMessageId">,
  type: EventType,
  pilot: Principal,
  detail?: string,
  trajectoryKind?: TrajectoryPoint["kind"],
): MissionState {
  const next = {
    ...s,
    revision: s.revision + 1,
    processedCommandIds: [...s.processedCommandIds, c.commandId],
  };
  next.events = [
    ...s.events,
    {
      id: `${s.runId}:${next.revision}`,
      runId: s.runId,
      revision: next.revision,
      timestamp: new Date().toISOString(),
      type,
      pilot,
      controlEpoch: s.controlEpoch,
      commandId: c.commandId,
      relayMessageId: c.relayMessageId,
      position: s.position,
      detail,
    },
  ];
  if (trajectoryKind)
    next.trajectory = [
      ...s.trajectory,
      {
        revision: next.revision,
        position: s.position,
        pilot,
        kind: trajectoryKind,
      },
    ];
  return next;
}
export function start(principal: Principal, c: StartMission): MissionState {
  authorize(principal, "coordinator");
  if (!text(c.runId) || !text(c.commandId))
    fail("INVALID_COMMAND", "Missing run or command ID");
  assertUnit(c.position);
  assertUnit(c.goal);
  const b = c.rescueAxis ?? perpendicular(c.goal);
  assertUnit(b);
  if (Math.abs(dot(b, c.goal)) > UNIT_TOLERANCE)
    fail("INVALID_VECTOR", "Rescue axis must be perpendicular to goal");
  const s: MissionState = {
    runId: c.runId,
    revision: 0,
    position: c.position,
    goal: c.goal,
    rescueAxis: b,
    phase: arrived(c.position, c.goal) ? "completed" : "navigating",
    activePilot: "navigator",
    controlEpoch: 0,
    processedCommandIds: [],
    events: [],
    trajectory: [],
    pendingRecovery: null,
  };
  return record(
    s,
    c,
    s.phase === "completed" ? "mission_completed" : "mission_started",
    principal,
    undefined,
    "start",
  );
}
export function challenge(
  s: MissionState,
  principal: Principal,
  c: CommandMeta,
): MissionState {
  authorize(principal, "coordinator");
  envelope(s, c);
  return record(
    {
      ...s,
      position: scale(s.goal, -1),
      phase: "navigating",
      activePilot: "navigator",
      controlEpoch: s.controlEpoch + 1,
      pendingRecovery: null,
    },
    c,
    "challenge_forced",
    principal,
    "Judge placed camera at exact antipode",
    "challenge",
  );
}
export function request(
  s: MissionState,
  principal: Principal,
  c: RecoveryRequest,
): MissionState {
  authorize(principal, "navigator");
  envelope(s, c);
  if (s.phase !== "navigating" || s.activePilot !== principal)
    fail("INVALID_PHASE", "Navigator is not steering");
  if (!text(c.requestId) || c.reason !== "navigator_stalled")
    fail("INVALID_COMMAND", "Invalid recovery request");
  if (!stalled(s.position, s.goal))
    fail("POLICY_VIOLATION", "Navigator has not stalled");
  return record(
    {
      ...s,
      phase: "awaiting_rescue",
      pendingRecovery: { requestId: c.requestId },
    },
    c,
    "recovery_requested",
    principal,
    c.requestId,
  );
}
function validateMovement(
  s: MissionState,
  tangent: unknown,
  alpha: number,
  pilot: "navigator" | "rescuer",
): void {
  assertUnit(tangent);
  if (Math.abs(dot(s.position, tangent)) > UNIT_TOLERANCE)
    fail("INVALID_MOVEMENT", "Direction must be tangent to position");
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha > MAX_ALPHA)
    fail("INVALID_MOVEMENT", "Angular step must be in (0, 0.35]");
  const axis = pilot === "navigator" ? s.goal : s.rescueAxis;
  const v = field(s.position, axis);
  if (norm(v) <= 1e-7 || dot(unit(v), tangent) < 1 - UNIT_TOLERANCE)
    fail(
      "POLICY_VIOLATION",
      "Direction must follow the authorized pilot field",
    );
  if (alpha > angle(s.position, axis) + UNIT_TOLERANCE)
    fail("POLICY_VIOLATION", "Step overshoots steering destination");
}
export function grant(
  s: MissionState,
  principal: Principal,
  c: RecoveryProposal,
): MissionState {
  authorize(principal, "coordinator");
  envelope(s, c);
  if (
    s.phase !== "awaiting_rescue" ||
    s.pendingRecovery?.requestId !== c.requestId
  )
    fail("INVALID_PHASE", "No matching recovery request");
  if (!text(c.proposalId)) fail("INVALID_COMMAND", "Missing proposal ID");
  validateMovement(s, c.tangent, c.alpha, "rescuer");
  return record(
    {
      ...s,
      phase: "rescuing",
      activePilot: "rescuer",
      controlEpoch: s.controlEpoch + 1,
      pendingRecovery: { requestId: c.requestId, proposalId: c.proposalId },
    },
    c,
    "handoff_granted",
    principal,
    c.proposalId,
  );
}
export function move(
  s: MissionState,
  principal: Principal,
  c: MovementCommand,
): MissionState {
  if (c.pilot !== "navigator" && c.pilot !== "rescuer")
    fail("UNAUTHORIZED", "Unknown pilot");
  authorize(principal, c.pilot);
  envelope(s, c);
  if (s.activePilot !== principal)
    fail("UNAUTHORIZED", "Pilot does not own control");
  if (s.phase !== (principal === "navigator" ? "navigating" : "rescuing"))
    fail("INVALID_PHASE", "Movement is not allowed in this phase");
  if (principal === "rescuer" && escaped(s.position, s.goal))
    fail("POLICY_VIOLATION", "Escape complete; return control");
  validateMovement(s, c.tangent, c.alpha, c.pilot);
  const position = sphericalMove(s.position, c.tangent, c.alpha);
  const complete = arrived(position, s.goal);
  return record(
    { ...s, position, phase: complete ? "completed" : s.phase },
    c,
    complete ? "mission_completed" : "movement_committed",
    principal,
    undefined,
    "movement",
  );
}
export function returnToNavigator(
  s: MissionState,
  principal: Principal,
  c: CommandMeta,
): MissionState {
  authorize(principal, "rescuer");
  envelope(s, c);
  if (s.phase !== "rescuing" || s.activePilot !== principal)
    fail("INVALID_PHASE", "Rescuer does not own control");
  if (!escaped(s.position, s.goal))
    fail(
      "POLICY_VIOLATION",
      "Must escape antipodal neighborhood before returning control",
    );
  return record(
    {
      ...s,
      phase: "navigating",
      activePilot: "navigator",
      controlEpoch: s.controlEpoch + 1,
      pendingRecovery: null,
    },
    c,
    "control_returned",
    principal,
  );
}
