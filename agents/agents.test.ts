import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RelayMessage } from "@agent-relay/sdk";
import type { MissionActorApi, MissionState, PilotId, Vec3 } from "../shared/contract";
import { challenge, grant, move, request, returnToNavigator, start } from "../core/mission";
import { angle, escaped, norm } from "../core/geometry";
import { Coordinator } from "../server/coordinator";
import { createHandler } from "../server/http";
import { Store } from "../server/store";
import { RelayLink, type Transport } from "./link";
import { NavigatorAgent } from "./navigator";
import { RescuerAgent } from "./rescuer";
import { HttpPilotApi, type PilotApi } from "./pilot-api";
import { deterministicChoice, planRecovery } from "./planner";
import { chooseRecovery } from "./decision";
import { decodeCoordinator, decodePeer, MAX_MESSAGE_BYTES } from "./protocol";
import type { AgentConfig } from "./config";

const KEEP_OUT={axis:[Math.sin(0.7),0,-Math.cos(0.7)] as Vec3,halfAngle:0.05};
const LLM_OFF: AgentConfig["llm"]={enabled:false,model:"claude-opus-5-5",timeoutMs:1000,disabledReason:"test"};
const TOKENS={navigator:"nav-token-test",rescuer:"res-token-test"};

// The pilot route prefers environment tokens; isolate tests from a developer's shell.
const savedEnv={n:process.env.RELAY_NAVIGATOR_TOKEN,r:process.env.RELAY_RESCUER_TOKEN};
beforeAll(()=>{delete process.env.RELAY_NAVIGATOR_TOKEN;delete process.env.RELAY_RESCUER_TOKEN;});
afterAll(()=>{if(savedEnv.n) process.env.RELAY_NAVIGATOR_TOKEN=savedEnv.n;if(savedEnv.r) process.env.RELAY_RESCUER_TOKEN=savedEnv.r;});

/** In-memory MissionActorApi over the same pure transitions the Terse actor uses. */
function memoryActor(): (id: string)=>MissionActorApi {
  const states=new Map<string,MissionState>();
  return (id)=>{
    const get=async()=>{const s=states.get(id);if(!s) throw new Error("NOT_FOUND: Mission has not started");return s;};
    const set=(s: MissionState)=>{states.set(id,s);return s;};
    return {
      startMission:async(p,c)=>set(start(p,c)),
      getState:get,
      forceBlindSpotChallenge:async(p,c)=>set(challenge(await get(),p,c)),
      requestHandoff:async(p,c)=>set(request(await get(),p,c)),
      grantHandoff:async(p,c)=>set(grant(await get(),p,c)),
      commitMovement:async(p,c)=>set(move(await get(),p,c)),
      returnControl:async(p,c)=>set(returnToNavigator(await get(),p,c)),
      getEvents:async(after=0)=>{const s=await get();return {events:s.events.filter(e=>e.revision>after),revision:s.revision};},
    };
  };
}

/** Real server/http.ts pilot route + real Coordinator over an in-memory actor, and an async in-memory Relay for peer DMs. */
class Bus {
  dir=mkdtempSync(join(tmpdir(),"counterwhorl-agents-"));
  store=new Store(join(this.dir,"c.sqlite"));
  coordinator=new Coordinator(memoryActor(),this.store);
  server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:createHandler(this.coordinator,()=>({terse:true,relay:true}))});
  url=this.server.url.origin;
  links={} as Record<PilotId,RelayLink>;
  runId="";
  seq=0;
  peerSent: Array<{id: string; from: string; to: string; text: string}>=[];
  /** Simulates a peer DM the Relay service accepted but never delivered. */
  dropPeer?: (from: string,text: string)=>boolean;
  readonly ids={coordinator:{id:"id-c",name:"counterwhorl-coordinator"},navigator:{id:"id-n",name:"navigator"},rescuer:{id:"id-r",name:"rescuer"}};
  constructor() {
    for(const pilot of ["navigator","rescuer"] as const) this.store.setSetting(`relay.${pilot}.token`,TOKENS[pilot]);
  }
  api(role: PilotId): PilotApi { return new HttpPilotApi(this.url,TOKENS[role]); }
  link(role: PilotId): RelayLink {
    const transport: Transport={self:this.ids[role],send:async(to,text)=>this.post(role,to,text)};
    const peer=role==="navigator"?"rescuer":"navigator";
    return this.links[role]=new RelayLink(role,transport,this.ids.coordinator,this.ids[peer]);
  }
  post(from: PilotId,to: string,text: string): string {
    const id=`relay-${++this.seq}`;
    this.peerSent.push({id,from,to,text});
    if(this.dropPeer?.(from,text)) {this.dropPeer=undefined;return id;}
    setTimeout(()=>this.links[to as PilotId].ingest(this.message(id,from,text)),5);
    return id;
  }
  message(id: string,from: PilotId,text: string): RelayMessage {
    return {id,messageId:id,text,from:{id:this.ids[from].id,name:this.ids[from].name}};
  }
  peerTypes(): string[] { return this.peerSent.map(m=>JSON.parse(m.text).type); }
  async startMission(input: {position?: Vec3; goal?: Vec3}={}) { this.runId=(await this.coordinator.start(input)).runId; }
  state() { return this.coordinator.actor(this.runId).getState(); }
  async until(predicate: (s: MissionState)=>boolean,ms=8000): Promise<MissionState> {
    const end=Date.now()+ms;
    while(Date.now()<end) {const s=await this.state();if(predicate(s)) return s;await Bun.sleep(10);}
    throw new Error(`timeout; phase=${(await this.state()).phase}`);
  }
  async close() { await this.server.stop(true); this.store.close(); rmSync(this.dir,{recursive:true,force:true}); }
}

