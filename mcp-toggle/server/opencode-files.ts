import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type JsonObject = Record<string, unknown>;
export const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Remove JSONC comments/trailing commas without modifying quoted strings. */
export function parseJsonc(source: string, file = "OpenCode config"): JsonObject {
  let text = "";
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    const next = source[i + 1];
    if (quoted) {
      text += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      text += char;
    } else if (char === "/" && next === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n" && source[i] !== "\r") i++;
      if (i < source.length) text += source[i];
    } else if (char === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") text += "\n";
        i++;
      }
      if (i >= source.length) throw new Error("Unterminated JSONC comment in " + file);
      i++;
    } else {
      text += char;
    }
  }
  let clean = "";
  quoted = false;
  escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      clean += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      clean += char;
    } else if (char === ",") {
      let next = i + 1;
      while (next < text.length && /\s/.test(text[next]!)) next++;
      if (text[next] !== "}" && text[next] !== "]") clean += char;
    } else {
      clean += char;
    }
  }
  let value: unknown;
  try { value = JSON.parse(clean.replace(/^\uFEFF/, "")); }
  catch (error) { throw new Error("Invalid JSONC in " + file + ": " + String(error)); }
  if (!isObject(value)) throw new Error("OpenCode config must be an object: " + file);
  return value;
}

function mergeConfig(previous: JsonObject, incoming: JsonObject): JsonObject {
  const former = isObject(previous.mcp) ? previous.mcp : {};
  const later = isObject(incoming.mcp) ? incoming.mcp : {};
  const merged = { ...former, ...later };
  if (isObject(former.servers) || isObject(later.servers)) {
    merged.servers = {
      ...(isObject(former.servers) ? former.servers : {}),
      ...(isObject(later.servers) ? later.servers : {}),
    };
  }
  return { ...previous, ...incoming, mcp: merged };
}

/** The closest project configuration overrides global settings. */
export async function readOpenCodeConfig(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): Promise<JsonObject> {
  const globalDir = resolve(env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode"));
  const folders: string[] = [];
  let current = resolve(cwd);
  while (true) {
    folders.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const files = [
    ...["opencode.json", "opencode.jsonc"].map((name) => join(globalDir, name)),
    ...(env.OPENCODE_CONFIG
      ? [isAbsolute(env.OPENCODE_CONFIG) ? env.OPENCODE_CONFIG : resolve(cwd, env.OPENCODE_CONFIG)]
      : []),
    ...folders.flatMap((folder) => ["opencode.json", "opencode.jsonc"].map((name) => join(folder, name))),
    ...folders.flatMap((folder) => ["opencode.json", "opencode.jsonc"].map((name) => join(folder, ".opencode", name))),
  ];
  let result: JsonObject = {};
  const visited = new Set<string>();
  for (const path of files) {
    const file = resolve(path);
    if (visited.has(file)) continue;
    visited.add(file);
    let content: string;
    try { content = await readFile(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    result = mergeConfig(result, parseJsonc(content, file));
  }
  return result;
}
