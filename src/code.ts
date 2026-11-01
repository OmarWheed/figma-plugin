import {normalizeSettings, weightFromStyle, slug, type FontUse, type GradientType, type Kind, type Note, type Occurrence, type RawColor, type RawGradient, type RawTextStyle, type ScanAsset, type ScanResult, type Settings} from './shared';

const TEMP_NAME = 'Flutter Assets Exporter (temporary)';
const UI_DEFAULT = {width: 560, height: 720};
const UI_MIN = {width: 380, height: 460};
const UI_MAX = {width: 1600, height: 1400};
const EXPORT_LANES = 6;     // concurrent exportAsync calls while scanning
const VARIANT_LANES = 3;    // concurrent @2x/@3x exports while the user reviews the preview
const MAX_IDS = 200;        // node ids kept per token for "Locate in Figma"
const ICON_BOX = 32;        // frames this small that hold only vectors are icons
const ARTWORK_MAX = 256;    // top-level containers up to this size without text are artwork, not screens
const MAX_VARIANT_SIDE = 8192;

figma.skipInvisibleInstanceChildren = true; // hidden layers are never exported; skipping them speeds up traversal
figma.showUI(__html__, {...UI_DEFAULT, themeColors: true});

// ---------- Node predicates ----------
type Container = SceneNode & ChildrenMixin;
const isContainer = (n: SceneNode): n is Container => 'children' in n;
const isPaintNode = (n: SceneNode): n is SceneNode & MinimalFillsMixin => 'fills' in n;
const hasStrokes = (n: SceneNode): n is SceneNode & MinimalStrokesMixin => 'strokes' in n;
const livePaints = (paints: unknown): Paint[] => Array.isArray(paints) ? (paints as Paint[]).filter(p => p.visible !== false && (p.opacity ?? 1) > 0) : [];
const imageCandidate = (n: SceneNode) => isPaintNode(n) && livePaints(n.fills).some(p => p.type === 'IMAGE' || p.type === 'VIDEO');
const VECTOR_TYPES = ['VECTOR', 'BOOLEAN_OPERATION', 'RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'LINE'];
const vectorSvgCandidate = (n: SceneNode) => VECTOR_TYPES.includes(n.type);
const visible = (n: SceneNode) => n.visible && (!('opacity' in n) || n.opacity > 0);
const isMask = (n: SceneNode) => 'isMask' in n && n.isMask && visible(n);
const hasAutoLayout = (n: SceneNode) => 'layoutMode' in n && n.layoutMode !== 'NONE';
const maxSide = (n: SceneNode) => 'width' in n ? Math.max(n.width, n.height) : 0;
const boxOf = (n: SceneNode) => 'absoluteBoundingBox' in n ? n.absoluteBoundingBox : null;
const words = (name: string) => name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_/\\.\-]+/g, ' ');
const IMAGE_WORDS = /\b(?:photo|image|img|picture|pic|illustration|avatar|thumbnail|thumb|collage|artwork|banner|cover|hero|poster)\b/i;
const ARTWORK_WORDS = /\b(?:icon|ico|ic|svg|symbol|logo|logotype|glyph|emblem|wordmark|brandmark)\b/i;
const hasOwnPaint = (n: SceneNode) => (isPaintNode(n) && livePaints(n.fills).length > 0) || (hasStrokes(n) && livePaints(n.strokes).length > 0) ||
  ('effects' in n && n.effects.some(e => e.visible !== false));

const isSystemIndicator = (n: SceneNode) => {
  const name = n.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return /\b(?:status\s*bar|statusbar|home\s*indicator|homeindicator|bottom\s*(?:navigation\s*)?indicator|navigation\s*indicator|navigationindicator|navigator\s*indicator|navigatorindicator|nav\s*indicator|navindicator|gesture\s*(?:bar|indicator)|system\s*(?:status|navigation)(?:\s*(?:bar|indicator))?)\b/.test(name);
};

type Analysis = {images: boolean; vectors: boolean; text: boolean; system: boolean};
const analysisCache = new Map<string, Analysis>();
function analyze(n: SceneNode): Analysis {
  const cached = analysisCache.get(n.id); if (cached) return cached;
  const children = visible(n) && isContainer(n) ? n.children.map(analyze) : [];
  const result = {
    images: visible(n) && (imageCandidate(n) || children.some(c => c.images)),
    vectors: visible(n) && ((vectorSvgCandidate(n) && !imageCandidate(n)) || children.some(c => c.vectors)),
    text: visible(n) && ((n.type === 'TEXT' && n.characters.trim().length > 0) || children.some(c => c.text)),
    system: visible(n) && (isSystemIndicator(n) || children.some(c => c.system))
  };
  analysisCache.set(n.id, result); return result;
}
const containsImageFill = (n: SceneNode) => analyze(n).images;
const containsSystemUI = (n: SceneNode) => analyze(n).system;