/** Wraps a PilotApi to lose exactly one reply (before or after the command reaches Terse). */
function lossy(api: PilotApi,match: (type: string)=>boolean,when: "before"|"after"): PilotApi {
  let armed=true;
  return {
    getState:id=>api.getState(id),
    activeRuns:()=>api.activeRuns(),
    command:async(input,relayMessageId)=>{
      if(armed&&match(input.type)) {
        armed=false;
        if(when==="after") await api.command(input,relayMessageId);
        throw new Error("simulated lost reply");
      }
      return api.command(input,relayMessageId);
    },
  };
}

const fast={navigatorStepMs:5,rescuerStepMs:5,pollMs:50,peerResendMs:500,maxRunIdleMs:60000,keepOut:KEEP_OUT,llm:LLM_OFF,requestSettleMs:300};
let bus: Bus|undefined;
const stoppers: Array<{stop(): void}>=[];
afterEach(async()=>{for(const a of stoppers.splice(0)) a.stop();await bus?.close();bus=undefined;});
function crew(options: {choose?: typeof chooseRecovery; config?: typeof fast; navApi?: (api: PilotApi)=>PilotApi; resApi?: (api: PilotApi)=>PilotApi; rescuer?: boolean}={}) {
  bus=new Bus();
  const config=options.config??fast;
  const nav=new NavigatorAgent((options.navApi??(a=>a))(bus.api("navigator")),bus.link("navigator"),config);
  nav.start();
  stoppers.push(nav);
  const resLink=bus.link("rescuer");
  let res: RescuerAgent|undefined;
  if(options.rescuer!==false) {
    res=new RescuerAgent((options.resApi??(a=>a))(bus.api("rescuer")),resLink,config,()=>{},options.choose);
    res.start();
    stoppers.push(res);
  }
  return {bus,nav,res:res!};
}

describe("protocol validation", () => {
  test("rejects malformed, oversized, wrong-version and extra-field peer messages", () => {
    expect(decodePeer("{not json")).toBeNull();
    expect(decodePeer(JSON.stringify({type:"peer_ping",v:2,nonce:"a"}))).toBeNull();
    expect(decodePeer(JSON.stringify({type:"peer_ping",v:1,nonce:"a",extra:1}))).toBeNull();
    expect(decodePeer(JSON.stringify({type:"recovery_request",v:1,runId:"r",handoffId:"h",revision:-1,controlEpoch:0,position:[0,0,1]}))).toBeNull();
    expect(decodePeer("x".repeat(MAX_MESSAGE_BYTES+1))).toBeNull();
    expect(decodePeer(JSON.stringify({type:"peer_ping",v:1,nonce:"a"}))).toEqual({type:"peer_ping",v:1,nonce:"a"});
    expect(decodeCoordinator(JSON.stringify({type:"command_result",result:{ok:true,commandId:"c"}}))).toBeNull();
  });
});

describe("relay link", () => {
  test("drops duplicates, self-echo, unknown senders and invalid payloads", () => {
    bus=new Bus();
    const link=bus.link("navigator");
    const seen: string[]=[];
    link.onPeer=(_m,id)=>seen.push(id);
    const ping=JSON.stringify({type:"peer_ping",v:1,nonce:"n"});
    expect(link.ingest(bus.message("a","rescuer",ping))).toBe("peer");
    expect(link.ingest(bus.message("a","rescuer",ping))).toBe("duplicate");
    expect(link.ingest({id:"x",messageId:"x",text:ping,from:{id:"id-n",name:"navigator"}})).toBe("self");
    expect(link.ingest({id:"y",messageId:"y",text:ping,from:{id:"id-evil",name:"rescuer"}})).toBe("unknown_sender");
    expect(link.ingest({id:"z",messageId:"z",text:"garbage",from:{id:"id-r",name:"rescuer"}})).toBe("invalid");
    expect(seen).toEqual(["a"]);
  });
});

