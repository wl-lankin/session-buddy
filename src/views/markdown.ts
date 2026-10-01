// A very small Markdown renderer for plans: headings, list items, fenced code,
// inline `code` and **bold**. Everything is text nodes: no HTML is ever parsed.

import { h } from "./dom";

function inline(text: string): Node[] {
  return text
    .split(/(`[^`]+`|\*\*[^*]+\*\*)/)
    .filter(Boolean)
    .map((part) => {
      if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) return h("code", { class: "md-code-inline", text: part.slice(1, -1) });
      if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) return h("strong", { text: part.slice(2, -2) });
      return document.createTextNode(part);
    });
}

export function renderMarkdown(text: string): Node[] {
  const out: Node[] = [];
  let code: string[] | null = null;
  const flushCode = () => {
    if (code) out.push(h("pre", { class: "md-code", text: code.join("\n") }));
    code = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) {
      if (code) flushCode();
      else code = [];
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
