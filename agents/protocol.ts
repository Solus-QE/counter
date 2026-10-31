import { z } from "zod";
import type { CoordinatorMessage } from "../shared/contract";
import { vectorSchema } from "../shared/validation";

/** Runtime validation for everything an agent receives. Mirrors shared/contract.ts. */
export const MAX_MESSAGE_BYTES=256*1024;
const id=z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.-]+$/);
const relayId=z.string().min(1).max(256);
const revision=z.number().int().nonnegative();
const principal=z.enum(["navigator","rescuer","coordinator"]);

export const missionEventSchema=z.object({
  id: z.string().min(1),
  runId: id,
  revision,
  timestamp: z.string(),
  type: z.enum(["mission_started","challenge_forced","recovery_requested","handoff_granted","movement_committed","control_returned","mission_completed"]),
  pilot: principal,
  controlEpoch: revision,
  commandId: z.string().min(1),
  relayMessageId: z.string().optional(),
  position: vectorSchema,
  detail: z.string().optional(),
});
export const missionStateSchema=z.object({
  runId: id,
  revision,
  position: vectorSchema,
  goal: vectorSchema,
  rescueAxis: vectorSchema,
  phase: z.enum(["navigating","awaiting_rescue","rescuing","completed"]),
  activePilot: z.enum(["navigator","rescuer"]),
  controlEpoch: revision,
  processedCommandIds: z.array(z.string()),
  events: z.array(missionEventSchema),
  trajectory: z.array(z.object({revision,position:vectorSchema,pilot:principal,kind:z.enum(["start","movement","challenge"])})),
  pendingRecovery: z.object({requestId:z.string(),proposalId:z.string().optional()}).nullable(),
});
const apiError=z.object({code:z.enum(["UNAUTHORIZED","NOT_FOUND","ALREADY_STARTED","INVALID_COMMAND","INVALID_VECTOR","INVALID_MOVEMENT","STALE_REVISION","STALE_EPOCH","DUPLICATE_COMMAND","INVALID_PHASE","POLICY_VIOLATION","COMPLETED","UNAVAILABLE"]),message:z.string()});
export const coordinatorMessageSchema=z.discriminatedUnion("type",[
  z.object({type:z.literal("mission_state"),correlationId:z.string().min(1),state:missionStateSchema}),
  z.object({type:z.literal("command_result"),result:z.union([
    z.object({ok:z.literal(true),commandId:z.string().min(1),state:missionStateSchema}),
    z.object({ok:z.literal(false),commandId:z.string().min(1),error:apiError}),
  ])}),
  z.object({type:z.literal("mission_event"),event:missionEventSchema,state:missionStateSchema}),
]);

const decisionSchema=z.object({
  source: z.enum(["llm","deterministic_fallback","resume_deterministic"]),
  candidateId: z.enum(["A","B"]),
  reason: z.string().max(500),
  model: z.string().max(64).optional(),
}).strict();
const peer={v:z.literal(1)};
const run={...peer,runId:id,handoffId:id};
export const peerMessageSchema=z.discriminatedUnion("type",[
  z.object({type:z.literal("peer_ping"),...peer,nonce:id}).strict(),
  z.object({type:z.literal("peer_pong"),...peer,nonce:id,pingMessageId:relayId}).strict(),
  /** Navigator → Rescuer at the stall. Its Relay ID is then cited by request_handoff and propose_recovery in Terse. */
  z.object({type:z.literal("recovery_request"),...run,revision,controlEpoch:revision,position:vectorSchema}).strict(),
  z.object({type:z.literal("recovery_rejected"),...run,requestMessageId:relayId,reason:z.enum(["unknown_run","not_awaiting","handoff_mismatch","revision_ahead","no_valid_candidate","proposal_rejected"]),detail:z.string().max(500).optional()}).strict(),
  /** Rescuer → Navigator, sent only after Terse committed return_control at `revision`. Navigator still verifies in Terse. */
  z.object({type:z.literal("recovery_complete"),...run,revision,controlEpoch:revision,proposalId:id,rescueMoves:z.number().int().nonnegative(),decision:decisionSchema}).strict(),
]);

export type PeerMessage = z.infer<typeof peerMessageSchema>;
export type Decision = z.infer<typeof decisionSchema>;

/** Parse JSON text and validate it. Returns null for oversized, malformed, or nonconforming input. */
export function decode<T>(text: unknown,schema: z.ZodType<T>): T|null {
  if(typeof text!=="string"||text.length>MAX_MESSAGE_BYTES) return null;
  let raw: unknown;
  try {raw=JSON.parse(text);} catch {return null;}
  const parsed=schema.safeParse(raw);
  return parsed.success?parsed.data:null;
}
export const decodeCoordinator=(text: unknown)=>decode(text,coordinatorMessageSchema) as CoordinatorMessage|null;
export const decodePeer=(text: unknown)=>decode(text,peerMessageSchema);
