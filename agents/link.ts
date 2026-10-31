import { AgentRelay, type RelayAgentClient, type RelayMessage } from "@agent-relay/sdk";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { CoordinatorMessage } from "../shared/contract";
import { peerOf, type AgentConfig, type Role } from "./config";
import { decodeCoordinator, decodePeer, type PeerMessage } from "./protocol";

export interface Identity { id: string; name: string }
export interface Transport {
  self: Identity;
  /** Sends a DM from the registered agent client; resolves to the real Relay message ID. */
  send(to: string,text: string,idempotencyKey: string): Promise<string>;
}
export type IngestOutcome = "coordinator"|"peer"|"duplicate"|"self"|"unknown_sender"|"invalid";

/** Jittered exponential backoff for Relay writes; the service sheds load with 503 + Retry-After. */
export const backoff=(attempt: number)=>Math.min(30000,1000*2**attempt)*(0.5+Math.random()/2);

/**
 * Retries a Relay call on retryable failures (503 database_overloaded, 429, transport), waiting the server's
 * Retry-After when given. Used for setup calls the SDK itself will not replay, such as registration.
 */
export async function withRelayRetry<T>(operation: ()=>Promise<T>,log: (text: string)=>void=()=>{},attempts=6): Promise<T> {
  for(let attempt=0;;attempt++) {
    try {return await operation();}
    catch(error) {
      const e=error as {retryable?: boolean; retryAfterMs?: number; status?: number; message?: string};
      if(attempt+1>=attempts||!(e.retryable||e.status===429||(e.status??0)>=500)) throw error;
      const wait=e.retryAfterMs??backoff(attempt);
      log(`Relay busy (${e.status??"?"} ${e.message?.slice(0,60)??""}); retrying in ${Math.round(wait)} ms`);
      await new Promise(resolve=>setTimeout(resolve,wait));
    }
  }
}

const AGENT_DIR=".counterwhorl/agents";
export const LEDGER_FILE=`${AGENT_DIR}/ledger.jsonl`;
export function logger(role: Role) {
  return (text: string)=>console.log(`${new Date().toISOString()} [${role}] ${text}`);
}
/** Append-only record of every real Relay message ID this agent sent or accepted. */
export function ledger(role: Role) {
  mkdirSync(AGENT_DIR,{recursive:true,mode:0o700});
  return (entry: Record<string,unknown>)=>appendFileSync(LEDGER_FILE,JSON.stringify({at:new Date().toISOString(),role,...entry})+"\n");
}

/**
 * Agent-to-agent Relay channel: sender pinning, dedupe by Relay message ID, and Zod validation.
 * Terse commands do not travel here; they go through the authenticated pilot API.
 */
export class RelayLink {
  /** Coordinator notifications are hints only; agents re-read Terse before acting. */
  onCoordinator: (message: Extract<CoordinatorMessage,{type:"mission_event"}>,messageId: string)=>void=()=>{};
  onPeer: (message: PeerMessage,messageId: string)=>void=()=>{};
  private seen=new Set<string>();
  constructor(readonly role: Role,private transport: Transport,readonly coordinator: Identity,readonly peer: Identity,
    private options: {log?: (text: string)=>void; record?: (entry: Record<string,unknown>)=>void}={}) {}
  get self(): Identity { return this.transport.self; }
  private log(text: string) { this.options.log?.(text); }

