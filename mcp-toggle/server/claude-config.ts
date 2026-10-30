import { execCommand } from "@getpaseo/plugin/server";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Mcp } from "../shared/rpc";
import { locateCli } from "./cli";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function paseoHome(): string {
  const configured = process.env.PASEO_HOME?.trim();
  return configured ? resolve(configured) : join(homedir(), ".paseo");
}

/** The `.claude.json` Claude reads when a session sets no `CLAUDE_CONFIG_DIR` of its own. */
export function mainConfigPath(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? join(resolve(configured), ".claude.json") : join(homedir(), ".claude.json");
}

/**
 * Every `.claude.json` a Paseo Claude session can read. ZeroSub gives each extra account its own copy
 * and does not sync `disabledMcpServers` into it, so a toggle has to land in each one.
 * shortcut: only knows ZeroSub's account homes; add other CLAUDE_CONFIG_DIR setups here if you use them.
 */
async function configPaths(): Promise<string[]> {
  const homes = join(paseoHome(), "zerosub", "homes");
  const names = await readdir(homes).catch(() => [] as string[]);
  const copies = names.filter((name) => name.startsWith("claude-")).map((name) => join(homes, name, ".claude.json"));
  const present = await Promise.all(copies.map(async (path) => ((await stat(path).catch(() => null)) ? path : null)));
  return [mainConfigPath(), ...present.filter((path): path is string => path !== null)];
}

const keys = new Map<string, Promise<string>>();

/** Claude files project settings under the git root, and a worktree under its main checkout. */
export function projectKey(cwd: string): Promise<string> {
  let key = keys.get(cwd);
  if (!key) {
    key = resolveProjectKey(cwd);
    keys.set(cwd, key);
  }
  return key;
}

async function resolveProjectKey(cwd: string): Promise<string> {
  const git = async (...args: string[]) => (await execCommand("git", ["-C", cwd, ...args], { timeout: 5_000 })).stdout.trim();
  try {
    const common = await git("rev-parse", "--path-format=absolute", "--git-common-dir");
    if (basename(common) === ".git") return dirname(common);
    return await git("rev-parse", "--show-toplevel");
  } catch {
    return cwd;
  }
}

async function readConfig(path: string): Promise<Json> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const value = JSON.parse(text) as unknown;
  if (!isObject(value)) throw new Error(`${path} is not a JSON object`);
  return value;
}

/** User-scope servers plus the project's own, each enabled unless the project lists it as disabled. */
export function mcpsFor(config: Json, key: string): Mcp[] {
  const project = isObject(config.projects) && isObject(config.projects[key]) ? config.projects[key] : {};
  const local = Object.keys(isObject(project.mcpServers) ? project.mcpServers : {});
  const names = new Set([...Object.keys(isObject(config.mcpServers) ? config.mcpServers : {}), ...local]);
  const disabled = Array.isArray(project.disabledMcpServers) ? project.disabledMcpServers : [];
  return [...names].sort().map((name) => ({
    name,
    enabled: !disabled.includes(name),
    scope: local.includes(name) ? ("project" as const) : ("user" as const),
  }));
}

export function applyToggle(config: Json, key: string, name: string, enabled: boolean): Json {
  const projects = isObject(config.projects) ? { ...config.projects } : {};
  const project = isObject(projects[key]) ? { ...projects[key] } : {};
  const disabled = (Array.isArray(project.disabledMcpServers) ? project.disabledMcpServers : []).filter((entry) => entry !== name);
  project.disabledMcpServers = enabled ? disabled : [...disabled, name];
  projects[key] = project;
  return { ...config, projects };
}

export async function listMcpsFor(cwds: readonly string[]): Promise<Record<string, Mcp[]>> {
  const config = await readConfig(mainConfigPath());
  const result: Record<string, Mcp[]> = {};
  for (const cwd of cwds) result[cwd] = mcpsFor(config, await projectKey(cwd));
  return result;
}

export async function setMcpEnabled(cwd: string, name: string, enabled: boolean): Promise<void> {
  const key = await projectKey(cwd);
  if (!mcpsFor(await readConfig(mainConfigPath()), key).some((server) => server.name === name)) {
    throw new Error(`Claude has no MCP server named "${name}" for ${key}`);
  }
  for (const path of await configPaths()) await updateConfig(path, (config) => applyToggle(config, key, name, enabled));
}

/** Takes the `<file>.lock` directory Claude Code takes for its own writes, then replaces the file atomically. */
async function updateConfig(path: string, change: (config: Json) => Json): Promise<void> {
  // Write through a dotfiles symlink instead of replacing it with a plain file.
  const file = await realpath(path).catch(() => path);
  const lock = `${file}.lock`;
  await acquireLock(lock);
  try {
    const next = change(await readConfig(file));
    const temporary = `${file}.mcp-toggle.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rmdir(lock).catch(() => undefined);
  }
}

async function acquireLock(lock: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await mkdir(lock);
      return;
    } catch {
      const held = await stat(lock).catch(() => null);
      // Claude refreshes a live lock; one untouched for 10s was left by a process that died mid-write.
      if (held && Date.now() - held.mtimeMs > 10_000) await rmdir(lock).catch(() => undefined);
      else await new Promise((done) => setTimeout(done, 100));
    }
  }
  throw new Error(`Claude's config is busy (${lock}). Try again.`);
}

/** The plugin SDK cannot reopen a session, so this runs `paseo agent reload` (close, then reopen with the current config). */
export async function reloadAgent(agentId: string): Promise<void> {
  // Paseo fails a plugin request after 30s, so give up before that.
  await execCommand(await findCli(), ["agent", "reload", agentId, "--json", "--home", paseoHome()], { timeout: 25_000 });
}

async function findCli(): Promise<string> {
  const bundle = process.execPath.match(/^(.*?\\.app\\/Contents)\\//)?.[1];
  return locateCli("paseo", [
    bundle ? join(bundle, "Resources", "bin") : "",
    "/Applications/Paseo.app/Contents/Resources/bin",
    join(homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...(process.platform === "win32" ? [
      join(dirname(process.execPath), "resources", "bin"),
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "Paseo", "resources", "bin") : "",
      process.env.ProgramFiles ? join(process.env.ProgramFiles, "Paseo", "resources", "bin") : "",
    ] : []),
  ]);
}
