// The windows are an app, not a browser: no WebView context menu (Back, Reload,
// Print, ...) and no reload, print, save, view-source or find shortcuts.

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
}

const WITH_MODIFIER = new Set(["r", "p", "s", "u", "f", "g"]);

/** True for F5 and Ctrl/Cmd + R, P, S, U, F, G (with or without Shift). */
export function isBrowserShortcut(e: KeyLike): boolean {
  if (e.key === "F5") return true;
  return (e.ctrlKey || e.metaKey) && WITH_MODIFIER.has(e.key.toLowerCase());
}

interface MaybeElement {
  closest?: (selector: string) => unknown;
}

/** Text fields keep their context menu (paste). */
export function insideTextField(target: EventTarget | null): boolean {
  const closest = (target as MaybeElement | null)?.closest;
  return typeof closest === "function" && closest.call(target, "input, textarea, [contenteditable]") != null;
}

export function installNoBrowser(target: Pick<Document, "addEventListener"> = document): void {
  target.addEventListener("contextmenu", (e) => {
    if (!insideTextField(e.target)) e.preventDefault();
  });
  target.addEventListener("keydown", (e) => {
    if (isBrowserShortcut(e)) e.preventDefault();
  });
}
