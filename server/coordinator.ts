import type {
  AgentRequest,
  CoordinatorMessage,
  MissionActorApi,
  MissionState,
  PilotId,
  StartMissionRequest,
} from "../shared/contract";
import { errorResponse, fail } from "../core/mission";
import { Store } from "./store";

export class Coordinator {
  constructor(
    readonly actor: (id: string) => MissionActorApi,
    readonly store: Store,
  ) {}
  knownActor(id: string): MissionActorApi {
    if (!this.store.hasRun(id)) fail("NOT_FOUND", "Unknown mission");
    return this.actor(id);
  }
  async start(input: StartMissionRequest): Promise<MissionState> {
    const runId = crypto.randomUUID();
    // Index first: a process crash cannot orphan a successfully started actor.
    this.store.registerRun(runId);
    return this.actor(runId).startMission("coordinator", {
      runId,
      commandId: crypto.randomUUID(),
      position: input.position ?? [1, 0, 0],
      goal: input.goal ?? [0, 0, 1],
      rescueAxis: input.rescueAxis,
    });
  }
  async challenge(runId: string): Promise<MissionState> {
    const actor = this.knownActor(runId);
    const s = await actor.getState();
    return actor.forceBlindSpotChallenge("coordinator", {
      runId,
      commandId: crypto.randomUUID(),
      expectedRevision: s.revision,
      controlEpoch: s.controlEpoch,
    });
  }
  async dispatch(
    pilot: PilotId,
    /** Relay message ID, or undefined for an authenticated HTTP pilot command without one. */
    messageId: string | undefined,
    input: AgentRequest,
  ): Promise<CoordinatorMessage> {
    if (input.type === "get_state") {
      try {
        return {
          type: "mission_state",
          correlationId: input.correlationId,
          state: await this.knownActor(input.runId).getState(),
        };
      } catch (error) {
        return {
          type: "command_result",
          result: {
            ok: false,
            commandId: input.correlationId,
            error: errorResponse(error),
          },
        };
      }
    }
    const command = { ...input.command, relayMessageId: messageId };
    try {
      const actor = this.knownActor(command.runId);
      let state: MissionState;
      switch (input.type) {
        case "request_handoff":
          if (pilot !== "navigator")
            fail("UNAUTHORIZED", "Only Navigator may request recovery");
          state = await actor.requestHandoff(pilot, {
            ...input.command,
            relayMessageId: messageId,
          });
          break;
        case "propose_recovery":
          if (pilot !== "rescuer")
            fail("UNAUTHORIZED", "Only Rescuer may propose recovery");
          state = await actor.grantHandoff("coordinator", {
            ...input.command,
            relayMessageId: messageId,
          });
          break;
        case "commit_movement":
          if (input.command.pilot !== pilot)
            fail("UNAUTHORIZED", "Payload pilot differs from Relay sender");
          state = await actor.commitMovement(pilot, {
            ...input.command,
            relayMessageId: messageId,
          });
          break;
        case "return_control":
          state = await actor.returnControl(pilot, command);
          break;
      }
      return {
        type: "command_result",
        result: { ok: true, commandId: command.commandId, state },
      };
    } catch (error) {
      const parsed = errorResponse(error);
      // Recover an acknowledged actor write if the coordinator crashed before saving its response.
      // A different Relay message reusing the same command ID remains a duplicate rejection.
      if (parsed.code === "DUPLICATE_COMMAND" && messageId !== undefined) {
        const state = await this.knownActor(command.runId).getState();
        if (
          state.events.some(
            (e) =>
              e.commandId === command.commandId &&
              e.relayMessageId === messageId,
          )
        )
          return {
            type: "command_result",
            result: { ok: true, commandId: command.commandId, state },
          };
      }
      return {
        type: "command_result",
        result: { ok: false, commandId: command.commandId, error: parsed },
      };
    }
  }
}
