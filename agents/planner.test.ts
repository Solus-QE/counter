import { expect, test } from "bun:test";
import { perpendicular, scale, unit } from "../core/geometry";
import { planRecovery } from "./planner";

test("the default demonstration cone rotates with random mission goals",()=>{
  let seed=31;
  const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296*2-1;};
  for(let i=0;i<2000;i++){
    const goal=unit([random(),random(),random()]);
    const candidates=planRecovery({position:scale(goal,-1),goal,rescueAxis:perpendicular(goal)},{axis:[Math.sin(.7),0,-Math.cos(.7)],halfAngle:.05,missionRelative:true});
    expect(candidates.find(candidate=>candidate.id==="A")!.valid).toBe(true);
  }
});
