import type { CommandMeta, MissionState } from "../shared/contract";
import { angle, escaped, steering } from "../core/geometry";
import { loadConfig, type AgentConfig } from "./config";
import { chooseRecovery, type Choice } from "./decision";
import { connect, logger, type RelayLink } from "./link";
import { HttpPilotApi, reread, type CommandReply, type PilotApi } from "./pilot-api";
import { planRecovery, type CandidateId } from "./planner";
import type { Decision, PeerMessage } from "./protocol";

type RecoveryRequestMessage = Extract<PeerMessage,{type:"recovery_request"}>;
type RejectReason = Extract<PeerMessage,{type:"recovery_rejected"}>["reason"];
interface Rescue { runId: string; handoffId: string; proposalId: string; stepAlpha: number; decision: Decision }

const meta=(s: MissionState): CommandMeta=>({runId:s.runId,commandId:`res-${crypto.randomUUID()}`,expectedRevision:s.revision,controlEpoch:s.controlEpoch});
const sleep=(ms: number)=>new Promise(resolve=>setTimeout(resolve,ms));
const lastActivity=(s: MissionState)=>Date.parse(s.events.at(-1)?.timestamp??"")||0;
const tag=(s: {runId: string})=>`[${s.runId.slice(0,8)}]`;
/** Keeps idempotency keys from colliding with a previous process's differently-shaped messages. */
const BOOT_ID=crypto.randomUUID().slice(0,8);
const MAX_FAILURES=5;
/** The Navigator sends the Relay request just before registering it in Terse; allow for that race. */
const REQUEST_SETTLE_MS=5000;

type RescuerConfig = Pick<AgentConfig,"rescuerStepMs"|"pollMs"|"keepOut"|"llm"|"maxRunIdleMs">&{requestSettleMs?: number};

/**
 * Autonomous Rescuer: answers real Relay recovery requests, validates them against Terse, proposes,
 * flies the escape through the pilot API, and reports recovery_complete over Relay only after Terse confirms it.
 */
export class RescuerAgent {
  /** One active rescue per run; doubles as the duplicate-handoff guard. */
  readonly jobs=new Map<string,{handoffId: string; done: Promise<void>}>();
  private timer?: ReturnType<typeof setInterval>;
  private polling=false;
  constructor(private api: PilotApi,private link: RelayLink,private config: RescuerConfig,private log: (text: string)=>void=()=>{},
    private choose: typeof chooseRecovery=chooseRecovery) {
    link.onCoordinator=({state})=>this.maybeResume(state);
    link.onPeer=(message,messageId)=>{if(message.type==="recovery_request") void this.onRequest(message,messageId);};
  }
  /** Restart path: a rescue Terse still assigns to us is finished even if its Relay request is long gone. */
  start(): void { this.timer=setInterval(()=>void this.poll(),Math.max(1000,this.config.pollMs)); }
  stop(): void { clearInterval(this.timer); }
  private async poll(): Promise<void> {
    if(this.polling) return;
    this.polling=true;
    try {
      for(const summary of await this.api.activeRuns()) {
        if(summary.phase==="rescuing"&&!this.jobs.has(summary.runId)) this.maybeResume(await this.api.getState(summary.runId));
      }
    } catch {/* next tick retries */}
    finally {this.polling=false;}
  }

  async onRequest(message: RecoveryRequestMessage,messageId: string): Promise<void> {
    const job=this.jobs.get(message.runId);
    if(job?.handoffId===message.handoffId) {this.log(`${tag(message)} duplicate recovery_request ${messageId} for active rescue ignored`);return;}
    if(job) {await this.reject(message,messageId,"not_awaiting","another rescue is active for this run");return;}
    let s: MissionState|undefined;
    const deadline=Date.now()+(this.config.requestSettleMs??REQUEST_SETTLE_MS);
    for(;;) {
      try {s=await this.api.getState(message.runId);} catch {await this.reject(message,messageId,"unknown_run");return;}
      if(s.pendingRecovery?.requestId===message.handoffId||Date.now()>deadline||this.jobs.has(message.runId)) break;
      await sleep(200);
    }
    if(this.jobs.has(message.runId)) return void this.onRequest(message,messageId);
    if(message.revision>s.revision) {await this.reject(message,messageId,"revision_ahead",`request r${message.revision} > Terse r${s.revision}`);return;}
    if(s.pendingRecovery?.requestId!==message.handoffId) {await this.reject(message,messageId,"handoff_mismatch",`Terse pending=${s.pendingRecovery?.requestId??"none"}`);return;}
    if(s.phase==="rescuing"&&s.activePilot==="rescuer") {this.maybeResume(s);return;}
    if(s.phase!=="awaiting_rescue") {await this.reject(message,messageId,"not_awaiting",`phase ${s.phase}`);return;}
    this.log(`${tag(s)} ACCEPT recovery_request ${message.handoffId} (relay ${messageId}); Terse r${s.revision} awaiting_rescue`);
    const done=this.rescue(s,message,messageId).catch(error=>this.log(`${tag(s)} rescue aborted: ${error instanceof Error?error.message:error}`)).finally(()=>this.jobs.delete(s!.runId));
    this.jobs.set(s.runId,{handoffId:message.handoffId,done});
  }
  private async reject(message: Pick<RecoveryRequestMessage,"runId"|"handoffId">,requestMessageId: string,reason: RejectReason,detail?: string): Promise<void> {
    this.log(`${tag(message)} REJECT ${message.handoffId}: ${reason} ${detail??""} (relay ${requestMessageId})`);
    await this.link.sendPeer({type:"recovery_rejected",v:1,runId:message.runId,handoffId:message.handoffId,requestMessageId,reason,detail},`recovery-reject-${requestMessageId}-${reason}`).catch(()=>{});
  }
  private async command(operation: ()=>Promise<CommandReply>): Promise<CommandReply|undefined> {
    try {return await operation();} catch(error) {this.log(`pilot API call failed: ${error instanceof Error?error.message:error}`);return undefined;}
  }

