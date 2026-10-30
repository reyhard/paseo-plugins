import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonc, readOpenCodeConfig } from "./opencode-files.ts";

test("JSONC parsing keeps URLs, removes comments and trailing commas", () => {
  const parsed = parseJsonc('{ // note\n "mcp": {"servers": {"x": {"url":"https://example.test/a,b",},},}, /* note */ }');
  assert.equal(parsed.mcp.servers.x.url, "https://example.test/a,b");
  assert.throws(() => parseJsonc("[]"), /must be an object/);
});
test("global and project MCP layers are merged, project winning", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opencode-mcp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const globalDir = join(root, "config");
  const project = join(root, "project");
  await mkdir(globalDir, { recursive: true });
  await mkdir(join(project, ".opencode"), { recursive: true });
  await writeFile(join(globalDir, "opencode.json"), '{"mcp":{"docs":{"type":"local","command":["global"]}}}');
  await writeFile(join(project, "opencode.jsonc"), '{"mcp":{"docs":{"type":"local","command":["project"]}}}');
  await writeFile(join(project, ".opencode", "opencode.json"), '{"mcp":{"servers":{"remote":{"type":"remote","url":"https://example.test"}}}}');
  const result = await readOpenCodeConfig(project, { OPENCODE_CONFIG_DIR: globalDir });
  assert.equal(result.mcp.docs.command[0], "project");
  assert.equal(result.mcp.servers.remote.type, "remote");
});
