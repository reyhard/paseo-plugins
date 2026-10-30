import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** The agent providers whose MCP servers this plugin manages. Defaults to Claude for clients from before Codex support. */
export const ProviderSchema = z.enum(["claude", "codex", "opencode"]);
export type Provider = z.infer<typeof ProviderSchema>;
export const PROVIDERS = ProviderSchema.options;

/**
 * `user`: loaded in every project. `project`: added to this project only.
 * `locked`: why the switch cannot change it, when a file this plugin does not edit decides it.
 */
export const McpSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
  scope: z.enum(["user", "project"]),
  locked: z.string().optional(),
});
export type Mcp = z.infer<typeof McpSchema>;

/** The MCP servers the provider loads in each folder, keyed by the folder asked for. */
export const listMcps = defineRpc({
  name: "mcp-toggle.list",
  input: z.object({ provider: ProviderSchema.default("claude"), cwds: z.array(z.string().min(1)).max(500) }),
  output: z.record(z.string(), z.array(McpSchema)),
});

export const listProjects = defineRpc({
  name: "mcp-toggle.projects",
  input: z.object({}),
  output: z.array(z.object({ name: z.string(), path: z.string() })),
});

/** With `agentId`, that agent's session is reloaded to pick up the change, and resumed if it was running. */
export const setMcp = defineRpc({
  name: "mcp-toggle.set",
  input: z.object({
    provider: ProviderSchema.default("claude"),
    cwd: z.string().min(1),
    name: z.string().min(1),
    enabled: z.boolean(),
    agentId: z.string().optional(),
  }),
  output: z.object({ reloadError: z.string().nullable() }),
});