  private async rescue(s: MissionState,request: RecoveryRequestMessage,requestMessageId: string): Promise<void> {
    const candidates=planRecovery(s,this.config.keepOut);
    for(const c of candidates) this.log(`${tag(s)} candidate ${c.id}: step ${c.stepAlpha} rad, ${c.steps} steps, keep-out margin ${c.minClearance.toFixed(4)} rad, ${c.valid?"VALID":`INVALID (${c.violations.join("; ")})`}`);
    const choice: Choice|null=await this.choose(candidates,this.config.llm);
    if(!choice) {await this.reject(request,requestMessageId,"no_valid_candidate");return;}
    const {candidate,decision}=choice;
    this.log(decision.source==="llm"
      ?`${tag(s)} DECISION llm (${decision.model}) chose ${candidate.id}: ${decision.reason}`
      :`${tag(s)} DECISION DETERMINISTIC FALLBACK chose ${candidate.id} — ${decision.reason}`);
    const proposalId=`${decision.source==="llm"?"llm":"det"}-${candidate.id}-${crypto.randomUUID().slice(0,8)}`;
    for(let failures=0;;) {
      // Cites the Navigator's Relay request: Terse records it on handoff_granted.
      const reply=await this.command(()=>this.api.command({type:"propose_recovery",command:{...meta(s),requestId:request.handoffId,proposalId,tangent:candidate.tangent,alpha:candidate.alpha}},requestMessageId));
      if(reply?.result.ok) {
        s=reply.result.state;
        this.log(`${tag(s)} handoff GRANTED by Terse r${s.revision} epoch ${s.controlEpoch} proposal ${proposalId}`);
        break;
      }
      const code=reply&&!reply.result.ok?reply.result.error.code:"no response";
      s=await reread(this.api,s.runId);
      if(s.phase==="rescuing"&&s.pendingRecovery?.proposalId===proposalId) break; // our proposal landed; reply was lost
      if(s.phase!=="awaiting_rescue"||s.pendingRecovery?.requestId!==request.handoffId||++failures>=MAX_FAILURES) {
        await this.reject(request,requestMessageId,"proposal_rejected",code);
        return;
      }
    }
    await this.fly(s,{runId:s.runId,handoffId:request.handoffId,proposalId,stepAlpha:candidate.stepAlpha,decision});
  }

