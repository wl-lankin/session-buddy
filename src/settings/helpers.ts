// Pure input helpers for the settings window.

/** Clamps to [min, max]; rounds when `integer`. Non-numeric input falls back to min. */
export function normalizeNumber(raw: number | string, min: number, max: number, integer: boolean): number {
  let v = Number(raw);
  if (!Number.isFinite(v)) v = min;
  if (integer) v = Math.round(v);
  return Math.min(max, Math.max(min, v));
}

/** The unit shown next to a seconds field: 0 means "do it at once". */
export function secondsLabel(value: number): string {
  return value === 0 ? "Immediately" : "seconds";
}

export const DEFAULT_OLLAMA_URL = "http://localhost:11434";

/** A server address the backend can use: scheme added, trailing slashes dropped, empty means the default. */
export function normalizeOllamaUrl(raw: string): string {
  const t = raw.trim();
  if (!t) return DEFAULT_OLLAMA_URL;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `http://${t}`;
  return withScheme.replace(/\/+$/, "");
}

/** The line next to the Ollama Test button. */
export function ollamaTestText(reachable: boolean, count: number, url: string): string {
  if (!reachable) return `Ollama is not reachable at ${url} - start it with \`ollama serve\``;
  if (count === 0) return "Reachable, but it has no models yet. Try: ollama pull qwen2.5:7b";
  return `Reachable - ${count} ${count === 1 ? "model" : "models"}`;
}

/** Adds a project folder: trimmed, a trailing separator dropped, no duplicate. Returns the same array when nothing changes. */
export function addRoot(roots: string[], path: string | null | undefined): string[] {
  const p = (path ?? "").trim().replace(/(?<=.)[\\/]+$/, "");
  return !p || roots.includes(p) ? roots : [...roots, p];
}

export const removeRoot = (roots: string[], path: string): string[] => roots.filter((r) => r !== path);

/** A folder as two parts: its name, and where it lies. */
export function rootParts(path: string): { name: string; dir: string } {
  const trimmed = path.replace(/(?<=.)[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut < 0 ? { name: trimmed, dir: "" } : { name: trimmed.slice(cut + 1) || trimmed, dir: trimmed.slice(0, cut) || trimmed.slice(0, cut + 1) };
}

/** The hosts the settings offer; terminals come later. */
export const SESSION_HOSTS: { id: string; label: string }[] = [{ id: "background", label: "Background" }];
