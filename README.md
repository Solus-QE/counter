# COUNTERWHORL

Durable satellite-camera steering on the unit sphere, with a Navigator that stalls at the antipode and a complementary Rescuer that temporarily takes control.

Terse and Agent Relay are self-hosted.

## Run

```sh
npm install
npm run setup:relay
npm run dev
```

The API listens on `http://127.0.0.1:3001`. Setup creates a real Relay workspace and coordinator, Navigator, and Rescuer identities. It preserves their tokens for reconnect. Private worker configuration is written to `.counterwhorl/relay-agents.env` (0600); source that file in the independently owned agent processes. Never expose it to the browser. Setup can also use `RELAY_WORKSPACE_KEY` and existing `RELAY_*_TOKEN` environment variables.

Bun is installed locally through npm. The Terse SDK downloads its official native runtime on first use and checks its release checksum. Development needs outbound access to GitHub and `cast.agentrelay.com`, plus local listening sockets. No Docker is required.

```sh
curl -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:3001/api/missions
curl http://127.0.0.1:3001/api/missions/RUN_ID
curl -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:3001/api/missions/RUN_ID/challenge
curl 'http://127.0.0.1:3001/api/missions/RUN_ID/events?afterRevision=0'
curl http://127.0.0.1:3001/api/health
```

Start accepts optional `position`, `goal`, and `rescueAxis` arrays. Defaults are `[1,0,0]`, `[0,0,1]`, and a deterministic perpendicular axis. The challenge sets position to exactly `-goal`. Health reports Terse and Relay separately; missing Relay configuration does not create a simulated transport. `WEB_ORIGIN` defaults to `http://localhost:5173`; `PORT` defaults to 3001.

## Integration contract

`shared/contract.ts` is dependency-free and shared by the backend, `agents/`, and `web/`. `shared/validation.ts` provides runtime schemas. This implementation owns root configuration, `shared/`, `core/`, `actors/`, and `server/`; it does not modify agent workers or frontend files.

Browser routes return `{ state }`, `{ events, revision }`, or `{ error: { code, message } }`. There is no browser endpoint for movement, pilot identity, handoff, or actor credentials. Timeline events come from the authoritative persisted actor state. Poll events with `afterRevision` and read the current snapshot on reconnect.

Agents reconnect through the official `AgentRelay.workspace.reconnect({ apiToken })`, then send JSON DMs to `@counterwhorl-coordinator` with their registered client's `sendMessage`. Subscribe through `relay.addListener('dm.received', ...)`. The bridge validates the authenticated sender's registered ID and name, pins pilot IDs across reconnects, and rejects a payload that claims a different pilot. Configure nondefault names with `RELAY_NAVIGATOR_NAME`, `RELAY_RESCUER_NAME`, and `RELAY_COORDINATOR_NAME`.

Every mutation carries `runId`, a unique `commandId`, `expectedRevision`, and `controlEpoch`. Read these from the latest authoritative state. Responses are `command_result` messages; successful results include the updated state. `get_state` requests use a separate `correlationId` and receive `mission_state`. `mission_event` notifications carry an actual actor event and the state captured when the notification was queued. Ignore snapshots older than the revision already observed. A stale response means read state and reconsider the command with a new ID; do not blindly replay an old tangent.

Navigator behavior:

1. Check arrival before checking field norm.
2. While navigating, send `commit_movement` using `steering(position, goal)` from `core/geometry.ts`.
3. At a stall, send `request_handoff` with a fresh `requestId` and reason `navigator_stalled`.
4. Wait while the mission is `awaiting_rescue` or `rescuing`, then resume after control returns.

Rescuer behavior:

1. On `awaiting_rescue`, send `propose_recovery` with the pending `requestId`, a fresh `proposalId`, and `steering(position, rescueAxis)`.
2. Wait for the coordinator's validated grant; it changes both revision and control epoch.
3. While rescuing, send movement along the rescue field until `escaped(position, goal)`.
4. Send `return_control`. Further rescue movement is rejected once escape is achieved.

`server/relay-smoke.ts` is a real-service integration driver for both pilot identities. It creates an isolated test workspace so it does not consume messages intended for concurrent production workers. Production worker behavior remains owned by `agents/`.

For the agent owner: use `AGENT_COMMAND_TIMEOUT_MS=90000` when testing against the current Relay service. Real message sends have returned HTTP 429 and may take longer than 20 seconds while the SDK retries. Consume durable inbox deliveries on reconnect as well as live events; replayed DMs may be classified as channel messages by this SDK version. Reconcile stale responses against Terse state before deciding the next movement.

## Persistence and safety

The real `Mission` Terse Actor is the only mission authority. `@Persisted @Emittable state` contains run ID, revision, position, goal, rescue axis, phase, active pilot, control epoch, processed command IDs, recovery correlation, events, and trajectory. Updates replace the snapshot and arrays. Mutations use `this.db.transaction(...)` and normal serialized actor calls; no method uses interleaving.

The published Terse 0.14.6 package does **not** export `Atomic`, despite the guide mentioning it. The supported database transaction groups persisted assignments atomically. Imports and connection options were checked against the installed declarations and source; no replacement SDK is used.

Movement validates finite unit vectors, unit tangency, pilot-field alignment, revision, epoch, command uniqueness, phase, and angular bounds. Steps use `cos(alpha) * x + sin(alpha) * u`, with numerical normalization and `alpha <= 0.35`. Arrival tolerance is `1e-4` radians; stall norm is `1e-7`; unit and tangency tolerance is `1e-8`. Rescuer yields once Navigator field norm reaches `0.5`.

Terse state lives in `.durable-actors/`. The coordinator's SQLite database in `.counterwhorl/` stores only the run index, private credentials, response cache, outbound payloads, and delivery cursors. It indexes run IDs before actor creation to prevent orphaning a successful start. Relay delivery replay and actor command IDs prevent repeated movement after a coordinator disconnect. Unread DM history provides an additional reconnect path. Outbound payloads are persisted before sending, so retries use exactly the same recipient, body, metadata, and idempotency key even when mission state has advanced. Event notifications use persisted delivery checkpoints and run separately from command intake. Phase changes notify the relevant pilot; movement replies update the active pilot. The complete timeline remains available through HTTP.

## Checks

```sh
npm run check
npm test
npm run test:integration
npm run test:relay
```

Unit tests cover exact antipodal failure, Rescuer escape, 500 seeded random missions, the complementary-field bound, 10,000 spherical movements, validation, control fencing, and completion. Integration tests use the real native Terse runtime to test conflicting writes, rejected updates, client reconnect, runtime restart, HTTP contracts, and coordinator replay. The Relay test needs network access; it creates an isolated real workspace, sends requests through the real service, tests impersonation rejection and an offline proposal, then completes a mission. It may take several minutes when the service rate-limits sends.

## Official references

- [Terse Durable Actors](https://github.com/TerseAI/durable-actors)
- [Terse TypeScript guide](https://github.com/TerseAI/durable-actors/blob/main/docs/reference/typescript-guide.md)
- [Agent Relay](https://github.com/AgentWorkforce/relay)
- [Relay SDK](https://github.com/AgentWorkforce/relay/blob/main/packages/sdk/README.md)