  /** Commits rescue-field steps until escape, then returns control. Each step is recomputed from Terse state. */
  private async fly(s: MissionState,rescue: Rescue): Promise<void> {
    let failures=0;
    while(!escaped(s.position,s.goal)) {
      if(s.phase!=="rescuing"||s.activePilot!=="rescuer") {this.log(`${tag(s)} control lost at r${s.revision} (${s.phase}); stopping rescue`);return;}
      const steer=steering(s.position,s.rescueAxis);
      if(!steer) throw new Error("rescue field vanished");
      await sleep(this.config.rescuerStepMs);
      const reply=await this.command(()=>this.api.command({type:"commit_movement",command:{...meta(s),pilot:"rescuer",tangent:steer.tangent,alpha:Math.min(rescue.stepAlpha,angle(s.position,s.rescueAxis))}}));
      if(reply?.result.ok) {s=reply.result.state;this.log(`${tag(s)} rescue move r${s.revision}`);continue;}
      if(++failures>=MAX_FAILURES) throw new Error("too many failed rescue moves");
      s=await reread(this.api,s.runId);
    }
    const sent=new Set<string>();
    for(;;) {
      const command=meta(s);
      sent.add(command.commandId);
      const reply=await this.command(()=>this.api.command({type:"return_control",command}));
      if(reply?.result.ok) {s=reply.result.state;break;}
      s=await reread(this.api,s.runId);
      // Our return may have committed even though its reply was lost.
      if(s.events.some(e=>e.type==="control_returned"&&sent.has(e.commandId))) break;
      if(s.phase!=="rescuing"||s.activePilot!=="rescuer") {this.log(`${tag(s)} return_control superseded at r${s.revision} (${s.phase})`);return;}
      if(++failures>=MAX_FAILURES) throw new Error("return_control repeatedly rejected");
    }
    this.log(`${tag(s)} control RETURNED to Navigator, confirmed by Terse r${s.revision} epoch ${s.controlEpoch}`);
    await this.reportComplete(s,rescue);
  }
  /** recovery_complete is sent only now that Terse holds the control_returned event. Counts come from Terse. */
  private async reportComplete(s: MissionState,rescue: Rescue): Promise<void> {
    const granted=s.events.findIndex(e=>e.type==="handoff_granted"&&e.detail===rescue.proposalId);
    const rescueMoves=s.events.slice(granted+1).filter(e=>e.type==="movement_committed"&&e.pilot==="rescuer").length;
    const returned=[...s.events].reverse().find(e=>e.type==="control_returned")!;
    for(let attempt=0;attempt<5;attempt++) {
      try {
        const id=await this.link.sendPeer({type:"recovery_complete",v:1,runId:s.runId,handoffId:rescue.handoffId,revision:returned.revision,controlEpoch:returned.controlEpoch,proposalId:rescue.proposalId,rescueMoves,decision:rescue.decision},`recovery-complete-${rescue.handoffId}-${BOOT_ID}`);
        this.log(`${tag(s)} recovery_complete ${rescue.handoffId} → ${this.link.peer.name} (relay ${id})`);
        return;
      } catch {await sleep(1000*2**attempt);}
    }
    this.log(`${tag(s)} recovery_complete could not be sent; Terse already records the return`);
  }

  /** After a Rescuer restart Terse may still show it in control; finish that rescue deterministically. */
  maybeResume(s: MissionState): void {
    if(s.phase!=="rescuing"||s.activePilot!=="rescuer"||!s.pendingRecovery?.proposalId||this.jobs.has(s.runId)) return;
    if(Date.now()-lastActivity(s)>this.config.maxRunIdleMs) return;
    const proposalId=s.pendingRecovery.proposalId;
    const candidateId: CandidateId=/^(?:llm|det)-B-/.test(proposalId)?"B":"A";
    const resumed=planRecovery(s,this.config.keepOut).find(c=>c.id===candidateId)!;
    const decision: Decision={source:"resume_deterministic",candidateId,reason:`resumed ${proposalId} from Terse state r${s.revision}`};
    this.log(`${tag(s)} RESUME rescue ${s.pendingRecovery.requestId} at r${s.revision} with candidate ${candidateId}`);
    const done=this.fly(s,{runId:s.runId,handoffId:s.pendingRecovery.requestId,proposalId,stepAlpha:resumed.stepAlpha,decision})
      .catch(error=>this.log(`${tag(s)} resume aborted: ${error instanceof Error?error.message:error}`)).finally(()=>this.jobs.delete(s.runId));
    this.jobs.set(s.runId,{handoffId:s.pendingRecovery.requestId,done});
  }
}

if(import.meta.main) {
  const config=loadConfig("rescuer");
  const log=logger("rescuer");
  const isSmoke=process.argv.includes("--smoke");
  const {link,token,stop}=await connect(config,isSmoke?{ack:o=>o==="peer"||o==="duplicate"}:{});
  if(isSmoke) {
    const timer=setTimeout(()=>{log("SMOKE FAIL no peer_ping within 60s");process.exit(1);},60000);
    link.onPeer=async(message,messageId)=>{
      if(message.type!=="peer_ping") return;
      const id=await link.sendPeer({type:"peer_pong",v:1,nonce:message.nonce,pingMessageId:messageId},`pong-${messageId}`);
      log(`SMOKE peer_ping ${messageId} answered with peer_pong relay ${id}`);
      clearTimeout(timer);
      await stop();
      process.exit(0);
    };
  } else {
    log(config.llm.enabled?`LLM advisor enabled (${config.llm.model})`:`LLM advisor OFF (${config.llm.disabledReason}); decisions use the deterministic fallback`);
    const agent=new RescuerAgent(new HttpPilotApi(config.apiUrl,token),link,config,log);
    agent.start();
    const shutdown=async()=>{agent.stop();await stop();process.exit(0);};
    process.on("SIGINT",()=>void shutdown());
    process.on("SIGTERM",()=>void shutdown());
  }
}
