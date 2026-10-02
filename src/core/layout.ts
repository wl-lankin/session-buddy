// Island geometry. All values are logical pixels. The window is a transparent
// panel, 960x440 unless the island needs more (src/model/size.ts panelFor); the
// island is drawn inside it, glued to the top edge and horizontally centred.

export type IslandMode = "strip" | "compact" | "expanded";
export type IslandViewName = "session" | "interaction" | "plan" | "finished" | "empty" | "confused" | "greeting" | "chat" | "update";

export type BotStateName =
  | "idle" | "working" | "thinking" | "searching" | "approval" | "question"
  | "error" | "finished" | "ratelimit" | "sleeping" | "dizzy";

export type BotEmoteName = "love" | "surprised" | "proud" | "wink" | "yawn" | "happy" | "annoyed";

/** The default panel. Keep in sync with src-tauri/src/island.rs and tauri.conf.json. */
export const PANEL_W = 960;
export const PANEL_H = 440;
/** Measured cards (interaction, finished) grow up to this height on their own. */
const CARD_MAX_H = 400;

// The launch greeting animates out of a notch-sized shape (src/buddy/greeting.ts).
export const NOTCH_W = 184;
export const NOTCH_H = 32;
export const COMPACT_W = 288;
export const GREETING_W = 640;

/** The strip grows with its label, dots and limits between these widths. */
export const STRIP_W = 340;
export const STRIP_MAX_W = 600;
export const STRIP_H = 28;
export const COMPACT_ISLAND_W = 480;
export const COMPACT_H = 64;
export const EXPANDED_W = 920;

export const ROUNDED_CORNER = 14;
export const EXPANDED_CORNER = 22;

const VIEW_HEIGHTS: Record<IslandViewName, number> = {
  session: 380,
  interaction: 300,
  plan: 300,
  finished: 150,
  empty: 140,
  confused: 160,
  greeting: 150,
  chat: 440,
  update: 150,
};

/** The session view without its unfolded last answer. */
export const VIEW_HEIGHT_SESSION = VIEW_HEIGHTS.session;

/** The one-line answer of a manual update check: as low as the card gets, Buddy in its middle. */
export const NOTE_CARD_H = 72;

/** Views whose height follows their content (ViewHost.measure), within [min, max]. */
const MEASURED: Partial<Record<IslandViewName, [number, number]>> = {
  session: [VIEW_HEIGHTS.session, 600],
  interaction: [200, CARD_MAX_H],
  finished: [VIEW_HEIGHTS.finished, CARD_MAX_H],
  update: [NOTE_CARD_H, CARD_MAX_H],
};

/** Natural island size. `measured` is the view's content height, `expandedWidth` the auto width (src/model/size.ts). */
export function islandSize(
  mode: IslandMode,
  view: IslandViewName,
  measured?: number,
  stripWidth?: number,
  expandedWidth = EXPANDED_W,
): { w: number; h: number } {
  switch (mode) {
    case "strip":
      return { w: Math.max(STRIP_W, Math.min(STRIP_MAX_W, Math.ceil(stripWidth ?? STRIP_W))), h: STRIP_H };
    case "compact":
      return { w: COMPACT_ISLAND_W, h: COMPACT_H };
    case "expanded":
      if (view === "greeting") return { w: GREETING_W, h: VIEW_HEIGHTS.greeting };
      const range = MEASURED[view];
      if (range && measured) return { w: expandedWidth, h: Math.max(range[0], Math.min(range[1], Math.round(measured))) };
      return { w: expandedWidth, h: VIEW_HEIGHTS[view] };
  }
}

export interface BotPlacement { cx: number; cy: number; diameter: number; opacity: number }

export function botPosition(mode: IslandMode, view: IslandViewName, noteCard = false): BotPlacement {
  switch (mode) {
    case "strip":
      return { cx: 18, cy: 14, diameter: 16, opacity: 1 };
    case "compact":
      return { cx: 34, cy: 32, diameter: 38, opacity: 1 };
    case "expanded":
      if (view === "greeting") return { cx: 320, cy: 90, diameter: 0, opacity: 0 };
      // The session view's tab row spans the whole island: Buddy sits below it.
      if (view === "session") return { cx: 56, cy: 112, diameter: 58, opacity: 1 };
      if (view === "update" && noteCard) return { cx: 56, cy: NOTE_CARD_H / 2, diameter: 58, opacity: 1 };
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
