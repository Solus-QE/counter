import { z } from "zod";
export const vectorSchema = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.-]+$/);
const commandMeta = {
  runId: id,
  commandId: id,
  expectedRevision: z.number().int().nonnegative(),
  controlEpoch: z.number().int().nonnegative(),
};
export const startSchema = z
  .object({
    position: vectorSchema.optional(),
    goal: vectorSchema.optional(),
    rescueAxis: vectorSchema.optional(),
  })
  .strict();
export const agentRequestSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("get_state"), runId: id, correlationId: id })
    .strict(),
  z
    .object({
      type: z.literal("request_handoff"),
      command: z
        .object({
          ...commandMeta,
          requestId: id,
          reason: z.literal("navigator_stalled"),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("propose_recovery"),
      command: z
        .object({
          ...commandMeta,
          requestId: id,
          proposalId: id,
          tangent: vectorSchema,
          alpha: z.number().finite(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("commit_movement"),
      command: z
        .object({
          ...commandMeta,
          pilot: z.enum(["navigator", "rescuer"]),
          tangent: vectorSchema,
          alpha: z.number().finite(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("return_control"),
      command: z.object(commandMeta).strict(),
    })
    .strict(),
]);
