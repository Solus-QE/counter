import { expect, test } from "bun:test";
import { RelayError } from "@agent-relay/sdk";
import { RelayRetryGate, relayRetryDelay } from "./relay-retry";

test("Relay Retry-After is a lower bound, including delays beyond a minute", () => {
  const error = new RelayError("backpressure", "busy", {statusCode:503,retryAfterMs:120000});
  expect(relayRetryDelay(error,0)).toBe(120000);
  const gate = new RelayRetryGate();
  gate.failed(error,1000);
  expect(gate.ready(120999)).toBe(false);
  expect(gate.ready(121000)).toBe(true);
});

test("repeated failures increase spacing; successful polling resets it", () => {
  const gate = new RelayRetryGate();
  const first=gate.failed(null,0);
  expect(first).toBeGreaterThanOrEqual(750);
  expect(gate.failed(null,0)).toBeGreaterThanOrEqual(1500);
  gate.succeeded();
  expect(gate.ready(0)).toBe(true);
  expect(gate.failed(null,0)).toBeLessThanOrEqual(1250);
  expect(relayRetryDelay({retryAfterMs:NaN},1000)).toBeLessThanOrEqual(75000);
});