/** Plain rectangles/circles/lines are UI chrome that Flutter draws with Container, DecoratedBox or Divider. */
function isPlainShape(n: SceneNode): boolean {
  if (!['RECTANGLE', 'ELLIPSE', 'LINE'].includes(n.type) || isMask(n)) return false;
  const paints = [...livePaints(isPaintNode(n) ? n.fills : []), ...livePaints(hasStrokes(n) ? n.strokes : [])];
  if (paints.some(p => p.type !== 'SOLID' && p.type !== 'GRADIENT_LINEAR' && p.type !== 'GRADIENT_RADIAL')) return false;
  if ('dashPattern' in n && n.dashPattern.length) return false;
  if ('effects' in n && n.effects.some(e => e.visible !== false && e.type !== 'DROP_SHADOW')) return false;
  if ('rotation' in n && Math.abs(n.rotation % 90) > 0.01) return false;
  if (n.type === 'ELLIPSE') {
    const arc = n.arcData;
    if (arc && (arc.innerRadius > 0 || Math.abs(arc.endingAngle - arc.startingAngle) < Math.PI * 2 - 0.001)) return false;
  }
  return true;
}

/** Siblings that are each a packaged artwork (instance/group/frame) and do not overlap: a row of separate icons, not one icon. */
function separateArtworks(kids: SceneNode[]): boolean {
  if (kids.length < 2 || kids.length > 48 || !kids.every(k => ['INSTANCE', 'GROUP', 'FRAME', 'COMPONENT'].includes(k.type))) return false;
  const boxes = kids.map(boxOf);
  if (boxes.some(b => !b)) return false;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i]!, b = boxes[j]!;
    const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x), h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    if (w > 0.5 && h > 0.5) return false;
  }
  return true;
}

/** Vector-only container that should become one SVG instead of one file per path. */
function isVectorComposition(n: SceneNode): boolean {
  if (!isContainer(n) || n.type === 'BOOLEAN_OPERATION') return false;
  const kids = n.children.filter(c => visible(c) && !isSystemIndicator(c));
  if (!kids.length) return false;
  if (hasAutoLayout(n)) return maxSide(n) <= ICON_BOX; // auto layout is UI structure; only icon-sized boxes stay whole
  if (ARTWORK_WORDS.test(words(n.name))) return true;
  if (separateArtworks(kids)) return false;
  if (['GROUP', 'COMPONENT', 'INSTANCE'].includes(n.type)) return true;
  // Frames: keep multi-part artwork and icon boxes, unwrap plain single-child wrappers.
  return n.type === 'FRAME' && (kids.length > 1 || hasOwnPaint(n) || maxSide(n) <= ICON_BOX);
}

function explicitFormat(n: SceneNode, images: boolean): Kind | null {
  if (!('exportSettings' in n) || !n.exportSettings.length) return null;
  const formats = new Set<string>(n.exportSettings.map(s => s.format));
  if (formats.has('SVG') && !images) return 'svg';
  if (formats.has('PNG') || formats.has('JPG')) return 'image';
  return formats.has('SVG') ? 'svg' : null;
}

function effectTypes(n: SceneNode): string[] {
  const types = new Set<string>(); let budget = 400;
  const walk = (m: SceneNode) => {
    if (budget-- <= 0 || !visible(m)) return;
    if ('effects' in m) for (const e of m.effects) if (e.visible !== false) types.add(e.type);
    if (isContainer(m)) m.children.forEach(walk);
  };
  walk(n); return [...types];
}

