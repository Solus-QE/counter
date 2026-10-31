import { describe, expect, test } from "bun:test";
import type { MissionEvent, MissionState } from "../../shared/contract";
import { ESCAPE_NORM, perpendicular, scale, sphericalMove } from "./sphere-math";
import {
  buildAuthenticRelayTranscript,
  buildProtocolTimeline,
  deriveRelayHealth,
  deriveTelemetry,
  mergeAuthoritativeState,
} from "./telemetry";

function makeBaseState(overrides: Partial<MissionState> = {}): MissionState {
  const goal = overrides.goal ?? ([0, 0, 1] as const);
  const rescueAxis = overrides.rescueAxis ?? perpendicular(goal);
  return {
    runId: "run-test-1",
    revision: 1,
    position: [1, 0, 0],
    goal,
    rescueAxis,
    phase: "navigating",
    activePilot: "navigator",
    controlEpoch: 0,
    processedCommandIds: ["cmd-1"],
    events: [
      {
        id: "run-test-1:1",
        runId: "run-test-1",
        revision: 1,
        timestamp: "2026-10-31T19:00:00.000Z",
        type: "mission_started",
        pilot: "coordinator",
        controlEpoch: 0,
        commandId: "cmd-1",
        position: [1, 0, 0],
      },
    ],
    trajectory: [
      {
        revision: 1,
        position: [1, 0, 0],
        pilot: "coordinator",
        kind: "start",
      },
    ],
    pendingRecovery: null,
    ...overrides,
  };
}

