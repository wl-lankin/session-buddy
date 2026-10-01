// Pure input helpers for the settings window.

/** Clamps to [min, max]; rounds when `integer`. Non-numeric input falls back to min. */
export function normalizeNumber(raw: number | string, min: number, max: number, integer: boolean): number {
  let v = Number(raw);
  if (!Number.isFinite(v)) v = min;
  if (integer) v = Math.round(v);
  return Math.min(max, Math.max(min, v));
}
