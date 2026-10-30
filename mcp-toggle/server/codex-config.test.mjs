// Runs the real `codex app-server` against a throwaway CODEX_HOME and git repos; never touches ~/.codex.
// The app-server tests skip when codex is not installed.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "mcp-toggle-codex-")));
const home = join(root, "home");
process.env.CODEX_HOME = join(home, ".codex");
const { codexMcpsFrom, listCodexMcpsFor, overridesIn, setCodexMcpEnabled, syncCheckout, withEnabled } = await import("./codex-config.ts");
const noCodex = spawnSync("codex", ["--version"]).status !== 0 && "codex is not installed";

test("lists every server with its state and says which ones a switch here cannot change", () => {
  const folder = "/repo/.codex";
  const user = { type: "user", file: "/home/me/.codex/config.toml" };
  const own = { type: "project", dotCodexFolder: folder };
  const sub = { type: "project", dotCodexFolder: "/repo/sub/.codex" };
  const read = {
    config: { mcp_servers: { cua: { enabled: false }, docs: {}, local: {}, nested: {}, pinned: { enabled: false }, managed: { enabled: false } } },
    origins: {
      "mcp_servers.cua.enabled": { name: own },
      "mcp_servers.pinned.enabled": { name: sub },
      "mcp_servers.managed.enabled": { name: { type: "enterpriseManaged" } },
    },
    layers: [
      { name: sub, config: { mcp_servers: { nested: { command: "x" }, pinned: { enabled: false } } } },
      { name: own, config: { mcp_servers: { cua: { enabled: false }, local: { command: "x" } } } },
      { name: user, config: { mcp_servers: { cua: {}, docs: {}, pinned: {}, managed: {} } } },
    ],
  };
  assert.deepEqual(codexMcpsFrom(read, folder), [
    { name: "cua", enabled: false, scope: "user" },
    { name: "docs", enabled: true, scope: "user" },
    { name: "local", enabled: true, scope: "project" },
    { name: "managed", enabled: false, scope: "user", locked: "Switched in Codex's enterpriseManaged config" },
    { name: "nested", enabled: true, scope: "project", locked: "Added in sub/.codex/config.toml" },
    { name: "pinned", enabled: false, scope: "user", locked: "Switched in sub/.codex/config.toml" },
  ]);
  assert.deepEqual(
    codexMcpsFrom(read, folder, "Codex does not trust this project").map((server) => server.locked),
    Array(6).fill("Codex does not trust this project"),
  );
  assert.deepEqual(codexMcpsFrom({ config: { mcp_servers: null }, origins: {}, layers: null }, folder), []);
});

test("edits only the enabled line, and removing it leaves the file as it was", () => {
  assert.equal(withEnabled("", "cua", false), "[mcp_servers.cua]\nenabled = false\n");
  const file = '# project settings\nmodel = "gpt-5"\n\n[mcp_servers.local]\ncommand = "x" # keep\n\n[mcp_servers.local.env]\nA = "1"\n';
  const added = withEnabled(file, "cua", false);
  assert.equal(added, `${file}\n[mcp_servers.cua]\nenabled = false\n`);
  assert.equal(withEnabled(added, "cua", true), `${file}\n[mcp_servers.cua]\nenabled = true\n`);
  assert.equal(withEnabled(added, "cua", undefined), file);
  const local = withEnabled(file, "local", false);
  assert.equal(local, file.replace('[mcp_servers.local]\n', '[mcp_servers.local]\nenabled = false\n'));
  assert.equal(withEnabled(local, "local", undefined), file);
  assert.equal(withEnabled(withEnabled("", "cua", false), "cua", undefined), "");
  assert.equal(withEnabled(file, "cua", undefined), file, "nothing to remove");
  assert.deepEqual([...overridesIn(withEnabled(local, "cua", true))], [["local", false], ["cua", true]]);
  assert.deepEqual([...overridesIn("[mcp_servers.\"q\"]\nenabled = true # on\n[other]\nenabled = false\n")], [["q", true]]);
});

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });
const repo = join(root, "repo");
const tree = join(root, "tree");
const later = join(root, "later");
const strange = join(root, "strange");
const userConfig = join(home, ".codex", "config.toml");
const USER_CONFIG = `# keep this comment
[mcp_servers.cua]
command = "true"

[mcp_servers.docs]
command = "true"
enabled = false

[projects."${repo}"]
trust_level = "trusted"

[projects."${home}"]
trust_level = "trusted"
`;
const projectFile = (checkout) => join(checkout, ".codex", "config.toml");
const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);
const states = async (cwd) => Object.fromEntries((await listCodexMcpsFor([cwd]))[cwd].map((server) => [server.name, server.locked ?? server.enabled]));

