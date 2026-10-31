/** Genuine two-process Relay smoke test: Navigator and Rescuer exchange peer_ping/peer_pong under their own identities. */
import { spawnAgent } from "./spawn";

console.log("SMOKE starting Rescuer process");
const rescuer=spawnAgent("agents/rescuer.ts",["--smoke"]);
await rescuer.waitFor(/READY/);
console.log("SMOKE starting Navigator process");
const navigator=spawnAgent("agents/navigator.ts",["--smoke"]);
const [navCode,resCode]=await Promise.all([navigator.proc.exited,rescuer.proc.exited]);
const pass=navigator.lines.find(l=>l.includes("SMOKE PASS"));
const answered=rescuer.lines.find(l=>l.includes("answered with peer_pong"));
if(navCode===0&&resCode===0&&pass&&answered) {
  console.log(`\nSMOKE PASS (Navigator pid ${navigator.proc.pid}, Rescuer pid ${rescuer.proc.pid})`);
  console.log(`  navigator: ${pass.slice(pass.indexOf("ping"))}`);
  console.log(`  rescuer:   ${answered.slice(answered.indexOf("peer_ping"))}`);
} else {
  console.error(`\nSMOKE FAIL navigator=${navCode} rescuer=${resCode}`);
  process.exitCode=1;
}
