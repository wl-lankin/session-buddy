// Auto-update: what the island shows for a release the backend found, and when
// it may take the island. The user always starts the install. Pure, no DOM.

import type { IslandMode, IslandViewName } from "../core/layout";

export interface UpdateInfo { version: string; currentVersion: string; notes: string | null }
export type UpdatePhase = "idle" | "downloading" | "installing" | "restarting" | "error";

export interface UpdateModel {
  info: UpdateInfo | null;
  /** "Later": this version stays out of sight until the next app start. */
  dismissed: string | null;
  phase: UpdatePhase;
  downloaded: number;
  total: number | null;
  error: string | null;
}

export const initialUpdate: UpdateModel = { info: null, dismissed: null, phase: "idle", downloaded: 0, total: null, error: null };

export type UpdateAction =
  | { type: "available"; info: UpdateInfo }
  | { type: "install" }
  | { type: "progress"; downloaded: number; total: number | null }
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "later" };

export const isBusy = (m: UpdateModel): boolean => m.phase === "downloading" || m.phase === "installing" || m.phase === "restarting";

export function reduceUpdate(m: UpdateModel, a: UpdateAction): UpdateModel {
  switch (a.type) {
    case "available":
      // The same version announced again is a new check: the user asked, so it shows again.
      return isBusy(m) ? m : { ...m, info: a.info, dismissed: null, phase: "idle", error: null };
    case "install":
      return m.info && !isBusy(m) ? { ...m, phase: "downloading", downloaded: 0, total: null, error: null } : m;
    case "progress": {
      if (!m.info || m.phase === "restarting") return m;
      const done = a.total != null && a.total > 0 && a.downloaded >= a.total;
      return { ...m, phase: done ? "installing" : "downloading", downloaded: a.downloaded, total: a.total, error: null };
    }
    case "ready":
      return !m.info ? m : { ...m, phase: "restarting", error: null };
    case "error":
      return isBusy(m) ? { ...m, phase: "error", error: a.message } : m;
    case "later":
      return m.info && !isBusy(m) ? { ...m, dismissed: m.info.version, phase: "idle", error: null } : m;
  }
}

/** "v1.0.11" and "1.0.11" both show as "1.0.11". */
export const displayVersion = (v: string): string => v.trim().replace(/^v/i, "");

export const versionLine = (i: UpdateInfo): string => `Version ${displayVersion(i.version)} (you have ${displayVersion(i.currentVersion)})`;

/** The pill on the strip and the compact card; null while there is nothing to show. */
export function pillText(m: UpdateModel): string | null {
  if (!m.info) return null;
  if (m.phase === "restarting") return "Restarting";
  if (m.phase === "downloading" || m.phase === "installing") return "Updating";
  if (m.dismissed === m.info.version) return null;
  return `Update ${displayVersion(m.info.version)}`;
}

export interface OpenContext {
  mode: IslandMode;
  view: IslandViewName;
  /** A question, approval, plan or action waits for the user. */
  needsUser: boolean;
}

/** An update found by itself opens the island only when it is quiet: closed, or showing nothing but the empty view. */
export function mayAutoOpen(c: OpenContext): boolean {
  return !c.needsUser && (c.mode !== "expanded" || c.view === "empty");
}

/** The answer to a manual check may replace a calm view, never a waiting card or the chat. */
export function mayShowNote(c: OpenContext): boolean {
  if (c.needsUser) return false;
  return c.mode !== "expanded" || (c.view !== "interaction" && c.view !== "plan" && c.view !== "chat");
}

export type NoteTone = "ok" | "bad";
export interface UpdateNote { text: string; tone: NoteTone }

export const latestText = (current: string | null): string =>
  current ? `You have the latest version (${displayVersion(current)})` : "You have the latest version";

export const checkFailedText = (message: string): string => `Could not check for updates: ${message.trim() || "unknown error"}`;

export type CardKind = "note" | "offer" | "progress" | "error";

/** Which card the update view shows. */
export function cardKind(m: UpdateModel, note: UpdateNote | null): CardKind {
  if (note) return "note";
  if (m.phase === "error") return "error";
  if (isBusy(m)) return "progress";
  return "offer";
}

export function progressPercent(downloaded: number, total: number | null): number | null {
  if (total == null || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((downloaded / total) * 100)));
}

export function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The line under the bar: "Downloading 35% (4.2 of 12.0 MB)", "Installing ...", "Restarting". */
export function progressLabel(m: UpdateModel): string {
  if (m.phase === "restarting") return "Restarting";
  if (m.phase === "installing") return "Installing ...";
  const pct = progressPercent(m.downloaded, m.total);
  if (pct == null) return m.downloaded > 0 ? `Downloading ${fmtBytes(m.downloaded)}` : "Downloading ...";
  return `Downloading ${pct}% (${fmtBytes(m.downloaded)} of ${fmtBytes(m.total ?? 0)})`;
}

export interface CheckResult { available: boolean; version?: string; currentVersion: string; notes?: string; error?: string }
export type CheckSummary = { tone: "ok" | "offer" | "bad"; text: string };

/** The settings window's line for the answer of `update_check`. */
export function checkSummary(r: CheckResult): CheckSummary {
  if (r.error) return { tone: "bad", text: checkFailedText(r.error) };
  if (r.available && r.version) return { tone: "offer", text: `Version ${displayVersion(r.version)} is available (you have ${displayVersion(r.currentVersion)})` };
  return { tone: "ok", text: latestText(r.currentVersion) };
}