describe("pilot HTTP route (server/http.ts)", () => {
  test("authenticates pilots by Relay token, refuses browsers, and runs the coordinator's checks", async () => {
    bus=new Bus();
    await bus.startMission({position:[0,0,-1],goal:[0,0,1]});
    const post=(token: string|undefined,body: unknown,headers: Record<string,string>={})=>fetch(`${bus!.url}/api/pilot/commands`,{method:"POST",headers:{"content-type":"application/json",...token?{authorization:`Bearer ${token}`}:{},...headers},body:JSON.stringify(body)});
    const getState={request:{type:"get_state",runId:bus.runId,correlationId:"c1"}};
    expect((await post(undefined,getState)).status).toBe(401);
    expect((await post("wrong",getState)).status).toBe(401);
    expect((await post(TOKENS.navigator,getState,{origin:"http://localhost:5173"})).status).toBe(403);
    expect((await post(TOKENS.navigator,{request:{type:"bogus"}})).status).toBe(400);
    expect(((await (await post(TOKENS.navigator,getState)).json()) as {type: string}).type).toBe("mission_state");
    const s=await bus.state();
    // The Rescuer's token cannot act as Navigator.
    const forged=await (await post(TOKENS.rescuer,{request:{type:"request_handoff",command:{runId:s.runId,commandId:"x1",expectedRevision:s.revision,controlEpoch:s.controlEpoch,requestId:"h1",reason:"navigator_stalled"}}})).json() as {result: {ok: boolean; error?: {code: string}}};
    expect(forged.result).toMatchObject({ok:false,error:{code:"UNAUTHORIZED"}});
    const accepted=await (await post(TOKENS.navigator,{request:{type:"request_handoff",command:{runId:s.runId,commandId:"x2",expectedRevision:s.revision,controlEpoch:s.controlEpoch,requestId:"h1",reason:"navigator_stalled"}},relayMessageId:"242370633461092352"})).json() as {result: {ok: boolean}};
    expect(accepted.result.ok).toBe(true);
    expect((await bus.state()).events.at(-1)).toMatchObject({type:"recovery_requested",relayMessageId:"242370633461092352"});
    const runs=await bus.api("rescuer").activeRuns();
    expect(runs).toEqual([{runId:bus.runId,revision:2,phase:"awaiting_rescue"}]);
  });
});

describe("deterministic planner", () => {
  test("default geometry: A clears the keep-out cone, B enters it; A is accepted by real Terse transitions", () => {
    let s=start("coordinator",{runId:"r1",commandId:"c0",position:[1,0,0],goal:[0,0,1]});
    s=challenge(s,"coordinator",{runId:"r1",commandId:"c1",expectedRevision:s.revision,controlEpoch:s.controlEpoch});
    const [a,b]=planRecovery(s,KEEP_OUT);
    expect(a.valid).toBe(true);
    expect(a.steps).toBe(3);
    expect(b.valid).toBe(false);
    expect(b.violations.join()).toContain("forbidden pointing cone");
    expect(deterministicChoice([a,b])!.id).toBe("A");
    s=request(s,"navigator",{runId:"r1",commandId:"c2",expectedRevision:s.revision,controlEpoch:s.controlEpoch,requestId:"h",reason:"navigator_stalled"});
    s=grant(s,"coordinator",{runId:"r1",commandId:"c3",expectedRevision:s.revision,controlEpoch:s.controlEpoch,requestId:"h",proposalId:"p",tangent:a.tangent,alpha:a.alpha});
    let i=4;
    while(!escaped(s.position,s.goal)) {
      const [next]=planRecovery(s,KEEP_OUT);
      s=move(s,"rescuer",{runId:"r1",commandId:`c${i++}`,expectedRevision:s.revision,controlEpoch:s.controlEpoch,pilot:"rescuer",tangent:next.tangent,alpha:Math.min(a.stepAlpha,angle(s.position,s.rescueAxis))});
    }
    expect(i-4).toBe(a.steps);
    s=returnToNavigator(s,"rescuer",{runId:"r1",commandId:"cz",expectedRevision:s.revision,controlEpoch:s.controlEpoch});
    expect(s.activePilot).toBe("navigator");
  });
});

