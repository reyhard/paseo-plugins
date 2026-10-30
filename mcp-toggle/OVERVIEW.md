# MCP Toggle — Claude, Codex and OpenCode

Based on [ragokan/paseo-plugins](https://github.com/ragokan/paseo-plugins/tree/main/mcp-toggle).

Open Settings → Plugins → MCP toggle → **MCP settings**, use the sidebar **Manage MCP servers**, or the MCP pill in agent chats. Supports Claude, Codex and OpenCode.

## Windows fixes
Codex executable discovery selects `codex.exe` / `codex.cmd` rather than the POSIX npm shim. The Paseo reload fallback also searches Windows CLI locations; Paseo 0.14+ uses native `agent.reload()`, while 0.13 retains CLI reload.

## OpenCode
OpenCode MCP servers are read using `opencode debug config` in the project's cwd. Toggle choices are stored as private booleans under `PASEO_HOME/mcp-toggle/opencode`, keyed by the Git checkout, and applied at every agent session open with an `OPENCODE_CONFIG_CONTENT` overlay. V1 (`mcp.<name>.enabled`) and V2 (`mcp.servers.<name>.disabled`) schemas are recognized.

Global MCP credentials are **not persisted in any project files**. Full server definitions are copied only into the **agent launch environment** when an override is active. This depends on OpenCode accepting `OPENCODE_CONFIG_CONTENT` as an overlay; integration-test against your installed OpenCode release before relying on it in production. Existing custom `OPENCODE_CONFIG_CONTENT` from your daemon's provider configuration is not read by the plugin unless inherited through the process or session environment, so verify any custom setup.

Project changes take effect for newly opened or reloaded sessions. A toggle in a running agent reloads it (and may interrupt a turn). OpenCode status here is configured enabled/disabled, not live connection health.

## Tests
`npm install`, `npm run typecheck`, `npm test`. Some Codex tests require a local `codex` installation. Windows host integration tests remain recommended.
