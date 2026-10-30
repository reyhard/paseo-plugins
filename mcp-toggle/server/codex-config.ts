import { execCommand, spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import { randomBytes } from "node:crypto";
import { access, appendFile, mkdir, readFile, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Mcp } from "../shared/rpc";
import { locateCli } from "./cli";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface LayerName {
  type: string;
  dotCodexFolder?: string;
}

interface Layer {
  name: LayerName;
  config: unknown;
  disabledReason?: string | null;
}

/** The parts of Codex app-server's `config/read` reply this plugin uses. Layers come highest precedence first. */
export interface CodexConfig {
  config: {
    mcp_servers?: Record<string, { enabled?: boolean }> | null;
    projects?: Record<string, { trust_level?: string }> | null;
  };
  origins: Record<string, { name: LayerName } | undefined>;
  layers: Layer[] | null;
}

/** The layers a project's .codex/config.toml overrides; managed ones (MDM, enterprise) sit above it. */
const BELOW_PROJECT = new Set(["user", "system", "packagedDefaults"]);
const UNTRUSTED = "Codex does not trust this project";

export function codexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? resolve(configured) : join(homedir(), ".codex");
}

const serversIn = (layer: Layer): Json => (isObject(layer.config) && isObject(layer.config.mcp_servers) ? layer.config.mcp_servers : {});

/**
 * Each server starts with the state ~/.codex/config.toml gives it; a switch writes `enabled` into
 * the checkout's own .codex/config.toml, the `folder` given here. `lock` locks every server.
 */
export function codexMcpsFrom({ config, origins, layers }: CodexConfig, folder: string, lock?: string): Mcp[] {
  const servers = config.mcp_servers ?? {};
  // Project layers from subfolders, which this plugin does not edit.
  const deeper = (name: LayerName) => name.type === "project" && name.dotCodexFolder !== folder;
  const where = (name: LayerName) => join(relative(dirname(folder), name.dotCodexFolder ?? ""), "config.toml");
  const lockOf = (definedIn: LayerName[], switchedIn: LayerName | undefined) => {
    if (definedIn.length > 0 && definedIn.every(deeper)) return `Added in ${where(definedIn[0]!)}`;
    if (switchedIn && deeper(switchedIn)) return `Switched in ${where(switchedIn)}`;
    if (switchedIn && switchedIn.type !== "project" && !BELOW_PROJECT.has(switchedIn.type)) {
      return `Switched in Codex's ${switchedIn.type} config`;
    }
    return undefined;
  };
  return Object.keys(servers)
    .sort()
    .map((name) => {
      const definedIn = (layers ?? []).filter((layer) => name in serversIn(layer)).map((layer) => layer.name);
      const scope = definedIn.length > 0 && definedIn.every((layer) => layer.type === "project") ? "project" : "user";
      const locked = lock ?? lockOf(definedIn, origins[`mcp_servers.${name}.enabled`]?.name);
      const mcp: Mcp = { name, enabled: servers[name]?.enabled !== false, scope };
      return locked ? { ...mcp, locked } : mcp;
    });
}

/** The server's state without project files: what ~/.codex/config.toml says, else Codex's default of on. */
function defaultEnabled({ layers }: CodexConfig, name: string): boolean {
  for (const layer of layers ?? []) {
    const enabled = layer.name.type === "project" ? undefined : (serversIn(layer)[name] as { enabled?: unknown } | undefined)?.enabled;
    if (typeof enabled === "boolean") return enabled;
  }
  return true;
}

