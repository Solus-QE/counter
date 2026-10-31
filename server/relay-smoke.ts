/** Real-service integration driver; production pilot implementations belong in agents/. */
import {
  AgentRelay,
  type RelayAgentClient,
  type RelayMessage,
} from "@agent-relay/sdk";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import type {
  AgentRequest,
  CommandMeta,
  CoordinatorMessage,
  MissionState,
  PilotId,
  RecoveryResult,
} from "../shared/contract";
import { angle, escaped, norm, steering, stalled } from "../core/geometry";
import { Store } from "./store";
import { Coordinator } from "./coordinator";
import { RelayBridge } from "./relay";
import { startRuntime } from "./runtime";

if (process.env.COUNTERWHORL_DEBUG_RELAY === "1") {
  const request = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const started = Date.now();
      const response = await request(input, init);
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "cast.agentrelay.com")
        console.log(
          "Relay HTTP",
          JSON.stringify({
            method: init?.method ?? "GET",
            path: url.pathname,
            status: response.status,
            ms: Date.now() - started,
          }),
        );
      return response;
    },
    { preconnect: request.preconnect },
  );
}

// Isolate real-service checks from the workspace used by concurrent agent workers.
const bootstrap = await AgentRelay.createWorkspace({
  name: `counterwhorl-test-${crypto.randomUUID().slice(0, 8)}`,
});
const workspaceKey = bootstrap.workspaceKey!;
const relay = new AgentRelay({
  workspaceKey,
  onError: () => console.error("Smoke Relay transport error"),
});
const dir = await mkdtemp(join(tmpdir(), "counterwhorl-relay-"));
const store = new Store(join(dir, "coordinator.sqlite"));
store.setSetting("relay.workspaceKey", workspaceKey);
const coordinatorName =
  process.env.RELAY_COORDINATOR_NAME ?? "counterwhorl-coordinator";
