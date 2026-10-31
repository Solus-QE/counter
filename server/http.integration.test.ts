import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startRuntime } from "./runtime";
import { Coordinator } from "./coordinator";
import { Store } from "./store";
import { createHandler } from "./http";
import { RelayBridge } from "./relay";
import { steering } from "../core/geometry";
import type {
  ApiErrorResponse,
  HealthResponse,
  MissionResponse,
} from "../shared/contract";

let host: Awaited<ReturnType<typeof startRuntime>>;
let store: Store;
let coordinator: Coordinator;
let fetchApi: ReturnType<typeof createHandler>;
beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "counterwhorl-http-"));
  host = await startRuntime({ dataDir: join(dir, "actors"), quiet: true });
  store = new Store(join(dir, "api.sqlite"));
  coordinator = new Coordinator(host.actor, store);
  fetchApi = createHandler(coordinator, () => ({ terse: true, relay: false }));
}, 180000);
afterAll(async () => {
  await host?.runtime.stop();
  store?.close();
});
const call = (path: string, method = "GET", body?: unknown) =>
  fetchApi(
    new Request(`http://localhost:3001${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
test("HTTP starts, reads, challenges and exposes only authoritative events", async () => {
  const response = await call("/api/missions", "POST", {});
  expect(response.status).toBe(201);
  const body = (await response.json()) as MissionResponse;
  expect(Object.keys(body)).toEqual(["state"]);
  const { state } = body;
  expect(state).toMatchObject({
    revision: 1,
    position: [1, 0, 0],
    goal: [0, 0, 1],
    rescueAxis: [1, 0, 0],
    phase: "navigating",
    activePilot: "navigator",
    controlEpoch: 0,
    pendingRecovery: null,
  });
  expect(state.processedCommandIds).toHaveLength(1);
  expect(state.events).toHaveLength(1);
  expect(state.trajectory).toHaveLength(1);
  expect(
    (await (await call(`/api/missions/${state.runId}`)).json()).state,
  ).toEqual(state);
  const challenged = await (
    await call(`/api/missions/${state.runId}/challenge`, "POST", {})
  ).json();
  expect(challenged.state.position).toEqual([0, 0, -1]);
  const timeline = await (
    await call(`/api/missions/${state.runId}/events?afterRevision=1`)
  ).json();
  expect(Object.keys(timeline).sort()).toEqual(["events", "revision"]);
  expect(timeline.revision).toBe(challenged.state.revision);
  expect(timeline.events.map((e: { type: string }) => e.type)).toEqual([
    "challenge_forced",
  ]);
  expect(
    (await call(`/api/missions/${state.runId}/events?afterRevision=-1`)).status,
  ).toBe(400);
  expect(
    (
      await call(`/api/missions/${state.runId}/movement`, "POST", {
        pilot: "navigator",
      })
    ).status,
  ).toBe(404);
  expect(
    (await call("/api/missions", "POST", { pilot: "navigator" })).status,
  ).toBe(400);
  const missing = await call("/api/missions/unknown");
  expect(missing.status).toBe(404);
  const errorBody = (await missing.json()) as ApiErrorResponse;
  expect(Object.keys(errorBody)).toEqual(["error"]);
  expect(errorBody.error.code).toBe("NOT_FOUND");
  expect(errorBody.error.message).toContain("Unknown mission");
  const health = (await (await call("/api/health")).json()) as HealthResponse;
  expect(health).toEqual({ terse: true, relay: false });
}, 60000);
test("HTTP validates bodies, vectors, origins, and completed missions", async () => {
  expect(
    (await call("/api/missions", "POST", { position: [0, 0, 0] })).status,
  ).toBe(400);
  expect(
    (
      await fetchApi(
        new Request("http://localhost:3001/api/missions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await fetchApi(
        new Request("http://localhost:3001/api/missions", {
          method: "POST",
          headers: {
            origin: "https://untrusted.example",
            "content-type": "application/json",
          },
          body: "{}",
        }),
      )
    ).status,
  ).toBe(403);
  const { state } = await (
    await call("/api/missions", "POST", {
      position: [0, 0, 1],
      goal: [0, 0, 1],
    })
  ).json();
  expect(state.phase).toBe("completed");
  expect(
    (await call(`/api/missions/${state.runId}/challenge`, "POST", {})).status,
  ).toBe(409);
}, 60000);
test("coordinator rejects forged pilot payloads and reconciles same-message redelivery", async () => {
  const s = await coordinator.start({});
  const command = {
    runId: s.runId,
    commandId: crypto.randomUUID(),
    expectedRevision: s.revision,
    controlEpoch: s.controlEpoch,
    pilot: "navigator" as const,
    ...steering(s.position, s.goal)!,
  };
  const forged = await coordinator.dispatch("rescuer", "forged", {
    type: "commit_movement",
    command,
  });
  expect(
    forged.type === "command_result" &&
      !forged.result.ok &&
      forged.result.error.code,
  ).toBe("UNAUTHORIZED");
  const accepted = await coordinator.dispatch("navigator", "original", {
    type: "commit_movement",
    command,
  });
  expect(accepted.type === "command_result" && accepted.result.ok).toBe(true);
  const replay = await coordinator.dispatch("navigator", "original", {
    type: "commit_movement",
    command,
  });
  expect(replay.type === "command_result" && replay.result.ok).toBe(true);
  const duplicate = await coordinator.dispatch(
    "navigator",
    "different-message",
    { type: "commit_movement", command },
  );
  expect(
    duplicate.type === "command_result" &&
      !duplicate.result.ok &&
      duplicate.result.error.code,
  ).toBe("DUPLICATE_COMMAND");
}, 60000);

test("Relay retry payload remains identical after state changes and coordinator storage reconnect", async () => {
  const dir = await mkdtemp(join(tmpdir(), "counterwhorl-outbox-"));
  const filename = join(dir, "outbox.sqlite");
  const first = new Store(filename);
  const payload = {
    to: "@navigator",
    text: JSON.stringify({ revision: 1 }),
    idempotencyKey: "event-retry",
    metadata: { session_ref: "original-process" },
  };
  expect(first.outgoing("event-retry", payload)).toEqual(payload);
  first.close();
  const reopened = new Store(filename);
  try {
    const retry = reopened.outgoing("event-retry", {
      ...payload,
      text: JSON.stringify({ revision: 2 }),
      metadata: { session_ref: "new-process" },
    });
    expect(JSON.stringify(retry)).toBe(JSON.stringify(payload));
  } finally {
    reopened.close();
  }
});

test("pilot commands without a Relay citation reject duplicate IDs instead of reporting a new success", async () => {
  const s = await coordinator.start({});
  const command = {
    runId: s.runId,
    commandId: crypto.randomUUID(),
    expectedRevision: s.revision,
    controlEpoch: s.controlEpoch,
    pilot: "navigator" as const,
    ...steering(s.position, s.goal)!,
  };
  const first = await coordinator.dispatch("navigator", undefined, {
    type: "commit_movement",
    command,
  });
  expect(first.type === "command_result" && first.result.ok).toBe(true);
  const duplicate = await coordinator.dispatch("navigator", undefined, {
    type: "commit_movement",
    command,
  });
  expect(
    duplicate.type === "command_result" &&
      !duplicate.result.ok &&
      duplicate.result.error.code,
  ).toBe("DUPLICATE_COMMAND");
  if (first.type !== "command_result" || !first.result.ok)
    throw new Error("First movement did not commit");
  expect(await coordinator.actor(s.runId).getState()).toEqual(
    first.result.state,
  );
});

test("Relay bridge restores configured pilot names from storage with environment overrides", async () => {
  const dir = await mkdtemp(join(tmpdir(), "counterwhorl-identities-"));
  const identityStore = new Store(join(dir, "identities.sqlite"));
  const savedNavigator = process.env.RELAY_NAVIGATOR_NAME;
  const savedRescuer = process.env.RELAY_RESCUER_NAME;
  try {
    delete process.env.RELAY_NAVIGATOR_NAME;
    delete process.env.RELAY_RESCUER_NAME;
    identityStore.setSetting("relay.navigator.name", "custom-navigator");
    identityStore.setSetting("relay.rescuer.name", "custom-rescuer");
    const identityCoordinator = new Coordinator(host.actor, identityStore);
    expect(new RelayBridge(identityCoordinator).names).toEqual({
      navigator: "custom-navigator",
      rescuer: "custom-rescuer",
    });
    process.env.RELAY_NAVIGATOR_NAME = "override-navigator";
    expect(new RelayBridge(identityCoordinator).names).toEqual({
      navigator: "override-navigator",
      rescuer: "custom-rescuer",
    });
  } finally {
    if (savedNavigator === undefined) delete process.env.RELAY_NAVIGATOR_NAME;
    else process.env.RELAY_NAVIGATOR_NAME = savedNavigator;
    if (savedRescuer === undefined) delete process.env.RELAY_RESCUER_NAME;
    else process.env.RELAY_RESCUER_NAME = savedRescuer;
    identityStore.close();
  }
});