// ---------- Bytes ----------
const fingerprint = (bytes: Uint8Array) => {
  let hash = 2166136261;
  for (let i = 0; i < bytes.length; i++) { hash ^= bytes[i]; hash = Math.imul(hash, 16777619); }
  return `${bytes.length}:${hash >>> 0}`;
};
const sameBytes = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
// The plugin sandbox has no TextEncoder.
function encodeUtf8(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    let code = value.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const low = value.charCodeAt(i + 1);
      if (low >= 0xDC00 && low <= 0xDFFF) { code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00); i++; }
      else code = 0xFFFD;
    } else if (code >= 0xDC00 && code <= 0xDFFF) code = 0xFFFD;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F));
    else if (code < 0x10000) bytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
    else bytes.push(0xF0 | (code >> 18), 0x80 | ((code >> 12) & 0x3F), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
  }
  return new Uint8Array(bytes);
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Runs `worker` over `items` with at most `lanes` in flight, preserving nothing but throughput. */
async function pool<T>(items: T[], lanes: number, worker: (item: T) => Promise<void>, stop: () => boolean = () => false) {
  let next = 0;
  await Promise.all(Array.from({length: Math.min(lanes, items.length)}, async () => {
    while (next < items.length && !stop()) await worker(items[next++]);
  }));
}

// ---------- Planning: decide which layers become files, without exporting yet ----------
type Ctx = {root: SceneNode; screen: string; screenNodeId: string};
type Rendered = {kind: Kind; bytes: Uint8Array; width: number; height: number; effects: string[]; reason?: string};
type Job = Ctx & {node: SceneNode; source: SceneNode; kind: Kind; span?: SceneNode[]; fallback?: Container; result?: Rendered; children?: Job[]};
class SkipError extends Error {}

function planner(settings: Settings, note: (n: SceneNode, reason: string) => void) {
  const job = (n: SceneNode, ctx: Ctx, kind: Kind, extra: Partial<Job> = {}): Job[] => [{...ctx, node: n, source: n, kind, ...extra}];

  function visit(n: SceneNode, ctx: Ctx, forced = false): Job[] {
    if (!visible(n)) { note(n, 'Hidden or fully transparent layer'); return []; }
    if (isSystemIndicator(n)) { note(n, 'System status/navigation indicator'); return []; }
    const container = isContainer(n);
    const {images, text} = analyze(n);
    const systemChild = container && n.children.some(containsSystemUI);
    if (!systemChild) {
      const explicit = explicitFormat(n, images);
      if (explicit) return job(n, ctx, explicit); // the designer marked this layer for export
      const layout = hasAutoLayout(n);
      const directMasks = container && n.children.some(isMask);
      // Keep photos, overlays, clipping and masks together without flattening screen layouts.
      const imageComposition = images && (imageCandidate(n) || IMAGE_WORDS.test(words(n.name)) || (!text && !layout));
      if (imageComposition || (directMasks && !text)) return job(n, ctx, images ? 'image' : 'svg');
      if (vectorSvgCandidate(n) && !images) {
        if (!forced && settings.skipShapes && isPlainShape(n)) { note(n, 'Simple shape: build it in Flutter (Container, DecoratedBox or Divider)'); return []; }
        return job(n, ctx, 'svg', container ? {fallback: n} : {});
      }
      if (!images && !text && analyze(n).vectors && isVectorComposition(n)) return job(n, ctx, 'svg', {fallback: n as Container});
      if (forced && !container) return job(n, ctx, 'svg'); // a directly selected text or other leaf layer
    }
    return container ? children(n, ctx) : [];
  }

  function children(parent: Container, ctx: Ctx): Job[] {
    const jobs: Job[] = [];
    const kids = [...parent.children];
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      if (!isMask(child)) { jobs.push(...visit(child, ctx)); continue; }
      // A mask affects following siblings until the next mask. Export that whole span.
      let end = i + 1;
      while (end < kids.length && !isMask(kids[end])) end++;
      const span = kids.slice(i, end);
      if (span.length < 2) note(child, 'Mask has no content');
      else if (span.some(containsSystemUI)) note(child, 'System UI mask span omitted');
      else jobs.push(...job(child, ctx, span.some(containsImageFill) ? 'image' : 'svg', {span}));
      i = end - 1;
    }
    return jobs;
  }

  /** Screens are scanned for assets; small text-free artwork that was selected directly is exported whole. */
  function root(n: SceneNode): Job[] {
    const ctx = {root: n, screen: n.name, screenNodeId: n.id};
    if (!visible(n)) { note(n, 'Hidden or fully transparent layer'); return []; }
    if (isSystemIndicator(n)) { note(n, 'System status/navigation indicator'); return []; }
    const parentType = n.parent?.type;
    const topLevel = !parentType || parentType === 'PAGE' || parentType === 'SECTION';
    const artwork = !analyze(n).text && maxSide(n) <= ARTWORK_MAX;
    if (isContainer(n) && topLevel && !artwork) return children(n, ctx);
    return visit(n, ctx, true);
  }
  return {root, children};
}

