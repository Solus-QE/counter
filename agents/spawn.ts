import type { Subprocess } from "bun";

export interface AgentProcess { proc: Subprocess<"ignore","pipe","inherit">; lines: string[]; waitFor: (pattern: RegExp,ms?: number)=>Promise<string> }

/** Launches an agent entry point as its own OS process and streams its log lines with a prefix. */
export function spawnAgent(script: string,args: string[]=[],env: Record<string,string>={}): AgentProcess {
  const proc=Bun.spawn([process.execPath,script,...args],{stdout:"pipe",stderr:"inherit",env:{...process.env,...env}});
  const lines: string[]=[];
  const listeners=new Set<()=>void>();
  void (async()=>{
    const decoder=new TextDecoder();
    let buffer="";
    for await (const chunk of proc.stdout) {
      buffer+=decoder.decode(chunk,{stream:true});
      const parts=buffer.split("\n");
      buffer=parts.pop()!;
      for(const line of parts) {lines.push(line);console.log(`  │ ${line}`);}
      for(const notify of listeners) notify();
    }
  })();
  const waitFor=(pattern: RegExp,ms=30000)=>new Promise<string>((resolve,reject)=>{
    const check=()=>{
      const hit=lines.find(l=>pattern.test(l));
      if(hit) {listeners.delete(check);clearTimeout(timer);resolve(hit);}
    };
    const timer=setTimeout(()=>{listeners.delete(check);reject(new Error(`${script}: no line matching ${pattern} within ${ms}ms`));},ms);
    listeners.add(check);
    void proc.exited.then(()=>setTimeout(()=>{if(listeners.has(check)) {listeners.delete(check);clearTimeout(timer);reject(new Error(`${script} exited before ${pattern}`));}},50));
    check();
  });
  return {proc,lines,waitFor};
}
