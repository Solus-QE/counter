import type { AgentRequest, MissionPhase, MissionState, RecoveryResult } from "../shared/contract";
import { decodeCoordinator } from "./protocol";

export interface CommandReply { result: RecoveryResult }
export interface RunSummary { runId: string; revision: number; phase: MissionPhase }

/** Terse-backed pilot API. Every call runs the coordinator's authorization and fencing checks. */
export interface PilotApi {
  /** relayMessageId cites the real Relay message that motivated the command (recorded on the Terse event). */
  command(input: Exclude<AgentRequest,{type:"get_state"}>,relayMessageId?: string): Promise<CommandReply>;
  getState(runId: string): Promise<MissionState>;
  activeRuns(): Promise<RunSummary[]>;
}

export class HttpPilotApi implements PilotApi {
  constructor(private baseUrl: string,private token: string,private timeoutMs=10000) {}
  private async call(path: string,body?: unknown): Promise<unknown> {
    const response=await fetch(`${this.baseUrl}${path}`,{
      method:body===undefined?"GET":"POST",
      headers:{authorization:`Bearer ${this.token}`,...body===undefined?{}:{"content-type":"application/json"}},
      body:body===undefined?undefined:JSON.stringify(body),
      signal:AbortSignal.timeout(this.timeoutMs),
    });
    const data=await response.json().catch(()=>null) as {error?: {code: string; message: string}}|null;
    if(!response.ok) throw new Error(`${response.status} ${data?.error?.code??""}: ${data?.error?.message??"pilot API error"}`);
    return data;
  }
  async command(input: Exclude<AgentRequest,{type:"get_state"}>,relayMessageId?: string): Promise<CommandReply> {
    const message=decodeCoordinator(JSON.stringify(await this.call("/api/pilot/commands",{request:input,relayMessageId})));
    if(message?.type!=="command_result") throw new Error("Malformed pilot command response");
    return {result:message.result};
  }
  async getState(runId: string): Promise<MissionState> {
    const message=decodeCoordinator(JSON.stringify(await this.call("/api/pilot/commands",{request:{type:"get_state",runId,correlationId:`state-${crypto.randomUUID()}`}})));
    if(message?.type==="mission_state") return message.state;
    if(message?.type==="command_result"&&!message.result.ok) throw new Error(`${message.result.error.code}: ${message.result.error.message}`);
    throw new Error("Malformed get_state response");
  }
  async activeRuns(): Promise<RunSummary[]> {
    const data=await this.call("/api/pilot/runs") as {runs?: RunSummary[]};
    return Array.isArray(data?.runs)?data.runs:[];
  }
}

/** Retries a state read through transient failures with short jittered backoff. */
export async function reread(api: PilotApi,runId: string,attempts=5): Promise<MissionState> {
  for(let attempt=0;;attempt++) {
    try {return await api.getState(runId);}
    catch(error) {
      if(attempt+1>=attempts) throw error;
      await new Promise(resolve=>setTimeout(resolve,200*2**attempt*(0.5+Math.random()/2)));
    }
  }
}