// ---------- Exporting ----------
async function render(job: Job, settings: Settings, scale = 1, forcePng = false): Promise<Rendered> {
  let temporary: FrameNode | undefined;
  try {
    let target: SceneNode = job.node;
    if (job.span) {
      temporary = figma.createFrame(); temporary.name = TEMP_NAME;
      temporary.fills = []; temporary.clipsContent = false; temporary.visible = true;
      const copies = job.span.map(original => {
        const copy = original.clone(); temporary!.appendChild(copy);
        copy.relativeTransform = original.relativeTransform; return copy;
      });
      target = figma.group(copies, temporary);
    }
    const bounds = 'absoluteRenderBounds' in target ? target.absoluteRenderBounds : null;
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) throw new SkipError('No visible render bounds');
    const size = {width: Math.round(bounds.width * 100) / 100, height: Math.round(bounds.height * 100) / 100};
    const png = () => target.exportAsync({format: 'PNG', constraint: {type: 'SCALE', value: scale}});
    if (job.kind === 'svg' && !forcePng) {
      const svg = await target.exportAsync({format: 'SVG_STRING', svgIdAttribute: false, svgOutlineText: true});
      const raster = /<(?:image|foreignObject)\b/i.test(svg), filtered = /<filter\b/i.test(svg);
      const effects = filtered ? effectTypes(target) : [];
      if (!raster && !(filtered && settings.effects === 'png')) {
        return {kind: 'svg', bytes: encodeUtf8(svg.trim()), ...size, effects, reason: filtered ? 'Uses SVG filters (shadow/blur) that flutter_svg ignores' : undefined};
      }
      return {kind: 'image', bytes: await png(), ...size, effects,
        reason: raster ? 'Contains bitmap content or background blur, exported as PNG' : 'Shadow/blur kept by exporting PNG (flutter_svg ignores SVG filters)'};
    }
    return {kind: 'image', bytes: await png(), ...size, effects: []};
  } finally { temporary?.remove(); }
}

// ---------- Smart names ----------
const GENERIC_WORDS = new Set(('vector group frame rectangle rect ellipse circle oval polygon triangle star line arrow union subtract intersect ' +
  'intersection exclude difference boolean mask clip path image img picture pic photo bitmap component instance layer shape stroke fill ' +
  'outline container content wrapper wrap box icon icons ic asset assets graphic object art artwork bg background untitled copy item ' +
  'element base placeholder slice section auto layout').split(' '));
function isGenericName(name: string): boolean {
  if (name.includes('=')) return true; // variant property strings such as "State=Default"
  const tokens = name.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-zÀ-ɏЀ-ӿ؀-ۿ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  return !tokens.length || tokens.every(t => GENERIC_WORDS.has(t));
}

async function componentLabel(n: SceneNode): Promise<string | null> {
  let main: ComponentNode | null = null;
  if (n.type === 'INSTANCE') { try { main = await n.getMainComponentAsync(); } catch { main = null; } }
  else if (n.type === 'COMPONENT') main = n;
  if (!main) return null;
  const set = main.parent?.type === 'COMPONENT_SET' ? main.parent : null;
  if (!set) return isGenericName(main.name) ? null : main.name;
  const values = main.name.split(',').map(part => part.split('=')[1]?.trim() ?? '')
    .filter(v => v && !/^(?:default|false|true|off|on|no|yes|none|base|regular)$/i.test(v));
  return isGenericName(set.name) && !values.length ? null : [set.name, ...values].join(' ');
}

/** The closest short text inside the same small container, e.g. "Home" next to a tab icon. */
function nearbyLabel(n: SceneNode, root: SceneNode): string | null {
  const box = boxOf(n); if (!box) return null;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  let parent = n.parent;
  for (let depth = 0; depth < 2 && parent && parent !== root && parent.type !== 'PAGE' && parent.type !== 'DOCUMENT'; depth++, parent = parent.parent) {
    if (!('children' in parent)) break;
    let best: {text: string; distance: number} | null = null, budget = 60;
    const walk = (m: SceneNode, level: number) => {
      if (budget-- <= 0 || m === n || !visible(m)) return;
      if (m.type === 'TEXT') {
        const text = m.characters.trim().replace(/\s+/g, ' ');
        const b = boxOf(m);
        if (b && text.length >= 2 && text.length <= 32 && text.split(' ').length <= 4 && /[a-zÀ-ɏЀ-ӿ؀-ۿ]/i.test(text)) {
          const distance = Math.hypot(b.x + b.width / 2 - cx, b.y + b.height / 2 - cy);
          if (distance <= 400 && (!best || distance < best.distance)) best = {text, distance};
        }
        return;
      }
      if (level < 3 && isContainer(m)) for (const c of m.children) walk(c, level + 1);
    };
    for (const c of (parent as BaseNode & ChildrenMixin).children) walk(c as SceneNode, 0);
    if (best) return (best as {text: string}).text;
  }
  return null;
}

