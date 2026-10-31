/** Public integration contract. This file has no SDK or server dependencies. */
export type Vec3 = readonly [number, number, number];
export type PilotId = "navigator" | "rescuer";
export type Principal = PilotId | "coordinator";
export type MissionPhase =
  "navigating" | "awaiting_rescue" | "rescuing" | "completed";
export interface CommandMeta {
  runId: string;
  commandId: string;
  expectedRevision: number;
  controlEpoch: number;
  /** Assigned by the coordinator from authenticated Relay traffic; omit from agent requests. */
  relayMessageId?: string;
}
export interface StartMission {
  runId: string;
  commandId: string;
  position: Vec3;
  goal: Vec3;
  rescueAxis?: Vec3;
}
export interface MovementCommand extends CommandMeta {
  pilot: PilotId;
  tangent: Vec3;
  alpha: number;
}
export interface RecoveryRequest extends CommandMeta {
  requestId: string;
  reason: "navigator_stalled";
}
export interface RecoveryProposal extends CommandMeta {
  requestId: string;
  proposalId: string;
  tangent: Vec3;
  alpha: number;
}
export type EventType =
  | "mission_started"
  | "challenge_forced"
  | "recovery_requested"
  | "handoff_granted"
  | "movement_committed"
  | "control_returned"
  | "mission_completed";
export interface MissionEvent {
  id: string;
  runId: string;
  revision: number;
  timestamp: string;
  type: EventType;
  pilot: Principal;
  controlEpoch: number;
  commandId: string;
  relayMessageId?: string;
  position: Vec3;
  detail?: string;
}
export interface TrajectoryPoint {
  revision: number;
  position: Vec3;
  pilot: Principal;
  kind: "start" | "movement" | "challenge";
}
export interface MissionState {
  runId: string;
  revision: number;
  position: Vec3;
  goal: Vec3;
  rescueAxis: Vec3;
  phase: MissionPhase;
  activePilot: PilotId;
  controlEpoch: number;
  processedCommandIds: string[];
  events: MissionEvent[];
  trajectory: TrajectoryPoint[];
  pendingRecovery: { requestId: string; proposalId?: string } | null;
}
export type ErrorCode =
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "ALREADY_STARTED"
  | "INVALID_COMMAND"
  | "INVALID_VECTOR"
  | "INVALID_MOVEMENT"
  | "STALE_REVISION"
  | "STALE_EPOCH"
  | "DUPLICATE_COMMAND"
  | "INVALID_PHASE"
  | "POLICY_VIOLATION"
  | "COMPLETED"
  | "UNAVAILABLE";
export interface ApiError {
  code: ErrorCode;
  message: string;
}
export interface ApiErrorResponse {
  error: ApiError;
}
export type RecoveryResult =
  | { ok: true; commandId: string; state: MissionState }
  | { ok: false; commandId: string; error: ApiError };
export interface StartMissionRequest {
  position?: Vec3;
  goal?: Vec3;
  rescueAxis?: Vec3;
}
export interface MissionResponse {
  state: MissionState;
}
export interface EventsResponse {
  events: MissionEvent[];
  revision: number;
}
export interface HealthResponse {
  terse: boolean;
  relay: boolean;
  relayError?: string;
}
/** Browser routes: POST /api/missions, GET /api/missions/:runId,
 * POST /api/missions/:runId/challenge, GET /api/missions/:runId/events?afterRevision=N.
 * No browser movement or agent-identity endpoint exists. */
export type AgentRequest =
  | { type: "get_state"; runId: string; correlationId: string }
  | { type: "request_handoff"; command: RecoveryRequest }
  | { type: "propose_recovery"; command: RecoveryProposal }
  | { type: "commit_movement"; command: MovementCommand }
  | { type: "return_control"; command: CommandMeta };
export type CoordinatorMessage =
  | { type: "mission_state"; correlationId: string; state: MissionState }
  | { type: "command_result"; result: RecoveryResult }
  | { type: "mission_event"; event: MissionEvent; state: MissionState };
export interface MissionActorApi {
  startMission(
    principal: Principal,
    command: StartMission,
  ): Promise<MissionState>;
  getState(): Promise<MissionState>;
  forceBlindSpotChallenge(
    principal: Principal,
    command: CommandMeta,
  ): Promise<MissionState>;
  requestHandoff(
    principal: Principal,
    command: RecoveryRequest,
  ): Promise<MissionState>;
  grantHandoff(
    principal: Principal,
    command: RecoveryProposal,
  ): Promise<MissionState>;
  commitMovement(
    principal: Principal,
    command: MovementCommand,
  ): Promise<MissionState>;
  returnControl(
    principal: Principal,
    command: CommandMeta,
  ): Promise<MissionState>;
  getEvents(afterRevision?: number): Promise<EventsResponse>;
}
