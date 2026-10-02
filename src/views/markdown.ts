// A very small Markdown renderer: headings, list items, fenced code, inline `code`,
// **bold** and http(s) links. Everything is text nodes: no HTML is ever parsed, and
// a link only ever opens through the open_link bridge command.

import { Bridge } from "../core/bridge";
import { h } from "./dom";

export interface MarkdownOptions {
  /** Fenced code gets a header with the language and a copy button. */
  copy?: boolean;
}

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>()\[\]]+)/;

/** A link in the source text: `[text](url)` or a bare http(s) URL (without the punctuation that ends a sentence). */
export function parseLink(part: string): { text: string; url: string; rest: string } | null {
  const named = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
  if (named) return { text: named[1], url: named[2], rest: "" };
  if (!/^https?:\/\/\S+$/.test(part)) return null;
  const url = part.replace(/[.,;:!?'"]+$/, "");
  if (!/^https?:\/\/[^\s/]+/.test(url)) return null;
  return { text: url, url, rest: part.slice(url.length) };
}

function link(text: string, url: string): HTMLElement {
  return h("a", {
    class: "md-link",
    href: url,
    title: url,
    onclick: (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      void Bridge.openLink(url);
    },
  }, text);
}

function inline(text: string): Node[] {
  return text
    .split(INLINE)
    .filter(Boolean)
    .flatMap((part): Node[] => {
      if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) return [h("code", { class: "md-code-inline", text: part.slice(1, -1) })];
      if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) return [h("strong", { text: part.slice(2, -2) })];
      const l = parseLink(part);
      if (l) return [link(l.text, l.url), ...(l.rest ? [document.createTextNode(l.rest)] : [])];
      return [document.createTextNode(part)];
    });
}

/** Copies text; falls back to a hidden textarea where the async clipboard is not allowed. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const box = h("textarea", { style: "position:fixed;opacity:0;pointer-events:none" });
    box.value = text;
    document.body.append(box);
    box.select();
    const ok = document.execCommand("copy");
    box.remove();
    return ok;
  }
}

function codeBlock(lines: string[], lang: string, copy: boolean): Node {
  const body = lines.join("\n");
  const pre = h("pre", { class: "md-code", text: body });
  if (!copy) return pre;
  const button = h("button", {
    class: "md-copy",
    text: "Copy",
    title: "Copy the code",
    onclick: (e: Event) => {
      e.stopPropagation();
      void copyText(body).then((ok) => {
        button.textContent = ok ? "Copied" : "Failed";
        button.classList.toggle("done", ok);
        window.setTimeout(() => {
          button.textContent = "Copy";
          button.classList.remove("done");
        }, 1400);
      });
    },
  });
  return h("div", { class: "md-block" }, h("div", { class: "md-block-head" }, h("span", { class: "md-lang", text: lang }), button), pre);
}

export function renderMarkdown(text: string, opts: MarkdownOptions = {}): Node[] {
  const out: Node[] = [];
  let code: string[] | null = null;
  let lang = "";
  const flushCode = () => {
    if (code) out.push(codeBlock(code, lang, opts.copy === true));
    code = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const fence = /^\s*```\s*([\w+#.-]*)/.exec(raw);
    if (fence) {
      if (code) flushCode();
      else {
        code = [];
        lang = fence[1];
      }
      continue;
    }
    if (code) {
      code.push(raw);
      continue;
    }
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      out.push(h("div", { class: `md-h md-h${Math.min(3, heading[1].length)}` }, ...inline(heading[2])));
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      const depth = Math.min(3, Math.floor(item[1].replace(/\t/g, "  ").length / 2));
      const ordered = /\d/.test(item[2]);
      out.push(
        h(
          "div",
          { class: "md-li", style: `padding-left:${depth * 14}px` },
          h("span", { class: "md-bullet", text: ordered ? item[2] : "•" }),
          h("span", { class: "md-li-text" }, ...inline(item[3])),
        ),
      );
      continue;
    }
    out.push(h("p", { class: "md-p" }, ...inline(line.trim())));
  }
  flushCode();
  return out;
}
