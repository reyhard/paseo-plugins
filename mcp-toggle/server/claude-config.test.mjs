// Runs against throwaway config files and git repos; never touches the real ~/.claude.json.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "mcp-toggle-")));
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
process.env.PASEO_HOME = join(root, "paseo");
const { applyToggle, listMcpsFor, mcpsFor, projectKey, setMcpEnabled } = await import("./claude-config.ts");

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
const read = (path) => JSON.parse(readFileSync(path, "utf8"));

const repo = join(root, "repo");
mkdirSync(join(repo, "sub"), { recursive: true });
git(root, "init", "-q", "repo");
git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
git(repo, "worktree", "add", "-q", join(root, "wt"), "-b", "wt");
const plain = join(root, "plain");
mkdirSync(plain);

const main = join(root, "claude", ".claude.json");
const account = join(root, "paseo", "zerosub", "homes", "claude-abc", ".claude.json");
mkdirSync(join(root, "claude"));
mkdirSync(join(root, "paseo", "zerosub", "homes", "claude-abc"), { recursive: true });
writeFileSync(
  main,
  JSON.stringify({
    oauthAccount: { id: "keep-me" },
    mcpServers: { cua: {}, browseros: {} },
    projects: { [repo]: { allowedTools: ["Bash"], mcpServers: { local: {} }, disabledMcpServers: ["browseros"] } },
  }),
);
writeFileSync(account, JSON.stringify({ oauthAccount: { id: "other" }, mcpServers: { cua: {}, browseros: {} } }));

test("lists user and project servers with their state", () => {
  const config = read(main);
  assert.deepEqual(mcpsFor(config, repo), [
    { name: "browseros", enabled: false, scope: "user" },
    { name: "cua", enabled: true, scope: "user" },
    { name: "local", enabled: true, scope: "project" },
  ]);
  assert.deepEqual(mcpsFor(config, plain), [
    { name: "browseros", enabled: true, scope: "user" },
    { name: "cua", enabled: true, scope: "user" },
  ]);
});

test("toggling adds or removes one name and keeps everything else", () => {
  const config = read(main);
  const off = applyToggle(config, repo, "cua", false);
  assert.deepEqual(off.projects[repo].disabledMcpServers, ["browseros", "cua"]);
  assert.deepEqual(off.projects[repo].allowedTools, ["Bash"]);
  assert.deepEqual(applyToggle(off, repo, "cua", false).projects[repo].disabledMcpServers, ["browseros", "cua"]);
  assert.deepEqual(applyToggle(off, repo, "browseros", true).projects[repo].disabledMcpServers, ["cua"]);
  assert.deepEqual(applyToggle({}, plain, "cua", false), { projects: { [plain]: { disabledMcpServers: ["cua"] } } });
  assert.equal(config.projects[repo].disabledMcpServers.length, 1, "input is not mutated");
});

test("a subfolder and a worktree use the main repository's entry", async () => {
  assert.equal(await projectKey(repo), repo);
  assert.equal(await projectKey(join(repo, "sub")), repo);
  assert.equal(await projectKey(join(root, "wt")), repo);
  assert.equal(await projectKey(plain), plain);
});

test("a toggle lands in the main config and each ZeroSub account copy", async () => {
  await setMcpEnabled(join(root, "wt"), "cua", false);
  assert.deepEqual(read(main).projects[repo].disabledMcpServers, ["browseros", "cua"]);
  assert.deepEqual(read(main).oauthAccount, { id: "keep-me" });
  assert.deepEqual(read(account).projects[repo].disabledMcpServers, ["cua"]);
  assert.deepEqual(read(account).oauthAccount, { id: "other" });
  assert.equal(statSync(main).mode & 0o777, 0o600);
  assert.equal(existsSync(`${main}.lock`), false, "lock released");
  assert.deepEqual((await listMcpsFor([join(repo, "sub")]))[join(repo, "sub")].find((s) => s.name === "cua"), {
    name: "cua",
    enabled: false,
    scope: "user",
  });

  await setMcpEnabled(repo, "cua", true);
  assert.deepEqual(read(main).projects[repo].disabledMcpServers, ["browseros"]);
  assert.deepEqual(read(account).projects[repo].disabledMcpServers, []);
});

test("an unknown server name is refused without writing", async () => {
  const before = readFileSync(main, "utf8");
  await assert.rejects(setMcpEnabled(repo, "nope", false), /no MCP server named "nope"/);
  assert.equal(readFileSync(main, "utf8"), before);
});

test("waits for a live Claude lock and takes over a stale one", async () => {
  mkdirSync(`${main}.lock`);
  setTimeout(() => rmdirSync(`${main}.lock`), 300);
  const started = Date.now();
  await setMcpEnabled(repo, "local", false);
  assert.ok(Date.now() - started >= 250, "waited for the lock");
  assert.deepEqual(read(main).projects[repo].disabledMcpServers, ["browseros", "local"]);

  mkdirSync(`${main}.lock`);
  const old = new Date(Date.now() - 60_000);
  execFileSync("touch", ["-t", old.toISOString().replace(/[-T:]/g, "").slice(0, 12), `${main}.lock`]);
  await setMcpEnabled(repo, "local", true);
  assert.deepEqual(read(main).projects[repo].disabledMcpServers, ["browseros"]);
});

test("a corrupt config is reported, not overwritten", async () => {
  const before = readFileSync(main, "utf8");
  writeFileSync(main, "{ not json");
  await assert.rejects(setMcpEnabled(repo, "cua", false), SyntaxError);
  assert.equal(readFileSync(main, "utf8"), "{ not json");
  writeFileSync(main, before);
});
