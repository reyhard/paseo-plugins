import type { PluginButtonContentProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { Icon } from "./ui";
import { useState, useSyncExternalStore, type ComponentType } from "react";
import { Pressable, Text, View } from "react-native";
import { listMcps, PROVIDERS, setMcp, type Mcp, type Provider } from "../shared/rpc";

interface TrackedAgent {
  id: string;
  workspaceId: string;
  cwd: string;
  provider: Provider;
}

const PROVIDER_NAMES: Record<Provider, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode" };
const isProvider = (provider: string): provider is Provider => (PROVIDERS as readonly string[]).includes(provider);

type Status = { kind: "reloading" } | { kind: "failed"; error: string };

const POLL_MS = 15_000;

/**
 * One "mcp (n)" composer pill per Claude, Codex or OpenCode agent. It opens a popover of that provider's MCP
 * servers for the agent's folder that stays open while you toggle them; each toggle reloads the agent.
 */
export function contributePills(client: PluginClientContext): () => void {
  const agents = new Map<string, TrackedAgent>();
  const mcpsByCwd: Record<Provider, Map<string, Mcp[]>> = { claude: new Map(), codex: new Map(), opencode: new Map() };
  const serversOf = (agent: TrackedAgent | undefined) => (agent ? mcpsByCwd[agent.provider].get(agent.cwd) : undefined);
  const status = new Map<string, Status>();
  const pills = new Map<string, { registration: PluginButtonRegistration; label: string }>();
  const listeners = new Set<() => void>();
  const lifetime = new AbortController();
  let version = 0;
  let stopped = false;

  /** Re-renders open popovers and brings pills in line with the current state. */
  function changed(): void {
    if (stopped) return;
    version += 1;
    for (const listener of listeners) listener();
    for (const [agentId, pill] of pills) {
      const agent = agents.get(agentId);
      if (!serversOf(agent)?.length) {
        pill.registration.remove();
        pills.delete(agentId);
      }
    }
    for (const agent of agents.values()) {
      const servers = serversOf(agent);
      if (!servers?.length) continue;
      const label = labelFor(agent, servers);
      const existing = pills.get(agent.id);
      if (existing) {
        // Only the label changes, so an open popover stays open.
        if (existing.label !== label) {
          existing.registration.update({ label });
          existing.label = label;
        }
        continue;
      }
      try {
        const registration = client.addComposerPill({
          id: "mcps",
          workspaceId: agent.workspaceId,
          agentId: agent.id,
          button: {
            title: `${PROVIDER_NAMES[agent.provider]} MCP servers`,
            icon: "Plug",
            label,
            behavior: { kind: "popover", Content: popoverFor(agent.id) },
          },
        });
        pills.set(agent.id, { registration, label });
      } catch (error) {
        console.warn("[mcp-toggle] could not add the mcp pill", error);
      }
    }
  }

  function labelFor(agent: TrackedAgent, servers: Mcp[]): string {
    const label = `mcp (${servers.filter((server) => server.enabled).length})`;
    const current = status.get(agent.id);
    if (current?.kind === "reloading") return `${label} · reloading…`;
    if (current?.kind === "failed") return `${label} · reload failed`;
    return label;
  }

  function popoverFor(agentId: string): ComponentType<PluginButtonContentProps> {
    // Metrics copied from Paseo's own menu rows (MenuItem in the 0.13 app), so the popover reads as a menu.
    return function McpPopover({ theme, layout, close }: PluginButtonContentProps) {
      useSyncExternalStore(
        (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        () => version,
      );
      const agent = agents.get(agentId);
      const servers = serversOf(agent) ?? [];
      const current = status.get(agentId);
      const busy = current?.kind === "reloading";
      const separator = <View style={{ height: 1, marginVertical: 4, backgroundColor: theme.colors.border }} />;
      return (
        // The popover pads its content by 12; a menu insets its rows by 4.
        <View style={{ margin: -8 }}>
          {servers.map((server) => (
            <MenuRow
              key={server.name}
              theme={theme}
              compact={layout.compact}
              icon={server.enabled ? "CircleCheck" : "Circle"}
              label={`${server.name} — ${server.enabled ? "enabled" : "disabled"}${server.locked ? " (locked)" : ""}`}
              checked={server.enabled}
              disabled={busy || !agent || server.locked !== undefined}
              onPress={() => agent && void toggle(agent, server)}
            />
          ))}
          {current && (
            <>
              {separator}
              <Text
                style={{
                  paddingHorizontal: 8,
                  paddingVertical: 8,
                  fontSize: 12,
                  color: busy ? theme.colors.foregroundMuted : theme.colors.statusDanger,
                }}
              >
                {current.kind === "reloading" ? "Reloading the agent…" : `Reload failed: ${current.error}`}
              </Text>
            </>
          )}
          {separator}
          <MenuRow
            theme={theme}
            compact={layout.compact}
            icon="SlidersHorizontal"
            label="Manage MCP servers…"
            onPress={() => {
              close();
              client.openScreen({ screenId: "mcps" });
            }}
          />
        </View>
      );
    };
  }

  async function toggle(agent: TrackedAgent, server: Mcp): Promise<void> {
    const enabled = !server.enabled;
    // Show the new state at once; the reload takes a few seconds.
    mcpsByCwd[agent.provider].set(
      agent.cwd,
      (serversOf(agent) ?? []).map((entry) => (entry.name === server.name ? { ...entry, enabled } : entry)),
    );
    status.set(agent.id, { kind: "reloading" });
    changed();
    try {
      const { reloadError } = await client.rpc(setMcp, {
        provider: agent.provider,
        cwd: agent.cwd,
        name: server.name,
        enabled,
        agentId: agent.id,
      });
      if (reloadError) status.set(agent.id, { kind: "failed", error: reloadError });
      else status.delete(agent.id);
    } catch (error) {
      console.error("[mcp-toggle] could not change the MCP server", error);
      status.set(agent.id, { kind: "failed", error: error instanceof Error ? error.message : String(error) });
    }
    await refresh();
  }

  async function refresh(): Promise<void> {
    // Each provider reads separately, so one that fails (Codex not installed) leaves the other's pills.
    await Promise.all(
      PROVIDERS.map(async (provider) => {
        const cwds = [...new Set([...agents.values()].filter((agent) => agent.provider === provider).map((agent) => agent.cwd))];
        if (stopped || cwds.length === 0) return;
        try {
          mcpsByCwd[provider] = new Map(Object.entries(await client.rpc(listMcps, { provider, cwds })));
        } catch (error) {
          if (!stopped) console.warn(`[mcp-toggle] could not read ${PROVIDER_NAMES[provider]}'s MCP servers`, error);
        }
      }),
    );
    changed();
  }

  /** Returns true when the agent's folder has not been looked up yet. */
  function track(agent: { id: string; workspaceId?: string | null; provider: string; cwd: string }): boolean {
    if (!agent.workspaceId || !isProvider(agent.provider)) return false;
    agents.set(agent.id, { id: agent.id, workspaceId: agent.workspaceId, cwd: agent.cwd, provider: agent.provider });
    return !mcpsByCwd[agent.provider].has(agent.cwd);
  }

  // shortcut: only the 200 most recently updated agents get a pill; page through older ones like ZeroSub if that bites.
  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal, sort: [{ key: "updated_at", direction: "desc" }], page: { limit: 200 } })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          agents.clear();
          for (const { agent } of entries) track(agent);
          void refresh();
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") {
            agents.delete(update.agentId);
            changed();
          } else if (track(update.agent)) void refresh();
          else changed();
        },
      });
    })
    .catch((error: unknown) => {
      if (!stopped) console.error("[mcp-toggle] could not watch agents", error);
    });

  // Picks up changes made elsewhere: the Manage MCP servers screen, Claude's own /mcp, another device.
  const poll = setInterval(() => void refresh(), POLL_MS);

  return () => {
    stopped = true;
    lifetime.abort();
    clearInterval(poll);
    listeners.clear();
    for (const pill of pills.values()) pill.registration.remove();
    pills.clear();
  };
}

/** A row styled like Paseo's own menu rows: hover and press both highlight it. `checked` makes it a switch. */
function MenuRow({
  theme,
  compact,
  icon,
  label,
  checked,
  disabled = false,
  onPress,
}: {
  theme: PluginButtonContentProps["theme"];
  compact: boolean;
  icon: string;
  label: string;
  checked?: boolean;
  disabled?: boolean;
  onPress(): void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole={checked === undefined ? "menuitem" : "switch"}
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        minHeight: compact ? 40 : 28,
        gap: 8,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 6,
        opacity: disabled ? 0.5 : 1,
        backgroundColor: (pressed || hovered) && !disabled ? theme.colors.surface2 : "transparent",
      })}
    >
      <View style={{ width: 16, alignItems: "center", justifyContent: "center" }}>
        <Icon name={icon} size={14} color={theme.colors.foregroundMuted} />
      </View>
      <Text style={{ fontSize: 14, lineHeight: 18, color: theme.colors.foreground }}>{label}</Text>
    </Pressable>
  );
}
