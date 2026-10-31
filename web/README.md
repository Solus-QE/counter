# COUNTERWHORL Mission Control (`web/`)

Live scientific attitude-control and autonomous blind-spot recovery dashboard for **COUNTERWHORL**.

## Quick Start

Start the backend API (`http://127.0.0.1:3001`) from the repository root, then run the `web/` server (`http://localhost:5173`):

```sh
# Terminal 1 (root): Terse Durable Actor runtime + Relay Coordinator (:3001)
npm run dev

# Terminal 2 & 3 (optional, for live autonomous pilot steps over Agent Relay):
./node_modules/.bin/bun agents/rescuer.ts
./node_modules/.bin/bun agents/navigator.ts

# Terminal 4 (web/): Mission Control UI + /api proxy (:5173)
npm --prefix web run dev
```

Open `http://localhost:5173` in your browser.

## Scripts (`web/package.json`)

- `npm --prefix web run dev` — Starts [`web/server.ts`](server.ts) on `WEB_PORT` (default `5173`), bundling TypeScript on request and proxying `/api/*` to `COUNTERWHORL_API_URL` (default `http://127.0.0.1:3001`).
- `npm --prefix web run build` — Emits a minified static production bundle into `web/dist/`.
- `npm --prefix web run check` — Runs strict TypeScript checking against [`shared/contract.ts`](../shared/contract.ts).
- `npm --prefix web test` — Runs telemetry, Relay transcript authenticity, and Terse confirmation gate unit tests.

## Architectural Guarantees

- **Zero fabricated telemetry**: The Agent Relay Transcript strictly displays real `MissionEvent.relayMessageId` entries persisted by Terse via `/api/missions/:runId/events` (plus real public message IDs from `.counterwhorl/agents/ledger.jsonl` when running locally). HTTP-originated Judge events (`mission_started`, `challenge_forced`) are explicitly labeled `HTTP judge` and never appear as Relay traffic.
- **Strict Terse Confirmation Gate**: Even after the Rescuer pilot crosses the antipodal escape boundary (`||v_nav(x)|| >= 0.50`) or sends a peer `recovery_complete` notice, the dashboard keeps recovery in `RECOVERING (AWAITING TERSE RETURN)` until Terse commits an authoritative `control_returned` event.
