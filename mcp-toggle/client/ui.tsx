import * as hostUi from "@getpaseo/plugin/client/ui";
import type { ComponentType } from "react";
import { ActivityIndicator, ScrollView as NativeScrollView, Text, View, type ScrollViewProps } from "react-native";

// Paseo 0.13 added Icon, Loading and ScrollView to the plugin UI kit; the 0.12 app leaves them
// undefined. There the plugin falls back to React Native, and icons to text glyphs, since 0.12 has
// no way to draw a Lucide icon by name.
interface IconProps {
  name: string;
  size: number;
  color: string;
}
const added = hostUi as Partial<{ Icon: ComponentType<IconProps>; Loading: ComponentType; ScrollView: ComponentType<ScrollViewProps> }>;

// Covers the icons this plugin draws. U+FE0E keeps the gear a text glyph rather than an emoji.
const GLYPHS: Record<string, string> = { Circle: "○", CircleCheck: "●", RefreshCw: "↻", SlidersHorizontal: "⚙︎" };

function GlyphIcon({ name, size, color }: IconProps) {
  const glyph = GLYPHS[name];
  if (!glyph) return null;
  return <Text style={{ fontSize: size, lineHeight: size + 2, color, textAlign: "center" }}>{glyph}</Text>;
}

function NativeLoading() {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <ActivityIndicator />
    </View>
  );
}

export const Icon = added.Icon ?? GlyphIcon;
export const Loading = added.Loading ?? NativeLoading;
export const ScrollView = added.ScrollView ?? NativeScrollView;