const coordinatorIdentity = await bootstrap.workspace.register({
  name: coordinatorName,
  type: "agent",
});
store.setSetting("relay.coordinator.token", coordinatorIdentity.token!);
const pilots = {} as Record<PilotId, RelayAgentClient>;
for (const pilot of ["navigator", "rescuer"] as const) {
  pilots[pilot] = await relay.workspace.register({
    name: process.env[`RELAY_${pilot.toUpperCase()}_NAME`] ?? pilot,
    type: "agent",
  });
}
const host = await startRuntime({ dataDir: join(dir, "actors"), quiet: true });
const coordinator = new Coordinator(host.actor, store);
let bridge = new RelayBridge(
  coordinator,
  workspaceKey,
  coordinatorIdentity.token,
);
const waits = new Map<
  string,
  {
    resolve: (value: RecoveryResult) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
const seen = new Set<string>();
function onMessage(message: RelayMessage) {
  if (process.env.COUNTERWHORL_DEBUG_RELAY === "1")
    console.log(
      "Smoke inbound",
      JSON.stringify({
        id: message.messageId,
        kind: message.kind,
        from: message.from,
        target: message.target,
      }),
    );
  if (message.from.name !== coordinatorName || seen.has(message.messageId))
    return;
  seen.add(message.messageId);
  let body: CoordinatorMessage;
  try {
    body = JSON.parse(message.text);
  } catch {
    return;
  }
  if (process.env.COUNTERWHORL_DEBUG_RELAY === "1")
    console.log(
      "Smoke response",
      JSON.stringify({
        type: body.type,
        commandId:
          body.type === "command_result" ? body.result.commandId : undefined,
        waiting: [...waits.keys()],
      }),
    );
  if (body.type !== "command_result") return;
  const pending = waits.get(body.result.commandId);
  if (pending) {
    clearTimeout(pending.timer);
    waits.delete(body.result.commandId);
    pending.resolve(body.result);
  }
}
const unsubscribers = [
  relay.addListener("dm.received", ({ message }) => onMessage(message)),
  relay.addListener("message.created", ({ message }) => onMessage(message)),
];
const meta = (s: MissionState): CommandMeta => ({
  runId: s.runId,
  commandId: crypto.randomUUID(),
  expectedRevision: s.revision,
  controlEpoch: s.controlEpoch,
});
function send(
  pilot: PilotId,
  input: Exclude<AgentRequest, { type: "get_state" }>,
): Promise<RecoveryResult> {
  return new Promise((resolve, reject) => {
    const id = input.command.commandId;
    const timer = setTimeout(() => {
      waits.delete(id);
      reject(
        new Error(
          `Timed out awaiting real Relay response: ${input.type}; bridge=${bridge.lastError ?? "healthy"}`,
        ),
      );
    }, 90000);
    waits.set(id, { resolve, reject, timer });
    void pilots[pilot]
      .sendMessage({
        to: `@${coordinatorName}`,
        text: JSON.stringify(input),
        idempotencyKey: `smoke-${crypto.randomUUID()}`,
      })
      .then((message) => {
        if (process.env.COUNTERWHORL_DEBUG_RELAY === "1")
          console.log(
            "Smoke sent",
            JSON.stringify({
              messageId: message.messageId,
              commandId: id,
              pilot,
            }),
          );
      })
      .catch((error) => {
        clearTimeout(timer);
        waits.delete(id);
        reject(error);
      });
  });
}
function accepted(result: RecoveryResult): MissionState {
  assert(
    result.ok,
    result.ok ? "Expected success" : JSON.stringify(result.error),
  );
  return result.state;
}
try {
  await bridge.start();
  assert(bridge.healthy, bridge.lastError ?? "Relay bridge is not healthy");
  let s = await coordinator.start({});
  s = await coordinator.challenge(s.runId);
  assert(stalled(s.position, s.goal));
  console.log("PASS real Terse challenge places Navigator at exact antipode");
  const forged = await send("rescuer", {
    type: "commit_movement",
    command: {
      ...meta(s),
      pilot: "navigator",
      tangent: s.rescueAxis,
      alpha: 0.2,
    },
  });
  assert(!forged.ok && forged.error.code === "UNAUTHORIZED");
  console.log("PASS authenticated Rescuer cannot impersonate Navigator");
  s = accepted(
    await send("navigator", {
      type: "request_handoff",
      command: {
        ...meta(s),
        requestId: crypto.randomUUID(),
        reason: "navigator_stalled",
      },
    }),
  );
  assert.equal(s.phase, "awaiting_rescue");
  // Send a real proposal while the coordinator is disconnected. The durable inbox must replay it.
  await bridge.stop();
  const proposal = {
    ...meta(s),
    requestId: s.pendingRecovery!.requestId,
    proposalId: crypto.randomUUID(),
    ...steering(s.position, s.rescueAxis)!,
  };
  const offline = send("rescuer", {
    type: "propose_recovery",
    command: proposal,
  });
  await Bun.sleep(300);
  bridge = new RelayBridge(
    coordinator,
    workspaceKey,
    coordinatorIdentity.token,
  );
  await bridge.start();
  s = accepted(await offline);
  assert.equal(s.activePilot, "rescuer");
  console.log(
    "PASS real Relay durable inbox replays proposal after coordinator reconnect",
  );
  while (!escaped(s.position, s.goal))
    s = accepted(
      await send("rescuer", {
        type: "commit_movement",
        command: {
          ...meta(s),
          pilot: "rescuer",
          ...steering(s.position, s.rescueAxis)!,
          alpha: Math.min(0.35, angle(s.position, s.rescueAxis)),
        },
      }),
    );
  s = accepted(
    await send("rescuer", { type: "return_control", command: meta(s) }),
  );
  assert.equal(s.activePilot, "navigator");
  console.log("PASS real Relay recovery escapes and returns control");
  let moves = 0;
  while (s.phase !== "completed" && moves++ < 40)
    s = accepted(
      await send("navigator", {
        type: "commit_movement",
        command: {
          ...meta(s),
          pilot: "navigator",
          ...steering(s.position, s.goal)!,
          alpha: Math.min(0.35, angle(s.position, s.goal)),
        },
      }),
    );
  assert.equal(s.phase, "completed");
  assert(s.trajectory.every((p) => Math.abs(norm(p.position) - 1) < 1e-12));
  assert(
    s.events
      .filter((e) =>
        [
          "recovery_requested",
          "handoff_granted",
          "movement_committed",
          "control_returned",
        ].includes(e.type),
      )
      .every((e) => !!e.relayMessageId),
  );
  console.log(
    `PASS mission completed through real Relay in ${moves} Navigator movements; ${s.events.length} durable events`,
  );
} finally {
  for (const pending of waits.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error("Test shutdown"));
  }
  waits.clear();
  for (const unsubscribe of unsubscribers) unsubscribe();
  await bridge.stop();
  await relay.events.disconnect();
  await host.runtime.stop();
  store.close();
}
