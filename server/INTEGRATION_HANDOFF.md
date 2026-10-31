# Counterwhorl backend handoff for Antigravity

Verified on 2026-10-31 using the real Terse native runtime, real Agent Relay, and independent Navigator/Rescuer OS processes. No `web/` files were modified.

The fresh isolated mission `b4717f52-421b-47e1-925a-333d9e130259` completed in **26.505 seconds**. Challenge-to-return was **14.518 seconds**; challenge-to-target was **25.432 seconds**. The full verification, including setup, independent Relay reads, and a native Terse restart, took **66.115 seconds**.

| Evidence                        | Verified value                                                            |
| ------------------------------- | ------------------------------------------------------------------------- |
| Navigator first movement        | r2                                                                        |
| Exact antipode challenge        | r3, position `[0,0,-1]`, goal `[0,0,1]`                                   |
| Recovery requested              | r4, Relay ID `242387263832367104`                                         |
| Handoff granted                 | r5, epoch 2, proposal `det-A-bf0dd11f`                                    |
| Rescuer movements               | r6–r8                                                                     |
| Control returned                | r9, epoch 3                                                               |
| `recovery_complete`             | Relay ID `242387308902408192`; both sender and Navigator receipt recorded |
| Navigator resumed and completed | r10–r22; final phase `completed`                                          |
| Persistence                     | Restart restored r22, all 22 events, and all 19 trajectory points         |

Both essential messages were fetched independently from Relay and checked against their real sender IDs and mission/handoff contents. The Rescuer used the deterministic candidate A because no Anthropic key was configured; no LLM success is claimed.

## Frontend integration

- Use the shared backend at `http://127.0.0.1:3001`; the isolated verification server has been stopped. Public routes and wrappers are unchanged: mission routes return `{ state }`, the event route returns `{ events, revision }`, and failures return `{ error }`.
- The verification ended with `{"terse":true,"relay":true}`; the shared backend also returned this. Fresh startup initially returned `relay:false` without an error. Keep polling health and distinguish connecting from an explicit capacity/error response; do not manufacture an online state.
- Agents now send routine Terse commands through token-authenticated `/api/pilot/*` routes. These are private worker routes; the browser must not call them or receive their tokens. Relay carries the essential peer recovery messages.
- `relayMessageId` is optional. Routine movement and `control_returned` events can be genuine authenticated HTTP commands without one. `recovery_requested` and `handoff_granted` can cite the **same** peer request ID; they are two Terse transitions, not two Relay messages.
- `recovery_complete` is recorded in `.counterwhorl/agents/ledger.jsonl`, not as a separate Terse event type. Use the web server's existing `/local/relay-ledger?runId=...` endpoint for peer telemetry. Navigator resumes from authoritative Terse control ownership and may resume before the informational completion DM arrives.
- Event epochs already contain the updated value. Ignore older state revisions and refresh/retry a judge challenge if it races a movement and returns 409. Default allowed browser origin is `http://localhost:5173` (`WEB_ORIGIN` is configurable).

## Exact launch commands

From `/home/solus/Documents/Repositories/counter`, configure identities once if needed with `npm run setup:relay`. Start one instance of each process in separate terminals:

```sh
# Terminal 1: native Terse runtime and backend
npm run dev

# Terminal 2: real Relay Rescuer
npm exec --no -- bun agents/rescuer.ts

# Terminal 3: real Relay Navigator
npm exec --no -- bun agents/navigator.ts
```

Use the npm launchers: direct invocation of the npm-installed Bun binary can leave `bun` off PATH for Terse's child build. The shared backend was restarted to load the tested duplicate-command fix; existing agent processes and their identities were preserved. Avoid starting duplicate instances on the same port/identities.

Reproduce the isolated fresh-mission verification with:

```sh
npm exec --no -- bun agents/e2e.ts --isolated
```

Evidence: `.counterwhorl/verification/b4717f52-421b-47e1-925a-333d9e130259.json` and `.counterwhorl/verification/backend-e2e-20261031-verified.log`. Checks passed: backend and agent typechecking, 10 controller tests, and 9 real backend regression tests. The pilot API's uncited duplicate-command reporting was fixed and regression-tested.
