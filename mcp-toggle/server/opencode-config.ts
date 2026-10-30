import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Mcp } from "../shared/rpc";
import { paseoHome, projectKey } from "./claude-config";

type ObjectMap = Record<string, unknown>;
type ServerMap = Record<string, ObjectMap>;
const isObject = (v: unknown): v is ObjectMap => !!v && typeof v === "object" && !Array.isArray(v);
const entries = (v: unknown): ServerMap =>
  isObject(v) ? Object.fromEntries(Object.entries(v).filter(([, value]) => isObject(value))) as ServerMap : {};

export function configuredServers(config: ObjectMap): { mode: "v1" | "v2"; servers: ServerMap } {
  const mcp = isObject(config.mcp) ? config.mcp : {};
  // OpenCode V2 uses mcp.servers; OpenCode V1 stores servers directly in mcp.
  if (isObject(mcp.servers)) return { mode: "v2", servers: entries(mcp.servers) };
  return { mode: "v1", servers: entries(mcp) };
}

export function effectiveEnabled(mode: "v1" | "v2", server: ObjectMap): boolean {
  return mode === "v2" ? server.disabled !== true : server.enabled !== false;
}

/** Override in launch environment only; never copy credentials to project files. */
export function applyOverrides(config: ObjectMap, overrides: Record<string, boolean>): ObjectMap {
  const { mode, servers } = configuredServers(config);
  const selected: ServerMap = {};
  for (const [name, enabled] of Object.entries(overrides)) {
    const server = servers[name];
    if (!server) continue;
    selected[name] = mode === "v2" ? { ...server, disabled: !enabled } : { ...server, enabled };
  }
  if (!Object.keys(selected).length) return {};
  return mode === "v2" ? { mcp: { servers: selected } } : { mcp: selected };
}

export function mergeContent(original: ObjectMap, overlay: ObjectMap): ObjectMap {
  const before = isObject(original.mcp) ? original.mcp : {};
  const extra = isObject(overlay.mcp) ? overlay.mcp : {};
  if (isObject(extra.servers)) {
    const prior = isObject(before.servers) ? before.servers : {};
    return { ...original, mcp: { ...before, ...extra, servers: { ...prior, ...extra.servers } } };
  }
  return { ...original, mcp: { ...before, ...extra } };
}

/** Read OpenCode configuration files instead of the redacted debug CLI output. */
export async function configFor(cwd: string): Promise<ObjectMap> {
  const home = homedir();
  const globalDir = process.env.OPENCODE_CONFIG_DIR ||
    join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
  const folders: string[] = [];
  let folder = resolve(cwd);
  while (true) {
    folders.unshift(folder);
    const parent = dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  const locations = [globalDir, ...folders, ...folders.map((p) => join(p, ".opencode"))];
  const result: ObjectMap = {};
  let found = 0;
  for (const location of locations) {
    for (const filename of ["opencode.json", "opencode.jsonc"]) {
      const file = join(location, filename);
      let raw: string;
      try { raw = await readFile(file, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      let parsed: unknown;
      try { parsed = JSON.parse(removeJsonc(raw)); }
      catch (error) { throw new Error(`Invalid OpenCode config ${file}: ${String(error)}`); }
      if (!isObject(parsed)) throw new Error(`OpenCode config is not an object: ${file}`);
      found++;
      const mcp = isObject(parsed.mcp) ? parsed.mcp : {};
      const old = isObject(result.mcp) ? result.mcp : {};
      const oldServers = isObject(old.servers) ? old.servers : {};
      const servers = isObject(mcp.servers) ? mcp.servers : {};
      Object.assign(result, parsed, { mcp: { ...old, ...mcp, servers: { ...oldServers, ...servers } } });
    }
  }
  if (!found) return {};
  return result;
}

/** Drop JSONC comments/trailing commas without damaging quoted URLs. */
export function removeJsonc(source: string): string {
  let text = "";
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!, n = source[i + 1];
    if (quoted) {
      text += c;
      if (escaped) escaped = false;
      else if (c === "\\\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true; text += c;
    } else if (c === "/" && n === "/") {
      while (i < source.length && source[i] !== "\\n") i++;
      text += "\\n";
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\\n") text += "\\n";
        i++;
      }
      i++;
    } else text += c;
  }
  return text.replace(/,\\s*([}\\]])/g, "$1");
}

function statePath(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return join(paseoHome(), "mcp-toggle", "opencode", `${hash}.json`);
}

async function readSwitches(cwd: string): Promise<Record<string, boolean>> {
  const file = statePath(await projectKey(cwd));
  let content: string;
  try { content = await readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const value: unknown = JSON.parse(content);
  return isObject(value) ? Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "boolean")) as Record<string, boolean> : {};
}
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(action: () => Promise<T>): Promise<T> {
  const next = queue.then(action, action);
  queue = next.catch(() => undefined);
  return next;
}

export async function listOpenCodeMcpsFor(cwds: readonly string[]): Promise<Record<string, Mcp[]>> {
  const result: Record<string, Mcp[]> = {};
  for (const cwd of cwds) {
    const [{ mode, servers }, overrides] = await Promise.all([configFor(cwd).then(configuredServers), readSwitches(cwd)]);
    result[cwd] = Object.entries(servers).sort(([a], [b]) => a.localeCompare(b)).map(([name, config]) => ({
      name,
      enabled: overrides[name] ?? effectiveEnabled(mode, config),
      // Effective config does not reliably retain file-origin metadata. Prefer non-misleading user scope.
      scope: "user" as const,
    }));
  }
  return result;
}

export function setOpenCodeMcpEnabled(cwd: string, name: string, enabled: boolean): Promise<void> {
  return serialized(async () => {
    const config = await configFor(cwd);
    const { mode, servers } = configuredServers(config);
    if (!Object.hasOwn(servers, name)) throw new Error(`OpenCode has no MCP server "${name}" for ${cwd}`);
    const key = await projectKey(cwd);
    const file = statePath(key);
    const overrides = await readSwitches(cwd);
    if (effectiveEnabled(mode, servers[name]!) === enabled) delete overrides[name];
    else overrides[name] = enabled;
    await mkdir(join(paseoHome(), "mcp-toggle", "opencode"), { recursive: true });
    const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temp, JSON.stringify(overrides, null, 2) + "\n", { mode: 0o600 });
    await rename(temp, file);
  });
}

/** Called on every OpenCode session opening, including reload and resume. */
export async function openCodeLaunchEnv(cwd: string, env: Record<string, string>): Promise<Record<string, string> | null> {
  const overrides = await readSwitches(cwd);
  if (!Object.keys(overrides).length) return null;
  const base = await configFor(cwd);
  const patched = applyOverrides(base, overrides);
  if (!Object.keys(patched).length) return null;
  const original = env.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT;
  const existing: unknown = original ? JSON.parse(original) : {};
  if (!isObject(existing)) throw new Error("Existing OPENCODE_CONFIG_CONTENT is not an object");
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify(mergeContent(existing, patched)) };
}