describe("LLM decision is validated deterministically", () => {
  const candidates=()=>planRecovery({position:[0,0,-1],goal:[0,0,1],rescueAxis:[1,0,0]},KEEP_OUT);
  const fakeFetch=(body: unknown,status=200)=>(async()=>new Response(JSON.stringify(body),{status})) as unknown as typeof fetch;
  const llmOn={...LLM_OFF,enabled:true,apiKey:"test",disabledReason:undefined};
  const output=(o: unknown)=>({stop_reason:"end_turn",content:[{type:"thinking",thinking:""},{type:"text",text:JSON.stringify(o)}]});
  test("disabled → visible deterministic fallback", async () => {
    const choice=await chooseRecovery(candidates(),LLM_OFF);
    expect(choice!.decision).toMatchObject({source:"deterministic_fallback",candidateId:"A"});
    expect(choice!.decision.reason).toContain("LLM unavailable");
  });
  test("model picking the keep-out violator is overruled", async () => {
    const choice=await chooseRecovery(candidates(),llmOn,fakeFetch(output({candidateId:"B",rationale:"faster"})));
    expect(choice!.decision.source).toBe("deterministic_fallback");
    expect(choice!.candidate.id).toBe("A");
    expect(choice!.decision.reason).toContain("rejected by validator");
  });
  test("valid model choice is used", async () => {
    const choice=await chooseRecovery(candidates(),llmOn,fakeFetch(output({candidateId:"A",rationale:"only safe option"})));
    expect(choice!.decision).toMatchObject({source:"llm",candidateId:"A",model:"claude-opus-5-5"});
  });
  test("malformed, refused and failed responses fall back", async () => {
    for(const f of [fakeFetch(output({candidateId:"C",rationale:"x"})),fakeFetch({stop_reason:"refusal",content:[]}),fakeFetch({},500),fakeFetch({content:[{type:"text",text:"not json"}]})]) {
      expect((await chooseRecovery(candidates(),llmOn,f))!.decision.source).toBe("deterministic_fallback");
    }
  });
});