  ingest(message: RelayMessage): IngestOutcome {
    if(!message?.messageId) return "invalid";
    if(message.from?.id===this.self.id) return "self";
    if(this.seen.has(message.messageId)) return "duplicate";
    this.seen.add(message.messageId);
    if(this.seen.size>5000) this.seen.delete(this.seen.values().next().value!);
    const from=message.from??{};
    if(from.id===this.coordinator.id&&from.name===this.coordinator.name) {
      const body=decodeCoordinator(message.text);
      if(!body) {this.log(`invalid coordinator message ${message.messageId} dropped`);return "invalid";}
      if(body.type==="mission_event") this.onCoordinator(body,message.messageId);
      return "coordinator";
    }
    if(from.id===this.peer.id&&from.name===this.peer.name) {
      const body=decodePeer(message.text);
      if(!body) {this.log(`invalid peer message ${message.messageId} dropped`);return "invalid";}
      this.options.record?.({dir:"in",messageId:message.messageId,from:from.name,type:body.type,runId:"runId" in body?body.runId:undefined,handoffId:"handoffId" in body?body.handoffId:undefined});
      this.onPeer(body,message.messageId);
      return "peer";
    }
    return "unknown_sender";
  }
  async sendPeer(message: PeerMessage,idempotencyKey: string): Promise<string> {
    const messageId=await this.transport.send(this.peer.name,JSON.stringify(message),idempotencyKey);
    this.options.record?.({dir:"out",messageId,to:this.peer.name,type:message.type,runId:"runId" in message?message.runId:undefined,handoffId:"handoffId" in message?message.handoffId:undefined});
    return messageId;
  }
}

function storedToken(config: AgentConfig): string|undefined {
  const tokenFile=`${AGENT_DIR}/${config.role}.token`;
  return config.token??(existsSync(tokenFile)?readFileSync(tokenFile,"utf8").trim():undefined);
}
async function client(relay: AgentRelay,config: AgentConfig): Promise<RelayAgentClient> {
  const token=storedToken(config);
  if(token) return relay.workspace.reconnect({apiToken:token});
  // First run without setup:relay credentials: register once and keep the token for reconnects.
  const registered=await relay.workspace.register({name:config.names[config.role],type:"agent"});
  if(!registered.token) throw new Error("Relay registration returned no token");
  mkdirSync(AGENT_DIR,{recursive:true,mode:0o700});
  writeFileSync(`${AGENT_DIR}/${config.role}.token`,registered.token,{mode:0o600});
  return registered;
}

export interface Connection { link: RelayLink; token: string; stop: ()=>Promise<void> }
/** Connects this process's own Relay identity: live listeners plus durable inbox replay. */
export async function connect(config: AgentConfig,options: {ack?: (outcome: IngestOutcome)=>boolean}={}): Promise<Connection> {
  const log=logger(config.role);
  const relay=new AgentRelay({workspaceKey:config.workspaceKey,onError:()=>log("Relay transport error")});
  const self=await withRelayRetry(()=>client(relay,config),log);
  const resolve=async(name: string): Promise<Identity>=>{
    const agent=await withRelayRetry(()=>self.agents.get(name),log);
    return {id:agent.id,name:agent.name};
  };
  const coordinator=await resolve(config.names.coordinator);
  const peer=await resolve(config.names[peerOf(config.role)]);
  const transport: Transport={
    self:{id:self.id,name:self.name},
    send:async(to,text,idempotencyKey)=>(await self.sendMessage({to:`@${to}`,text,idempotencyKey})).messageId,
  };
  const link=new RelayLink(config.role,transport,coordinator,peer,{log,record:ledger(config.role)});
  const unsubscribers=(["dm.received","message.created"] as const).map(selector=>relay.addListener(selector,({message})=>{link.ingest(message);}));
  const ack=options.ack??(()=>true);
  let draining=false;
  let failures=0;
  let nextDrain=0;
  // Live events are the fast path; the inbox is the durable backstop, polled gently and backed off on 503s.
  const drain=async()=>{
    if(draining||Date.now()<nextDrain) return;
    draining=true;
    try {
      const {items}=await self.inbox.list({limit:100});
      for(const item of items) {
        const outcome=link.ingest(item.message);
        if(ack(outcome)) await self.inbox.ack({inboxItemId:item.id});
      }
      failures=0;
    } catch {
      nextDrain=Date.now()+backoff(failures++);
      log("inbox replay deferred (Relay busy)");
    }
    finally {draining=false;}
  };
  void drain();
  const timer=setInterval(()=>void drain(),config.inboxPollMs);
  log(`READY ${self.name} id=${self.id} coordinator=${coordinator.name}/${coordinator.id} peer=${peer.name}/${peer.id}`);
  return {
    link,
    token:self.token??storedToken(config)!,
    stop:async()=>{
      clearInterval(timer);
      for(const unsubscribe of unsubscribers) unsubscribe();
      await relay.events.disconnect();
    },
  };
}
