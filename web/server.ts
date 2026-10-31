import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const WEB_DIR = dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = resolve(WEB_DIR, "..");
const LEDGER_PATH = join(REPO_ROOT, ".counterwhorl", "agents", "ledger.jsonl");

const PORT = Number(process.env.WEB_PORT ?? 5173);
const HOST = process.env.WEB_HOST ?? "127.0.0.1";
const API_TARGET = (
  process.env.COUNTERWHORL_API_URL ??
  `http://127.0.0.1:${process.env.PORT ?? 3001}`
).replace(/\/+$/, "");
const ALLOWED_ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:5173";

export interface PublicPeerLedgerRecord {
  at: string;
  role: "navigator" | "rescuer";
  dir: "in" | "out";
  messageId: string;
  to?: string;
  from?: string;
  type: string;
  runId?: string;
  handoffId?: string;
  key?: string;
  ok?: boolean;
  inReplyTo?: string;
}

function readPublicLedger(runId?: string | null): PublicPeerLedgerRecord[] {
  if (!existsSync(LEDGER_PATH)) return [];
  try {
    const raw = readFileSync(LEDGER_PATH, "utf8");
    const out: PublicPeerLedgerRecord[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (
          typeof parsed.at !== "string" ||
          (parsed.role !== "navigator" && parsed.role !== "rescuer") ||
          (parsed.dir !== "in" && parsed.dir !== "out") ||
          typeof parsed.messageId !== "string" ||
          typeof parsed.type !== "string"
        ) {
          continue;
        }
        if (runId && typeof parsed.runId === "string" && parsed.runId !== runId) {
          continue;
        }
        // If filtering by runId, skip unrelated generic pings unless no runId filter was passed
        if (runId && !parsed.runId) {
          continue;
        }
        out.push({
          at: parsed.at,
          role: parsed.role,
          dir: parsed.dir,
          messageId: parsed.messageId,
          to: typeof parsed.to === "string" ? parsed.to : undefined,
          from: typeof parsed.from === "string" ? parsed.from : undefined,
          type: parsed.type,
          runId: typeof parsed.runId === "string" ? parsed.runId : undefined,
          handoffId:
            typeof parsed.handoffId === "string" ? parsed.handoffId : undefined,
          key: typeof parsed.key === "string" ? parsed.key : undefined,
          ok: typeof parsed.ok === "boolean" ? parsed.ok : undefined,
          inReplyTo:
            typeof parsed.inReplyTo === "string" ? parsed.inReplyTo : undefined,
        });
      } catch {
        // Ignore malformed partial line during concurrent append
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function bundleAppJs(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(WEB_DIR, "src", "main.ts")],
    target: "browser",
    format: "esm",
    sourcemap: "inline",
  });
  if (!result.success || result.outputs.length === 0) {
    const logs = result.logs.map((l) => l.message).join("\n");
    throw new Error(`Frontend bundle failed:\n${logs}`);
  }
  return result.outputs[0].text();
}

async function proxyApi(request: Request, url: URL): Promise<Response> {
  const upstreamUrl = `${API_TARGET}${url.pathname}${url.search}`;
  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  headers.set("accept", "application/json");
  headers.set("origin", ALLOWED_ORIGIN);

  try {
    const body =
      request.method !== "GET" && request.method !== "HEAD"
        ? await request.text()
        : undefined;
    const upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body,
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return Response.json(
      {
        error: {
          code: "UNAVAILABLE",
          message: `Backend API unreachable at ${API_TARGET} (${detail})`,
        },
      },
      {
        status: 503,
        headers: { "cache-control": "no-store" },
      },
    );
  }
}

export function startWebServer(port = PORT, hostname = HOST) {
  return Bun.serve({
    hostname,
    port,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      if (url.pathname.startsWith("/api/")) {
        return proxyApi(request, url);
      }

      if (url.pathname === "/local/relay-ledger" && request.method === "GET") {
        const runId = url.searchParams.get("runId");
        return Response.json(
          { entries: readPublicLedger(runId) },
          { headers: { "cache-control": "no-store" } },
        );
      }

      if (url.pathname === "/app.js" && request.method === "GET") {
        try {
          const js = await bundleAppJs();
          return new Response(js, {
            headers: {
              "content-type": "application/javascript; charset=utf-8",
              "cache-control": "no-store",
            },
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return new Response(`console.error(${JSON.stringify(msg)});`, {
            status: 500,
            headers: { "content-type": "application/javascript; charset=utf-8" },
          });
        }
      }

      if (url.pathname === "/styles.css" && request.method === "GET") {
        return new Response(Bun.file(join(WEB_DIR, "styles.css")), {
          headers: {
            "content-type": "text/css; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      }

      if (
        (url.pathname === "/" || url.pathname === "/index.html") &&
        request.method === "GET"
      ) {
        return new Response(Bun.file(join(WEB_DIR, "index.html")), {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      }

      if (url.pathname === "/favicon.svg" && request.method === "GET") {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="#08090b" stroke="#38bdf8" stroke-width="2"/><ellipse cx="32" cy="32" rx="28" ry="10" fill="none" stroke="#a78bfa" stroke-width="1.6" transform="rotate(-28 32 32)"/><circle cx="48" cy="20" r="4" fill="#34d399"/><circle cx="16" cy="44" r="4" fill="#f43f5e"/></svg>`;
        return new Response(svg, {
          headers: { "content-type": "image/svg+xml" },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });
}

if (import.meta.main) {
  const server = startWebServer();
  console.log(
    `COUNTERWHORL Mission Control listening at http://localhost:${server.port} (API target: ${API_TARGET})`,
  );
  const shutdown = async () => {
    await server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
