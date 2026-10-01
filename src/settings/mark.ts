// A small static Buddy for the settings footer: the same superellipse body and
// pill eyes as the app icon (scripts/gen-icons.mjs), in the app colour.

const NS = "http://www.w3.org/2000/svg";

/** Closed SVG path of |x/rx|^n + |y/ry|^n = 1 around (cx, cy). */
export function superellipsePath(cx: number, cy: number, rx: number, ry: number, n: number, steps = 48): string {
  const pts: string[] = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const x = cx + rx * Math.sign(c) * Math.abs(c) ** (2 / n);
    const y = cy + ry * Math.sign(s) * Math.abs(s) ** (2 / n);
    pts.push(`${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return `M${pts.join("L")}Z`;
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

export function buddyMark(size = 18): SVGSVGElement {
  const svg = el("svg", { viewBox: "0 0 24 24", width: size, height: size, class: "mark", "aria-hidden": "true" });
  const grad = el("linearGradient", { id: "buddy-body", x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.append(el("stop", { offset: "0", "stop-color": "#67e8f9" }), el("stop", { offset: "1", "stop-color": "#0ea5c4" }));
  const defs = el("defs", {});
  defs.append(grad);
  // Body: R = 8.2, rx = 1.14 R, ry = 0.88 R like the icon; eyes as in BotEngine (yaw 0.37, pitch -0.12).
  const R = 8.2;
  const body = el("path", { d: superellipsePath(12, 12.5, R * 1.14, R * 0.88, 2.7), fill: "url(#buddy-body)" });
  const eye = (x: number) => el("rect", { x: x - R * 0.115, y: 12.5 + R * 0.105 - R * 0.135, width: R * 0.23, height: R * 0.27, rx: R * 0.115, fill: "#0b1a1f" });
  const ex = R * 0.41;
  svg.append(defs, body, eye(12 - ex), eye(12 + ex));
  return svg;
}
