import { describe, expect, test } from "bun:test";
import type { MissionEvent, MissionState } from "../../shared/contract";
import { ESCAPE_NORM, perpendicular, scale, sphericalMove } from "./sphere-math";
import {
  buildAuthenticRelayTranscript,
  buildProtocolTimeline,
  deriveTelemetry,
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

    // Both recovery_requested and handoff_granted citing sharedRelayReqId are preserved
    expect(snapDuring.relayTranscript).toHaveLength(2);
    expect(
      snapDuring.protocolTimeline.filter(
        (t) => t.relayMessageId === sharedRelayReqId,
      ),
    ).toHaveLength(2);
  });
});
