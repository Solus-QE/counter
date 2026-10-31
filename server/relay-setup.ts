import { AgentRelay, safeRelayErrorMessage } from "@agent-relay/sdk";
import { writeFileSync } from "node:fs";
import { Store } from "./store";

export async function setupRelay(store: Store): Promise<void> {
  const workspaceKey =
    process.env.RELAY_WORKSPACE_KEY ?? store.setting("relay.workspaceKey");
  const relay = workspaceKey
    ? new AgentRelay({ workspaceKey, baseUrl: process.env.RELAY_BASE_URL })
    : await AgentRelay.createWorkspace({
        name: `counterwhorl-${crypto.randomUUID().slice(0, 8)}`,
        baseUrl: process.env.RELAY_BASE_URL,
      });
  if (!relay.workspaceKey)
    throw new Error("Relay did not return a workspace key");
  store.setSetting("relay.workspaceKey", relay.workspaceKey);
  const rows: string[] = [];
  for (const role of ["coordinator", "navigator", "rescuer"] as const) {
    const configuredName =
      process.env[`RELAY_${role.toUpperCase()}_NAME`] ??
      (role === "coordinator" ? "counterwhorl-coordinator" : role);
    const token =
      process.env[`RELAY_${role.toUpperCase()}_TOKEN`] ??
      store.setting(`relay.${role}.token`);
    const client = token
      ? await relay.workspace.reconnect({ apiToken: token })
      : await relay.workspace.register({ name: configuredName, type: "agent" });
    if (!client.token)
      throw new Error(`Relay did not return a token for ${role}`);
    store.setSetting(`relay.${role}.token`, client.token);
    store.setSetting(`relay.${role}.name`, client.name);
    store.setSetting(`relay.${role}.id`, client.id);
    rows.push(
      `RELAY_${role.toUpperCase()}_TOKEN=${client.token}`,
      `RELAY_${role.toUpperCase()}_NAME=${client.name}`,
    );
  }
  // Private handoff to the independently owned agents/ workers. No credentials in logs.
  writeFileSync(
    ".counterwhorl/relay-agents.env",
    [`RELAY_WORKSPACE_KEY=${relay.workspaceKey}`, ...rows, ""].join("\n"),
    { mode: 0o600 },
  );
  await relay.events.disconnect();
  console.log(
    "Real Relay workspace and three identities ready. Credentials: .counterwhorl/relay-agents.env (mode 0600)",
  );
}
if (import.meta.main) {
  const store = new Store();
  try {
    await setupRelay(store);
  } catch (error) {
    console.error(`Relay setup failed: ${safeRelayErrorMessage(error)}`);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}