describe("two-agent rescue protocol (real coordinator + HTTP route, in-memory Relay)", () => {
  test("only the two essential messages use Relay, and Terse cites the real request message", async () => {
    const {bus}=crew();
    await bus.startMission({position:[0,0,-1],goal:[0,0,1]});
    const s=await bus.until(s=>s.phase==="completed");
    await bus.until(()=>bus!.peerTypes().includes("recovery_complete"));
    const types=s.events.map(e=>`${e.type}:${e.pilot}`);
    let at=-1;
    for(const t of ["recovery_requested:navigator","handoff_granted:coordinator","movement_committed:rescuer","control_returned:rescuer","mission_completed:navigator"]) {const i=types.indexOf(t,at+1);expect(i).toBeGreaterThan(at);at=i;}
    expect(bus.peerTypes()).toEqual(["recovery_request","recovery_complete"]);
    const requestId=bus.peerSent[0].id;
    expect(s.events.find(e=>e.type==="recovery_requested")!.relayMessageId).toBe(requestId);
    expect(s.events.find(e=>e.type==="handoff_granted")).toMatchObject({relayMessageId:requestId,detail:expect.stringMatching(/^det-A-/)});
    const complete=decodePeer(bus.peerSent[1].text)!;
    expect(complete).toMatchObject({type:"recovery_complete",revision:s.events.find(e=>e.type==="control_returned")!.revision,rescueMoves:3});
    expect(s.trajectory.every(p=>Math.abs(norm(p.position)-1)<1e-12)).toBe(true);
  });
  test("mid-flight challenge: Navigator's stale command is fenced, then rescue completes", async () => {
    const {bus}=crew();
    await bus.startMission();
    await bus.until(s=>s.events.some(e=>e.type==="movement_committed"));
    await bus.coordinator.challenge(bus.runId);
    const s=await bus.until(s=>s.phase==="completed");
    expect(s.events.map(e=>e.type)).toContain("control_returned");
  });
  test("LLM choosing the forbidden candidate cannot reach Terse", async () => {
    const llmPicksB=async(c: ReturnType<typeof planRecovery>)=>chooseRecovery(c,{...LLM_OFF,enabled:true,apiKey:"k",disabledReason:undefined},
      (async()=>new Response(JSON.stringify({content:[{type:"text",text:JSON.stringify({candidateId:"B",rationale:"fewer steps"})}]}))) as unknown as typeof fetch);
    const {bus}=crew({choose:llmPicksB});
    await bus.startMission({position:[0,0,-1],goal:[0,0,1]});
    const s=await bus.until(s=>s.phase==="completed");
    expect(s.events.find(e=>e.type==="handoff_granted")!.detail).toMatch(/^det-A-/);
  });
  test("without the keep-out conflict the faster 0.35 rad candidate B is chosen and accepted by Terse", async () => {
    const {bus}=crew({config:{...fast,keepOut:{axis:[0,1,0],halfAngle:0.05}}});
    await bus.startMission({position:[0,0,-1],goal:[0,0,1]});
    const s=await bus.until(s=>s.phase==="completed");
    expect(s.events.find(e=>e.type==="handoff_granted")!.detail).toMatch(/^det-B-/);
    expect(s.events.filter(e=>e.type==="movement_committed"&&e.pilot==="rescuer").length).toBe(2);
  });
  test("a lost Navigator reply is recovered from re-read state without a duplicate move", async () => {
    const {bus}=crew({navApi:a=>lossy(a,t=>t==="commit_movement","after")});
    await bus.startMission();
    const s=await bus.until(s=>s.phase==="completed");
    expect(new Set(s.events.map(e=>e.commandId)).size).toBe(s.events.length);
  });
  test("a lost return_control reply is recognized from Terse and recovery_complete is still sent", async () => {
    const {bus}=crew({resApi:a=>lossy(a,t=>t==="return_control","after")});
    await bus.startMission({position:[0,0,-1],goal:[0,0,1]});
    await bus.until(()=>bus!.peerTypes().includes("recovery_complete"));
    const s=await bus.until(s=>s.phase==="completed");
    expect(s.events.filter(e=>e.type==="control_returned").length).toBe(1);
  });
  test("a lost Relay request is resent and the rescue still completes", async () => {
    const {bus}=crew();
    bus.dropPeer=(from,text)=>from==="navigator"&&text.includes('"recovery_request"');
    await bus.startMission({position:[0,0,-1],goal:[0,0,1]});
    const s=await bus.until(s=>s.phase==="completed");
    expect(bus.peerTypes().filter(t=>t==="recovery_request").length).toBe(2);
    expect(s.events.filter(e=>e.type==="handoff_granted").length).toBe(1);
  });
  test("Rescuer rejects a late/forged recovery request that Terse does not hold", async () => {
    const {bus,res}=crew();
    await bus.startMission({position:[1,0,0],goal:[0,0,1]});
    await res.onRequest({type:"recovery_request",v:1,runId:bus.runId,handoffId:"h-forged",revision:1,controlEpoch:0,position:[1,0,0]},"relay-forged");
    const rejection=bus.peerSent.map(m=>m.from==="rescuer"?decodePeer(m.text):null).find(m=>m?.type==="recovery_rejected");
    expect(rejection).toMatchObject({handoffId:"h-forged",reason:"handoff_mismatch"});
    expect(res.jobs.size).toBe(0);
  });
  test("duplicate recovery requests start exactly one rescue", async () => {
    const {bus,res}=crew();
    await bus.startMission({position:[0,0,-1],goal:[0,0,1]});
    await bus.until(()=>bus!.peerSent.some(m=>m.text.includes('"recovery_request"')));
    const req=decodePeer(bus.peerSent.find(m=>m.text.includes('"recovery_request"'))!.text) as never;
    await Promise.all([res.onRequest(req,"resend-1"),res.onRequest(req,"resend-2")]);
    const done=await bus.until(s=>s.phase==="completed");
    expect(done.events.filter(e=>e.type==="handoff_granted").length).toBe(1);
  });
  test("a restarted Rescuer finishes a rescue Terse still assigns to it", async () => {
    const {bus}=crew({rescuer:false});
    await bus.startMission({position:[0,0,-1],goal:[0,0,1]});
    let s=await bus.until(s=>s.phase==="awaiting_rescue");
    const [a]=planRecovery(s,KEEP_OUT);
    const granted=await bus.api("rescuer").command({type:"propose_recovery",command:{runId:s.runId,commandId:"pre-crash",expectedRevision:s.revision,controlEpoch:s.controlEpoch,requestId:s.pendingRecovery!.requestId,proposalId:"det-A-precrash",tangent:a.tangent,alpha:a.alpha}});
    expect(granted.result.ok).toBe(true);
    const res=new RescuerAgent(bus.api("rescuer"),bus.links.rescuer,fast);
    res.start();
    stoppers.push(res);
    s=await bus.until(s=>s.phase==="completed");
    expect(s.events.filter(e=>e.type==="control_returned").length).toBe(1);
  });
});
