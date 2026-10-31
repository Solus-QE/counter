import { startLocalActors } from "durable-actors/dev";
import {
  createActorStub,
  createActorTransport,
  type ActorRpcTransport,
} from "durable-actors/backend";
import type { MissionActorApi } from "../shared/contract";
import { resolve } from "node:path";

const methodNames = [
  "startMission",
  "getState",
  "forceBlindSpotChallenge",
  "requestHandoff",
  "grantHandoff",
  "commitMovement",
  "returnControl",
  "getEvents",
] as const satisfies readonly (keyof MissionActorApi)[];
const methods = methodNames.map((name) => ({ name, result: "value" as const }));
export function missionActor(
  transport: ActorRpcTransport,
  runId: string,
): MissionActorApi {
  return createActorStub<MissionActorApi>("Mission", runId, methods, transport);
}
export async function startRuntime(
  options: { dataDir?: string; apiKey?: string; quiet?: boolean } = {},
) {
  process.env.DURABLE_ACTORS_CACHE_DIR ??= resolve(".counterwhorl/runtime");
  const runtime = await startLocalActors({
    entrypoint: "actors/index.ts",
    project: resolve("."),
    projectId: "counterwhorl",
    dataDir: options.dataDir ?? ".durable-actors",
    apiKey: options.apiKey ?? crypto.randomUUID(),
    quiet: options.quiet ?? false,
  });
  const { projectId, apiKey, controlPlaneUrl, storageRegion } =
    runtime.connection;
  const transport = createActorTransport({
    projectId,
    apiKey,
    controlPlaneUrl,
    homeRegion: storageRegion,
  });
  return {
    runtime,
    transport,
    actor: (runId: string) => missionActor(transport, runId),
  };
}
