# COUNTERWHORL agents

Two independent processes, each with its own Agent Relay identity (`@agent-relay/sdk` 15.0.1). Neither mutates mission state directly. Every change is a command checked by the coordinator and applied by the Terse `Mission` actor.

```sh
npm run setup:relay            # once: workspace + coordinator/navigator/rescuer identities → .counterwhorl/relay-agents.env
npm run dev                    # backend (Terse + coordinator + HTTP :3001)
npx bun agents/rescuer.ts          # terminal 2
npx bun agents/navigator.ts        # terminal 3

npx bun test agents               # offline: real coordinator + real HTTP pilot route, in-memory Relay
npx bun agents/smoke.ts            # real Relay: two processes exchange peer_ping/peer_pong
npx bun agents/e2e.ts              # real Relay + running backend: start, challenge, rescue, complete, timing report
npx bun agents/e2e.ts --isolated   # same, on a fresh Relay workspace and an in-process backend (temp Terse runtime)
```

Credentials are read from the environment, falling back to `.counterwhorl/relay-agents.env`.

## Protocol

Relay carries only the two messages exchanged between the agents. Terse commands go through the coordinator's authenticated pilot API, `POST /api/pilot/commands`. Each agent authenticates there with its own Relay token, and the coordinator runs the same `dispatch` checks it applies to Relay-delivered commands.

| Step | Channel | What happens |
|---|---|---|
| 1 | Relay, Navigator → Rescuer | `recovery_request {runId, handoffId, revision, controlEpoch}` at the antipodal stall |
| 2 | Pilot API, Navigator | `request_handoff` with `relayMessageId` = step 1's Relay ID → Terse `recovery_requested` |
| 3 | Pilot API, Rescuer | Reads Terse state and accepts only if `pendingRecovery.requestId` matches the handoff. Plans, then sends `propose_recovery` citing the step 1 Relay ID → Terse `handoff_granted` |
| 4 | Pilot API, Rescuer | Sends `commit_movement` until `escaped`, then `return_control` → Terse `control_returned` |
| 5 | Relay, Rescuer → Navigator | `recovery_complete {revision, decision, rescueMoves}`, sent only after Terse confirms step 4 |
| — | Pilot API, Navigator | Polls Terse every 500 ms and resumes as soon as Terse shows control returned; `recovery_complete` is informational |

The Navigator resends `recovery_request` if Terse shows no grant after 15 s, then 30 s, and so on up to 60 s. Every Terse command carries `runId`, a fresh `commandId`, `expectedRevision` and `controlEpoch`. After a stale, rejected or lost command, the agent re-reads state rather than replaying. Relay messages are validated with Zod and accepted only from the pinned peer identity. They are deduplicated by Relay message ID, and idempotency keys are scoped per process.

## Recovery decision

`planner.ts` deterministically simulates two candidates along the only direction Terse accepts: **A** steps 0.20 rad, **B** steps 0.35 rad. Each is checked against Terse's movement rules and a forbidden camera-pointing cone (`RESCUER_KEEP_OUT_AXIS`, `RESCUER_KEEP_OUT_HALF_ANGLE`). With the default mission, B enters the cone.

If `ANTHROPIC_API_KEY` is set (disable with `RESCUER_LLM=0`; model `RESCUER_LLM_MODEL`, default `claude-opus-5-5`, 8 s cap), the model picks a candidate ID through JSON-schema structured output. It never produces numbers. Its pick is validated with Zod and against the deterministic checks; any failure falls back to the deterministic choice, logged as `DETERMINISTIC FALLBACK`. The proposal ID on `handoff_granted` (`llm-A-…` / `det-A-…`) shows the source to the frontend.

Tuning: `AGENT_POLL_MS` (500), `NAVIGATOR_STEP_MS` (750), `RESCUER_STEP_MS` (300), `AGENT_PEER_RESEND_MS` (15000), `AGENT_INBOX_POLL_MS` (10000).

Relay retry handling uses the server's `Retry-After` deadline and jittered exponential backoff. SDK automatic retries are disabled where the application owns retries, so they do not multiply each other. Temporary setup failures keep the workers waiting rather than exiting. Failed inbox reads leave live listeners running. The coordinator polls every five seconds and backs off inbox and notification failures separately; health continues to report actual service errors. HTTP 503 `database_overloaded` is a Relay service failure and may still delay both requests and completion messages.
