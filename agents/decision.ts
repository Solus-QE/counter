import { z } from "zod";
import type { AgentConfig } from "./config";
import { deterministicChoice, type Candidate } from "./planner";
import type { Decision } from "./protocol";

export interface Choice { candidate: Candidate; decision: Decision }

const llmOutputSchema=z.object({candidateId:z.enum(["A","B"]),rationale:z.string().min(1).max(400)}).strict();
const OUTPUT_JSON_SCHEMA={
  type:"object",
  properties:{candidateId:{type:"string",enum:["A","B"]},rationale:{type:"string"}},
  required:["candidateId","rationale"],
  additionalProperties:false,
};
const SYSTEM=`You advise the Rescuer of a satellite camera that is stuck at the antipode of its target.
Flight software has already computed two recovery candidates and validated each one; you only choose.
Never recompute geometry. A candidate with violations must not be chosen.
Prefer the candidate that returns control in fewer steps, unless its keep-out margin is much thinner.
Answer with the candidate ID and a one-sentence rationale.`;

function summary(candidates: Candidate[]) {
  return candidates.map(c=>({id:c.id,stepAlphaRad:c.stepAlpha,steps:c.steps,minKeepOutMarginRad:Number(c.minClearance.toFixed(4)),violations:c.violations,valid:c.valid}));
}
function fallback(candidates: Candidate[],reason: string): Choice|null {
  const candidate=deterministicChoice(candidates);
  return candidate?{candidate,decision:{source:"deterministic_fallback",candidateId:candidate.id,reason:reason.slice(0,500)}}:null;
}

/** Structured-output call to the Messages API. Returns the parsed choice or throws with a short reason. */
async function askModel(candidates: Candidate[],llm: AgentConfig["llm"],fetchImpl: typeof fetch): Promise<z.infer<typeof llmOutputSchema>> {
  const response=await fetchImpl("https://api.anthropic.com/v1/messages",{
    method:"POST",
    signal:AbortSignal.timeout(llm.timeoutMs),
    headers:{
      "content-type":"application/json",
      "x-api-key":llm.apiKey!,
      "anthropic-version":"2026-10-21",
      "anthropic-beta":"server-side-fallback-2026-07-01",
    },
    body:JSON.stringify({
      model:llm.model,
      max_tokens:4000,
      fallbacks:"default",
      system:SYSTEM,
      output_config:{effort:"low",format:{type:"json_schema",schema:OUTPUT_JSON_SCHEMA}},
      messages:[{role:"user",content:`Recovery candidates:\n${JSON.stringify(summary(candidates),null,2)}`}],
    }),
  });
  if(!response.ok) throw new Error(`HTTP ${response.status}`);
  const body=await response.json() as {stop_reason?: string; content?: Array<{type: string; text?: string}>};
  if(body.stop_reason==="refusal") throw new Error("model refused");
  const text=body.content?.find(block=>block.type==="text")?.text;
  if(!text) throw new Error(`no text output (stop_reason=${body.stop_reason})`);
  let raw: unknown;
  try {raw=JSON.parse(text);} catch {throw new Error("output is not JSON");}
  const parsed=llmOutputSchema.safeParse(raw);
  if(!parsed.success) throw new Error("output failed schema validation");
  return parsed.data;
}

/**
 * Optional LLM choice between deterministic candidates. The model never produces numbers that reach Terse:
 * the chosen ID selects a precomputed candidate, which must also pass deterministic validation.
 */
export async function chooseRecovery(candidates: Candidate[],llm: AgentConfig["llm"],fetchImpl: typeof fetch=fetch): Promise<Choice|null> {
  if(!llm.enabled) return fallback(candidates,`LLM unavailable: ${llm.disabledReason}`);
  let output: z.infer<typeof llmOutputSchema>;
  try {output=await askModel(candidates,llm,fetchImpl);}
  catch(error) {return fallback(candidates,`LLM unavailable: ${error instanceof Error?error.message:"request failed"}`);}
  const candidate=candidates.find(c=>c.id===output.candidateId);
  if(!candidate?.valid) return fallback(candidates,`LLM chose ${output.candidateId}, rejected by validator: ${candidate?.violations.join("; ")??"unknown"}`);
  return {candidate,decision:{source:"llm",candidateId:candidate.id,model:llm.model,reason:output.rationale}};
}