// shortcut: line-based TOML for the `[mcp_servers.<name>]` + `enabled = …` form this plugin writes. Codex's
// own editor only writes ~/.codex/config.toml, so every edit here is read back through Codex and undone if it disagrees.
const TABLE = /^\s*\[\s*mcp_servers\s*\.\s*(?:"([\w-]+)"|'([\w-]+)'|([\w-]+))\s*\]\s*(?:#.*)?$/;
const ANY_TABLE = /^\s*\[/;
const ENABLED = /^(\s*)enabled\s*=\s*(true|false)?.*$/;

function tableName(line: string): string | undefined {
  const match = TABLE.exec(line);
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

/** The `enabled` values the file sets in `[mcp_servers.<name>]` tables. */
export function overridesIn(text: string): Map<string, boolean> {
  const result = new Map<string, boolean>();
  let table: string | undefined;
  for (const line of text.split("\n")) {
    if (ANY_TABLE.test(line)) table = tableName(line);
    else if (table) {
      const value = ENABLED.exec(line)?.[2];
      if (value) result.set(table, value === "true");
    }
  }
  return result;
}

/** Sets `enabled` in the file's `[mcp_servers.<name>]` table, adding the table if needed. `undefined` removes it, and the table once empty. */
export function withEnabled(text: string, name: string, enabled: boolean | undefined): string {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const start = lines.findIndex((line) => tableName(line) === name);
  if (start < 0) {
    if (enabled === undefined) return text;
    while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
    if (lines.length > 0) lines.push("");
    lines.push(`[mcp_servers.${name}]`, `enabled = ${enabled}`);
    return `${lines.join("\n")}\n`;
  }
  let end = lines.findIndex((line, index) => index > start && ANY_TABLE.test(line));
  if (end < 0) end = lines.length;
  const at = lines.findIndex((line, index) => index > start && index < end && ENABLED.test(line));
  if (enabled !== undefined) {
    if (at >= 0) lines[at] = lines[at]!.replace(ENABLED, `$1enabled = ${enabled}`);
    else lines.splice(start + 1, 0, `enabled = ${enabled}`);
  } else {
    if (at < 0) return text;
    lines.splice(at, 1);
    end -= 1;
    if (lines.slice(start + 1, end).every((line) => line.trim() === "")) {
      // The table held only the switch, as when the plugin added it: drop it and the blank line before it.
      lines.splice(start, end - start);
      if (start > 0 && lines[start - 1]!.trim() === "" && (start === lines.length || lines[start]!.trim() === "")) {
        lines.splice(start - 1, 1);
      }
    }
  }
  while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

const checkouts = new Map<string, Promise<string>>();

/** The folder whose .codex/config.toml Codex reads for `cwd`: its git checkout (a worktree is its own), else the folder itself. */
function checkoutRoot(cwd: string): Promise<string> {
  let root = checkouts.get(cwd);
  if (!root) {
    root = execCommand("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 5_000 }).then(
      ({ stdout }) => stdout.trim() || cwd,
      () => cwd,
    );
    checkouts.set(cwd, root);
  }
  return root;
}

/** Every checkout of `cwd`'s project, the main one first. A folder outside git is its own project. */
async function checkoutsOf(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execCommand("git", ["-C", cwd, "worktree", "list", "--porcelain"], { timeout: 5_000 });
    const paths = stdout.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length));
    const present = await Promise.all(paths.map(async (path) => ((await access(path).then(() => true, () => false)) ? path : null)));
    const checkouts = present.filter((path): path is string => path !== null);
    if (checkouts.length > 0) return checkouts;
  } catch {
    // Not in git.
  }
  return [await checkoutRoot(cwd)];
}

type Request = (method: string, params: unknown) => Promise<unknown>;

const readAt = async (request: Request, cwd: string | null) => (await request("config/read", { includeLayers: true, cwd })) as CodexConfig;

/** Why no server can be switched for this checkout, if so. */
async function projectLock(read: CodexConfig, cwd: string, checkout: string): Promise<string | undefined> {
  const folder = join(checkout, ".codex");
  const canonical = (path: string) => realpath(path).catch(() => path);
  if ((await canonical(folder)) === (await canonical(codexHome()))) return "Codex keeps no project settings in your home folder";
  const layer = read.layers?.find((entry) => entry.name.type === "project" && entry.name.dotCodexFolder === folder);
  if (layer) return layer.disabledReason ? UNTRUSTED : undefined;
  // No .codex folder yet, so Codex has not said; look the project up as Codex does, the folder before its repository.
  const projects = read.config.projects ?? {};
  const [main] = await checkoutsOf(cwd);
  const entry = [cwd, checkout, main].map((path) => (path ? projects[path] : undefined)).find(Boolean);
  return entry?.trust_level === "trusted" ? undefined : UNTRUSTED;
}

async function listAt(request: Request, cwd: string): Promise<Mcp[]> {
  const checkout = await checkoutRoot(cwd);
  const folder = join(checkout, ".codex");
  let read: CodexConfig;
  try {
    read = await readAt(request, cwd);
  } catch (error) {
    // A broken project file fails the whole read; show ~/.codex/config.toml's servers, locked.
    const reason = `Codex cannot read this project's config: ${describe(error).split("\n")[0]}`;
    return codexMcpsFrom(await readAt(request, null), folder, reason);
  }
  return codexMcpsFrom(read, folder, await projectLock(read, cwd, checkout));
}

export async function listCodexMcpsFor(cwds: readonly string[]): Promise<Record<string, Mcp[]>> {
  return withAppServer(async (request) => {
    const result: Record<string, Mcp[]> = {};
    for (const cwd of cwds) result[cwd] = await listAt(request, cwd);
    return result;
  });
}

/** Switches the server for `cwd`'s project: its main checkout and every worktree. */
export function setCodexMcpEnabled(cwd: string, name: string, enabled: boolean): Promise<void> {
  // Codex's own `codex mcp add` allows only these characters, which keeps the TOML key bare.
  if (!/^[\w-]+$/.test(name)) return Promise.reject(new Error(`Codex's "${name}" has a name this plugin cannot edit`));
  return serialized(() =>
    withAppServer(async (request) => {
      const server = (await listAt(request, cwd)).find((entry) => entry.name === name);
      if (!server) throw new Error(`Codex has no MCP server named "${name}" for ${cwd}`);
      if (server.locked) throw new Error(`Codex's "${name}" cannot be switched here: ${server.locked}`);
      const clicked = await checkoutRoot(cwd);
      await applyAt(request, clicked, name, enabled);
      for (const checkout of await checkoutsOf(cwd)) {
        if (checkout === clicked) continue;
        await applyAt(request, checkout, name, enabled).catch((error: unknown) =>
          console.warn(`[mcp-toggle] could not switch Codex's "${name}" in ${checkout}:`, describe(error)),
        );
      }
    }),
  );
}

/**
 * Before Codex opens in a worktree, copies the main checkout's switches into it, for worktrees made
 * after a switch. Only spawns Codex when the worktree's file differs.
 */
export async function syncCheckout(cwd: string): Promise<void> {
  const [checkout, [main]] = await Promise.all([checkoutRoot(cwd), checkoutsOf(cwd)]);
  if (!main || checkout === main) return;
  const wanted = overridesIn((await readText(join(main, ".codex", "config.toml"))) ?? "");
  const current = overridesIn((await readText(join(checkout, ".codex", "config.toml"))) ?? "");
  const missing = [...wanted].filter(([name, enabled]) => current.get(name) !== enabled);
  if (missing.length === 0) return;
  await serialized(() =>
    withAppServer(async (request) => {
      for (const [name, enabled] of missing) {
        await applyAt(request, checkout, name, enabled).catch((error: unknown) =>
          console.warn(`[mcp-toggle] could not copy Codex's "${name}" into ${checkout}:`, describe(error)),
        );
      }
    }),
  );
}

/** Writes the switch into the checkout's .codex/config.toml, or removes it when it matches the default, then has Codex read it back. */
async function applyAt(request: Request, checkout: string, name: string, enabled: boolean): Promise<void> {
  const file = join(checkout, ".codex", "config.toml");
  const before = await readText(file);
  const after = withEnabled(before ?? "", name, enabled === defaultEnabled(await readAt(request, checkout), name) ? undefined : enabled);
  if (after !== (before ?? "")) await writeText(file, after);
  try {
    const read = await readAt(request, checkout);
    if ((read.config.mcp_servers?.[name]?.enabled !== false) !== enabled) {
      throw new Error(`Codex still reads "${name}" as ${enabled ? "off" : "on"} in ${checkout}`);
    }
  } catch (error) {
    if (after !== (before ?? "")) await writeText(file, before);
    throw error;
  }
  if (before === null && after !== "") await excludeFromGit(checkout);
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Replaces the file atomically; empty text removes it, and its .codex folder once empty. */
async function writeText(file: string, text: string | null): Promise<void> {
  if (!text?.trim()) {
    await rm(file, { force: true });
    await rmdir(dirname(file)).catch(() => undefined);
    return;
  }
  await mkdir(dirname(file), { recursive: true });
  // Write through a symlink instead of replacing it with a plain file.
  const target = await realpath(file).catch(() => file);
  const temporary = `${target}.mcp-toggle.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, target);
}

/** Keeps a .codex/config.toml the plugin created out of `git status`, so agents do not commit it. Covers every worktree. */
async function excludeFromGit(checkout: string): Promise<void> {
  const git = (...args: string[]) => execCommand("git", ["-C", checkout, ...args], { timeout: 5_000 });
  // 0: already ignored; 1: not ignored; anything else: not a git checkout.
  const status = await git("check-ignore", "-q", ".codex/config.toml").then(
    () => 0,
    (error: { code?: unknown }) => error.code,
  );
  if (status !== 1) return;
  const common = (await git("rev-parse", "--path-format=absolute", "--git-common-dir")).stdout.trim();
  await mkdir(join(common, "info"), { recursive: true });
  await appendFile(join(common, "info", "exclude"), "\n# mcp-toggle: per-project Codex MCP switches\n/.codex/config.toml\n");
}

let queue: Promise<unknown> = Promise.resolve();

/** Runs Codex config edits one at a time, so two switches do not overwrite each other's file. */
function serialized<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

/** Runs `use` against a short-lived `codex app-server`, whose config API reads every Codex config layer. */
async function withAppServer<T>(use: (request: Request) => Promise<T>): Promise<T> {
  const child = spawnProcess(await findCodex(), ["app-server"], { stdio: "pipe", env: process.env });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let failure: Error | null = null;
  let stderr = "";
  const fail = (error: Error) => {
    failure ??= error;
    for (const waiter of pending.values()) waiter.reject(failure);
    pending.clear();
  };
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-1_000)));
  child.on("exit", (code) => fail(new Error(`codex app-server exited with ${code}: ${stderr.trim().split("\n").at(-1) ?? ""}`)));
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message: Json;
    try {
      message = JSON.parse(line) as Json;
    } catch {
      return;
    }
    // Notifications and Codex's own requests to the client carry a method; replies do not.
    const waiter = typeof message.id === "number" && !("method" in message) ? pending.get(message.id) : undefined;
    if (!waiter) return;
    pending.delete(message.id as number);
    if (isObject(message.error)) waiter.reject(new Error(String(message.error.message ?? "Codex config request failed")));
    else waiter.resolve(message.result);
  });
  let lastId = 0;
  const send = (message: Json) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request: Request = (method, params) =>
    new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      pending.set(++lastId, { resolve, reject });
      send({ id: lastId, method, params });
    });
  // Paseo fails a plugin request after 30s, and a toggle still has to reload the agent after this.
  const timer = setTimeout(() => fail(new Error("codex app-server did not answer within 10s")), 10_000);
  try {
    await request("initialize", { clientInfo: { name: "mcp-toggle", title: "MCP toggle", version: "0.0.0" }, capabilities: null });
    send({ method: "initialized" });
    return await use(request);
  } finally {
    clearTimeout(timer);
    await terminateProcess(child).catch(() => undefined);
  }
}

/** Locate a native Windows binary or npm .cmd shim, never a POSIX npm shim. */
async function findCodex(): Promise<string> {
  return locateCli("codex", [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]);
}
