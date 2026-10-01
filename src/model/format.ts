// Small formatters shared by every view. Plain hyphens only.

export type Level = "ok" | "warn" | "crit";

export function level(pct: number | null | undefined): Level {
  if (pct == null) return "ok";
  return pct >= 90 ? "crit" : pct >= 70 ? "warn" : "ok";
}

export const fmtPct = (p: number): string => String(Math.round(p));

export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return "?";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export const fmtLines = (added: number, removed: number): string => `+${added} -${removed}`;

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtAgo(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export function parseReset(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

const pad = (n: number) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function fmtReset(v: string | number | null | undefined, now: number): string {
  const t = parseReset(v);
  if (t == null) return "";
  const d = new Date(t);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return t - now < 24 * 3600_000 ? hm : `${DAYS[d.getDay()]} ${hm}`;
}

export function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

export function firstLine(text: string | null | undefined, max = 120): string {
  if (!text) return "";
  const line = (text.split(/\r?\n/).find((l) => l.trim()) ?? "").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