async function smartName(job: Job, kind: Kind): Promise<string> {
  const n = job.source, suffix = kind === 'svg' ? 'icon' : 'image';
  const describe = (label: string) => /\b(?:icon|image|logo|photo|avatar|illustration|banner|picture|img|ic)\b/i.test(words(label)) ? label : `${label} ${suffix}`;
  if (!isGenericName(n.name)) return n.name;
  const component = await componentLabel(n); if (component) return component;
  const label = nearbyLabel(n, job.root); if (label) return describe(label);
  for (let p = n.parent; p && p.type !== 'PAGE' && p.type !== 'DOCUMENT' && p !== job.root; p = p.parent) {
    if (!isGenericName(p.name)) return describe(p.name);
  }
  return describe(job.screen);
}

// ---------- Tokens ----------
const toByte = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
const round = (n: number, digits = 2) => +n.toFixed(digits);
const hex2 = (v: number) => v.toString(16).padStart(2, '0').toUpperCase();
const GRADIENT_TYPES: Record<string, GradientType> = {GRADIENT_LINEAR: 'linear', GRADIENT_RADIAL: 'radial', GRADIENT_ANGULAR: 'angular', GRADIENT_DIAMOND: 'diamond'};

type Named = {styleIds: Set<string>; variableIds: Set<string>};
function descendants(root: SceneNode): SceneNode[] {
  const result: SceneNode[] = [];
  const walk = (n: SceneNode) => { if (!visible(n) || isSystemIndicator(n)) return; result.push(n); if (isContainer(n)) for (const c of n.children) walk(c); };
  walk(root); return result;
}

