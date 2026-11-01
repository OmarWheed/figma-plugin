// UI-side analysis: render every file, reject empty output, find duplicates, build previews and the ZIP.
import JSZip from 'jszip';
import {dartIdentifier, slug, uniqueSlug, type Kind, type Note, type Occurrence, type ScanAsset, type ScanResult, type Screen} from './shared';
import {dartColors, dartGradients, dartTextStyles, hex6, type ColorToken, type GradientToken, type TextToken} from './tokens';

const decoder = new TextDecoder();
const LIMIT = {side: 16384, pixels: 32000000};
const SIGNATURE = {svg: 64, image: 32}; // SVGs re-render exactly at any size, so they can be compared more strictly
const THUMB_MAX = 240;

export function fingerprint(bytes: Uint8Array | Uint8ClampedArray) {
  let hash = 2166136261;
  for (let i = 0; i < bytes.length; i++) { hash ^= bytes[i]; hash = Math.imul(hash, 16777619); }
  return `${bytes.length}:${hash >>> 0}`;
}
export const samePixels = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

export function canonicalSvg(source: string) {
  const document = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (document.querySelector('parsererror') || document.documentElement.localName !== 'svg') throw new Error('Invalid SVG');
  if (document.querySelector('image, foreignObject, script')) throw new Error('SVG contains raster or unsupported content');
  document.querySelectorAll('metadata, title, desc').forEach(node => node.remove());
  // Generated paint/clip IDs vary between copies. Preserve their internal references.
  const ids = new Map<string, string>();
  if (!document.querySelector('style')) document.querySelectorAll('[id]').forEach((node, index) => ids.set(node.id, `asset_ref_${index}`));
  const normalize = (element: Element) => {
    const attributes = Array.from(element.attributes).map(a => ({name: a.name, namespace: a.namespaceURI, value: a.value}));
    for (const a of Array.from(element.attributes)) element.removeAttributeNode(a);
    attributes.sort((a, b) => a.name.localeCompare(b.name)).forEach(a => {
      if (['data-name', 'data-node-id', 'aria-labelledby'].includes(a.name)) return;
      let value = a.value;
      if (a.name === 'id') value = ids.get(value) || value;
      if ((a.name === 'href' || a.name === 'xlink:href') && value.startsWith('#')) value = `#${ids.get(value.slice(1)) || value.slice(1)}`;
      value = value.replace(/url\(\s*['"]?#([^\s)'"]+)['"]?\s*\)/g, (_, id: string) => `url(#${ids.get(id) || id})`);
      element.setAttributeNS(a.namespace, a.name, value);
    });
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === 8) child.remove();
      else if (child.nodeType === 3 && !child.textContent?.trim() && !['text', 'tspan', 'textPath'].includes(element.localName)) child.remove();
      else if (child.nodeType === 1) normalize(child as Element);
    }
  };
  normalize(document.documentElement);
  return new XMLSerializer().serializeToString(document.documentElement);
}

