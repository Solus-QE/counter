import { describe, expect, test } from "bun:test";
import type { CommandMeta, MissionState, Vec3 } from "../shared/contract";
import {
  arrived,
  dot,
  escaped,
  field,
  norm,
  perpendicular,
  scale,
  sphericalMove,
  stalled,
  steering,
  unit,
} from "./geometry";
import {
  challenge,
  grant,
  move,
  request,
  returnToNavigator,
  start,
} from "./mission";

const g: Vec3 = [0, 0, 1];
let serial = 0;
export const meta = (s: MissionState): CommandMeta => ({
  runId: s.runId,
  commandId: `command-${++serial}`,
  expectedRevision: s.revision,
  controlEpoch: s.controlEpoch,
});
const initial = (position: Vec3 = [1, 0, 0], goal: Vec3 = g) =>
  start("coordinator", {
    runId: "test",
    commandId: `start-${++serial}`,
    position,
    goal,
  });
function recover(s: MissionState): MissionState {
  s = request(s, "navigator", {
    ...meta(s),
    requestId: "rescue",
    reason: "navigator_stalled",
  });
  s = grant(s, "coordinator", {
    ...meta(s),
    requestId: "rescue",
    proposalId: "proposal",
    ...steering(s.position, s.rescueAxis)!,
  });
  for (let i = 0; !escaped(s.position, s.goal) && i < 10; i++)
    s = move(s, "rescuer", {
      ...meta(s),
      pilot: "rescuer",
      ...steering(s.position, s.rescueAxis)!,
    });
  expect(escaped(s.position, s.goal)).toBe(true);
  return returnToNavigator(s, "rescuer", meta(s));
}
describe("spherical steering", () => {
  test("Navigator stalls exactly at antipode; arrival is not a stall", () => {
    expect(norm(field(scale(g, -1), g))).toBe(0);
    expect(stalled(scale(g, -1), g)).toBe(true);
    expect(steering(scale(g, -1), g)).toBeNull();
    expect(stalled(g, g)).toBe(false);
    expect(initial(g).phase).toBe("completed");
  });
  test("Rescuer escapes and Navigator completes", () => {
    let s = recover(initial(scale(g, -1)));
    for (let i = 0; s.phase !== "completed" && i < 40; i++)
      s = move(s, "navigator", {
        ...meta(s),
        pilot: "navigator",
        ...steering(s.position, s.goal)!,
      });
    expect(s.phase).toBe("completed");
    expect(s.controlEpoch).toBe(2);
    expect(
      s.trajectory.every((p) => Math.abs(norm(p.position) - 1) < 1e-12),
    ).toBe(true);
  });
  test("numerical tolerances distinguish near-target arrival from an antipodal stall", () => {
    const nearGoal = unit([1e-6, 0, 1]);
    expect(arrived(nearGoal, g)).toBe(true);
    expect(stalled(nearGoal, g)).toBe(false);
    expect(steering(nearGoal, g)).toBeNull();
    const nearAntipode = unit([1e-9, 0, -1]);
    expect(stalled(nearAntipode, g)).toBe(true);
    expect(steering(nearAntipode, g)).toBeNull();
    const steerable = unit([1e-5, 0, -1]);
    expect(stalled(steerable, g)).toBe(false);
    const step = steering(steerable, g)!;
    expect(step).not.toBeNull();
    expect(Math.abs(norm(step.tangent) - 1)).toBeLessThan(1e-12);
    expect(Math.abs(dot(steerable, step.tangent))).toBeLessThan(1e-8);
  });
  test("500 seeded random missions converge and preserve the sphere", () => {
    let seed = 9017;
    const random = () => {
      seed = (1664525 * seed + 1013904223) >>> 0;
      return (seed / 2 ** 32) * 2 - 1;
    };
    for (let j = 0; j < 500; j++) {
      const goal = unit([random(), random(), random()]);
      let s = initial(
        j % 10 === 0 ? scale(goal, -1) : unit([random(), random(), random()]),
        goal,
      );
      if (stalled(s.position, s.goal)) s = recover(s);
      for (let i = 0; s.phase !== "completed" && i < 50; i++) {
        s = move(s, "navigator", {
          ...meta(s),
          pilot: "navigator",
          ...steering(s.position, s.goal)!,
        });
        expect(Math.abs(norm(s.position) - 1)).toBeLessThan(1e-12);
      }
      expect(arrived(s.position, goal)).toBe(true);
    }
  });
  test("one complementary field always has norm >= 1/sqrt(2)", () => {
    for (let i = 0; i < 1000; i++) {
      const goal = unit([
        Math.sin(i + 0.3),
        Math.cos(i * 0.7),
        Math.sin(i * 0.13),
      ]);
      const x = unit([
        Math.cos(i * 0.23),
        Math.sin(i + 0.7),
        Math.cos(i * 0.37),
      ]);
      expect(
        Math.max(norm(field(x, goal)), norm(field(x, perpendicular(goal)))),
      ).toBeGreaterThanOrEqual(Math.SQRT1_2 - 1e-12);
    }
  });
  test("10,000 exponential-map movements remain unit and tangent", () => {
    let x: Vec3 = [1, 0, 0];
    for (let i = 0; i < 10000; i++) {
      const u = perpendicular(x);
      expect(Math.abs(dot(x, u))).toBeLessThan(1e-12);
      x = sphericalMove(x, u, 0.35);
      expect(Math.abs(norm(x) - 1)).toBeLessThan(1e-12);
    }
  });
});
describe("mission policy", () => {
  test("rejects invalid vectors and nonperpendicular rescue axis", () => {
    expect(() => initial([0, 0, 0])).toThrow("INVALID_VECTOR");
    expect(() => initial([NaN, 0, 1])).toThrow("INVALID_VECTOR");
    expect(() =>
      start("coordinator", {
        runId: "a",
        commandId: "a",
        position: [1, 0, 0],
        goal: g,
        rescueAxis: g,
      }),
    ).toThrow("INVALID_VECTOR");
  });
  test("rejects invalid, stale, duplicate, unauthorized and wrong-field movement without changing state", () => {
    const s = initial();
    const before = JSON.stringify(s);
    const c = {
      ...meta(s),
      pilot: "navigator" as const,
      ...steering(s.position, s.goal)!,
    };
    expect(() => move(s, "rescuer", c)).toThrow("UNAUTHORIZED");
    expect(() => move(s, "navigator", { ...c, expectedRevision: 0 })).toThrow(
      "STALE_REVISION",
    );
    expect(() => move(s, "navigator", { ...c, controlEpoch: 99 })).toThrow(
      "STALE_EPOCH",
    );
    expect(() => move(s, "navigator", { ...c, alpha: 0.350001 })).toThrow(
      "INVALID_MOVEMENT",
    );
    expect(() => move(s, "navigator", { ...c, alpha: 0 })).toThrow(
      "INVALID_MOVEMENT",
    );
    expect(() => move(s, "navigator", { ...c, tangent: s.position })).toThrow(
      "INVALID_MOVEMENT",
    );
    expect(() =>
      move(s, "navigator", { ...c, tangent: scale(c.tangent, -1) }),
    ).toThrow("POLICY_VIOLATION");
    const next = move(s, "navigator", c);
    expect(() => move(next, "navigator", c)).toThrow("DUPLICATE_COMMAND");
    expect(JSON.stringify(s)).toBe(before);
  });
  test("challenge and handoff fence delayed commands; pending recovery freezes movement", () => {
    let s = initial();
    const delayed = {
      ...meta(s),
      pilot: "navigator" as const,
      ...steering(s.position, s.goal)!,
    };
    s = challenge(s, "coordinator", meta(s));
    expect(() =>
      move(s, "navigator", { ...delayed, expectedRevision: s.revision }),
    ).toThrow("STALE_EPOCH");
    s = request(s, "navigator", {
      ...meta(s),
      requestId: "r",
      reason: "navigator_stalled",
    });
    expect(() =>
      move(s, "navigator", {
        ...meta(s),
        pilot: "navigator",
        tangent: s.rescueAxis,
        alpha: 0.2,
      }),
    ).toThrow("INVALID_PHASE");
    expect(() =>
      grant(s, "rescuer", {
        ...meta(s),
        requestId: "r",
        proposalId: "p",
        tangent: s.rescueAxis,
        alpha: 0.2,
      }),
    ).toThrow("UNAUTHORIZED");
    s = grant(s, "coordinator", {
      ...meta(s),
      requestId: "r",
      proposalId: "p",
      tangent: s.rescueAxis,
      alpha: 0.2,
    });
    expect(() => returnToNavigator(s, "rescuer", meta(s))).toThrow(
      "POLICY_VIOLATION",
    );
    expect(() =>
      move(s, "navigator", {
        ...meta(s),
        pilot: "navigator",
        tangent: s.rescueAxis,
        alpha: 0.2,
      }),
    ).toThrow("UNAUTHORIZED");
  });
  test("target completion prevents challenges and movement", () => {
    const s = initial(g);
    expect(() => challenge(s, "coordinator", meta(s))).toThrow("COMPLETED");
    expect(() =>
      move(s, "navigator", {
        ...meta(s),
        pilot: "navigator",
        tangent: [1, 0, 0],
        alpha: 0.1,
      }),
    ).toThrow("COMPLETED");
  });
});
