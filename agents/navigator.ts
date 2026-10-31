import type { CommandMeta, MissionState } from "../shared/contract";
import { stalled, steering } from "../core/geometry";
import { loadConfig, type AgentConfig } from "./config";
import { connect, logger, type RelayLink } from "./link";
import { HttpPilotApi, type CommandReply, type PilotApi } from "./pilot-api";
import type { PeerMessage } from "./protocol";
import { relayRetryDelay } from "../shared/relay-retry";

interface Handoff { handoffId: string; requestMessageId: string; epochAtRequest: number; attempts: number; lastSent: number; sending?: boolean }
interface Run { state: MissionState; busy: boolean; dirty: boolean; handoff?: Handoff; done?: boolean; failures: number }

const meta=(s: MissionState): CommandMeta=>({runId:s.runId,commandId:`nav-${crypto.randomUUID()}`,expectedRevision:s.revision,controlEpoch:s.controlEpoch});
const sleep=(ms: number)=>new Promise(resolve=>setTimeout(resolve,ms));
/** Relay deduplicates by idempotency key; a restarted process must not collide with its predecessor's resends. */
const BOOT_ID=crypto.randomUUID().slice(0,8);
const lastActivity=(s: MissionState)=>Date.parse(s.events.at(-1)?.timestamp??"")||0;
const tag=(s: MissionState)=>`[${s.runId.slice(0,8)}]`;

type NavigatorConfig = Pick<AgentConfig,"navigatorStepMs"|"pollMs"|"peerResendMs"|"maxRunIdleMs">;

/**
 * Autonomous Navigator. Routine steering goes straight to Terse through the pilot API; Relay carries the
 * essential recovery_request to the Rescuer, whose real message ID Terse records on the handoff.
 */
export class NavigatorAgent {
  readonly runs=new Map<string,Run>();
  private timer?: ReturnType<typeof setInterval>;
  private polling=false;
  constructor(private api: PilotApi,private link: RelayLink,private config: NavigatorConfig,private log: (text: string)=>void=()=>{}) {
    link.onCoordinator=({state})=>this.observe(state);
    link.onPeer=(message,messageId)=>this.onPeer(message,messageId);
  }
  start(): void { void this.poll(); this.timer=setInterval(()=>void this.poll(),this.config.pollMs); }
  stop(): void { clearInterval(this.timer); }

