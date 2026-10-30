import assert from "node:assert/strict";
import { test } from "node:test";
import { configuredServers, effectiveEnabled, applyOverrides, mergeContent } from "./opencode-config.ts";

test("V1 and V2 formats can both be read", () => {
  assert.equal(configuredServers({ mcp: { docs: { type: "local", command: ["a"], enabled: false } } }).mode, "v1");
  assert.equal(configuredServers({ mcp: { servers: { docs: { type: "local", command: ["a"], disabled: false } } } }).mode, "v2");
  assert.equal(effectiveEnabled("v1", { enabled: false }), false);
  assert.equal(effectiveEnabled("v2", { disabled: true }), false);
});
test("preserve complete server definitions and secrets only in ephemeral overlay", () => {
  const source = { mcp: { servers: { github: { type: "remote", url: "https://example.test/mcp", headers: { Authorization: "secret" } } } } };
  const result = applyOverrides(source, { github: false });
  assert.deepEqual(result, { mcp: { servers: { github: { ...source.mcp.servers.github, disabled: true } } } });
  assert.equal(source.mcp.servers.github.disabled, undefined);
  assert.deepEqual(mergeContent({ plugins: ["paseo"], mcp: { servers: { x: { type: "local" } } } }, result), { plugins: ["paseo"], mcp: { servers: { x: { type: "local" }, github: { ...source.mcp.servers.github, disabled: true } } } });
});
