import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";

/** Windows npm puts a POSIX shim beside codex.cmd; never return that shim. */
export const cliNames = (name: string, platform: NodeJS.Platform = process.platform): string[] =>
  platform === "win32" ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name];

export async function locateCli(
  name: string,
  extraFolders: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const folders = [
    ...(env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : delimiter),
    ...extraFolders,
    ...(platform === "win32" ? [join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "npm")] : []),
  ];
  for (const folder of new Set(folders.filter(Boolean))) {
    for (const executable of cliNames(name, platform)) {
      const full = join(folder, executable);
      if (await access(full, platform === "win32" ? constants.F_OK : constants.X_OK).then(() => true, () => false))
        return full;
    }
  }
  throw new Error(`Could not find ${name} executable (check PATH and the provider installation).`);
}
