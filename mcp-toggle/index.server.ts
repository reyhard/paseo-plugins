import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listMcpsFor, reloadAgent, setMcpEnabled } from "./server/claude-config";
import { listCodexMcpsFor, setCodexMcpEnabled, syncCheckout } from "./server/codex-config";
import { listOpenCodeMcpsFor, setOpenCodeMcpEnabled, openCodeLaunchEnv } from "./server/opencode-config";
import { listMcps, listProjects, setMcp } from "./shared/rpc";

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default function contribute(server: PluginServerContext) {
  server.handle(listMcps, ({ provider, cwds }) => {
    if (provider === "codex") return listCodexMcpsFor(cwds);
    if (provider === "opencode") return listOpenCodeMcpsFor(cwds);
    return listMcpsFor(cwds);
  });

  server.handle(listProjects, async (_input, { paseo }) => {
    const { projects } = await paseo.projects.list();
    return projects.map((project) => ({
      name: project.projectCustomName ?? project.projectDisplayName,
      path: project.projectRootPath,
    }));
  });

  server.handle(setMcp, async ({ provider, cwd, name, enabled, agentId }, { paseo }) => {
    if (provider === "codex") await setCodexMcpEnabled(cwd, name, enabled);
    else if (provider === "opencode") await setOpenCodeMcpEnabled(cwd, name, enabled);
    else await setMcpEnabled(cwd, name, enabled);
    if (!agentId) return { reloadError: null };
    const agent = paseo.agents.ref(agentId);
    await agent.refresh();
    // A reload cancels the running turn, so a running agent is asked to pick it back up.
    const wasRunning = agent.status === "running";
    try {
      // Paseo 0.14+ has a native reload; 0.13 requires its CLI.
      const nativeReload = (agent as typeof agent & { reload?: () => Promise<unknown> }).reload;
      if (typeof nativeReload === "function") await nativeReload.call(agent);
      else await reloadAgent(agentId);
      if (wasRunning) {
        await agent.send(
          `Continue where you left off. The MCP server "${name}" was ${enabled ? "enabled" : "disabled"}, so your session was reloaded.`,
        );
      }
      return { reloadError: null };
    } catch (error) {
      console.error(`[mcp-toggle] could not reload ${agentId}`, describe(error));
      return { reloadError: describe(error) };
    }
  });

  // Codex reads only a worktree's own .codex/config.toml, so a worktree made after a switch gets the project's switches here.
  const stopSync = server.before("agent.session_open", async ({ request }) => {
    if (request.provider === "opencode") {
      const env = await openCodeLaunchEnv(request.cwd, request.env ?? {});
      return env ? { ...request, env: { ...request.env, ...env } } : undefined;
    }
    if (request.provider !== "codex") return;
    await syncCheckout(request.cwd).catch((error: unknown) =>
      console.warn(`[mcp-toggle] could not copy Codex's switches into ${request.cwd}:`, describe(error)),
    );
  });

  return () => stopSync();
}
