import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cliNames, locateCli } from "./cli.ts";

test("Windows chooses cmd shim over POSIX npm shim", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-toggle-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "codex"), "#!/bin/sh\n");
  await writeFile(join(dir, "codex.cmd"), "@echo off\r\n");
  assert.deepEqual(cliNames("codex", "win32"), ["codex.exe", "codex.cmd", "codex.bat"]);
  assert.equal(await locateCli("codex", [dir], "win32", { PATH: "", APPDATA: dir }), join(dir, "codex.cmd"));
  await writeFile(join(dir, "codex.exe"), "binary");
  assert.equal(await locateCli("codex", [dir], "win32", { PATH: "", APPDATA: dir }), join(dir, "codex.exe"));
});
