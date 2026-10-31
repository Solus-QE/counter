import { Actor, Emittable, Persisted } from "durable-actors";
import type {
  CommandMeta,
  EventsResponse,
  MissionActorApi,
  MissionState,
  MovementCommand,
  Principal,
  RecoveryProposal,
  RecoveryRequest,
  StartMission,
} from "../shared/contract";
import {
  challenge,
  fail,
  grant,
  move,
  request,
  returnToNavigator,
  start,
} from "../core/mission";

export class Mission extends Actor implements MissionActorApi {
  @Persisted @Emittable state: MissionState | null = null;

  async startMission(
    principal: Principal,
    command: StartMission,
  ): Promise<MissionState> {
    return this.db.transaction(async () => {
      if (this.state)
        fail("ALREADY_STARTED", "Use a new actor ID for a new mission");
      if (command.runId !== this.id)
        fail("INVALID_COMMAND", "Run ID must match actor ID");
      this.state = start(principal, command);
      return this.state;
    });
  }
  async getState(): Promise<MissionState> {
    if (!this.state) fail("NOT_FOUND", "Mission has not started");
    return this.state;
  }
  async forceBlindSpotChallenge(
    principal: Principal,
    command: CommandMeta,
  ): Promise<MissionState> {
    return this.db.transaction(
      async () =>
        (this.state = challenge(await this.getState(), principal, command)),
    );
  }
  async requestHandoff(
    principal: Principal,
    command: RecoveryRequest,
  ): Promise<MissionState> {
    return this.db.transaction(
      async () =>
        (this.state = request(await this.getState(), principal, command)),
    );
  }
  async grantHandoff(
    principal: Principal,
    command: RecoveryProposal,
  ): Promise<MissionState> {
    return this.db.transaction(
      async () =>
        (this.state = grant(await this.getState(), principal, command)),
    );
  }
  async commitMovement(
    principal: Principal,
    command: MovementCommand,
  ): Promise<MissionState> {
    return this.db.transaction(
      async () =>
        (this.state = move(await this.getState(), principal, command)),
    );
  }
  async returnControl(
    principal: Principal,
    command: CommandMeta,
  ): Promise<MissionState> {
    return this.db.transaction(
      async () =>
        (this.state = returnToNavigator(
          await this.getState(),
          principal,
          command,
        )),
    );
  }
  async getEvents(afterRevision = 0): Promise<EventsResponse> {
    const s = await this.getState();
    return {
      events: s.events.filter((e) => e.revision > afterRevision),
      revision: s.revision,
    };
  }
}