const NAMED_COLORS: Record<string, string> = {white: '#FFFFFF', black: '#000000'};
function svgColor(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (NAMED_COLORS[v]) return NAMED_COLORS[v];
  if (/^#[0-9a-f]{6}$/.test(v)) return v.toUpperCase();
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v.slice(1).split('').map(c => c + c).join('')}`.toUpperCase();
  const rgb = v.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  return rgb ? hex6({r: +rgb[1], g: +rgb[2], b: +rgb[3], a: 1}) : null;
}

/** For single-color SVGs: the geometry with its color removed, and that color. Recolored copies share the key. */
export function tintSignature(canonical: string): {key: string; color: string} | null {
  if (/\sstyle="/.test(canonical)) return null;
  const colors = new Set<string>(); let unsupported = false;
  const key = canonical.replace(/\s(fill|stroke|stop-color|flood-color|lighting-color|color)="([^"]*)"/g, (all, attribute: string, value: string) => {
    const v = value.trim().toLowerCase();
    if (!v || v === 'none' || v === 'transparent') return all;
    const color = v.startsWith('url(') ? null : svgColor(v);
    if (!color) { unsupported = true; return all; }
    colors.add(color); return ` ${attribute}="§"`;
  });
  return unsupported || colors.size !== 1 ? null : {key, color: [...colors][0]};
}

// ---------- Rendering ----------
type Decoded = {source: CanvasImageSource; width: number; height: number; close: () => void};
const blobOf = (bytes: Uint8Array, kind: Kind) => new Blob([bytes as unknown as BlobPart], {type: kind === 'svg' ? 'image/svg+xml' : 'image/png'});

async function decode(bytes: Uint8Array, kind: Kind): Promise<Decoded> {
  const blob = blobOf(bytes, kind);
  if (kind === 'image' && typeof createImageBitmap === 'function') {
    try { const bitmap = await createImageBitmap(blob); return {source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close()}; }
    catch { /* fall back to <img> */ }
  }
  const url = URL.createObjectURL(blob), image = new Image();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve(); image.onerror = () => reject(new Error('Image could not be rendered'));
      timer = setTimeout(() => reject(new Error('Image rendering timed out')), 30000); image.src = url;
    });
  } catch (error) { URL.revokeObjectURL(url); throw error; }
  finally { clearTimeout(timer); image.onload = image.onerror = null; }
  return {source: image, width: Math.ceil(image.naturalWidth), height: Math.ceil(image.naturalHeight), close: () => URL.revokeObjectURL(url)};
}

function context(width: number, height: number) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', {willReadFrequently: true});
  if (!ctx) throw new Error('Canvas unavailable');
  return {canvas, ctx, release: () => { canvas.width = canvas.height = 0; }};
}

function checkLimits(width: number, height: number) {
  if (!width || !height) throw new Error('Zero-size asset');
  if (width > LIMIT.side || height > LIMIT.side || width * height > LIMIT.pixels) throw new Error('Asset exceeds the 32-megapixel validation limit');
}

/** Full-resolution RGBA with transparent pixels zeroed, so encoder differences do not affect comparisons. */
function readPixels(source: CanvasImageSource, width: number, height: number) {
  const {ctx, release} = context(width, height);
  try {
    ctx.drawImage(source, 0, 0);
    const pixels = ctx.getImageData(0, 0, width, height).data;
    let painted = false;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3]) painted = true;
      else pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
    }
    return {width, height, pixels, painted};
  } finally { release(); }
}

export async function renderPixels(bytes: Uint8Array, type: Kind) {
  const decoded = await decode(bytes, type);
  try { checkLimits(decoded.width, decoded.height); return readPixels(decoded.source, decoded.width, decoded.height); }
  finally { decoded.close(); }
}

/** Small premultiplied RGBA fingerprint used to recognise the same artwork at another size. */
function signature(source: CanvasImageSource, size: number) {
  const {ctx, release} = context(size, size);
  try {
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    let luminance = 0, alpha = 0, transparent = false;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 250) transparent = true;
      data[i] = data[i] * a / 255; data[i + 1] = data[i + 1] * a / 255; data[i + 2] = data[i + 2] * a / 255;
      luminance += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]; alpha += a;
    }
    const coarse = new Float32Array(8 * 8 * 4), cell = size / 8;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4, to = ((Math.floor(y / cell) * 8) + Math.floor(x / cell)) * 4;
      for (let c = 0; c < 4; c++) coarse[to + c] += data[from + c] / (cell * cell);
    }
    return {data, coarse, luminance: alpha ? luminance / alpha : 0, transparent};
  } finally { release(); }
}

function compareSignatures(a: Uint8ClampedArray, b: Uint8ClampedArray, far: number) {
  let sum = 0, farCount = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3]));
    sum += d; if (d > far) farCount++;
  }
  const n = a.length / 4;
  return {mean: sum / n, far: farCount / n};
}

async function thumbnail(raw: ScanAsset, decoded: Decoded): Promise<string> {
  const scale = THUMB_MAX / Math.max(decoded.width, decoded.height);
  if (raw.kind === 'svg' || scale >= 1) return URL.createObjectURL(blobOf(raw.bytes, raw.kind));
  const width = Math.max(1, Math.round(decoded.width * scale)), height = Math.max(1, Math.round(decoded.height * scale));
  const {canvas, ctx, release} = context(width, height);
  try {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(decoded.source, 0, 0, width, height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', 0.86));
    return URL.createObjectURL(blob ?? blobOf(raw.bytes, raw.kind));
  } finally { release(); }
}

export type Analyzed = {
  key: string; index: number; kind: Kind; raw: ScanAsset;
  status: 'ok' | 'empty' | 'failed'; error?: string;
  width: number; height: number; size: number;
  canonical?: string; tintKey?: string; tint?: string; pixelKey?: string; duplicateOf?: string;
  sig?: Uint8ClampedArray; coarse?: Float32Array; luminance: number; transparent: boolean; thumb?: string;
};

async function inspect(item: Analyzed) {
  const {raw} = item;
  try {
    if (raw.kind === 'svg') {
      item.canonical = canonicalSvg(decoder.decode(raw.bytes));
      const tint = tintSignature(item.canonical);
      if (tint) { item.tintKey = tint.key; item.tint = tint.color; }
    }
    const decoded = await decode(raw.bytes, raw.kind);
    try {
      checkLimits(decoded.width, decoded.height);
      item.width = decoded.width; item.height = decoded.height;
      const pixels = readPixels(decoded.source, decoded.width, decoded.height);
      if (!pixels.painted) { item.status = 'empty'; return; }
      if (raw.kind === 'image') item.pixelKey = `${pixels.width}x${pixels.height}:${fingerprint(pixels.pixels)}`;
      const sig = signature(decoded.source, SIGNATURE[raw.kind]);
      item.sig = sig.data; item.coarse = sig.coarse; item.luminance = sig.luminance; item.transparent = sig.transparent;
      item.thumb = await thumbnail(raw, decoded);
      item.status = 'ok';
    } finally { decoded.close(); }
  } catch (error) { item.status = 'failed'; item.error = error instanceof Error ? error.message : String(error); }
}

const yieldToUi = () => new Promise<void>(resolve => { const channel = new MessageChannel(); channel.port1.onmessage = () => resolve(); channel.port2.postMessage(null); });

/** Renders every asset once (4 in parallel), then marks exact duplicates. Grouping is a separate, instant step. */
export async function analyzeScan(scan: ScanResult, onProgress: (done: number, total: number) => void = () => {}): Promise<Analyzed[]> {
  const items: Analyzed[] = scan.assets.map((raw, index) => ({key: raw.key, index, kind: raw.kind, raw, status: 'failed', width: 0, height: 0,
    size: raw.bytes.byteLength, luminance: 0, transparent: true}));
  let next = 0, done = 0, lastYield = performance.now();
  await Promise.all(Array.from({length: Math.min(4, items.length)}, async () => {
    while (next < items.length) {
      await inspect(items[next++]);
      onProgress(++done, items.length);
      if (performance.now() - lastYield > 16) { await yieldToUi(); lastYield = performance.now(); }
    }
  }));
  const svgIndex = new Map<string, Analyzed>(), imageIndex = new Map<string, Analyzed[]>();
  for (const item of items) {
    if (item.status !== 'ok') continue;
    if (item.canonical !== undefined) {
      const previous = svgIndex.get(item.canonical);
      if (previous) item.duplicateOf = previous.key; else svgIndex.set(item.canonical, item);
      continue;
    }
    const candidates = imageIndex.get(item.pixelKey!) ?? [];
    // Equal hashes are confirmed pixel by pixel; only two decoded images are alive at a time.
    for (const previous of candidates) {
      const [a, b] = await Promise.all([renderPixels(previous.raw.bytes, 'image'), renderPixels(item.raw.bytes, 'image')]);
      if (samePixels(a.pixels, b.pixels)) { item.duplicateOf = previous.key; break; }
    }
    if (!item.duplicateOf) imageIndex.set(item.pixelKey!, [...candidates, item]);
  }
  return items;
}

export function revokeAnalysis(items: Analyzed[]) {
  for (const item of items) if (item.thumb) URL.revokeObjectURL(item.thumb);
}

export const EMPTY_REASON = 'Fully transparent / empty output';
/** Report entries for files that were rendered but cannot be exported. */
export function analysisNotes(items: Analyzed[]): Note[] {
  return items.filter(i => i.status !== 'ok').map(i => ({nodeId: i.raw.figmaNodeId, name: i.raw.layerName,
    reason: i.status === 'empty' ? EMPTY_REASON : `Validation failed: ${i.error}`}));
}

/** True when two renders are the same artwork, possibly at a different size. Thresholds were calibrated in Chrome. */
export function looksSame(a: Analyzed, b: Analyzed): boolean {
  if (a.kind !== b.kind || !a.sig || !b.sig || !a.coarse || !b.coarse || !a.height || !b.height) return false;
  if (Math.abs((a.width / a.height) / (b.width / b.height) - 1) > 0.02) return false;
  const svg = a.kind === 'svg';
  let coarse = 0;
  for (let i = 0; i < a.coarse.length; i++) coarse += Math.abs(a.coarse[i] - b.coarse[i]);
  if (coarse / a.coarse.length > (svg ? 4 : 10)) return false;
  const {mean, far} = compareSignatures(a.sig, b.sig, svg ? 64 : 48);
  return svg ? mean <= 2 && far <= 0.001 : mean <= 6 && far <= 0.01;
}

// ---------- Grouping ----------
export type Relation = 'primary' | 'exact' | 'tint' | 'similar';
export type AssetGroup = {
  /** Stable across rescans: the first layer's Figma node id. */
  id: string; kind: Kind;
  /** File source: the largest render for PNGs, the first occurrence for SVGs. */
  primary: Analyzed;
  /** First in design order: provides the suggested name. */
  first: Analyzed;
  members: {item: Analyzed; relation: Relation}[];
  occurrences: Occurrence[]; tints: string[];
};

export function groupAssets(items: Analyzed[], options: {mergeTints: boolean; mergeSimilar: boolean}): AssetGroup[] {
  const ok = items.filter(i => i.status === 'ok');
  const clusters = new Map<string, {items: {item: Analyzed; relation: Relation}[]}>();
  const owner = new Map<string, string>(); // item key → cluster key
  for (const item of ok) {
    if (item.duplicateOf && clusters.has(owner.get(item.duplicateOf)!)) {
      const target = owner.get(item.duplicateOf)!;
      clusters.get(target)!.items.push({item, relation: 'exact'}); owner.set(item.key, target);
    } else { clusters.set(item.key, {items: [{item, relation: 'primary'}]}); owner.set(item.key, item.key); }
  }
  const merge = (into: string, from: string, relation: Relation) => {
    const target = clusters.get(into)!, source = clusters.get(from)!;
    for (const member of source.items) { target.items.push({item: member.item, relation: member.relation === 'primary' ? relation : member.relation}); owner.set(member.item.key, into); }
    clusters.delete(from);
  };
  if (options.mergeTints) {
    const byShape = new Map<string, string>();
    for (const [key, cluster] of [...clusters]) {
      const lead = cluster.items[0].item;
      if (!lead.tintKey) continue;
      const existing = byShape.get(lead.tintKey);
      if (existing) merge(existing, key, 'tint'); else byShape.set(lead.tintKey, key);
    }
  }
  if (options.mergeSimilar) {
    const keys = [...clusters.keys()];
    for (let i = 0; i < keys.length; i++) {
      if (!clusters.has(keys[i])) continue;
      for (let j = i + 1; j < keys.length; j++) {
        if (!clusters.has(keys[j])) continue;
        if (looksSame(clusters.get(keys[i])!.items[0].item, clusters.get(keys[j])!.items[0].item)) merge(keys[i], keys[j], 'similar');
      }
    }
  }
  const groups = [...clusters.values()].map(cluster => {
    const members = cluster.items.sort((a, b) => a.item.index - b.item.index);
    const first = members[0].item;
    const primary = first.kind === 'image'
      ? members.reduce((best, m) => m.relation !== 'tint' && m.item.width * m.item.height > best.width * best.height ? m.item : best, first)
      : first;
    const tints = [...new Set(members.map(m => m.item.tint).filter((t): t is string => !!t))];
    const tinted = members.some(m => m.relation === 'tint');
    const occurrences = members.flatMap(({item}) => item.raw.occurrences.map(o => ({
      ...o,
      ...(tinted && item.tint ? {tint: item.tint} : {}),
      ...(item.width !== primary.width || item.height !== primary.height ? {width: item.width, height: item.height} : {})
    })));
    return {id: first.raw.figmaNodeId, kind: first.kind, primary, first, members, occurrences, tints: tinted ? tints : []};
  });
  return groups.sort((a, b) => a.first.index - b.first.index);
}

export function mergeStats(groups: AssetGroup[]) {
  let tint = 0, similar = 0, occurrences = 0;
  for (const g of groups) {
    occurrences += g.occurrences.length;
    for (const m of g.members) { if (m.relation === 'tint') tint++; if (m.relation === 'similar') similar++; }
  }
  return {files: groups.length, occurrences, tint, similar, exact: occurrences - groups.length - tint - similar};
}

/** Unique snake_case file names; user renames win, then design order. */
export function assignNames(groups: AssetGroup[], renames: Map<string, string>): Map<string, string> {
  const used = new Set<string>(), names = new Map<string, string>();
  for (const g of groups) { const rename = renames.get(`a:${g.id}`); if (rename) names.set(g.id, uniqueSlug(slug(rename), used)); }
  for (const g of groups) if (!names.has(g.id)) names.set(g.id, uniqueSlug(slug(g.first.raw.name || g.first.raw.layerName), used));
  return names;
}

export const categoryOf = (g: AssetGroup) => g.kind === 'image' ? 'image' : Math.max(g.primary.width, g.primary.height) <= 64 ? 'icon' : 'illustration';
export const assetPath = (kind: Kind, name: string, scale = 1) =>
  kind === 'svg' ? `assets/icons/${name}.svg` : `assets/images/${scale > 1 ? `${scale}.0x/` : ''}${name}.png`;

// ---------- Export ----------
export type ManifestEntry = {
  id: string; dartName: string; name: string; type: Kind; category: string; path: string; variants: string[];
  width: number; height: number; figmaNodeId: string; screen: string; screenNodeId: string; usage: string; uses: number;
  occurrences: Occurrence[]; tintable?: boolean; tints?: string[]; notes?: string[];
};

export function manifestEntries(groups: AssetGroup[], names: Map<string, string>, variants: Map<string, Map<number, Uint8Array>>, scales: number[]): ManifestEntry[] {
  const used = new Set<string>();
  return groups.map(g => {
    const name = names.get(g.id)!, available = variants.get(g.primary.key);
    const notes = [...new Set(g.members.map(m => m.item.raw.reason).filter((r): r is string => !!r))];
    return {
      id: name, dartName: dartIdentifier(name, used, 'asset'), name: g.first.raw.layerName, type: g.kind, category: categoryOf(g),
      path: assetPath(g.kind, name),
      variants: g.kind === 'image' ? scales.filter(s => s > 1 && available?.has(s)).map(s => assetPath('image', name, s)) : [],
      width: g.primary.width, height: g.primary.height,
      figmaNodeId: g.first.raw.figmaNodeId, screen: g.first.raw.screen, screenNodeId: g.first.raw.screenNodeId, usage: g.first.raw.layerName,
      uses: g.occurrences.length, occurrences: g.occurrences,
      ...(g.tints.length ? {tintable: true, tints: g.tints} : {}),
      ...(notes.length ? {notes} : {})
    };
  });
}

export function dartAssets(entries: Pick<ManifestEntry, 'dartName' | 'path' | 'type' | 'width' | 'height' | 'uses' | 'tintable'>[]) {
  const lines = entries.map(e => `  /// ${e.type === 'svg' ? `SVG${e.tintable ? ', tintable with colorFilter' : ''}` : 'PNG'} · ${e.width}×${e.height} · used ${e.uses}×\n  static const String ${e.dartName} = '${e.path}';`);
  return `// Generated by Flutter Assets Exporter. Do not edit by hand.\n// SVG: SvgPicture.asset(AppAssets.name) from package:flutter_svg. PNG: Image.asset(AppAssets.name).\nabstract final class AppAssets {\n${lines.join('\n\n')}\n}\n`;
}