async function collectTokens(roots: SceneNode[]) {
  const colors = new Map<string, RawColor & Named>();
  const gradients = new Map<string, RawGradient & Named>();
  const typography = new Map<string, RawTextStyle & Named>();
  const fonts = new Map<string, FontUse>();
  const remember = (ids: string[], id: string) => { if (ids.length < MAX_IDS && ids[ids.length - 1] !== id) ids.push(id); };
  const addPaints = (paints: unknown, node: SceneNode, styleId: unknown) => {
    const live = livePaints(paints);
    const style = typeof styleId === 'string' && styleId && live.length === 1 ? styleId : '';
    for (const p of live) {
      if (p.type === 'SOLID') {
        const c = {r: toByte(p.color.r), g: toByte(p.color.g), b: toByte(p.color.b), a: round(p.opacity ?? 1)};
        const key = `${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${hex2(toByte(c.a))}`;
        let entry = colors.get(key);
        if (!entry) colors.set(key, entry = {...c, key, uses: 0, nodeIds: [], names: [], styleIds: new Set(), variableIds: new Set()});
        entry.uses++; remember(entry.nodeIds, node.id);
        if (style) entry.styleIds.add(style);
        const variable = p.boundVariables?.color?.id; if (variable) entry.variableIds.add(variable);
      } else if (GRADIENT_TYPES[p.type]) {
        const g = p as GradientPaint, opacity = g.opacity ?? 1;
        const stops = g.gradientStops.map(s => ({r: toByte(s.color.r), g: toByte(s.color.g), b: toByte(s.color.b), a: round(s.color.a * opacity), position: round(s.position, 3)}));
        const transform = g.gradientTransform.map(row => row.map(v => round(v, 4)));
        const type = GRADIENT_TYPES[p.type], key = JSON.stringify([type, stops, transform]);
        let entry = gradients.get(key);
        if (!entry) gradients.set(key, entry = {key, type, stops, transform, uses: 0, nodeIds: [], names: [], styleIds: new Set(), variableIds: new Set()});
        entry.uses++; remember(entry.nodeIds, node.id);
        if (style) entry.styleIds.add(style);
      }
    }
  };
  for (const root of roots) for (const n of descendants(root)) {
    if (n.type !== 'TEXT' && isPaintNode(n)) addPaints(n.fills, n, 'fillStyleId' in n ? n.fillStyleId : '');
    if (hasStrokes(n)) addPaints(n.strokes, n, 'strokeStyleId' in n ? n.strokeStyleId : '');
    if (n.type !== 'TEXT') continue;
    // Styled runs preserve mixed typography without querying every character individually.
    for (const s of n.getStyledTextSegments(['fontName', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'fills', 'fillStyleId', 'textStyleId'])) {
      const uses = s.end - s.start, family = s.fontName.family, style = s.fontName.style;
      addPaints(s.fills, n, s.fillStyleId);
      const fontKey = JSON.stringify([family, style]), font = fonts.get(fontKey);
      if (font) font.uses += uses; else fonts.set(fontKey, {fontFamily: family, fontStyle: style, uses});
      const lh = s.lineHeight, ls = s.letterSpacing ?? {unit: 'PIXELS', value: 0};
      const lineHeight = lh.unit === 'AUTO' ? {unit: 'AUTO' as const, value: 0} : {unit: lh.unit, value: round(lh.value)};
      const letterSpacing = {unit: ls.unit, value: round(ls.value)};
      const key = JSON.stringify([family, style, s.fontSize, lineHeight.unit, lineHeight.value, letterSpacing.unit, letterSpacing.value]);
      let entry = typography.get(key);
      if (!entry) typography.set(key, entry = {key, fontFamily: family, fontStyle: style, fontSize: s.fontSize,
        fontWeight: typeof s.fontWeight === 'number' ? s.fontWeight : weightFromStyle(style), italic: /italic|oblique/i.test(style),
        lineHeight, letterSpacing, uses: 0, nodeIds: [], names: [], styleIds: new Set(), variableIds: new Set()});
      entry.uses += uses; remember(entry.nodeIds, n.id);
      if (s.textStyleId) entry.styleIds.add(s.textStyleId);
    }
  }
  // Designer-given names from styles and variables become token names.
  const all = [...colors.values(), ...gradients.values(), ...typography.values()];
  const styleNames = new Map<string, string>(), variableNames = new Map<string, string>();
  await Promise.all([
    ...[...new Set(all.flatMap(e => [...e.styleIds]))].map(async id => {
      try { const style = await figma.getStyleByIdAsync(id); if (style) styleNames.set(id, style.name); } catch { /* remote or deleted style */ }
    }),
    ...[...new Set(all.flatMap(e => [...e.variableIds]))].map(async id => {
      try { const variable = await figma.variables.getVariableByIdAsync(id); if (variable) variableNames.set(id, variable.name); } catch { /* unavailable */ }
    })
  ]);
  const finish = <T extends Named & {names: string[]}>(entry: T) => {
    const {styleIds, variableIds, ...rest} = entry;
    const names = [...[...variableIds].map(id => variableNames.get(id)), ...[...styleIds].map(id => styleNames.get(id))].filter((n): n is string => !!n);
    return {...rest, names: [...new Set(names)]};
  };
  return {
    colors: [...colors.values()].map(finish) as RawColor[],
    gradients: [...gradients.values()].map(finish) as RawGradient[],
    typography: [...typography.values()].map(finish) as RawTextStyle[],
    fonts: [...fonts.values()]
  };
}

// ---------- Selection ----------
function selectionRoots(): SceneNode[] {
  const selection = figma.currentPage.selection;
  const ids = new Set(selection.map(n => n.id));
  // Ignore a selected child when its selected ancestor already includes it.
  const top = selection.filter(n => {
    for (let p = n.parent; p && p.type !== 'PAGE' && p.type !== 'DOCUMENT'; p = p.parent) if (ids.has(p.id)) return false;
    return true;
  });
  // Sections only organize the canvas: their frames are the screens.
  const expand = (n: SceneNode): SceneNode[] => n.type === 'SECTION' ? n.children.flatMap(expand) : [n];
  return top.flatMap(expand);
}

const TYPE_LABELS: Record<string, string> = {FRAME: 'Frame', GROUP: 'Group', COMPONENT: 'Component', COMPONENT_SET: 'Component set', INSTANCE: 'Instance', SECTION: 'Section', TEXT: 'Text'};
function describeSelection() {
  const selection = figma.currentPage.selection;
  if (!selection.length) return {count: 0, label: 'Nothing selected. Select frames, groups or layers.'};
  if (selection.length === 1) return {count: 1, label: `${TYPE_LABELS[selection[0].type] ?? 'Layer'} “${selection[0].name}”`};
  const frames = selection.filter(n => n.type === 'FRAME').length;
  return {count: selection.length, label: frames === selection.length ? `${frames} frames selected` : `${selection.length} layers selected`};
}

