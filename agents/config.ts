import { existsSync, readFileSync } from "node:fs";
import type { Vec3 } from "../shared/contract";
import { unit } from "../core/geometry";

export type Role = "navigator" | "rescuer";
export const peerOf = (role: Role): Role => role==="navigator"?"rescuer":"navigator";

/** Private credentials written by `bun run setup:relay`. Explicit environment variables win. */
const CREDENTIALS_FILE=".counterwhorl/relay-agents.env";
function credentialFile(): Record<string,string> {
  if(!existsSync(CREDENTIALS_FILE)) return {};
  const out: Record<string,string>={};
  for(const line of readFileSync(CREDENTIALS_FILE,"utf8").split("\n")) {
    const match=/^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if(match) out[match[1]]=match[2];
  }
  return out;
}
const fileEnv=credentialFile();
const env=(key: string): string|undefined => process.env[key]||fileEnv[key]||undefined;
const num=(key: string,fallback: number): number => {
  const value=Number(env(key));
  return Number.isFinite(value)&&env(key)!==undefined?value:fallback;
};
function vector(key: string,fallback: Vec3): Vec3 {
  const raw=env(key);
  if(!raw) return fallback;
  const parts=raw.split(",").map(Number);
  if(parts.length!==3||!parts.every(Number.isFinite)) throw new Error(`${key} must be three comma-separated numbers`);
  return unit(parts as unknown as Vec3);
}

export interface AgentConfig {
  role: Role;
  workspaceKey: string;
  token?: string;
  names: { navigator: string; rescuer: string; coordinator: string };
  apiUrl: string;
  /** Terse poll interval for discovering missions and noticing out-of-band changes. */
  pollMs: number;
  inboxPollMs: number;
  navigatorStepMs: number;
  rescuerStepMs: number;
  peerResendMs: number;
  maxRunIdleMs: number;
  /** Forbidden camera pointing cone enforced by the Rescuer's deterministic validator. */
  keepOut: { axis: Vec3; halfAngle: number; missionRelative?: boolean };
  llm: { enabled: boolean; apiKey?: string; model: string; timeoutMs: number; disabledReason?: string };
}

// Centred 0.70 rad along the default mission's rescue arc (antipode of +Z toward +X): the 0.35 rad
// candidate ends inside it, the 0.20 rad candidate stays clear. Override for other geometries.
const DEFAULT_KEEP_OUT: Vec3=[Math.sin(0.7),0,-Math.cos(0.7)];

export function loadConfig(role: Role): AgentConfig {
  const workspaceKey=env("RELAY_WORKSPACE_KEY");
  if(!workspaceKey) throw new Error("RELAY_WORKSPACE_KEY missing; run `bun run setup:relay` first");
  const apiKey=env("ANTHROPIC_API_KEY");
  const llmFlag=env("RESCUER_LLM");
  const disabledReason=llmFlag==="0"?"RESCUER_LLM=0":!apiKey?"ANTHROPIC_API_KEY not set":undefined;
  return {
    role,
    workspaceKey,
    token: env(`RELAY_${role.toUpperCase()}_TOKEN`),
    names: {
      navigator: env("RELAY_NAVIGATOR_NAME")??"navigator",
      rescuer: env("RELAY_RESCUER_NAME")??"rescuer",
      coordinator: env("RELAY_COORDINATOR_NAME")??"counterwhorl-coordinator",
    },
    apiUrl: env("COUNTERWHORL_API_URL")??`http://127.0.0.1:${env("PORT")??3001}`,
    pollMs: num("AGENT_POLL_MS",500),
    inboxPollMs: num("AGENT_INBOX_POLL_MS",30000),
    navigatorStepMs: num("NAVIGATOR_STEP_MS",750),
    rescuerStepMs: num("RESCUER_STEP_MS",300),
    peerResendMs: num("AGENT_PEER_RESEND_MS",15000),
    maxRunIdleMs: num("AGENT_MAX_RUN_IDLE_MS",30*60*1000),
    keepOut: { axis: vector("RESCUER_KEEP_OUT_AXIS",DEFAULT_KEEP_OUT), halfAngle: num("RESCUER_KEEP_OUT_HALF_ANGLE",0.05), missionRelative:!env("RESCUER_KEEP_OUT_AXIS") },
    llm: { enabled: !disabledReason, apiKey, model: env("RESCUER_LLM_MODEL")??"claude-opus-5-5", timeoutMs: num("RESCUER_LLM_TIMEOUT_MS",8000), disabledReason },
  };
}
