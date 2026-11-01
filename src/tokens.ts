// Design tokens: palette, gradients and text styles, plus their Dart code.
import {camelCase, dartIdentifier, type GradientType, type RawColor, type RawGradient, type RawTextStyle, type RGBA8} from './shared';

export type Lab = [number, number, number];
export type ColorToken = RGBA8 & {
  id: string; name: string; figmaName?: string; hex: string; argb: string; css: string;
  uses: number; nodeIds: string[]; aliases: string[];
};
export type Point = {x: number; y: number};
export type GradientToken = {
  id: string; name: string; figmaName?: string; type: GradientType;
  stops: (RGBA8 & {position: number})[]; begin: Point; end: Point; center: Point; radius: Point;
  css: string; uses: number; nodeIds: string[];
};
export type TextToken = {
  id: string; name: string; figmaName?: string; fontFamily: string; fontStyle: string; fontWeight: number; italic: boolean;
  fontSize: number; lineHeight: string; height: number | null; letterSpacing: number; uses: number; nodeIds: string[];
};

const hex2 = (v: number) => Math.round(v).toString(16).padStart(2, '0').toUpperCase();
export const alphaByte = (a: number) => Math.round(Math.max(0, Math.min(1, a)) * 255);
export const hex6 = (c: RGBA8) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
export const argbHex = (c: RGBA8) => `0x${hex2(alphaByte(c.a))}${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
export const cssColor = (c: RGBA8) => c.a >= 1 ? hex6(c) : `rgba(${c.r}, ${c.g}, ${c.b}, ${+c.a.toFixed(3)})`;
const round = (n: number, digits = 4) => +n.toFixed(digits);

// ---------- Color science ----------
const linear = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };

/** sRGB → CIE L*a*b* (D65). */
export function toLab(c: RGBA8): Lab {
  const r = linear(c.r), g = linear(c.g), b = linear(c.b);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
  const z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => t > 216 / 24389 ? Math.cbrt(t) : t * 841 / 108 + 4 / 29;
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIEDE2000 color difference. Values below ~1 are imperceptible. */
export function deltaE2000([l1, a1, b1]: Lab, [l2, a2, b2]: Lab): number {
  const rad = Math.PI / 180, deg = 180 / Math.PI, p7 = 25 ** 7;
  const cBar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + p7)));
  const a1p = (1 + g) * a1, a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1), c2p = Math.hypot(a2p, b2);
  const hue = (b: number, a: number) => { if (!a && !b) return 0; const h = Math.atan2(b, a) * deg; return h < 0 ? h + 360 : h; };
  const h1p = hue(b1, a1p), h2p = hue(b2, a2p);
  let dhp = 0;
  if (c1p * c2p) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
  const dLp = l2 - l1, dCp = c2p - c1p, dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin(dhp * rad / 2);
  const lBar = (l1 + l2) / 2, cBarP = (c1p + c2p) / 2;
  let hBar = h1p + h2p;
  if (c1p * c2p) hBar = Math.abs(h1p - h2p) > 180 ? (h1p + h2p + (h1p + h2p < 360 ? 360 : -360)) / 2 : (h1p + h2p) / 2;
  const t = 1 - 0.17 * Math.cos((hBar - 30) * rad) + 0.24 * Math.cos(2 * hBar * rad) + 0.32 * Math.cos((3 * hBar + 6) * rad) - 0.2 * Math.cos((4 * hBar - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hBar - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(cBarP ** 7 / (cBarP ** 7 + p7));
  const sl = 1 + 0.015 * (lBar - 50) ** 2 / Math.sqrt(20 + (lBar - 50) ** 2);
  const sc = 1 + 0.045 * cBarP, sh = 1 + 0.015 * cBarP * t, rt = -Math.sin(2 * dTheta * rad) * rc;
  return Math.sqrt((dLp / sl) ** 2 + (dCp / sc) ** 2 + (dHp / sh) ** 2 + rt * (dCp / sc) * (dHp / sh));
}

/** sRGB → OKLCH (perceptual lightness 0-1, chroma, hue degrees). */
export function toOklch(c: RGBA8) {
  const r = linear(c.r), g = linear(c.g), b = linear(c.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  const h = Math.atan2(B, A) * 180 / Math.PI;
  return {l: L, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h};
}

const HUES: [string, number][] = [['rose', 12], ['red', 27], ['orange', 50], ['amber', 72], ['yellow', 95], ['lime', 128], ['green', 150],
  ['teal', 182], ['cyan', 212], ['sky', 237], ['blue', 260], ['indigo', 277], ['violet', 293], ['purple', 306], ['fuchsia', 322], ['pink', 350]];
// OKLCH lightness of each step, after Tailwind's neutral and blue scales (chromatic colors are lighter at the same step).
const NEUTRAL_STEPS: [number, number][] = [[50, 0.985], [100, 0.97], [200, 0.922], [300, 0.87], [400, 0.708], [500, 0.556], [600, 0.439], [700, 0.371], [800, 0.269], [900, 0.205], [950, 0.145]];
const CHROMATIC_STEPS: [number, number][] = [[50, 0.97], [100, 0.932], [200, 0.882], [300, 0.809], [400, 0.707], [500, 0.623], [600, 0.546], [700, 0.488], [800, 0.424], [900, 0.379], [950, 0.282]];

function hslSaturation(c: RGBA8) {
  const max = Math.max(c.r, c.g, c.b) / 255, min = Math.min(c.r, c.g, c.b) / 255, l = (max + min) / 2;
  return max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
}

/** Color family used for naming and palette ordering ('gray' for neutrals). */
export function colorFamily(c: RGBA8): string {
  const {c: chroma, h} = toOklch(c);
  if (chroma < 0.02 || (chroma < 0.05 && hslSaturation(c) < 0.25)) return 'gray';
  let best = HUES[0];
  for (const entry of HUES) {
    const distance = (a: number) => Math.min(Math.abs(h - a), 360 - Math.abs(h - a));
    if (distance(entry[1]) < distance(best[1])) best = entry;
  }
  return best[0];
}

/** Tailwind-like name such as `blue600`, `gray100`, `white` or `blackAlpha10`. */
export function generatedColorName(c: RGBA8): string {
  const {l} = toOklch(c), family = colorFamily(c);
  let base: string;
  if (family === 'gray' && l >= 0.995) base = 'white';
  else if (family === 'gray' && l <= 0.05) base = 'black';
  else base = family + (family === 'gray' ? NEUTRAL_STEPS : CHROMATIC_STEPS).reduce((best, step) => Math.abs(step[1] - l) < Math.abs(best[1] - l) ? step : best)[0];
  return c.a < 1 ? `${base}Alpha${Math.round(c.a * 100)}` : base;
}

/** Display order: neutrals light → dark, then hues around the wheel. */
export function paletteOrder<T extends RGBA8>(colors: T[]): T[] {
  const keyed = colors.map(c => {
    const {l, h} = toOklch(c), family = colorFamily(c);
    return {c, gray: family === 'gray' ? 0 : 1, hue: family === 'gray' ? 0 : HUES.findIndex(([name]) => name === family) * 1000 + h, l};
  });
  return keyed.sort((a, b) => a.gray - b.gray || a.hue - b.hue || b.l - a.l).map(k => k.c);
}

// ---------- Tokens ----------
/** Assigns unique Dart names: Figma-named tokens first so they keep their exact names. */
function nameTokens<T extends {id: string; figmaName?: string}>(tokens: T[], generated: (t: T) => string, prefix: string, renames: Map<string, string>, alternate?: (t: T) => string): (T & {name: string})[] {
  const used = new Set<string>(), names = new Map<string, string>();
  const order = [...tokens.filter(t => renames.has(t.id)), ...tokens.filter(t => !renames.has(t.id) && t.figmaName), ...tokens.filter(t => !renames.has(t.id) && !t.figmaName)];
  for (const token of order) {
    const wanted = renames.get(token.id) ?? token.figmaName ?? generated(token);
    if (alternate && used.has(camelCase(wanted)) && !used.has(camelCase(alternate(token)))) names.set(token.id, dartIdentifier(alternate(token), used, prefix, 'V'));
    else names.set(token.id, dartIdentifier(wanted, used, prefix, 'V'));
  }
  return tokens.map(t => ({...t, name: names.get(t.id)!}));
}

/** Unique palette. With `merge`, imperceptibly different colors (ΔE00 ≤ 1, same alpha) collapse into the most used one. */
export function buildPalette(raw: RawColor[], merge: boolean, renames = new Map<string, string>()): ColorToken[] {
  const sorted = [...raw].sort((a, b) => b.uses - a.uses || a.key.localeCompare(b.key));
  const groups: {base: RawColor; lab: Lab; members: RawColor[]; names: Set<string>}[] = [];
  for (const color of sorted) {
    const lab = toLab(color);
    // Two different designer-named tokens are never merged, however close their values are.
    const target = merge ? groups.find(g => Math.abs(g.base.a - color.a) <= 0.02 && deltaE2000(g.lab, lab) <= 1 &&
      (!color.names.length || !g.names.size || color.names.some(n => g.names.has(n)))) : undefined;
    if (target) { target.members.push(color); color.names.forEach(n => target.names.add(n)); }
    else groups.push({base: color, lab, members: [color], names: new Set(color.names)});
  }
  const tokens = groups.map(({base, members, names}) => ({
    id: `c:${base.key}`, r: base.r, g: base.g, b: base.b, a: base.a,
    figmaName: [...names][0], hex: hex6(base), argb: argbHex(base), css: cssColor(base),
    uses: members.reduce((n, m) => n + m.uses, 0),
    nodeIds: [...new Set(members.flatMap(m => m.nodeIds))],
    aliases: members.slice(1).map(m => m.a < 1 ? `${hex6(m)} ${Math.round(m.a * 100)}%` : hex6(m))
  }));
  return nameTokens(tokens, generatedColorName, 'color', renames);
}

/** Gradient handles in normalized node space (0-1), from Figma's gradientTransform. */
export function gradientGeometry(transform: number[][]) {
  const [[a, b, c], [d, e, f]] = transform;
  const det = a * e - b * d;
  if (Math.abs(det) < 1e-9) return {begin: {x: 0, y: 0.5}, end: {x: 1, y: 0.5}, center: {x: 0.5, y: 0.5}, radius: {x: 0.5, y: 0.5}};
  const inverse = (x: number, y: number) => ({x: (e * (x - c) - b * (y - f)) / det, y: (-d * (x - c) + a * (y - f)) / det});
  const center = inverse(0.5, 0.5), xHandle = inverse(1, 0.5), yHandle = inverse(0.5, 1);
  return {
    begin: inverse(0, 0.5), end: inverse(1, 0.5), center,
    radius: {x: Math.hypot(xHandle.x - center.x, xHandle.y - center.y), y: Math.hypot(yHandle.x - center.x, yHandle.y - center.y)}
  };
}

/** CSS approximation used for previews (exact for linear gradients in a square box). */
export function cssGradient(token: Pick<GradientToken, 'type' | 'stops' | 'begin' | 'end' | 'center' | 'radius'>): string {
  const pct = (n: number) => `${round(n * 100, 2)}%`;
  const {type, stops, begin, end, center, radius} = token;
  if (type === 'linear') {
    const dx = end.x - begin.x, dy = end.y - begin.y;
    const angle = Math.atan2(dx, -dy), dir = {x: Math.sin(angle), y: -Math.cos(angle)};
    const length = Math.abs(dir.x) + Math.abs(dir.y);
    const start = {x: 0.5 - dir.x * length / 2, y: 0.5 - dir.y * length / 2};
    const list = stops.map(s => {
      const p = {x: begin.x + dx * s.position, y: begin.y + dy * s.position};
      return `${cssColor(s)} ${pct(((p.x - start.x) * dir.x + (p.y - start.y) * dir.y) / length)}`;
    });
    return `linear-gradient(${round(angle * 180 / Math.PI, 2)}deg, ${list.join(', ')})`;
  }
  if (type === 'angular') {
    // Figma's angular gradient starts at the x handle (the same point as a linear gradient's end).
    const from = Math.atan2(end.x - center.x, -(end.y - center.y)) * 180 / Math.PI;
    return `conic-gradient(from ${round(from, 2)}deg at ${pct(center.x)} ${pct(center.y)}, ${stops.map(s => `${cssColor(s)} ${round(s.position * 360, 2)}deg`).join(', ')})`;
  }
  return `radial-gradient(ellipse ${pct(radius.x)} ${pct(radius.y)} at ${pct(center.x)} ${pct(center.y)}, ${stops.map(s => `${cssColor(s)} ${pct(s.position)}`).join(', ')})`;
}

export function buildGradients(raw: RawGradient[], renames = new Map<string, string>()): GradientToken[] {
  const tokens = [...raw].sort((a, b) => b.uses - a.uses).map(g => {
    const geometry = gradientGeometry(g.transform);
    const token = {id: `g:${g.key}`, figmaName: g.names[0], type: g.type, stops: g.stops, ...geometry, uses: g.uses, nodeIds: g.nodeIds, css: ''};
    token.css = cssGradient(token);
    return token;
  });
  return nameTokens(tokens, t => {
    const first = colorFamily(t.stops[0]), last = colorFamily(t.stops[t.stops.length - 1]);
    const base = first === last ? `${first}Gradient` : `${first}To${last.charAt(0).toUpperCase()}${last.slice(1)}`;
    return t.type === 'linear' ? base : `${base}${t.type.charAt(0).toUpperCase()}${t.type.slice(1)}`;
  }, 'gradient', renames);
}

export function buildTextStyles(raw: RawTextStyle[], renames = new Map<string, string>()): TextToken[] {
  const tokens = [...raw].sort((a, b) => b.uses - a.uses).map(t => {
    const lh = t.lineHeight, ls = t.letterSpacing;
    return {
      id: `t:${t.key}`, figmaName: t.names[0], fontFamily: t.fontFamily, fontStyle: t.fontStyle, fontWeight: t.fontWeight, italic: t.italic, fontSize: t.fontSize,
      lineHeight: lh.unit === 'PIXELS' ? `${lh.value}px` : lh.unit === 'PERCENT' ? `${lh.value}%` : 'AUTO',
      height: lh.unit === 'PIXELS' ? round(lh.value / t.fontSize) : lh.unit === 'PERCENT' ? round(lh.value / 100) : null,
      letterSpacing: round(ls.unit === 'PERCENT' ? ls.value / 100 * t.fontSize : ls.value, 3),
      uses: t.uses, nodeIds: t.nodeIds
    };
  });
  // "15.5" becomes "15p5" so the identifier does not read as size 155.
  const size = (n: number) => String(round(n, 1)).replace('.', 'p');
  return nameTokens(tokens, t => `${t.fontFamily} ${t.fontStyle} ${size(t.fontSize)}`, 'text', renames,
    t => `${t.fontFamily} ${t.fontStyle} ${size(t.fontSize)} ${t.height ? `h${size(t.height * t.fontSize)}` : ''}`);
}

// ---------- Dart ----------
const dartString = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$/g, '\\$')}'`;
const comment = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();
export function dartDouble(n: number): string {
  const text = String(round(n, 4));
  return /[.e]/.test(text) ? text : `${text}.0`;
}
const header = '// Generated by Flutter Assets Exporter. Do not edit by hand.\n';