describe("COUNTERWHORL web telemetry & Terse confirmation invariants", () => {
  test("covers connecting, waiting, stalled, recovering, failed, and completed states", () => {
    // 1. connecting
    const connecting = deriveTelemetry({
      booting: true,
      health: null,
      mission: null,
      events: [],
      stagedPosition: [1, 0, 0],
      stagedGoal: [0, 0, 1],
      lastError: null,
    });
    expect(connecting.lifecycle).toBe("connecting");

    // 2. waiting (healthy backend, pre-launch)
    const waiting = deriveTelemetry({
      booting: false,
      health: { terse: true, relay: true },
      mission: null,
      events: [],
      stagedPosition: [1, 0, 0],
      stagedGoal: [0, 0, 1],
      lastError: null,
    });
    expect(waiting.lifecycle).toBe("waiting");

    // 3. stalled (at exact antipode -goal)
    const antipodeState = makeBaseState({
      revision: 2,
      position: [0, 0, -1],
      goal: [0, 0, 1],
      controlEpoch: 1,
    });
    const stalledSnap = deriveTelemetry({
      booting: false,
      health: { terse: true, relay: true },
      mission: antipodeState,
      events: antipodeState.events,
      stagedPosition: [1, 0, 0],
      stagedGoal: [0, 0, 1],
      lastError: null,
    });
    expect(stalledSnap.lifecycle).toBe("stalled");
    expect(stalledSnap.navNorm).toBeLessThanOrEqual(1e-7);
    expect(stalledSnap.resNorm).toBeCloseTo(1, 6);

    // 4. recovering (phase === "rescuing")
    const rescuingState = makeBaseState({
      revision: 4,
      position: sphericalMove([0, 0, -1], [1, 0, 0], 0.2),
      phase: "rescuing",
      activePilot: "rescuer",
      controlEpoch: 2,
      pendingRecovery: { requestId: "h-1", proposalId: "llm-A-12345678" },
    });
    const recoveringSnap = deriveTelemetry({
      booting: false,
      health: { terse: true, relay: true },
      mission: rescuingState,
      events: rescuingState.events,
      stagedPosition: [1, 0, 0],
      stagedGoal: [0, 0, 1],
      lastError: null,
    });
    expect(recoveringSnap.lifecycle).toBe("recovering");
    expect(recoveringSnap.decision.source).toBe("llm");
    expect(recoveringSnap.decision.candidate).toBe("A");

    // 5. failed (Terse offline or recovery watch failed)
    const failedSnap = deriveTelemetry({
      booting: false,
      health: { terse: false, relay: false, relayError: "disconnected" },
      mission: antipodeState,
      events: antipodeState.events,
      stagedPosition: [1, 0, 0],
      stagedGoal: [0, 0, 1],
      lastError: null,
    });
    expect(failedSnap.lifecycle).toBe("failed");

    // 6. completed (Terse phase === "completed")
    const completedState = makeBaseState({
      revision: 12,
      position: [0, 0, 1],
      goal: [0, 0, 1],
      phase: "completed",
      activePilot: "navigator",
      controlEpoch: 3,
    });
    const completedSnap = deriveTelemetry({
      booting: false,
      health: { terse: true, relay: true },
      mission: completedState,
      events: completedState.events,
      stagedPosition: [1, 0, 0],
      stagedGoal: [0, 0, 1],
      lastError: null,
    });
    expect(completedSnap.lifecycle).toBe("completed");
  });

  test("NEVER marks recovery complete before Terse commits control_returned, even after escape norm >= 0.50 and peer recovery_complete", () => {
    // Escaped position (0.60 rad away from -Z along +X has sin(0.6) ≈ 0.5646 >= 0.50)
    const escapedPos = sphericalMove(scale([0, 0, 1], -1), [1, 0, 0], 0.6);
    const eventsBeforeReturn: MissionEvent[] = [
      {
        id: "r:1",
        runId: "run-test-1",
        revision: 1,
        timestamp: "2026-10-31T19:00:00.000Z",
        type: "mission_started",
        pilot: "coordinator",
        controlEpoch: 0,
        commandId: "c1",
        position: [1, 0, 0],
      },
      {
        id: "r:2",
        runId: "run-test-1",
        revision: 2,
        timestamp: "2026-10-31T19:00:01.000Z",
        type: "challenge_forced",
        pilot: "coordinator",
        controlEpoch: 1,
        commandId: "c2",
        position: [0, 0, -1],
      },
      {
        id: "r:3",
        runId: "run-test-1",
        revision: 3,
        timestamp: "2026-10-31T19:00:02.000Z",
        type: "recovery_requested",
        pilot: "navigator",
        controlEpoch: 1,
        commandId: "c3",
        relayMessageId: "relay-msg-req-1",
        position: [0, 0, -1],
        detail: "h-99",
      },
      {
        id: "r:4",
        runId: "run-test-1",
        revision: 4,
        timestamp: "2026-10-31T19:00:03.000Z",
        type: "handoff_granted",
        pilot: "coordinator",
        controlEpoch: 2,
        commandId: "c4",
        relayMessageId: "relay-msg-prop-1",
        position: [0, 0, -1],
        detail: "det-A-abcd1234",
      },
    ];

    const unconfirmedState = makeBaseState({
      revision: 7,
      position: escapedPos,
      phase: "rescuing",
      activePilot: "rescuer",
      controlEpoch: 2,
      events: eventsBeforeReturn,
      pendingRecovery: { requestId: "h-99", proposalId: "det-A-abcd1234" },
    });

    const snapBefore = deriveTelemetry({
      booting: false,
      health: { terse: true, relay: true },
      mission: unconfirmedState,
      events: eventsBeforeReturn,
      peerLedger: [
        {
          at: "2026-10-31T19:00:05.000Z",
          role: "rescuer",
          dir: "out",
          to: "navigator",
          messageId: "relay-peer-complete-1",
          type: "recovery_complete",
          runId: "run-test-1",
          handoffId: "h-99",
        },
      ],
      stagedPosition: [1, 0, 0],
      stagedGoal: [0, 0, 1],
      lastError: null,
    });

    expect(snapBefore.navNorm).toBeGreaterThanOrEqual(ESCAPE_NORM);
    expect(snapBefore.isEscaped).toBe(true);
    // CRITICAL INVARIANT: still "recovering", 0 confirmed recoveries, pipeline NOT "confirmed"!
    expect(snapBefore.lifecycle).toBe("recovering");
    expect(snapBefore.outcomes.terseConfirmedRecoveries).toBe(0);
    expect(snapBefore.handoffStage).toBe("escaping");

    // Now Terse commits `control_returned`!
    const eventsAfterReturn: MissionEvent[] = [
      ...eventsBeforeReturn,
      {
        id: "r:8",
        runId: "run-test-1",
        revision: 8,
        timestamp: "2026-10-31T19:00:05.500Z",
        type: "control_returned",
        pilot: "rescuer",
        controlEpoch: 3,
        commandId: "c8",
        relayMessageId: "relay-msg-ret-1",
        position: escapedPos,
      },
    ];
    const confirmedState = makeBaseState({
      revision: 8,
      position: escapedPos,
      phase: "navigating",
      activePilot: "navigator",
      controlEpoch: 3,
      events: eventsAfterReturn,
      pendingRecovery: null,
    });

    const snapAfter = deriveTelemetry({
      booting: false,
      health: { terse: true, relay: true },
      mission: confirmedState,
      events: eventsAfterReturn,
      stagedPosition: [1, 0, 0],
      stagedGoal: [0, 0, 1],
      lastError: null,
    });

    expect(snapAfter.outcomes.terseConfirmedRecoveries).toBe(1);
    expect(snapAfter.handoffStage).toBe("confirmed");
    const grantRow = snapAfter.protocolTimeline.find((r) => r.revision === 4);
    const returnRow = snapAfter.protocolTimeline.find((r) => r.revision === 8);
    expect(grantRow?.summary).toContain("(epoch e2)");
    expect(returnRow?.summary).toContain("(epoch e3)");
  });

  test("Relay transcript never fabricates messages for HTTP-only events", () => {
    const httpOnlyEvents: MissionEvent[] = [
      {
        id: "r:1",
        runId: "run-1",
        revision: 1,
        timestamp: "2026-10-31T19:00:00.000Z",
        type: "mission_started",
        pilot: "coordinator",
        controlEpoch: 0,
        commandId: "http-1",
        position: [1, 0, 0],
      },
      {
        id: "r:2",
        runId: "run-1",
        revision: 2,
        timestamp: "2026-10-31T19:00:01.000Z",
        type: "challenge_forced",
        pilot: "coordinator",
        controlEpoch: 0,
        commandId: "http-2",
        position: [0, 0, -1],
      },
    ];
    const transcript = buildAuthenticRelayTranscript(httpOnlyEvents, []);
    expect(transcript).toHaveLength(0);

    const timeline = buildProtocolTimeline(httpOnlyEvents, []);
    expect(timeline).toHaveLength(2);
    expect(timeline.every((t) => t.relayMessageId === null)).toBe(true);
    expect(timeline[0].transportLabel).toBe("HTTP · Judge");
  });

  test("7-stage recovery checklist and protocol timeline preserve shared Relay IDs and gate Navigator resumes strictly on control_returned", () => {
    const escapedPos = sphericalMove(scale([0, 0, 1], -1), [1, 0, 0], 0.6);
    const sharedRelayReqId = "msg_019shared_recovery_req";
    const eventsRescuing: MissionEvent[] = [
      {
        id: "r:1",
        runId: "run-shared",
        revision: 1,
        timestamp: "2026-10-31T19:00:00.000Z",
        type: "mission_started",
        pilot: "coordinator",
        controlEpoch: 0,
        commandId: "c1",
        position: [1, 0, 0],
      },
      {
        id: "r:2",
        runId: "run-shared",
        revision: 2,
        timestamp: "2026-10-31T19:00:01.000Z",
        type: "challenge_forced",
        pilot: "coordinator",
        controlEpoch: 1,
        commandId: "c2",
        position: [0, 0, -1],
      },
      {
        id: "r:3",
        runId: "run-shared",
        revision: 3,
        timestamp: "2026-10-31T19:00:02.000Z",
        type: "recovery_requested",
        pilot: "navigator",
        controlEpoch: 1,
        commandId: "c3",
        relayMessageId: sharedRelayReqId,
        position: [0, 0, -1],
        detail: "handoff-42",
      },
      {
        id: "r:4",
        runId: "run-shared",
        revision: 4,
        timestamp: "2026-10-31T19:00:02.400Z",
        type: "handoff_granted",
        pilot: "coordinator",
        controlEpoch: 2,
        commandId: "c4",
        relayMessageId: sharedRelayReqId,
        position: [0, 0, -1],
        detail: "llm-A-99887766",
      },
    ];

    const rescuingState = makeBaseState({
      runId: "run-shared",
      revision: 6,
      position: escapedPos,
      phase: "rescuing",
      activePilot: "rescuer",
      controlEpoch: 2,
      events: eventsRescuing,
      pendingRecovery: { requestId: "handoff-42", proposalId: "llm-A-99887766" },
    });

    const snapDuring = deriveTelemetry({
      booting: false,
      health: { terse: true, relay: true },
      mission: rescuingState,
      events: eventsRescuing,
      stagedPosition: [1, 0, 0],
      stagedGoal: [0, 0, 1],
      lastError: null,
    });

    expect(snapDuring.recoverySteps).toHaveLength(7);
    expect(snapDuring.recoverySteps.map((s) => s.title)).toEqual([
      "Navigator active",
      "Mathematical blind spot detected",
      "Recovery requested via Agent Relay",
      "Rescuer accepts responsibility",
      "Terse authorizes movement",
      "Navigator resumes",
      "Mission completed",
    ]);
    // Navigator resumes MUST still be pending before control_returned!
    expect(snapDuring.recoverySteps[4].status).toBe("active");
    expect(snapDuring.recoverySteps[5].status).toBe("pending");

    // Shared peer request ID produces 1 unique Relay message and 2 Terse revision rows (r4 citing r3)
    expect(snapDuring.outcomes.verifiedRelayCount).toBe(1);
    expect(snapDuring.relayTranscript).toHaveLength(1);
    const sharedRows = snapDuring.protocolTimeline.filter(
      (t) => t.relayMessageId === sharedRelayReqId,
    );
    expect(sharedRows).toHaveLength(2);
    expect(sharedRows.find((r) => r.revision === 3)?.relayCited).toBe(false);
    expect(sharedRows.find((r) => r.revision === 4)?.relayCited).toBe(true);
  });

  test("distinguishes connecting, online, offline, and errored Relay health states without manufacturing online", () => {
    // 1. Booting before first health response -> connecting
    expect(deriveRelayHealth(true, null).status).toBe("connecting");

    // 2. Fresh backend startup: terse:true, relay:false, no relayError -> connecting
    const startupConnecting = deriveRelayHealth(false, {
      terse: true,
      relay: false,
    });
    expect(startupConnecting.status).toBe("connecting");

    // 3. Connected -> online
    expect(
      deriveRelayHealth(false, { terse: true, relay: true }).status,
    ).toBe("online");

    // 4. Unconfigured / disconnected / backend down -> offline
    expect(
      deriveRelayHealth(false, {
        terse: true,
        relay: false,
        relayError: "RELAY_WORKSPACE_KEY is not configured",
      }).status,
    ).toBe("offline");
    expect(
      deriveRelayHealth(false, {
        terse: false,
        relay: false,
        relayError: "API unreachable",
      }).status,
    ).toBe("offline");

    // 5. Explicit capacity / initialization / transport failure -> errored
    const capacityErr = deriveRelayHealth(false, {
      terse: true,
      relay: false,
      relayError: "Relay initialization: workspace capacity limit reached",
    });
    expect(capacityErr.status).toBe("errored");
    expect(capacityErr.label).toBe("error");
  });

  test("ignores stale state revisions while accepting newer revisions and new runs, and verifies peer recovery_complete receipt", () => {
    const r5 = makeBaseState({ runId: "run-a", revision: 5 });
    const r3Stale = makeBaseState({ runId: "run-a", revision: 3 });
    const r6Newer = makeBaseState({ runId: "run-a", revision: 6 });
    const newRun = makeBaseState({ runId: "run-b", revision: 1 });

    expect(mergeAuthoritativeState(r5, r3Stale).revision).toBe(5);
    expect(mergeAuthoritativeState(r5, r6Newer).revision).toBe(6);
    expect(mergeAuthoritativeState(r5, newRun).runId).toBe("run-b");

    // Verify recovery_complete ledger receipt after Terse control_returned
    const eventsWithReturn: MissionEvent[] = [
      {
        id: "a:9",
        runId: "run-a",
        revision: 9,
        timestamp: "2026-10-31T20:40:31.725Z",
        type: "control_returned",
        pilot: "rescuer",
        controlEpoch: 3,
        commandId: "cmd-9",
        position: [0.56, 0, -0.82],
      },
    ];
    const timeline = buildProtocolTimeline(eventsWithReturn, [
      {
        at: "2026-10-31T20:40:38.963Z",
        role: "rescuer",
        dir: "out",
        to: "navigator",
        messageId: "242387308902408192",
        type: "recovery_complete",
        runId: "run-a",
      },
      {
        at: "2026-10-31T20:40:41.324Z",
        role: "navigator",
        dir: "in",
        from: "rescuer",
        messageId: "242387308902408192",
        type: "recovery_complete",
        runId: "run-a",
      },
    ]);
    const dmRow = timeline.find(
      (t) => t.relayMessageId === "242387308902408192",
    );
    expect(dmRow?.summary).toContain("@navigator receipt verified");
  });
});