  /** Discovers missions and notices out-of-band changes (challenge, rescue progress) from Terse directly. */
  private async poll(): Promise<void> {
    if(this.polling) return;
    this.polling=true;
    try {
      for(const summary of await this.api.activeRuns()) {
        const run=this.runs.get(summary.runId);
        if(!run||summary.revision!==run.state.revision) await this.refresh(summary.runId);
        else if(run.state.phase==="awaiting_rescue"&&!run.busy) void this.drive(run);
      }
    } catch {/* backend briefly unavailable; next tick retries */}
    finally {this.polling=false;}
  }
  /** Accepts authoritative state; late or duplicate snapshots are ignored unless re-read on purpose. */
  observe(state: MissionState,force=false): void {
    let run=this.runs.get(state.runId);
    if(run&&(state.revision<run.state.revision||(state.revision===run.state.revision&&!force))) return;
    if(!run) {
      if(state.phase==="completed"||Date.now()-lastActivity(state)>this.config.maxRunIdleMs) return;
      run={state,busy:false,dirty:false,failures:0};
      this.runs.set(state.runId,run);
      this.log(`${tag(state)} tracking run at r${state.revision} (${state.phase})`);
    }
    run.state=state;
    void this.drive(run);
  }
  private async drive(run: Run): Promise<void> {
    if(run.busy) {run.dirty=true;return;}
    run.busy=true;
    try {
      do {run.dirty=false;await this.step(run);} while(run.dirty);
    } finally {run.busy=false;}
  }
  private async step(run: Run): Promise<void> {
    const s=run.state;
    if(s.phase==="completed") {
      if(!run.done) this.log(`${tag(s)} COMPLETED at r${s.revision}`);
      run.done=true;
      return;
    }
    if(s.phase==="awaiting_rescue") {
      if(s.pendingRecovery&&run.handoff?.handoffId!==s.pendingRecovery.requestId) {
        // Navigator restart: rebuild the handoff from the authoritative pending request.
        const prior=[...s.events].reverse().find(e=>e.type==="recovery_requested"&&e.detail===s.pendingRecovery!.requestId);
        run.handoff={handoffId:s.pendingRecovery.requestId,requestMessageId:prior?.relayMessageId??"unknown",epochAtRequest:s.controlEpoch,attempts:1,lastSent:0};
      }
      if(run.handoff) this.resendIfStuck(run);
      return;
    }
    if(s.phase!=="navigating"||s.activePilot!=="navigator") return;
    if(run.handoff) {
      this.log(`${tag(s)} control RETURNED per Terse r${s.revision} (epoch ${run.handoff.epochAtRequest}→${s.controlEpoch}); resuming navigation`);
      run.handoff=undefined;
    }
    const steer=steering(s.position,s.goal);
    if(!steer||stalled(s.position,s.goal)) {await this.requestRecovery(run);return;}
    await sleep(this.config.navigatorStepMs);
    if(run.dirty) return; // newer state arrived while pacing; recompute from it
    const reply=await this.send(run,()=>this.api.command({type:"commit_movement",command:{...meta(s),pilot:"navigator",...steer}}));
    if(reply?.result.ok) this.log(`${tag(s)} moved r${reply.result.state.revision}`);
  }
  /** Essential Relay exchange: ask the Rescuer first, then register the request in Terse citing that real message. */
  private async requestRecovery(run: Run): Promise<void> {
    const s=run.state;
    const handoffId=`h-${crypto.randomUUID()}`;
    this.log(`${tag(s)} STALLED at antipodal zero r${s.revision}; sending recovery_request ${handoffId} via Relay`);
    let requestMessageId: string;
    try {
      requestMessageId=await this.link.sendPeer({type:"recovery_request",v:1,runId:s.runId,handoffId,revision:s.revision,controlEpoch:s.controlEpoch,position:[...s.position]},`recovery-request-${handoffId}-${BOOT_ID}-1`);
    } catch(error) {
      this.log(`${tag(s)} Relay send failed (${error instanceof Error?error.message:error}); retrying`);
      await sleep(relayRetryDelay(error, run.failures++));
      run.dirty=true;
      return;
    }
    this.log(`${tag(s)} recovery_request → ${this.link.peer.name} (relay ${requestMessageId})`);
    const reply=await this.send(run,()=>this.api.command({type:"request_handoff",command:{...meta(s),requestId:handoffId,reason:"navigator_stalled"}},requestMessageId));
    if(!reply?.result.ok) return;
    this.log(`${tag(s)} Terse recorded recovery_requested r${reply.result.state.revision} citing relay ${requestMessageId}`);
    run.handoff={handoffId,requestMessageId,epochAtRequest:reply.result.state.controlEpoch,attempts:1,lastSent:Date.now()};
  }
  /**
   * If Terse still shows no grant, the Relay request may be lost: resend with growing spacing.
   * Fire-and-forget: a slow Relay send must never delay noticing that Terse returned control.
   */
  private resendIfStuck(run: Run): void {
    const handoff=run.handoff!;
    const spacing=Math.min(60000,this.config.peerResendMs*2**(handoff.attempts-1));
    if(handoff.sending||Date.now()-handoff.lastSent<spacing) return;
    handoff.lastSent=Date.now();
    handoff.attempts++;
    handoff.sending=true;
    const s=run.state;
    this.link.sendPeer({type:"recovery_request",v:1,runId:s.runId,handoffId:handoff.handoffId,revision:s.revision,controlEpoch:s.controlEpoch,position:[...s.position]},`recovery-request-${handoff.handoffId}-${BOOT_ID}-${handoff.attempts}`)
      .then(id=>this.log(`${tag(s)} no grant yet; recovery_request resent attempt ${handoff.attempts} (relay ${id})`))
      .catch(()=>this.log(`${tag(s)} recovery_request resend failed; will retry`))
      .finally(()=>{handoff.sending=false;});
  }
  private onPeer(message: PeerMessage,messageId: string): void {
    if(message.type==="peer_ping"||message.type==="peer_pong"||message.type==="recovery_request") return;
    const run=this.runs.get(message.runId);
    if(!run) {this.log(`${message.type} for unknown run ignored (relay ${messageId})`);return;}
    if(message.type==="recovery_rejected") {
      if(run.handoff?.handoffId!==message.handoffId) {this.log(`stale recovery_rejected for ${message.handoffId} ignored (relay ${messageId})`);return;}
      this.log(`${tag(run.state)} Rescuer rejected ${message.handoffId}: ${message.reason} ${message.detail??""} (relay ${messageId})`);
    }
    // recovery_complete is a report, not authority: control resumes only from Terse state.
    if(message.type==="recovery_complete") this.log(`${tag(run.state)} recovery_complete ${message.handoffId} reports Terse r${message.revision} via ${message.decision.source}/${message.decision.candidateId}, ${message.rescueMoves} rescue moves (relay ${messageId})`);
    void this.refresh(message.runId);
  }
  private async refresh(runId: string): Promise<void> {
    // Forced: a lost or timed-out command leaves the revision unchanged, and the run must still be re-driven.
    try {this.observe(await this.api.getState(runId),true);} catch {this.log(`[${runId.slice(0,8)}] state read failed`);}
  }
  /** Sends one command; on rejection or failure re-reads authoritative state instead of replaying. */
  private async send(run: Run,operation: ()=>Promise<CommandReply>): Promise<CommandReply|undefined> {
    try {
      const reply=await operation();
      if(reply.result.ok) {run.failures=0;this.observe(reply.result.state);return reply;}
      this.log(`${tag(run.state)} command rejected ${reply.result.error.code}`);
    } catch(error) {
      this.log(`${tag(run.state)} pilot API call failed: ${error instanceof Error?error.message:error}`);
    }
    await sleep(Math.min(5000,100*2**run.failures++));
    await this.refresh(run.state.runId);
    return undefined;
  }
}