export type ExportInput = {
  scan: ScanResult; groups: AssetGroup[]; names: Map<string, string>;
  variants: Map<string, Map<number, Uint8Array>>; scales: number[];
  colors: ColorToken[]; gradients: GradientToken[]; textStyles: TextToken[];
  notes: Note[]; excludedAssets: {id: string; path: string}[];
};

function pubspecSnippet(entries: ManifestEntry[], textStyles: TextToken[]) {
  const svg = entries.some(e => e.type === 'svg'), png = entries.some(e => e.type === 'image');
  const fonts = new Map<string, Set<string>>();
  for (const t of textStyles) fonts.set(t.fontFamily, (fonts.get(t.fontFamily) ?? new Set()).add(`${t.fontWeight}${t.italic ? ' italic' : ''}`));
  const lines = ['# Merge into your pubspec.yaml. Flutter picks the 2.0x/3.0x PNG variants automatically.'];
  if (svg) lines.push('dependencies:', '  flutter_svg: ^2.0.0', '');
  lines.push('flutter:');
  if (svg || png) lines.push('  assets:', ...(svg ? ['    - assets/icons/'] : []), ...(png ? ['    - assets/images/'] : []));
  if (fonts.size) {
    lines.push('  # Fonts used in the design. Add the font files to your project, then uncomment:', '  # fonts:');
    for (const [family, variants] of fonts) {
      lines.push(`  #   - family: ${family}`, '  #     fonts:');
      for (const variant of [...variants].sort()) {
        const [weight, italic] = variant.split(' ');
        lines.push(`  #       - asset: assets/fonts/${family.replace(/\s+/g, '')}-${weight}${italic ? 'Italic' : ''}.ttf`, `  #         weight: ${weight}`, ...(italic ? ['  #         style: italic'] : []));
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

const README = `Flutter Assets Exporter output

- assets/icons/*.svg: vector artwork. Use SvgPicture.asset(AppAssets.name) from package:flutter_svg.
- assets/images/*.png: bitmaps at 1x, with 2.0x/ and 3.0x/ variants that Flutter selects by screen density.
- lib/generated/: AppAssets, AppColors, AppGradients and AppTextStyles constants.
- tokens/: colors, gradients, typography and fonts as JSON. Font files are not included.
- metadata/assets_manifest.json: every file with all of its Figma occurrences. Assets marked "tintable" are one
  single-color SVG used in several colors: apply the occurrence's "tint" with
  colorFilter: ColorFilter.mode(color, BlendMode.srcIn).
- metadata/screen_mapping.json: which assets each screen uses.
- metadata/export_report.json: duplicates removed, merges, skipped layers and failures with reasons.
- metadata/pubspec_snippet.yaml: the pubspec entries these files need.

Every file was rendered before export: empty output is removed. Duplicates are removed by exact SVG structure and exact pixels;
recolored icons and identical artwork at another size are merged unless those options were turned off.
`;

export function buildZip(input: ExportInput) {
  const {scan, groups, names, variants, scales, colors, gradients, textStyles} = input;
  const zip = new JSZip();
  const entries = manifestEntries(groups, names, variants, scales);
  const stored = {compression: 'STORE' as const}; // PNGs are already compressed; deflating them again only costs time
  groups.forEach((g, index) => {
    const entry = entries[index];
    zip.file(entry.path, g.primary.raw.bytes, g.kind === 'image' ? stored : undefined);
    if (g.kind === 'image') for (const scale of scales) {
      const bytes = variants.get(g.primary.key)?.get(scale);
      if (scale > 1 && bytes) zip.file(assetPath('image', entry.id, scale), bytes, stored);
    }
  });
  const json = (path: string, value: unknown) => zip.file(path, JSON.stringify(value, null, 2));
  const screens: Screen[] = scan.screens;
  json('metadata/assets_manifest.json', {version: 3, generator: 'Flutter Assets Exporter', exportedAt: new Date().toISOString(), screens, assets: entries});
  json('metadata/screen_mapping.json', {screens: screens.map(screen => ({
    screen: screen.name, figmaNodeId: screen.figmaNodeId,
    assets: entries.filter(a => a.occurrences.some(o => o.screenNodeId === screen.figmaNodeId)).map(a => {
      const here = a.occurrences.filter(o => o.screenNodeId === screen.figmaNodeId);
      return {id: a.id, dartName: a.dartName, path: a.path, usage: a.usage, figmaNodeIds: here.map(o => o.figmaNodeId), uses: here.length,
        ...(a.tintable ? {tints: [...new Set(here.map(o => o.tint).filter(Boolean))]} : {})};
    })
  }))});
  const stats = mergeStats(groups);
  json('metadata/export_report.json', {
    summary: {files: stats.files, layers: stats.occurrences, exactDuplicatesRemoved: stats.exact, recoloredMerged: stats.tint, similarMerged: stats.similar,
      emptyRemoved: input.notes.filter(n => n.reason === EMPTY_REASON).length, excludedByUser: input.excludedAssets.length},
    excludedByUser: input.excludedAssets, skipped: input.notes
  });
  json('tokens/colors.json', {colors: colors.map(c => ({name: c.name, hex: c.hex, alpha: c.a, argb: c.argb, uses: c.uses,
    ...(c.figmaName ? {figmaName: c.figmaName} : {}), ...(c.aliases.length ? {mergedSimilar: c.aliases} : {})}))});
  json('tokens/gradients.json', {gradients: gradients.map(g => ({name: g.name, type: g.type, ...(g.figmaName ? {figmaName: g.figmaName} : {}),
    stops: g.stops.map(s => ({hex: hex6(s), alpha: s.a, position: s.position})), begin: g.begin, end: g.end, center: g.center, radius: g.radius, css: g.css, uses: g.uses}))});
  json('tokens/typography.json', {typography: textStyles.map(t => ({name: t.name, fontFamily: t.fontFamily, fontStyle: t.fontStyle, fontWeight: t.fontWeight,
    italic: t.italic, fontSize: t.fontSize, lineHeight: t.lineHeight, height: t.height, letterSpacing: t.letterSpacing, uses: t.uses,
    ...(t.figmaName ? {figmaName: t.figmaName} : {})}))});
  json('tokens/fonts.json', {fonts: scan.fonts});
  zip.file('lib/generated/app_assets.dart', dartAssets(entries));
  zip.file('lib/generated/app_colors.dart', dartColors(colors));
  const gradientDart = dartGradients(gradients); if (gradientDart) zip.file('lib/generated/app_gradients.dart', gradientDart);
  const textDart = dartTextStyles(textStyles); if (textDart) zip.file('lib/generated/app_text_styles.dart', textDart);
  zip.file('metadata/pubspec_snippet.yaml', pubspecSnippet(entries, textStyles));
  zip.file('metadata/README.md', README);
  return zip;
}
