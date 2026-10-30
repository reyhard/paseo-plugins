import { execCommand } from "@getpaseo/plugin/server";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Mcp } from "../shared/rpc";
import { paseoHome, projectKey } from "./claude-config";
import { locateCli } from "./cli";

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

async function configFor(cwd: string): Promise<ObjectMap> {
  const cli = await locateCli("opencode");
  const { stdout } = await execCommand(cli, ["debug", "config"], {
    cwd, timeout: 12_000, maxBuffer: 5 * 1024 * 1024,
  });
  const parsed: unknown = JSON.parse(stdout);
  if (!isObject(parsed)) throw new Error("OpenCode debug config did not return a JSON object");
  return parsed;
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