export function dartColors(colors: ColorToken[]): string {
  const lines = colors.map(c => `  /// ${comment(`${c.hex}${c.a < 1 ? ` at ${Math.round(c.a * 100)}%` : ''} · used ${c.uses}×${c.figmaName ? ` · Figma: ${c.figmaName}` : ''}`)}\n  static const Color ${c.name} = Color(${c.argb});`);
  return `${header}import 'package:flutter/painting.dart';\n\nabstract final class AppColors {\n${lines.join('\n\n')}\n}\n`;
}

/** Linear and radial gradients (angular/diamond stay in tokens/gradients.json). Returns null when none apply. */
export function dartGradients(gradients: GradientToken[]): string | null {
  const align = (p: Point) => `Alignment(${dartDouble(p.x * 2 - 1)}, ${dartDouble(p.y * 2 - 1)})`;
  const lines = gradients.filter(g => g.type === 'linear' || g.type === 'radial').map(g => {
    const colors = g.stops.map(s => `Color(${argbHex(s)})`).join(', '), stops = g.stops.map(s => dartDouble(s.position)).join(', ');
    const doc = `  /// ${comment(`${g.type} gradient · used ${g.uses}×${g.figmaName ? ` · Figma: ${g.figmaName}` : ''}${g.type === 'radial' ? ' · radius is approximate on non-square boxes' : ''}`)}\n`;
    return g.type === 'linear'
      ? `${doc}  static const LinearGradient ${g.name} = LinearGradient(\n    begin: ${align(g.begin)},\n    end: ${align(g.end)},\n    colors: [${colors}],\n    stops: [${stops}],\n  );`
      : `${doc}  static const RadialGradient ${g.name} = RadialGradient(\n    center: ${align(g.center)},\n    radius: ${dartDouble((g.radius.x + g.radius.y) / 2)},\n    colors: [${colors}],\n    stops: [${stops}],\n  );`;
  });
  return lines.length ? `${header}import 'package:flutter/painting.dart';\n\nabstract final class AppGradients {\n${lines.join('\n\n')}\n}\n` : null;
}

export function dartTextStyles(styles: TextToken[]): string | null {
  if (!styles.length) return null;
  const lines = styles.map(t => {
    const props = [`fontFamily: ${dartString(t.fontFamily)}`, `fontSize: ${dartDouble(t.fontSize)}`, `fontWeight: FontWeight.w${Math.min(900, Math.max(100, Math.round(t.fontWeight / 100) * 100))}`];
    if (t.italic) props.push('fontStyle: FontStyle.italic');
    if (t.height !== null) props.push(`height: ${dartDouble(t.height)}`);
    if (t.letterSpacing) props.push(`letterSpacing: ${dartDouble(t.letterSpacing)}`);
    return `  /// ${comment(`${t.fontFamily} ${t.fontStyle} ${t.fontSize}/${t.lineHeight} · ${t.uses} characters${t.figmaName ? ` · Figma: ${t.figmaName}` : ''}`)}\n  static const TextStyle ${t.name} = TextStyle(\n    ${props.join(',\n    ')},\n  );`;
  });
  return `${header}import 'package:flutter/painting.dart';\n\nabstract final class AppTextStyles {\n${lines.join('\n\n')}\n}\n`;
}