if (!noCodex) {
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(userConfig, USER_CONFIG);
  git(root, "init", "-q", "repo");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  mkdirSync(join(repo, "sub"));
  git(repo, "worktree", "add", "-q", tree, "-b", "tree");
  mkdirSync(strange);
  git(strange, "init", "-q");
}

test("each project starts with ~/.codex/config.toml's state", { skip: noCodex }, async () => {
  assert.deepEqual(await states(repo), { cua: true, docs: false });
  assert.deepEqual(await states(join(repo, "sub")), { cua: true, docs: false });
  assert.deepEqual(await states(strange), { cua: "Codex does not trust this project", docs: "Codex does not trust this project" });
  assert.deepEqual(await states(home), {
    cua: "Codex keeps no project settings in your home folder",
    docs: "Codex keeps no project settings in your home folder",
  });
});

test("a switch writes the project's .codex/config.toml in every checkout and keeps it out of git", { skip: noCodex }, async () => {
  await setCodexMcpEnabled(repo, "cua", false);
  assert.equal(read(projectFile(repo)), "[mcp_servers.cua]\nenabled = false\n");
  assert.equal(read(projectFile(tree)), "[mcp_servers.cua]\nenabled = false\n");
  assert.equal(read(userConfig), USER_CONFIG, "~/.codex/config.toml untouched");
  assert.match(read(join(repo, ".git", "info", "exclude")), /^\/\.codex\/config\.toml$/m);
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.equal(git(tree, "status", "--porcelain"), "");
  assert.deepEqual(await states(join(repo, "sub")), { cua: false, docs: false });
  assert.deepEqual(await states(tree), { cua: false, docs: false });

  // From a worktree agent's pill, the switch still lands in the whole project.
  await setCodexMcpEnabled(tree, "docs", true);
  for (const checkout of [repo, tree]) {
    assert.equal(read(projectFile(checkout)), "[mcp_servers.cua]\nenabled = false\n\n[mcp_servers.docs]\nenabled = true\n");
  }
  assert.equal((read(join(repo, ".git", "info", "exclude")).match(/\.codex/g) ?? []).length, 1, "excluded once");
});

test("a worktree made after a switch gets the project's switches before Codex opens in it", { skip: noCodex }, async () => {
  git(repo, "worktree", "add", "-q", later, "-b", "later");
  assert.equal(read(projectFile(later)), null);
  await syncCheckout(join(later));
  assert.equal(read(projectFile(later)), read(projectFile(repo)));
  assert.deepEqual(await states(later), { cua: false, docs: true });
  await syncCheckout(repo);
  await syncCheckout(later);
});

test("switching back to the default removes the override, and the file once empty", { skip: noCodex }, async () => {
  await setCodexMcpEnabled(repo, "cua", true);
  assert.equal(read(projectFile(tree)), "[mcp_servers.docs]\nenabled = true\n");
  await setCodexMcpEnabled(later, "docs", false);
  for (const checkout of [repo, tree, later]) {
    assert.equal(existsSync(join(checkout, ".codex")), false, `${checkout}/.codex removed`);
  }
  assert.deepEqual(await states(repo), { cua: true, docs: false });
});

test("a server the project defines itself gets the switch in its own table", { skip: noCodex }, async () => {
  const own = '[mcp_servers.local]\ncommand = "true"\n';
  mkdirSync(join(repo, ".codex"));
  writeFileSync(projectFile(repo), own);
  assert.equal((await listCodexMcpsFor([repo]))[repo].find((server) => server.name === "local").scope, "project");
  await setCodexMcpEnabled(repo, "local", false);
  assert.equal(read(projectFile(repo)), '[mcp_servers.local]\nenabled = false\ncommand = "true"\n');
  await setCodexMcpEnabled(repo, "local", true);
  assert.equal(read(projectFile(repo)), own);
});

test("refuses unknown servers, untrusted projects and broken files without writing", { skip: noCodex }, async () => {
  await assert.rejects(setCodexMcpEnabled(repo, "nope", false), /no MCP server named "nope"/);
  await assert.rejects(setCodexMcpEnabled(strange, "cua", false), /cannot be switched here: Codex does not trust this project/);
  assert.equal(existsSync(join(strange, ".codex")), false);
  await assert.rejects(setCodexMcpEnabled(home, "cua", false), /no project settings in your home folder/);
  assert.equal(read(userConfig), USER_CONFIG);

  writeFileSync(projectFile(repo), "not toml [[[\n");
  assert.match((await listCodexMcpsFor([repo]))[repo][0].locked, /^Codex cannot read this project's config: .*TOML parse error/);
  await assert.rejects(setCodexMcpEnabled(repo, "cua", false), /cannot be switched here/);
  assert.equal(read(projectFile(repo)), "not toml [[[\n");
});
