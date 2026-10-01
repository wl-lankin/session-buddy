// Island geometry. All values are logical pixels. The window is a fixed
// 720x360 transparent panel; the island is drawn inside it, glued to the top
// edge and horizontally centred.

export type IslandMode = "strip" | "compact" | "expanded";
export type IslandViewName = "session" | "interaction" | "empty" | "confused" | "greeting";

export type BotStateName =
  | "idle" | "working" | "thinking" | "searching" | "approval" | "question"
  | "error" | "finished" | "ratelimit" | "sleeping" | "dizzy";

export type BotEmoteName = "love" | "surprised" | "proud" | "wink" | "yawn" | "happy" | "annoyed";

export const PANEL_W = 720;
export const PANEL_H = 360;

// The launch greeting animates out of a notch-sized shape (src/mochi/greeting.ts).
export const NOTCH_W = 184;
export const NOTCH_H = 32;
export const COMPACT_W = 288;
export const GREETING_W = 640;

export const STRIP_W = 340;
export const STRIP_H = 28;
export const COMPACT_ISLAND_W = 480;
export const COMPACT_H = 64;
export const EXPANDED_W = 700;

export const ROUNDED_CORNER = 14;
export const EXPANDED_CORNER = 22;

const VIEW_HEIGHTS: Record<IslandViewName, number> = {
  session: 320,
  interaction: 300,
  empty: 140,
  confused: 160,
  greeting: 150,
};

export function islandSize(mode: IslandMode, view: IslandViewName, interactionHeight?: number): { w: number; h: number } {
  switch (mode) {
    case "strip":
      return { w: STRIP_W, h: STRIP_H };
    case "compact":
      return { w: COMPACT_ISLAND_W, h: COMPACT_H };
    case "expanded":
      if (view === "greeting") return { w: GREETING_W, h: VIEW_HEIGHTS.greeting };
      if (view === "interaction" && interactionHeight) {
        return { w: EXPANDED_W, h: Math.max(200, Math.min(PANEL_H, Math.round(interactionHeight))) };
      }
      return { w: EXPANDED_W, h: VIEW_HEIGHTS[view] };
  }
}

export interface BotPlacement { cx: number; cy: number; diameter: number; opacity: number }

export function botPosition(mode: IslandMode, view: IslandViewName): BotPlacement {
  switch (mode) {
    case "strip":
      return { cx: 18, cy: 14, diameter: 16, opacity: 1 };
    case "compact":
      return { cx: 34, cy: 32, diameter: 38, opacity: 1 };
    case "expanded":
      if (view === "greeting") return { cx: 320, cy: 90, diameter: 0, opacity: 0 };
      return { cx: 56, cy: 96, diameter: 58, opacity: 1 };
  }
}

export function botGlowColor(s: BotStateName): string {
  switch (s) {
    case "working":
      return "#3B9EFF";
    case "thinking":
      return "#A78BFA";
    case "searching":
      return "#6366F1";
    case "approval":
      return "#F5A524";
    case "error":
      return "#F4505E";
    case "finished":
      return "#34D399";
    case "ratelimit":
      return "#F59E0B";
    default:
      return "#FFFFFF";
  }
}

export function botGlowOpacity(s: BotStateName): number {
  switch (s) {
    case "idle":
    case "sleeping":
      return 0.15;
    case "dizzy":
      return 0;
    default:
      return 0.65;
  }
}

const PROJECT_COLORS: Record<string, string> = {
  pushdocs: "#60A5FA",
  fetchdocs: "#22C55E",
  bankconnect: "#F5A524",
  invoicerails: "#E879F9",
  gmi: "#F4505E",
  "session-buddy": "#22D3EE",
};

const FALLBACK_COLORS = ["#34D399", "#EAB308", "#818CF8", "#F472B6", "#FB923C", "#2DD4BF"];

export function colorForProject(name: string): string {
  const key = name.toLowerCase().trim();
  const exact = PROJECT_COLORS[key];
  if (exact) return exact;
  for (const [k, c] of Object.entries(PROJECT_COLORS)) {
    if (key.startsWith(k) || key.includes(k)) return c;
  }
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}
