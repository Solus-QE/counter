import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Coordinator } from "./coordinator";
import { errorResponse } from "../core/mission";
import { agentRequestSchema, startSchema } from "../shared/validation";
import type {
  ApiErrorResponse,
  EventsResponse,
  HealthResponse,
  MissionResponse,
  PilotId,
} from "../shared/contract";

/** Pilot command over HTTP; relayMessageId cites the Relay message that motivated it. */
const pilotCommandSchema = z
  .object({
    request: agentRequestSchema,
    relayMessageId: z
      .string()
      .regex(/^[0-9A-Za-z_-]{1,64}$/)
      .optional(),
  })
  .strict();
const digest = (value: string) => createHash("sha256").update(value).digest();
/** Pilots authenticate with their own Relay identity token, which the coordinator already stores. */
function pilotFor(
  coordinator: Coordinator,
  authorization: string | null,
): PilotId | undefined {
  const presented = /^Bearer (\S+)$/.exec(authorization ?? "")?.[1];
  if (!presented) return undefined;
  for (const pilot of ["navigator", "rescuer"] as const) {
    const token =
      process.env[`RELAY_${pilot.toUpperCase()}_TOKEN`] ??
      coordinator.store.setting(`relay.${pilot}.token`);
    if (token && timingSafeEqual(digest(token), digest(presented)))
      return pilot;
  }
  return undefined;
}

export function createHandler(
  coordinator: Coordinator,
  health: () => HealthResponse,
) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    const allowedOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "cache-control": "no-store",
    };
    if (origin && origin !== allowedOrigin && origin !== url.origin)
      return Response.json(
        {
          error: { code: "UNAUTHORIZED", message: "Origin is not allowed" },
        } satisfies ApiErrorResponse,
        { status: 403 },
      );
    if (origin)
      Object.assign(headers, {
        "access-control-allow-origin": origin,
        vary: "Origin",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "Content-Type",
      });
    const json = (body: unknown, status = 200) =>
      Response.json(body, { status, headers });
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers });
    try {
      if (url.pathname === "/api/health" && request.method === "GET")
        return json(health());
      if (
        request.method === "POST" &&
        !request.headers.get("content-type")?.startsWith("application/json")
      )
        return json(
          {
            error: { code: "INVALID_COMMAND", message: "Use application/json" },
          },
          415,
        );
      if (url.pathname.startsWith("/api/pilot/")) {
        // Server-to-server only: browsers never hold pilot credentials.
        if (origin)
          return json(
            {
              error: {
                code: "UNAUTHORIZED",
                message: "Pilot routes are not available to browsers",
              },
            },
            403,
          );
        const pilot = pilotFor(coordinator, request.headers.get("authorization"));
        if (!pilot)
          return json(
            {
              error: { code: "UNAUTHORIZED", message: "Invalid pilot credentials" },
            },
            401,
          );
        if (url.pathname === "/api/pilot/runs" && request.method === "GET") {
          const runs = [];
          for (const runId of coordinator.store.runs()) {
            const state = await coordinator
              .actor(runId)
              .getState()
              .catch(() => undefined);
            if (state && state.phase !== "completed")
              runs.push({ runId, revision: state.revision, phase: state.phase });
          }
          return json({ runs });
        }
        if (url.pathname === "/api/pilot/commands" && request.method === "POST") {
          const parsed = pilotCommandSchema.safeParse(await request.json());
          if (!parsed.success)
            return json(
              {
                error: {
                  code: "INVALID_COMMAND",
                  message: "Body must be {request: AgentRequest, relayMessageId?}",
                },
              },
              400,
            );
          // Same authorization, fencing and Terse path as Relay-delivered commands.
          return json(
            await coordinator.dispatch(
              pilot,
              parsed.data.relayMessageId,
              parsed.data.request,
            ),
          );
        }
      }
      if (url.pathname === "/api/missions" && request.method === "POST") {
        const parsed = startSchema.safeParse(await request.json());
        if (!parsed.success)
          return json(
            {
              error: {
                code: "INVALID_COMMAND",
                message: "Invalid mission request",
              },
            },
            400,
          );
        return json(
          {
            state: await coordinator.start(parsed.data),
          } satisfies MissionResponse,
          201,
        );
      }
      const match =
        /^\/api\/missions\/([a-zA-Z0-9_.-]{1,128})(?:\/(challenge|events))?$/.exec(
          url.pathname,
        );
      if (match) {
        const [, runId, action] = match;
        const actor = coordinator.knownActor(runId);
        if (!action && request.method === "GET")
          return json({
            state: await actor.getState(),
          } satisfies MissionResponse);
        if (action === "challenge" && request.method === "POST")
          return json({
            state: await coordinator.challenge(runId),
          } satisfies MissionResponse);
        if (action === "events" && request.method === "GET") {
          const after = Number(url.searchParams.get("afterRevision") ?? 0);
          if (!Number.isSafeInteger(after) || after < 0)
            return json(
              {
                error: {
                  code: "INVALID_COMMAND",
                  message: "Invalid event cursor",
                },
              },
              400,
            );
          return json((await actor.getEvents(after)) satisfies EventsResponse);
        }
      }
      return json(
        { error: { code: "NOT_FOUND", message: "Route not found" } },
        404,
      );
    } catch (error) {
      if (error instanceof SyntaxError)
        return json(
          { error: { code: "INVALID_COMMAND", message: "Invalid JSON" } },
          400,
        );
      const parsed = errorResponse(error);
      const status =
        parsed.code === "NOT_FOUND"
          ? 404
          : parsed.code === "UNAUTHORIZED"
            ? 403
            : parsed.code === "UNAVAILABLE"
              ? 503
              : [
                    "STALE_REVISION",
                    "STALE_EPOCH",
                    "DUPLICATE_COMMAND",
                    "COMPLETED",
                    "INVALID_PHASE",
                    "ALREADY_STARTED",
                  ].includes(parsed.code)
                ? 409
                : 400;
      return json({ error: parsed } satisfies ApiErrorResponse, status);
    }
  };
}
