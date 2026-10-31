import { startRuntime } from "./runtime";
import { Store } from "./store";
import { Coordinator } from "./coordinator";
import { RelayBridge } from "./relay";
import { createHandler } from "./http";

const store = new Store();
const runtimeKey =
  process.env.TERSE_API_KEY ??
  store.setting("terse.apiKey") ??
  crypto.randomUUID();
store.setSetting("terse.apiKey", runtimeKey);
const host = await startRuntime({ apiKey: runtimeKey });
const coordinator = new Coordinator(host.actor, store);
const bridge = new RelayBridge(coordinator);
let terse = true;
void host.runtime.closed
  .then(() => {
    terse = false;
  })
  .catch(() => {
    terse = false;
  });
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 3001),
  maxRequestBodySize: 65536,
  fetch: createHandler(coordinator, () => ({
    terse,
    relay: bridge.healthy,
    relayError: bridge.lastError,
  })),
});
console.log(`COUNTERWHORL API listening at ${server.url}`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server.stop(true);
  await bridge.stop();
  await host.runtime.stop();
  store.close();
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
await bridge.start();
if (bridge.lastError) console.error(bridge.lastError);