// ---------- Scan ----------
let scanGeneration = 0, cancelRequested = false, lastSettings = normalizeSettings(null);
let recipes = new Map<string, Job>(); // asset key → job, reused to export @2x/@3x later
let lastProgress = 0;
function progress(text: string, done = 0, total = 0) {
  const now = Date.now();
  if (done && done < total && now - lastProgress < 60) return; // throttle message traffic
  lastProgress = now;
  figma.ui.postMessage({type: 'progress', text, done, total});
}

async function scan(settings: Settings) {
  const started = Date.now(), generation = ++scanGeneration;
  const stopped = () => cancelRequested || generation !== scanGeneration;
  cancelRequested = false; lastSettings = settings;
  analysisCache.clear();
  const roots = selectionRoots();
  if (!roots.length) throw new Error('Select one or more frames, groups or layers first.');
  const notes: Note[] = [];
  const note = (n: SceneNode, reason: string) => notes.push({nodeId: n.id, name: n.name, reason});

  progress('Reading colors and text styles…');
  const tokens = await collectTokens(roots);

  progress('Finding assets…');
  const plan = planner(settings, note);
  const top = roots.flatMap(plan.root);
  let batch = top, done = 0, total = top.length;
  while (batch.length && !stopped()) {
    await pool(batch, EXPORT_LANES, async job => {
      try { job.result = await render(job, settings); }
      catch (error) {
        if (error instanceof SkipError) note(job.source, error.message);
        else {
          note(job.source, `Export failed: ${errorText(error)}`);
          // A composition that cannot export as a whole is exported part by part.
          if (job.fallback) job.children = plan.children(job.fallback, job);
        }
      }
      progress(`Exporting assets… ${++done}/${total}`, done, total);
    }, stopped);
    batch = batch.flatMap(job => job.children ?? []);
    total += batch.length;
  }
  if (stopped()) { figma.ui.postMessage({type: 'scan-cancelled'}); return; }

  // Assemble in traversal order so names are deterministic, folding identical bytes into one file.
  const flatten = (jobs: Job[]): Job[] => jobs.flatMap(job => job.children ? flatten(job.children) : [job]);
  const assets: ScanAsset[] = [];
  const byContent = new Map<string, {bytes: Uint8Array; asset: ScanAsset}[]>();
  recipes = new Map();
  for (const job of flatten(top)) {
    const r = job.result; if (!r) continue;
    const occurrence: Occurrence = {figmaNodeId: job.source.id, screen: job.screen, screenNodeId: job.screenNodeId};
    const contentKey = `${r.kind}:${fingerprint(r.bytes)}`, matches = byContent.get(contentKey) ?? [];
    const same = matches.find(m => sameBytes(m.bytes, r.bytes));
    if (same) { same.asset.occurrences.push(occurrence); continue; }
    const asset: ScanAsset = {key: `a${assets.length + 1}`, kind: r.kind, name: '', layerName: job.source.name, figmaNodeId: job.source.id,
      screen: job.screen, screenNodeId: job.screenNodeId, width: r.width, height: r.height, bytes: r.bytes,
      occurrences: [occurrence], effects: r.effects, reason: r.reason};
    matches.push({bytes: r.bytes, asset}); byContent.set(contentKey, matches);
    assets.push(asset); recipes.set(asset.key, job);
  }
  progress('Naming assets…');
  await pool(assets, 8, async asset => { asset.name = await smartName(recipes.get(asset.key)!, asset.kind); });

  const result: ScanResult = {
    zipName: roots.length === 1 ? `${slug(roots[0].name)}_assets.zip` : 'figma_assets.zip',
    screens: roots.map(root => ({name: root.name, figmaNodeId: root.id})),
    assets, ...tokens, skipped: notes, durationMs: Date.now() - started
  };
  figma.ui.postMessage({type: 'scan-result', scan: result});
}

