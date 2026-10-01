// The windows are an app, not a browser: no WebView context menu (Back, Reload,
// Print, ...) and no reload, print, save, find, zoom, history, devtools or new
// window shortcuts.

export interface KeyLike {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

// Physical keys (e.code), so a keyboard layout does not change what is blocked.
const WITH_MODIFIER = new Set([
  "KeyR", // reload (also with Shift)
  "KeyP", // print
  "KeyS", // save page
  "KeyU", // view source
  "KeyF", // find
  "KeyG", // find next
  "KeyN", // new window
  "KeyO", // open file
  "KeyD", // bookmark
  "KeyJ", // downloads
  "Equal", // zoom in
  "Minus", // zoom out
  "Digit0", // zoom reset
  "NumpadAdd",
  "NumpadSubtract",
  "Numpad0",
]);

/** True for the browser's own shortcuts. */
export function isBrowserShortcut(e: KeyLike): boolean {
  if (e.code === "F5" || e.code === "BrowserBack" || e.code === "BrowserForward" || e.code === "BrowserRefresh") return true;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && WITH_MODIFIER.has(e.code)) return true;
  if (mod && e.shiftKey && e.code === "KeyI") return true; // devtools
  return e.altKey && !mod && (e.code === "ArrowLeft" || e.code === "ArrowRight"); // history
}

const TEXT_FIELDS = [
  "textarea",
  '[contenteditable]:not([contenteditable="false"])',
  "input:not([type])",
  ...["text", "search", "email", "url", "number", "password"].map((t) => `input[type="${t}" i]`),
].join(", ");

interface MaybeElement {
  closest?: (selector: string) => unknown;
}

/** Text fields keep their context menu (paste); checkboxes, ranges and buttons do not. */
export function insideTextField(target: EventTarget | null): boolean {
  const closest = (target as MaybeElement | null)?.closest;
  return typeof closest === "function" && closest.call(target, TEXT_FIELDS) != null;
}

export function installNoBrowser(target: Pick<Document, "addEventListener"> = document): void {
  target.addEventListener("contextmenu", (e) => {
    if (!insideTextField(e.target)) e.preventDefault();
  });
  target.addEventListener(
    "keydown",
    (e) => {
      if (isBrowserShortcut(e)) e.preventDefault();
    },
    { capture: true },
  );
  // Ctrl + wheel zooms the page.
  target.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey) e.preventDefault();
    },
    { passive: false },
  );
}
