import type {
  ApiError,
  ErrorCode,
  EventsResponse,
  HealthResponse,
  MissionEvent,
  MissionResponse,
  MissionState,
  StartMissionRequest,
} from "../../shared/contract";

export interface PeerLedgerEntry {
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

export class CounterwhorlApiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status = 500,
  ) {
    super(message);
    this.name = "CounterwhorlApiError";
  }
}

declare global {
  interface Window {
    __COUNTERWHORL_API_URL__?: string;
  }
}

function initialBaseUrl(): string {
  if (typeof window === "undefined") return "http://127.0.0.1:3001";
  const param = new URLSearchParams(window.location.search).get("api");
  if (param) return param.replace(/\/+$/, "");
  if (window.__COUNTERWHORL_API_URL__) {
    return window.__COUNTERWHORL_API_URL__.replace(/\/+$/, "");
  }
  return "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseApiError(payload: unknown, fallbackStatus: number): CounterwhorlApiError {
  if (isObject(payload) && isObject(payload.error)) {
    const err = payload.error as Partial<ApiError>;
    if (typeof err.code === "string" && typeof err.message === "string") {
      return new CounterwhorlApiError(
        err.code as ErrorCode,
        err.message,
        fallbackStatus,
      );
    }
  }
  return new CounterwhorlApiError(
    fallbackStatus === 404 ? "NOT_FOUND" : "UNAVAILABLE",
    `HTTP ${fallbackStatus} from COUNTERWHORL backend`,
    fallbackStatus,
  );
}

export class CounterwhorlApiClient {
  private baseUrl: string;
  private triedDirectFallback = false;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl !== undefined ? baseUrl.replace(/\/+$/, "") : initialBaseUrl();
  }

  get endpointBase(): string {
    return this.baseUrl || (typeof window !== "undefined" ? window.location.origin : "");
  }

  private async requestJson<T>(
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          accept: "application/json",
          ...(init?.body ? { "content-type": "application/json" } : {}),
          ...(init?.headers ?? {}),
        },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new CounterwhorlApiError(
        "UNAVAILABLE",
        `Network link to backend failed (${msg})`,
        503,
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    // If served from a plain static file server on :5173 without /api proxy, fall back once to :3001
    if (
      !contentType.includes("application/json") &&
      this.baseUrl === "" &&
      !this.triedDirectFallback
    ) {
      this.triedDirectFallback = true;
      this.baseUrl = "http://127.0.0.1:3001";
      return this.requestJson<T>(path, init);
    }

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      throw new CounterwhorlApiError(
        "UNAVAILABLE",
        `Non-JSON response (${response.status}) from ${path}`,
        response.status,
      );
    }

    if (!response.ok) {
      throw parseApiError(payload, response.status);
    }
    return payload as T;
  }

  async getHealth(signal?: AbortSignal): Promise<HealthResponse> {
    const data = await this.requestJson<HealthResponse>("/api/health", {
      method: "GET",
      signal,
    });
    if (typeof data?.terse !== "boolean" || typeof data?.relay !== "boolean") {
      throw new CounterwhorlApiError(
        "UNAVAILABLE",
        "Malformed /api/health payload",
        502,
      );
    }
    return data;
  }

  async startMission(
    req: StartMissionRequest = {},
    signal?: AbortSignal,
  ): Promise<MissionState> {
    const data = await this.requestJson<MissionResponse>("/api/missions", {
      method: "POST",
      body: JSON.stringify(req),
      signal,
    });
    if (!data?.state?.runId) {
      throw new CounterwhorlApiError(
        "UNAVAILABLE",
        "Malformed MissionResponse on start",
        502,
      );
    }
    return data.state;
  }

  async getMission(runId: string, signal?: AbortSignal): Promise<MissionState> {
    const safeId = encodeURIComponent(runId);
    const data = await this.requestJson<MissionResponse>(
      `/api/missions/${safeId}`,
      { method: "GET", signal },
    );
    if (!data?.state?.runId) {
      throw new CounterwhorlApiError(
        "UNAVAILABLE",
        "Malformed MissionResponse snapshot",
        502,
      );
    }
    return data.state;
  }

  async forceChallenge(
    runId: string,
    signal?: AbortSignal,
  ): Promise<MissionState> {
    const safeId = encodeURIComponent(runId);
    const data = await this.requestJson<MissionResponse>(
      `/api/missions/${safeId}/challenge`,
      {
        method: "POST",
        body: JSON.stringify({}),
        signal,
      },
    );
    if (!data?.state?.runId) {
      throw new CounterwhorlApiError(
        "UNAVAILABLE",
        "Malformed MissionResponse on challenge",
        502,
      );
    }
    return data.state;
  }

  async getEvents(
    runId: string,
    afterRevision = 0,
    signal?: AbortSignal,
  ): Promise<EventsResponse> {
    const safeId = encodeURIComponent(runId);
    const cursor = Math.max(0, Math.trunc(afterRevision));
    const data = await this.requestJson<EventsResponse>(
      `/api/missions/${safeId}/events?afterRevision=${cursor}`,
      { method: "GET", signal },
    );
    if (!Array.isArray(data?.events) || typeof data?.revision !== "number") {
      throw new CounterwhorlApiError(
        "UNAVAILABLE",
        "Malformed EventsResponse",
        502,
      );
    }
    return {
      events: data.events as MissionEvent[],
      revision: data.revision,
    };
  }

  /**
   * Optional read-only peer DM ledger exposed by web/server.ts when `.counterwhorl/agents/ledger.jsonl` exists.
   * Never fabricates messages; returns `[]` if unavailable.
   */
  async getPeerLedger(
    runId: string,
    signal?: AbortSignal,
  ): Promise<PeerLedgerEntry[]> {
    if (this.baseUrl !== "") return [];
    try {
      const res = await fetch(
        `/local/relay-ledger?runId=${encodeURIComponent(runId)}`,
        { method: "GET", headers: { accept: "application/json" }, signal },
      );
      if (!res.ok) return [];
      const data = (await res.json()) as { entries?: unknown };
      return Array.isArray(data.entries)
        ? (data.entries as PeerLedgerEntry[])
        : [];
    } catch {
      return [];
    }
  }
}