// ---------- @2x/@3x variants, exported while the user reviews the preview ----------
let variantGeneration = 0;
async function exportVariants(requestId: number, items: {key: string; scales: number[]}[]) {
  const generation = ++variantGeneration;
  const tasks = items.flatMap(item => item.scales.filter(s => s === 2 || s === 3).map(scale => ({key: item.key, scale})));
  const failed: {key: string; scale: number; reason: string}[] = [];
  await pool(tasks, VARIANT_LANES, async ({key, scale}) => {
    const job = recipes.get(key);
    if (!job?.result) { failed.push({key, scale, reason: 'The source layer is no longer available'}); return; }
    const {width, height} = job.result;
    if (Math.max(width, height) * scale > MAX_VARIANT_SIDE) { failed.push({key, scale, reason: `@${scale}x would exceed ${MAX_VARIANT_SIDE} px`}); return; }
    try {
      const r = await render(job, lastSettings, scale, true);
      if (generation === variantGeneration) figma.ui.postMessage({type: 'variant', requestId, key, scale, bytes: r.bytes});
    } catch (error) { failed.push({key, scale, reason: errorText(error)}); }
  }, () => generation !== variantGeneration);
  if (generation === variantGeneration) figma.ui.postMessage({type: 'variants-done', requestId, failed});
}

// ---------- Locate layers ----------
function pageOf(node: BaseNode): PageNode | null {
  for (let p: BaseNode | null = node; p; p = p.parent) if (p.type === 'PAGE') return p as PageNode;
  return null;
}
async function selectNodes(ids: string[]) {
  const found = await Promise.all([...new Set(ids)].slice(0, 500).map(id => figma.getNodeByIdAsync(id).catch(() => null)));
  const nodes = found.filter((n): n is SceneNode => !!n && n.type !== 'PAGE' && n.type !== 'DOCUMENT' && !n.removed);
  if (!nodes.length) { figma.notify('Layer not found. It may have been deleted.'); return; }
  const page = pageOf(nodes[0]);
  if (page && page !== figma.currentPage) await figma.setCurrentPageAsync(page);
  const onPage = nodes.filter(n => (pageOf(n) ?? figma.currentPage) === figma.currentPage);
  figma.currentPage.selection = onPage;
  figma.viewport.scrollAndZoomIntoView(onPage);
  figma.notify(onPage.length === 1 ? `Selected “${onPage[0].name}”` : `Selected ${onPage.length} layers`);
}

// ---------- Messages ----------
const postSelection = () => figma.ui.postMessage({type: 'selection', selection: describeSelection()});
figma.on('selectionchange', postSelection);
figma.on('currentpagechange', postSelection);

// Remove temporary frames left behind if Figma closed the plugin in the middle of an export.
try { for (const child of figma.currentPage.children || []) if (child.name === TEMP_NAME) child.remove(); } catch { /* best effort */ }

let scanning = false, sizeTimer: ReturnType<typeof setTimeout> | undefined;
figma.ui.onmessage = async (msg: {type: string; [key: string]: any}) => {
  switch (msg?.type) {
    case 'ready': {
      const [settings, size] = await Promise.all([figma.clientStorage.getAsync('settings').catch(() => null), figma.clientStorage.getAsync('ui-size').catch(() => null)]);
      if (size && typeof size.width === 'number' && typeof size.height === 'number') figma.ui.resize(size.width, size.height);
      figma.ui.postMessage({type: 'init', settings: normalizeSettings(settings), selection: describeSelection()});
      return;
    }
    case 'scan':
      if (scanning) return;
      scanning = true; variantGeneration++;
      try { await scan(normalizeSettings(msg.settings)); }
      catch (error) { figma.ui.postMessage({type: 'error', message: errorText(error)}); }
      finally { scanning = false; }
      return;
    case 'cancel': cancelRequested = true; return;
    case 'variants': await exportVariants(msg.requestId, Array.isArray(msg.items) ? msg.items : []); return;
    case 'select': await selectNodes(Array.isArray(msg.ids) ? msg.ids.map(String) : []); return;
    case 'resize': {
      const width = Math.round(Math.min(UI_MAX.width, Math.max(UI_MIN.width, Number(msg.width) || UI_DEFAULT.width)));
      const height = Math.round(Math.min(UI_MAX.height, Math.max(UI_MIN.height, Number(msg.height) || UI_DEFAULT.height)));
      figma.ui.resize(width, height);
      if (sizeTimer !== undefined) clearTimeout(sizeTimer);
      sizeTimer = setTimeout(() => figma.clientStorage.setAsync('ui-size', {width, height}).catch(() => {}), 400);
      return;
    }
    case 'save-settings': await figma.clientStorage.setAsync('settings', normalizeSettings(msg.settings)).catch(() => {}); return;
    case 'notify': figma.notify(String(msg.message).slice(0, 200)); return;
  }
};
