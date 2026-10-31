import {
  AgentRelay,
  type RelayAgentClient,
  type RelayMessage,
  safeRelayErrorMessage,
} from "@agent-relay/sdk";
import type { CoordinatorMessage, PilotId } from "../shared/contract";
import { agentRequestSchema } from "../shared/validation";
import { Coordinator } from "./coordinator";

export class RelayBridge {
  private relay?: AgentRelay;
  private client?: RelayAgentClient;
  private identities = new Map<PilotId, { id: string; name: string }>();
  private unsubscribers: Array<() => void> = [];
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private connecting = false;
  private tickTask?: Promise<void>;
  private publishTask?: Promise<void>;
  private identitiesCheckedAt = 0;
  private stopped = false;
  private inFlight = new Map<string, Promise<void>>();
  private lastSuccess = 0;
  lastError: string | undefined;
  readonly names: Record<PilotId, string>;
  constructor(
    private coordinator: Coordinator,
    private workspaceKey = process.env.RELAY_WORKSPACE_KEY ??
      coordinator.store.setting("relay.workspaceKey"),
    private coordinatorToken?: string,
  ) {
    this.names = {
      navigator:
        process.env.RELAY_NAVIGATOR_NAME ??
        coordinator.store.setting("relay.navigator.name") ??
        "navigator",
      rescuer:
        process.env.RELAY_RESCUER_NAME ??
        coordinator.store.setting("relay.rescuer.name") ??
        "rescuer",
    };
  }
  get healthy(): boolean {
    return (
      !!this.client &&
      this.identities.size === 2 &&
      !this.lastError &&
      Date.now() - this.lastSuccess < 10000
    );
  }
  async start(): Promise<void> {
    if (this.stopped || this.connecting) return;
    if (this.timer) clearInterval(this.timer);
    if (!this.workspaceKey) {
      this.lastError = "RELAY_WORKSPACE_KEY is not configured";
      return;
    }
    this.connecting = true;
    try {
      this.relay = new AgentRelay({
        workspaceKey: this.workspaceKey,
        // Persist explicit metadata ourselves; disable ambient per-process injection.
        sessionRef: "",
        onError: () => {
          this.lastError = "Relay transport error";
        },
      });
      const token =
        this.coordinatorToken ??
        process.env.RELAY_COORDINATOR_TOKEN ??
        this.coordinator.store.setting("relay.coordinator.token");
      this.client = token
        ? await this.relay.workspace.reconnect({ apiToken: token })
        : await this.relay.workspace.register({
            name:
              process.env.RELAY_COORDINATOR_NAME ??
              this.coordinator.store.setting("relay.coordinator.name") ??
              "counterwhorl-coordinator",
            type: "agent",
          });
      if (this.stopped) {
        await this.relay.events.disconnect();
        return;
      }
      if (this.client.token)
        this.coordinator.store.setSetting(
          "relay.coordinator.token",
          this.client.token,
        );
      this.coordinator.store.setSetting(
        "relay.coordinator.name",
        this.client.name,
      );
      for (const selector of ["message.created", "dm.received"] as const) {
        // Live notifications wake the durable inbox drain. The authenticated inbox
        // establishes the recipient even when the SDK labels a DM as a channel.
        this.unsubscribers.push(
          this.relay.addListener(selector, ({ message }) =>
            this.receive(message),
          ),
        );
      }
      await this.tick();
      if (!this.stopped) this.timer = setInterval(() => void this.tick(), 1000);
    } catch (error) {
      this.lastError = `Relay initialization: ${safeRelayErrorMessage(error)}`;
      this.client = undefined;
      for (const unsubscribe of this.unsubscribers) unsubscribe();
      this.unsubscribers = [];
      await this.relay?.events.disconnect();
      if (!this.stopped)
        this.timer = setInterval(() => void this.start(), 5000);
    } finally {
      this.connecting = false;
    }
  }
  private tick(): Promise<void> {
    if (this.tickTask) return this.tickTask;
    const task = this.drain().finally(() => {
      if (this.tickTask === task) this.tickTask = undefined;
    });
    this.tickTask = task;
    return task;
  }
  private async drain(): Promise<void> {
    if (this.busy || this.stopped || !this.relay || !this.client) return;
    this.busy = true;
    try {
      if (
        this.identities.size < 2 ||
        Date.now() - this.identitiesCheckedAt > 60000
      ) {
        for (const pilot of ["navigator", "rescuer"] as const) {
          const identity = await this.relay.agents.get(this.names[pilot]);
          const pinned = this.coordinator.store.setting(`relay.${pilot}.id`);
          if (pinned && pinned !== identity.id)
            throw new Error(
              "Pilot identity changed; explicit reconfiguration required",
            );
          if (!pinned)
            this.coordinator.store.setSetting(`relay.${pilot}.id`, identity.id);
          this.identities.set(pilot, { id: identity.id, name: identity.name });
          this.lastSuccess = Date.now();
        }
        this.identitiesCheckedAt = Date.now();
      }
      // The delivery ledger retains requests across coordinator disconnects.
      const { items } = await this.client.inbox.list({ limit: 100 });
      this.lastSuccess = Date.now();
      if (process.env.COUNTERWHORL_DEBUG_RELAY === "1")
        console.log("Relay inbox", items.length);
      for (const item of items) {
        if (this.stopped) return;
        await this.receive(item.message);
        await this.client.inbox.ack({ inboxItemId: item.id });
      }
      // Some Relay deployments deliver online DMs without leaving a pending ledger
      // row. Unread conversation history is the durable reconnect path for those DMs.
      const inbox = await this.client.inbox.get({ limit: 100 });
      this.lastSuccess = Date.now();
      for (const conversation of inbox.unreadDms) {
        if (this.stopped) return;
        const cursorKey = `relay.conversation.${conversation.conversationId}.cursor`;
        const saved = this.coordinator.store.setting(cursorKey);
        const messages: RelayMessage[] = [];
        let before: string | undefined;
        // Read backwards until the saved cursor, then apply unseen requests FIFO.
        for (;;) {
          const page = await this.client.messages.listDirect({
            conversationId: conversation.conversationId,
            limit: 100,
            before,
          });
          if (!page.length) break;
          messages.push(...page);
          if (page.length < 100 || page.some((m) => m.messageId === saved))
            break;
          const oldest = page.reduce((a, b) =>
            a.messageId.length < b.messageId.length ||
            (a.messageId.length === b.messageId.length &&
              a.messageId.localeCompare(b.messageId) < 0)
              ? a
              : b,
          ).messageId;
          if (oldest === before)
            throw new Error("Relay history cursor did not advance");
          before = oldest;
        }
        messages.sort(
          (a, b) =>
            a.messageId.length - b.messageId.length ||
            a.messageId.localeCompare(b.messageId),
        );
        let lastIncoming: string | undefined;
        for (const message of messages) {
          if (this.stopped) return;
          if (
            saved &&
            (message.messageId.length < saved.length ||
              (message.messageId.length === saved.length &&
                message.messageId.localeCompare(saved) <= 0))
          )
            continue;
          if (
            ![...this.identities.values()].some(
              (identity) => identity.id === message.from.id,
            )
          )
            continue;
          await this.receive(message);
          lastIncoming = message.messageId;
          this.coordinator.store.setSetting(cursorKey, message.messageId);
        }
        if (lastIncoming) await this.client.messages.markRead(lastIncoming);
      }
      this.lastError = undefined;
      this.lastSuccess = Date.now();
      // Notification latency must never block the control-command inbox.
      if (!this.publishTask) {
        this.publishTask = this.publishEvents()
          .catch(() => {
            this.lastError = "Relay event notification unavailable";
          })
          .finally(() => {
            this.publishTask = undefined;
          });
      }
    } catch (error) {
      this.lastError =
        error instanceof Error && error.message.includes("identity changed")
          ? error.message
          : `Relay: ${safeRelayErrorMessage(error)}`;
    } finally {
      this.busy = false;
    }
  }
  private async publishEvents(): Promise<void> {
    for (const runId of this.coordinator.store.runs()) {
      if (this.stopped) return;
      let state;
      try {
        state = await this.coordinator.actor(runId).getState();
      } catch {
        continue;
      }
      const results = await Promise.allSettled(
        (["navigator", "rescuer"] as const).map(async (pilot) => {
          const cursor = this.coordinator.store.cursor(runId, pilot);
          for (const event of state.events.filter((e) => e.revision > cursor)) {
            if (this.stopped) return;
            // Movement replies already deliver authoritative state to the active pilot.
            // All movement events remain available through the HTTP timeline.
            const notify =
              event.type === "mission_started" ||
              event.type === "challenge_forced" ||
              event.type === "control_returned"
                ? pilot === "navigator"
                : event.type === "recovery_requested"
                  ? pilot === "rescuer"
                  : event.type === "mission_completed";
            if (notify) {
              await this.send(
                pilot,
                { type: "mission_event", event, state },
                `event-${event.id}-${pilot}`,
              );
            }
            this.coordinator.store.checkpoint(runId, pilot, event.revision);
          }
        }),
      );
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }
  }
  private receive(message: RelayMessage): Promise<void> {
    const running = this.inFlight.get(message.messageId);
    if (running) return running;
    const operation = this.handle(message).finally(() =>
      this.inFlight.delete(message.messageId),
    );
    this.inFlight.set(message.messageId, operation);
    return operation;
  }
  private async handle(message: RelayMessage): Promise<void> {
    if (process.env.COUNTERWHORL_DEBUG_RELAY === "1")
      console.log(
        "Relay inbound",
        JSON.stringify({
          id: message.messageId,
          kind: message.kind,
          from: message.from,
          target: message.target,
          identities: [...this.identities],
        }),
      );
    if (!this.client || !message.from.id) return;
    const pilot = (["navigator", "rescuer"] as const).find(
      (p) =>
        this.identities.get(p)?.id === message.from.id &&
        this.identities.get(p)?.name === message.from.name,
    );
    if (!pilot) return;
    // This relay has only the coordinator's authenticated client as an event source.
    // Durable inbox/history calls are likewise scoped to that same client.
    let response = this.coordinator.store.response(
      message.messageId,
      message.from.id,
    );
    if (!response) {
      let raw: unknown;
      try {
        raw = JSON.parse(message.text);
      } catch {
        return;
      }
      const parsed = agentRequestSchema.safeParse(raw);
      if (!parsed.success) {
        response = {
          type: "command_result",
          result: {
            ok: false,
            commandId: message.messageId,
            error: {
              code: "INVALID_COMMAND",
              message: "Message does not match the shared agent protocol",
            },
          },
        };
      } else {
        response = await this.coordinator.dispatch(
          pilot,
          message.messageId,
          parsed.data,
        );
      }
      this.coordinator.store.saveResponse(
        message.messageId,
        message.from.id,
        response,
      );
    }
    await this.send(pilot, response, `result-${message.messageId}`);
  }
  private async send(
    pilot: PilotId,
    message: CoordinatorMessage,
    key: string,
  ): Promise<void> {
    const stableKey = `counterwhorl:outbox:v1:${key}`;
    const sessionRef = process.env.RELAY_ATTEST_SESSION_ID?.trim();
    const payload = this.coordinator.store.outgoing(stableKey, {
      to: `@${this.names[pilot]}`,
      text: JSON.stringify(message),
      idempotencyKey: stableKey,
      metadata:
        sessionRef && sessionRef.length <= 255
          ? { session_ref: sessionRef }
          : {},
    });
    await this.client!.sendMessage(payload);
    this.lastSuccess = Date.now();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    await this.relay?.events.disconnect();
    await this.tickTask;
    await this.publishTask;
    await Promise.allSettled(this.inFlight.values());
  }
}
