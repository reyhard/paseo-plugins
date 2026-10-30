import type { PluginClientContext, PluginSidebarItemProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { contributePills } from "./client/pills";
import { McpScreen } from "./client/screen";

function McpSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="Plug" active={currentScreen?.screenId === "mcps"} onPress={() => openScreen({ screenId: "mcps" })} />;
}

function McpSettings(props: PluginSurfaceProps) {
  return <McpScreen {...props} params={{}} />;
}

export default function contribute(client: PluginClientContext) {
  // This is the entry available from Settings → Plugins → MCP Toggle.
  client.addSettingsScreen({ id: "mcps-settings", title: "MCP settings", icon: "Plug", Component: McpSettings });
  client.addScreen({ id: "mcps", title: "Manage MCP servers", Component: McpScreen });
  client.addSidebarHeaderItem({ id: "mcps", title: "Manage MCP servers", Component: McpSidebarItem });
  return contributePills(client);
}