async function smoke(link: RelayLink,log: (text: string)=>void): Promise<void> {
  const nonce=`n-${crypto.randomUUID()}`;
  const pong=new Promise<{pingMessageId: string; pongMessageId: string}>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error("no peer_pong within 60s")),60000);
    link.onPeer=(message,messageId)=>{
      if(message.type==="peer_pong"&&message.nonce===nonce) {clearTimeout(timer);resolve({pingMessageId:message.pingMessageId,pongMessageId:messageId});}
    };
  });
  const sent=await link.sendPeer({type:"peer_ping",v:1,nonce},`ping-${nonce}`);
  log(`SMOKE peer_ping sent relay ${sent}`);
  const result=await pong;
  if(result.pingMessageId!==sent) throw new Error("pong references a different ping");
  log(`SMOKE PASS ping ${sent} → pong ${result.pongMessageId}`);
}

if(import.meta.main) {
  const config=loadConfig("navigator");
  const log=logger("navigator");
  const isSmoke=process.argv.includes("--smoke");
  const {link,token,stop}=await connect(config,isSmoke?{ack:o=>o==="peer"||o==="duplicate"}:{});
  if(isSmoke) {
    try {await smoke(link,log);} catch(error) {log(`SMOKE FAIL ${error instanceof Error?error.message:error}`);process.exitCode=1;}
    await stop();
    process.exit();
  }
  const agent=new NavigatorAgent(new HttpPilotApi(config.apiUrl,token),link,config,log);
  agent.start();
  const shutdown=async()=>{agent.stop();await stop();process.exit(0);};
  process.on("SIGINT",()=>void shutdown());
  process.on("SIGTERM",()=>void shutdown());
}
