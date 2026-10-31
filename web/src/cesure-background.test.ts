import { expect, test } from "bun:test";
import { makeNoise } from "./cesure-background";

test("noise matches samples captured from Cesure's original makeNoise", () => {
  const noise = makeNoise(20260703);
  const samples = [
    [[0, 0, 0], 0],
    [[0.1, 0.2, 0.3], 0.13755130880000002],
    [[12.34, 56.78, 0.9], 0.32941826531917795],
    [[-3.7, 2.1, -1.2], -0.14754879999999992],
    [[256.1, 0.2, 0.3], 0.137551308799989],
  ] as const;
  for (const [point, expected] of samples) {
    expect(noise(point[0], point[1], point[2])).toBeCloseTo(expected, 12);
  }
});

test("seeded flow is reproducible and continuous across lattice cells", () => {
  const first = makeNoise(20260703);
  const same = makeNoise(20260703);
  const other = makeNoise(17);
  for (let i = -10; i < 10; i++) {
    expect(first(i + 0.3, i * 0.17, 0.25)).toBe(same(i + 0.3, i * 0.17, 0.25));
    expect(
      Math.abs(first(i - 1e-7, 0.3, 0.2) - first(i + 1e-7, 0.3, 0.2)),
    ).toBeLessThan(1e-5);
  }
  expect(first(0.1, 0.2, 0.3)).not.toBe(other(0.1, 0.2, 0.3));
});
