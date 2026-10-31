import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRuntime, missionActor } from "../server/runtime";
import { angle, escaped, norm, stalled, steering } from "../core/geometry";
import type { CommandMeta, MissionState } from "../shared/contract";

let host: Awaited<ReturnType<typeof startRuntime>>;
let dataDir: string;
const key = crypto.randomUUID();
const meta = (s: MissionState): CommandMeta => ({
  runId: s.runId,
  commandId: crypto.randomUUID(),
  expectedRevision: s.revision,
  controlEpoch: s.controlEpoch,
});
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "counterwhorl-"));
  host = await startRuntime({ dataDir, apiKey: key, quiet: true });
}, 180000);

test("real Terse persists Rescuer movement and completes an antipodal mission after restart", async () => {
  const runId = "antipodal-recovery";
  let actor = host.actor(runId);
  let s = await actor.startMission("coordinator", {
    runId,
    commandId: "start",
    position: [0, 0, -1],
    goal: [0, 0, 1],
  });
  expect(stalled(s.position, s.goal)).toBe(true);
  expect(steering(s.position, s.goal)).toBeNull();
  await expect(
    actor.commitMovement("navigator", {
      ...meta(s),
      pilot: "navigator",
      tangent: s.rescueAxis,
      alpha: 0.2,
    }),
  ).rejects.toThrow("POLICY_VIOLATION");
  expect(await actor.getState()).toEqual(s);
  s = await actor.requestHandoff("navigator", {
    ...meta(s),
    requestId: "recovery",
    reason: "navigator_stalled",
  });
  s = await actor.grantHandoff("coordinator", {
    ...meta(s),
    requestId: "recovery",
    proposalId: "proposal",
    ...steering(s.position, s.rescueAxis)!,
  });
  const firstMovement = {
    ...meta(s),
    pilot: "rescuer" as const,
    ...steering(s.position, s.rescueAxis)!,
  };
  s = await actor.commitMovement("rescuer", firstMovement);
  expect(s.activePilot).toBe("rescuer");
  expect(s.controlEpoch).toBe(1);
  expect(s.position).not.toEqual([0, 0, -1]);
  await host.runtime.stop();
  host = await startRuntime({ dataDir, apiKey: key, quiet: true });
  actor = host.actor(runId);
  expect(await actor.getState()).toEqual(s);
  await expect(actor.commitMovement("rescuer", firstMovement)).rejects.toThrow(
    "DUPLICATE_COMMAND",
  );
  await expect(
    actor.commitMovement("navigator", {
      ...meta(s),
      controlEpoch: 0,
      pilot: "navigator",
      ...steering(s.position, s.goal)!,
    }),
  ).rejects.toThrow("STALE_EPOCH");
  let rescueMoves = 1;
  while (!escaped(s.position, s.goal) && rescueMoves < 10) {
    s = await actor.commitMovement("rescuer", {
      ...meta(s),
      pilot: "rescuer",
      ...steering(s.position, s.rescueAxis)!,
    });
    rescueMoves++;
  }
  expect(escaped(s.position, s.goal)).toBe(true);
  s = await actor.returnControl("rescuer", meta(s));
  expect(s.activePilot).toBe("navigator");
  expect(s.controlEpoch).toBe(2);
  let navigatorMoves = 0;
  while (s.phase !== "completed" && navigatorMoves < 40) {
    s = await actor.commitMovement("navigator", {
      ...meta(s),
      pilot: "navigator",
      ...steering(s.position, s.goal)!,
    });
    navigatorMoves++;
  }
  expect(s.phase).toBe("completed");
  expect(angle(s.position, s.goal)).toBeLessThanOrEqual(1e-4);
  expect(
    s.trajectory.every((point) => Math.abs(norm(point.position) - 1) < 1e-12),
  ).toBe(true);
  expect(await actor.getState()).toEqual(s);
  console.log(
    "Real Terse recovery:",
    JSON.stringify({
      runId,
      revision: s.revision,
      controlEpoch: s.controlEpoch,
      rescueMoves,
      navigatorMoves,
      events: s.events.length,
      phase: s.phase,
    }),
  );
}, 180000);
afterAll(async () => {
  await host?.runtime.stop();
});
test("real Terse serializes conflicting writes and rejects invalid commands atomically", async () => {
  const actor = host.actor("concurrency");
  const s = await actor.startMission("coordinator", {
    runId: "concurrency",
    commandId: "start",
    position: [1, 0, 0],
    goal: [0, 0, 1],
  });
  const command = {
    ...meta(s),
    pilot: "navigator" as const,
    ...steering(s.position, s.goal)!,
  };
  const results = await Promise.allSettled([
    actor.commitMovement("navigator", command),
    actor.commitMovement("navigator", {
      ...command,
      commandId: crypto.randomUUID(),
    }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const committed = await actor.getState();
  expect(committed.revision).toBe(2);
  expect(committed.events).toHaveLength(2);
  expect(committed.trajectory).toHaveLength(2);
  await expect(
    actor.commitMovement("navigator", {
      ...command,
      expectedRevision: committed.revision,
      commandId: crypto.randomUUID(),
      alpha: 0.4,
    }),
  ).rejects.toThrow();
  await expect(
    actor.forceBlindSpotChallenge("rescuer", meta(committed)),
  ).rejects.toThrow();
  expect(await actor.getState()).toEqual(committed);
}, 60000);
test("persisted state and command IDs survive client reconnect and runtime restart", async () => {
  const actor = host.actor("persistence");
  let s = await actor.startMission("coordinator", {
    runId: "persistence",
    commandId: "start",
    position: [1, 0, 0],
    goal: [0, 0, 1],
  });
  const command = meta(s);
  s = await actor.forceBlindSpotChallenge("coordinator", command);
  expect(await missionActor(host.transport, "persistence").getState()).toEqual(
    s,
  );
  await host.runtime.stop();
  host = await startRuntime({ dataDir, apiKey: key, quiet: true });
  const reconnected = host.actor("persistence");
  expect(await reconnected.getState()).toEqual(s);
  await expect(
    reconnected.forceBlindSpotChallenge("coordinator", command),
  ).rejects.toThrow("DUPLICATE_COMMAND");
  expect(await reconnected.getState()).toEqual(s);
}, 180000);
