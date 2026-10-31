/**
 * Real end-to-end rescue: backend + two independent agent processes over real Agent Relay.
 * Usage: bun agents/e2e.ts [--external] [--isolated] [--resume <runId>]
 *   default     uses the running `bun run dev` backend and the setup:relay identities
 *   --external  uses agents you already started
 *   --isolated  creates a fresh Relay workspace with its own three identities and hosts the unmodified
 *               server/ Coordinator, RelayBridge, Terse runtime and HTTP handler on temp dirs and a random port
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRelay } from "@agent-relay/sdk";
import type {
  EventsResponse,
  HealthResponse,
  MissionResponse,
  MissionState,
} from "../shared/contract";
import { loadConfig } from "./config";
import { LEDGER_FILE, withRelayRetry } from "./link";
import { spawnAgent, type AgentProcess } from "./spawn";
import { decodePeer } from "./protocol";
import { angle, norm, stalled } from "../core/geometry";

const verificationStartedAt = Date.now();

const external = process.argv.includes("--external");
const resumeRun = process.argv.includes("--resume")
  ? process.argv[process.argv.indexOf("--resume") + 1]
  : undefined;
const isolated = process.argv.includes("--isolated");
const agentEnv: Record<string, string> = {};
const teardown: Array<() => Promise<unknown>> = [];
let verifyPersistedState: ((state: MissionState) => Promise<void>) | undefined;

async function isolatedStack(): Promise<string> {
  const [
    { startRuntime },
    { Store },
    { Coordinator },
    { RelayBridge },
    { createHandler },
  ] = await Promise.all([
    import("../server/runtime"),
    import("../server/store"),
    import("../server/coordinator"),
    import("../server/relay"),
    import("../server/http"),
  ]);
  const log = (text: string) => console.log(`E2E setup: ${text}`);
  const relay = await withRelayRetry(
    () =>
      AgentRelay.createWorkspace({
        name: `counterwhorl-e2e-${crypto.randomUUID().slice(0, 8)}`,
        baseUrl: process.env.RELAY_BASE_URL,
      }),
    log,
  );
  const tokens: Record<string, { token: string; name: string }> = {};
  for (const role of ["coordinator", "navigator", "rescuer"] as const) {
    const client = await withRelayRetry(
      () =>
        relay.workspace.register({
          name: role === "coordinator" ? "counterwhorl-coordinator" : role,
          type: "agent",
        }),
      log,
    );
    if (!client.token) throw new Error(`no token for ${role}`);
    tokens[role] = { token: client.token, name: client.name };
  }
  await relay.events.disconnect();
  console.log(
    `E2E isolated Relay workspace created with fresh coordinator/navigator/rescuer identities`,
  );
  const dir = mkdtempSync(join(tmpdir(), "counterwhorl-agents-e2e-"));
  const store = new Store(join(dir, "coordinator.sqlite"));
  // The pilot API authenticates each agent with its own Relay token.
  store.setSetting("relay.navigator.token", tokens.navigator.token);
  store.setSetting("relay.rescuer.token", tokens.rescuer.token);
  const runtimeOptions = { dataDir: join(dir, "actors"), quiet: true };
  let host = await startRuntime(runtimeOptions);
  let terseAvailable = true;
  const observeRuntime = () =>
    void host.runtime.closed.then(
      () => {
        terseAvailable = false;
      },
      () => {
        terseAvailable = false;
      },
    );
  observeRuntime();
  const coordinator = new Coordinator((id) => host.actor(id), store);
  process.env.RELAY_NAVIGATOR_NAME = tokens.navigator.name;
  process.env.RELAY_RESCUER_NAME = tokens.rescuer.name;
  const bridge = new RelayBridge(
    coordinator,
    relay.workspaceKey!,
    tokens.coordinator.token,
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createHandler(coordinator, () => ({
      terse: terseAvailable,
      relay: bridge.healthy,
      relayError: bridge.lastError,
    })),
  });
  void bridge.start();
  teardown.push(
    () => server.stop(true),
    () => bridge.stop(),
    () => host.runtime.stop(),
    async () => store.close(),
  );
  Object.assign(agentEnv, {
    RELAY_WORKSPACE_KEY: relay.workspaceKey!,
    RELAY_COORDINATOR_NAME: tokens.coordinator.name,
    RELAY_NAVIGATOR_NAME: tokens.navigator.name,
    RELAY_RESCUER_NAME: tokens.rescuer.name,
    RELAY_NAVIGATOR_TOKEN: tokens.navigator.token,
    RELAY_RESCUER_TOKEN: tokens.rescuer.token,
    COUNTERWHORL_API_URL: server.url.origin,
  });
  verifyPersistedState = async (state) => {
    await host.runtime.stop();
    host = await startRuntime(runtimeOptions);
    terseAvailable = true;
    observeRuntime();
    assert.deepEqual(await host.actor(state.runId).getState(), state);
    console.log(
      `E2E persistence PASS: native Terse restart restored ${state.runId} at r${state.revision} with ${state.events.length} events and ${state.trajectory.length} trajectory points`,
    );
  };
  return server.url.origin;
}

const api = isolated ? await isolatedStack() : loadConfig("navigator").apiUrl;
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 40 * 60 * 1000);
const json = async <T>(path: string, body?: unknown): Promise<T> => {
  const response = await fetch(
    `${api}${path}`,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (!response.ok)
    throw new Error(`${path} → ${response.status} ${JSON.stringify(data)}`);
  return data as T;
};
const fail = (message: string): never => {
  throw new Error(message);
};

async function waitHealthy() {
  const end = Date.now() + 90000;
  let last: HealthResponse | undefined;
  while (Date.now() < end) {
    // Agents talk to Terse through the pilot API and to each other over their own Relay clients,
    // so the coordinator bridge's Relay health is informational here.
    try {
      last = await json<HealthResponse>("/api/health");
      if (last.terse) return;
    } catch {}
    await Bun.sleep(1000);
  }
  fail(`backend not healthy at ${api}: ${JSON.stringify(last)}`);
}

const children: AgentProcess[] = [];
let exitCode = 0;
try {
  await waitHealthy();
  console.log(
    `E2E backend readiness at ${api}: ${JSON.stringify(await json<HealthResponse>("/api/health"))}`,
  );
  if (!external) {
    const rescuer = spawnAgent("agents/rescuer.ts", [], agentEnv);
    children.push(rescuer);
    await rescuer.waitFor(/READY/, 60000);
    const navigator = spawnAgent("agents/navigator.ts", [], {
      ...agentEnv,
      ...(resumeRun ? { AGENT_RESUME_RUNS: resumeRun } : {}),
    });
    children.push(navigator);
    await navigator.waitFor(/READY/, 60000);
  }
  let state = resumeRun
    ? (await json<MissionResponse>(`/api/missions/${resumeRun}`)).state
    : (await json<MissionResponse>("/api/missions", {})).state;
  const runId = state.runId;
  console.log(
    resumeRun
      ? `E2E resuming mission ${runId} at r${state.revision} (${state.phase}) with freshly started agents`
      : `E2E mission ${runId} started`,
  );
  const poll = async (
    predicate: (s: MissionState) => boolean,
    ms: number,
    what: string,
  ) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      state = (await json<MissionResponse>(`/api/missions/${runId}`)).state;
      if (predicate(state)) return state;
      await Bun.sleep(250);
    }
    return fail(
      `timed out waiting for ${what}; phase=${state.phase} r${state.revision}`,
    );
  };
  if (!resumeRun) {
    await poll(
      (s) =>
        s.events.some(
          (e) => e.type === "movement_committed" && e.pilot === "navigator",
        ),
      TIMEOUT_MS,
      "first Navigator movement",
    );
    console.log(
      `E2E Navigator is steering autonomously (r${state.revision}); forcing antipodal challenge`,
    );
    const challenged = (
      await json<MissionResponse>(`/api/missions/${runId}/challenge`, {})
    ).state;
    assert(
      stalled(challenged.position, challenged.goal),
      "challenge did not place Navigator at its mathematical blind spot",
    );
    console.log(
      `E2E blind spot verified at r${challenged.revision}: position=${JSON.stringify(challenged.position)} goal=${JSON.stringify(challenged.goal)}`,
    );
  }
  await poll((s) => s.phase === "completed", TIMEOUT_MS, "mission completion");
  const { events } = await json<EventsResponse>(
    `/api/missions/${runId}/events?afterRevision=0`,
  );

  console.log(`\nE2E authoritative Terse timeline for ${runId}:`);
  console.log(
    "rev  type                  pilot        epoch  relayMessageId          detail",
  );
  for (const e of events)
    console.log(
      `${String(e.revision).padEnd(4)} ${e.type.padEnd(21)} ${e.pilot.padEnd(12)} ${String(e.controlEpoch).padEnd(6)} ${(e.relayMessageId ?? "(http)").padEnd(23)} ${e.detail ?? ""}`,
    );

  const challengeAt = events.findIndex((e) => e.type === "challenge_forced");
  const after = events.slice(challengeAt).map((e) => `${e.type}:${e.pilot}`);
  let cursor = -1;
  for (const step of [
    "recovery_requested:navigator",
    "handoff_granted:coordinator",
    "movement_committed:rescuer",
    "control_returned:rescuer",
    "mission_completed:navigator",
  ]) {
    const index = after.indexOf(step, cursor + 1);
    if (index <= cursor)
      fail(`expected ${step} after position ${cursor} in ${after.join(", ")}`);
    cursor = index;
  }
  const requested = events.find((e) => e.type === "recovery_requested")!;
  const grant = events.find((e) => e.type === "handoff_granted")!;
  const returned = events.find((e) => e.type === "control_returned")!;
  const challenged = events[challengeAt];
  const completed = events.find((e) => e.type === "mission_completed")!;
  if (!/^(det|llm)-[AB]-/.test(grant.detail ?? ""))
    fail(`unexpected proposal ID ${grant.detail}`);
  const handoffId = requested.detail;

  // recovery_complete is sent only after Terse commits the return; give it a moment to be recorded.
  const allLedgerRows = () =>
    existsSync(LEDGER_FILE)
      ? readFileSync(LEDGER_FILE, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
          .filter((r) => r.handoffId === handoffId)
      : [];
  const ledgerRows = () => allLedgerRows().filter((r) => r.dir === "out");
  const end = Date.now() + 60000;
  while (
    !(
      ledgerRows().some((r) => r.type === "recovery_complete") &&
      allLedgerRows().some(
        (r) =>
          r.type === "recovery_complete" &&
          r.dir === "in" &&
          r.role === "navigator",
      )
    ) &&
    Date.now() < end
  )
    await Bun.sleep(250);
  const peer = ledgerRows();
  console.log(
    `\nE2E Navigator ⇄ Rescuer Relay messages for handoff ${handoffId} (real Relay IDs, from ${LEDGER_FILE}):`,
  );
  for (const r of peer)
    console.log(
      `  ${r.at} ${r.role.padEnd(9)} → ${r.to.padEnd(9)} ${r.type.padEnd(17)} ${r.messageId}`,
    );
  const request = peer.find(
    (r) =>
      r.type === "recovery_request" && r.messageId === requested.relayMessageId,
  );
  const grantRequest = peer.find(
    (r) =>
      r.type === "recovery_request" && r.messageId === grant.relayMessageId,
  );
  const complete = peer.find((r) => r.type === "recovery_complete");
  if (!request) fail("no recovery_request Relay message recorded");
  if (!grantRequest)
    fail(
      "handoff_granted does not cite a genuine recovery_request in the Relay ledger",
    );
  if (!complete) fail("no recovery_complete Relay message recorded");
  if (requested.relayMessageId !== request.messageId)
    fail(
      `recovery_requested cites ${requested.relayMessageId}, expected Relay request ${request.messageId}`,
    );
  if (
    !allLedgerRows().some(
      (r) =>
        r.dir === "in" &&
        r.role === "rescuer" &&
        r.type === "recovery_request" &&
        r.messageId === grantRequest.messageId,
    )
  )
    fail("Rescuer did not record receiving the granted recovery_request");
  if (
    !allLedgerRows().some(
      (r) =>
        r.dir === "in" &&
        r.role === "navigator" &&
        r.type === "recovery_complete" &&
        r.messageId === complete.messageId,
    )
  )
    fail("Navigator did not record receiving recovery_complete");
  if (Date.parse(complete.at) < Date.parse(returned.timestamp))
    fail("recovery_complete was sent before Terse committed control_returned");

  const at = (e: { timestamp: string }) => Date.parse(e.timestamp);
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  console.log(`\nE2E timing (Terse event timestamps):`);
  console.log(
    `  mission_started → mission_completed ${seconds(at(completed) - at(events[0]))}`,
  );
  console.log(
    `  challenge → recovery_requested   ${seconds(at(requested) - at(challenged))}`,
  );
  console.log(
    `  challenge → handoff_granted      ${seconds(at(grant) - at(challenged))}`,
  );
  console.log(
    `  challenge → control_returned     ${seconds(at(returned) - at(challenged))}   ← complete recovery`,
  );
  console.log(
    `  challenge → mission_completed    ${seconds(at(completed) - at(challenged))}`,
  );
  console.log(
    `  control_returned → recovery_complete sent  ${seconds(Date.parse(complete.at) - at(returned))}`,
  );
  assert(
    angle(state.position, state.goal) <= 1e-4,
    "final pointing did not reach target",
  );
  assert(
    state.trajectory.every(
      (point) => Math.abs(norm(point.position) - 1) < 1e-12,
    ),
    "trajectory left the unit sphere",
  );

  // Retrieve the essential DMs from Relay independently of the process ledger,
  // then verify their source identities and exact mission/handoff contents.
  const workspaceKey =
    agentEnv.RELAY_WORKSPACE_KEY ?? loadConfig("navigator").workspaceKey;
  const auditRelay = new AgentRelay({ workspaceKey, baseUrl: process.env.RELAY_BASE_URL, sessionRef: "", retryPolicy: {maxRetries:0} });
  try {
    for (const [role, id, type] of [
      ["rescuer", grantRequest.messageId, "recovery_request"],
      ["navigator", complete.messageId, "recovery_complete"],
    ] as const) {
      const token =
        agentEnv[`RELAY_${role.toUpperCase()}_TOKEN`] ?? loadConfig(role).token;
      if (!token)
        fail(`missing ${role} token for independent Relay verification`);
      const recipient = await withRelayRetry(() =>
        auditRelay.workspace.reconnect({ apiToken: token! }),
      );
      const message = await withRelayRetry(() => recipient.messages.get(id));
      const body = decodePeer(message.text);
      assert(
        body &&
          body.type === type &&
          "runId" in body &&
          body.runId === runId &&
          "handoffId" in body &&
          body.handoffId === handoffId,
        `Relay message ${id} does not match the observed handoff`,
      );
      const sender = await withRelayRetry(() =>
        recipient.agents.get(
          role === "rescuer"
            ? (agentEnv.RELAY_NAVIGATOR_NAME ??
                loadConfig("navigator").names.navigator)
            : (agentEnv.RELAY_RESCUER_NAME ??
                loadConfig("rescuer").names.rescuer),
        ),
      );
      assert.equal(message.from.id, sender.id);
      console.log(
        `E2E Relay fetch PASS: ${type} ${id}, sender=${sender.name}/${sender.id}, authenticated recipient=${recipient.name}/${recipient.id}`,
      );
    }
  } finally {
    await auditRelay.events.disconnect();
  }

  const finalHealth = await json<HealthResponse>("/api/health");
  console.log(`E2E final backend health: ${JSON.stringify(finalHealth)}`);
  for (const child of children) child.proc.kill("SIGTERM");
  await Promise.all(children.map((c) => c.proc.exited));
  children.length = 0;
  if (verifyPersistedState) await verifyPersistedState(state);
  mkdirSync(".counterwhorl/verification", { recursive: true, mode: 0o700 });
  const report = {
    runId,
    api,
    finalHealth,
    state,
    peerMessages: allLedgerRows(),
    timingsMs: {
      mission: at(completed) - at(events[0]),
      challengeToRecovery: at(returned) - at(challenged),
      challengeToCompletion: at(completed) - at(challenged),
      verificationWall: Date.now() - verificationStartedAt,
    },
    persistenceRestartVerified: !!verifyPersistedState,
  };
  const reportPath = `.counterwhorl/verification/${runId}.json`;
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(`E2E evidence: ${reportPath}`);
  console.log(
    `\nE2E PASS: ${events.length} durable events, ${peer.length} Relay messages between agents for this handoff, decision ${grant.detail!.startsWith("llm") ? "LLM" : "DETERMINISTIC FALLBACK"} (proposal ${grant.detail})`,
  );
} catch (error) {
  console.error(
    `\nE2E FAIL: ${error instanceof Error ? error.message : error}`,
  );
  exitCode = 1;
} finally {
  for (const child of children) child.proc.kill("SIGTERM");
  await Promise.all(children.map((c) => c.proc.exited));
  for (const step of teardown) await step().catch(() => {});
  process.exit(exitCode);
}
