import type { MissionState, Vec3 } from "../shared/contract";
import { angle, dot, escaped, isUnit, MAX_ALPHA, sphericalMove, STEP_ALPHA, steering, UNIT_TOLERANCE } from "../core/geometry";

export type CandidateId = "A"|"B";
export interface KeepOut { axis: Vec3; halfAngle: number }
export interface Candidate {
  id: CandidateId;
  /** Per-step angular cap; each committed step is min(stepAlpha, distance to rescue axis). */
  stepAlpha: number;
  /** First step, sent as the recovery proposal. */
  tangent: Vec3;
  alpha: number;
  steps: number;
  finalPosition: Vec3;
  /** Smallest angular margin to the keep-out cone along the swept arc (negative = inside). */
  minClearance: number;
  violations: string[];
  valid: boolean;
}

const CANDIDATE_ALPHAS: Record<CandidateId,number>={A:STEP_ALPHA,B:MAX_ALPHA};
const SAMPLES_PER_STEP=32;
const MAX_STEPS=40;

/** Deterministically simulate a rescue at a fixed step cap and validate it against Terse policy and the keep-out cone. */
export function simulate(state: Pick<MissionState,"position"|"goal"|"rescueAxis">,id: CandidateId,keepOut: KeepOut): Candidate {
  const stepAlpha=CANDIDATE_ALPHAS[id];
  const violations: string[]=[];
  let x=state.position;
  let minClearance=angle(x,keepOut.axis)-keepOut.halfAngle;
  let first: {tangent: Vec3; alpha: number}|undefined;
  let steps=0;
  while(!escaped(x,state.goal)&&steps<MAX_STEPS) {
    const steer=steering(x,state.rescueAxis);
    if(!steer) {violations.push("rescue field vanishes before escape");break;}
    // steering() caps at STEP_ALPHA; Terse's own bound is the remaining angle to the rescue axis.
    const alpha=Math.min(stepAlpha,angle(x,state.rescueAxis));
    // Same checks the Terse actor applies in core/mission.ts validateMovement for the rescuer.
    if(!isUnit(steer.tangent)||Math.abs(dot(x,steer.tangent))>UNIT_TOLERANCE) violations.push(`step ${steps+1}: tangent not unit/tangent`);
    if(!(alpha>0&&alpha<=MAX_ALPHA)) violations.push(`step ${steps+1}: alpha ${alpha} outside (0, ${MAX_ALPHA}]`);
    if(alpha>angle(x,state.rescueAxis)+UNIT_TOLERANCE) violations.push(`step ${steps+1}: overshoots rescue axis`);
    for(let k=1;k<=SAMPLES_PER_STEP;k++) minClearance=Math.min(minClearance,angle(sphericalMove(x,steer.tangent,alpha*k/SAMPLES_PER_STEP),keepOut.axis)-keepOut.halfAngle);
    first??={tangent:steer.tangent,alpha};
    x=sphericalMove(x,steer.tangent,alpha);
    steps++;
  }
  if(!escaped(x,state.goal)) violations.push("does not escape the antipodal neighborhood");
  if(minClearance<0) violations.push(`enters forbidden pointing cone (margin ${minClearance.toFixed(4)} rad)`);
  if(!first) violations.push("no first step");
  return {id,stepAlpha,tangent:first?.tangent??[0,0,0],alpha:first?.alpha??0,steps,finalPosition:x,minClearance,violations,valid:violations.length===0};
}

export function planRecovery(state: Pick<MissionState,"position"|"goal"|"rescueAxis">,keepOut: KeepOut): Candidate[] {
  return (["A","B"] as const).map(id=>simulate(state,id,keepOut));
}

/** Deterministic policy: fewest steps among valid candidates, then the wider keep-out margin. */
export function deterministicChoice(candidates: Candidate[]): Candidate|undefined {
  return candidates.filter(c=>c.valid).sort((a,b)=>a.steps-b.steps||b.minClearance-a.minClearance)[0];
}
