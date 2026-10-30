import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useIsFetching, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View, type ViewStyle } from "react-native";
import { listMcps, listProjects, setMcp, type Mcp, type Provider } from "../shared/rpc";
import { Icon, Loading, ScrollView } from "./ui";

type Theme = PluginScreenProps["theme"];

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const PROVIDERS: { provider: Provider; name: string; about: string }[] = [
  { provider: "claude", name: "Claude", about: "Saved for this project." },
  { provider: "codex", name: "Codex", about: "Saved in this project's .codex/config.toml." },
  { provider: "opencode", name: "OpenCode", about: "Private per-project switches; no MCP credentials are copied into project files." },
];

// Layout and type scale follow ZeroSub's accounts page, so the two read as one app.
export function McpScreen({ theme, layout }: PluginScreenProps) {
  const fetchProjects = useRpc(listProjects);
  const queryClient = useQueryClient();
  const fetching = useIsFetching({ queryKey: ["mcp-toggle"] }) > 0;
  const [picked, setPicked] = useState<string | null>(null);

  const projects = useQuery({ queryKey: ["mcp-toggle", "projects"], queryFn: () => fetchProjects({}) });
  const path = picked ?? projects.data?.[0]?.path ?? null;

  if (projects.isPending) return <Loading />;

  const colors = theme.colors;
  const muted = { color: colors.foregroundMuted, fontSize: 13 };
  const danger = { color: colors.statusDanger, fontSize: 13 };
  // Side by side on wide screens; stacked on phones.
  const column: ViewStyle = layout.compact ? {} : { flex: 1, minWidth: 0 };
  return (
    <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
      <ScrollView
        contentContainerStyle={{
          padding: layout.compact ? 16 : 28,
          gap: layout.compact ? 20 : 28,
          maxWidth: 1100,
          width: "100%",
          alignSelf: "center",
        }}
      >
        <View style={{ gap: 6 }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12, fontWeight: "600", letterSpacing: 0.4 }}>Claude · Codex · OpenCode</Text>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <Text style={{ color: colors.foreground, fontSize: 22, fontWeight: "700" }} accessibilityRole="header">
              MCP servers
            </Text>
            <RefreshButton
              theme={theme}
              busy={fetching}
              onPress={() => void queryClient.refetchQueries({ queryKey: ["mcp-toggle"] })}
            />
          </View>
          <Text style={muted}>
            Turn Claude, Codex and OpenCode MCP servers on or off. New sessions start with this set; to change a running chat,
            use the mcp pill above its composer.
          </Text>
        </View>

        <Section theme={theme} title="Project">
          {projects.error ? (
            <Text style={danger}>Could not load projects: {message(projects.error)}</Text>
          ) : (
            <SettingsCard>
              <SettingsSelect
                label="Show servers for"
                hint="A subfolder or worktree uses its repository's list."
                value={path ?? ""}
                options={(projects.data ?? []).map((project) => ({ label: project.name, value: project.path }))}
                onValueChange={setPicked}
              />
            </SettingsCard>
          )}
        </Section>

        {path !== null && (
          <View
            style={{
              flexDirection: layout.compact ? "column" : "row",
              alignItems: layout.compact ? "stretch" : "flex-start",
              gap: layout.compact ? 20 : 28,
            }}
          >
            {PROVIDERS.map(({ provider, name, about }) => (
              <View key={provider} style={column}>
                <Servers theme={theme} provider={provider} name={name} about={about} path={path} />
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function Servers({ theme, provider, name, about, path }: { theme: Theme; provider: Provider; name: string; about: string; path: string }) {
  const fetchMcps = useRpc(listMcps);
  const changeMcp = useRpc(setMcp);
  const mcps = useQuery({
    queryKey: ["mcp-toggle", "mcps", provider, path],
    queryFn: async () => (await fetchMcps({ provider, cwds: [path] }))[path] ?? [],
  });
  const toggle = useMutation({ mutationFn: changeMcp, onSettled: () => mcps.refetch() });

  const muted = { color: theme.colors.foregroundMuted, fontSize: 13 };
  const hint = (server: Mcp) =>
    server.locked ??
    (server.scope === "user" ? "On or off for this project" : "Added to this project only");
  return (
    <Section theme={theme} title={name}>
      <Text style={muted}>{about}</Text>
      {mcps.isPending ? (
        <Text style={muted}>Loading servers…</Text>
      ) : mcps.error ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>
          Could not read {name}'s MCP servers: {message(mcps.error)}
        </Text>
      ) : mcps.data.length === 0 ? (
        <Text style={muted}>{name} has no MCP servers for this project.</Text>
      ) : (
        <SettingsCard>
          {mcps.data.map((server) => (
            <SettingsSwitch
              key={server.name}
              label={server.name}
              hint={hint(server)}
              value={server.enabled}
              disabled={toggle.isPending || server.locked !== undefined}
              error={toggle.error && toggle.variables?.name === server.name ? message(toggle.error) : null}
              onValueChange={(enabled) => toggle.mutate({ provider, cwd: path, name: server.name, enabled })}
            />
          ))}
        </SettingsCard>
      )}
    </Section>
  );
}

function Section({ theme, title, children }: { theme: Theme; title: string; children: ReactNode }) {
  return (
    <View style={{ gap: 10 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "700" }} accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

function RefreshButton({ theme, busy, onPress }: { theme: Theme; busy: boolean; onPress(): void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Refresh"
      accessibilityState={{ busy }}
      disabled={busy}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      hitSlop={4}
      style={({ pressed }) => ({
        width: 30,
        height: 30,
        borderRadius: 8,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed || hovered ? theme.colors.surface2 : "transparent",
      })}
    >
      {busy ? (
        <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
      ) : (
        <Icon name="RefreshCw" size={15} color={theme.colors.foregroundMuted} />
      )}
    </Pressable>
  );
}
