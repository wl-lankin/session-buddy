// The windows are an app, not a browser: no WebView context menu (Back, Reload,
// Print, ...) and no reload, print, save, find, zoom, history, devtools or new
// window shortcuts.

export interface KeyLike {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  getModifierState?: (key: string) => boolean;
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

export interface ShortcutContext {
  /** macOS: shortcuts use Cmd (metaKey) only; elsewhere Ctrl (ctrlKey) only. Default: the current platform. */
  mac?: boolean;
  /** The key goes to a text field: Option/Alt + arrows are word navigation there, not history. */
  inTextField?: boolean;
}

function onMac(): boolean {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.platform ?? "");
}

/** True for the browser's own shortcuts. */
export function isBrowserShortcut(e: KeyLike, ctx: ShortcutContext = {}): boolean {
  if (e.code === "F5" || e.code === "BrowserBack" || e.code === "BrowserForward" || e.code === "BrowserRefresh") return true;
  const mac = ctx.mac ?? onMac();
  // AltGr arrives as Ctrl+Alt on Windows (AltGr+0 is "}" on a German keyboard): never a shortcut.
  const altGr = e.altKey || e.getModifierState?.("AltGraph") === true;
  const mod = (mac ? e.metaKey : e.ctrlKey) && !altGr;
  if (mod && WITH_MODIFIER.has(e.code)) return true;
  if (mod && e.shiftKey && e.code === "KeyI") return true; // devtools
  // macOS devtools is Cmd+Option+I.
  if (mac && e.metaKey && e.altKey && e.code === "KeyI") return true;
  // history
  return !ctx.inTextField && e.altKey && !e.ctrlKey && !e.metaKey && (e.code === "ArrowLeft" || e.code === "ArrowRight");
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
      if (isBrowserShortcut(e, { inTextField: insideTextField(e.target) })) e.preventDefault();
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
