import assert from "node:assert/strict";
import { test } from "node:test";

import { findClosestProxy } from "./matcher.js";
import type { ManagedOutbound } from "./types.js";

const node = (id: string, remarks: string, host: string, port = 443, protocol = "vless"): ManagedOutbound => ({
  id,
  protocol,
  remarks,
  settings: { vnext: [{ address: host, port }] },
  tag: "proxy",
});

test("same remarks on a new host is the same server", () => {
  const previous = node("a", "🇩🇪 Berlin 1", "old.example.com");
  const result = findClosestProxy(previous, [node("b", "🇩🇪 Berlin 2", "x.example.com"), node("c", "🇩🇪 Berlin 1", "new.example.com")]);
  assert.equal(result?.best.id, "c");
  assert.equal(result?.isStructureUpdate, true);
});

test("same host with a rotated port is the same server", () => {
  const previous = node("a", "Berlin", "de.example.com", 443);
  const result = findClosestProxy(previous, [node("b", "Paris", "fr.example.com"), node("c", "Frankfurt", "de.example.com", 8443)]);
  assert.equal(result?.best.id, "c");
  assert.equal(result?.isStructureUpdate, true);
});

test("us 1 does not match us 12", () => {
  const previous = node("a", "US 1", "a.example.com");
  const result = findClosestProxy(previous, [node("b", "US 12", "b.example.com")]);
  assert.equal(result?.isStructureUpdate, false);
});

test("whole-word containment still matches", () => {
  const previous = node("a", "Berlin 1", "a.example.com");
  const result = findClosestProxy(previous, [node("b", "Fast Berlin 1 Premium", "b.example.com")]);
  assert.equal(result?.isStructureUpdate, true);
});

test("same country alone is not a confident match", () => {
  const previous = node("a", "🇩🇪 Berlin", "a.example.com");
  const result = findClosestProxy(previous, [node("b", "🇩🇪 Munich", "b.example.com")]);
  assert.equal(result?.isStructureUpdate, false);
});

test("no candidates gives no match", () => {
  assert.equal(findClosestProxy(node("a", "x", "h"), []), undefined);
});
