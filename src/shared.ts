// Types and helpers shared by the Figma sandbox (code.ts) and the plugin UI.
// Keep this file free of DOM and Figma globals: it is type-checked under both tsconfigs.

export type Kind = 'svg' | 'image';
export type Occurrence = {figmaNodeId: string; screen: string; screenNodeId: string; tint?: string; width?: number; height?: number};
export type Note = {nodeId: string; name: string; reason: string};
export type Screen = {name: string; figmaNodeId: string};

/** One unique file produced by the sandbox. Exact byte duplicates are already folded into `occurrences`. */
export type ScanAsset = {
  key: string; kind: Kind; name: string; layerName: string;
  figmaNodeId: string; screen: string; screenNodeId: string;
  width: number; height: number; bytes: Uint8Array;
  occurrences: Occurrence[]; effects: string[]; reason?: string;
};

/** r/g/b are 0-255 integers, a is 0-1. */
export type RGBA8 = {r: number; g: number; b: number; a: number};
export type RawColor = RGBA8 & {key: string; uses: number; nodeIds: string[]; names: string[]};
export type GradientType = 'linear' | 'radial' | 'angular' | 'diamond';
export type RawGradient = {
  key: string; type: GradientType; stops: (RGBA8 & {position: number})[];
  transform: number[][]; uses: number; nodeIds: string[]; names: string[];
};
export type RawTextStyle = {
  key: string; fontFamily: string; fontStyle: string; fontWeight: number; italic: boolean; fontSize: number;
  lineHeight: {unit: 'AUTO' | 'PIXELS' | 'PERCENT'; value: number};
  letterSpacing: {unit: 'PIXELS' | 'PERCENT'; value: number};
  uses: number; nodeIds: string[]; names: string[];
};
export type FontUse = {fontFamily: string; fontStyle: string; uses: number};

export type ScanResult = {
  zipName: string; screens: Screen[]; assets: ScanAsset[];
  colors: RawColor[]; gradients: RawGradient[]; typography: RawTextStyle[]; fonts: FontUse[];
  skipped: Note[]; durationMs: number;
};

export type Settings = {
  /** PNG densities. 1 is always exported; 2 and 3 become Flutter's 2.0x/3.0x variants. */
  scales: number[];
  /** Vector art with shadows/blur: 'png' keeps the look, 'svg' keeps vectors (flutter_svg drops filters). */
  effects: 'png' | 'svg';
  /** Skip plain rectangles, ellipses and lines that Flutter builds with Container/Divider. */
  skipShapes: boolean;
  /** Merge SVGs that differ only by a single fill color into one tintable SVG. */
  mergeTints: boolean;
  /** Merge artwork that is visually identical at a different size. */
  mergeSimilar: boolean;
  /** Merge colors that are imperceptibly different (CIEDE2000 ≤ 1). */
  mergeColors: boolean;
  background: 'auto' | 'checker' | 'light' | 'dark';
};
export const DEFAULT_SETTINGS: Settings = {
  scales: [1, 2, 3], effects: 'png', skipShapes: true,
  mergeTints: true, mergeSimilar: true, mergeColors: true, background: 'auto'
};
/** Settings that change what the sandbox exports, so a change needs a new scan. */
export const SCAN_SETTINGS: (keyof Settings)[] = ['effects', 'skipShapes'];

export function normalizeSettings(value: unknown): Settings {
  const input = (value && typeof value === 'object' ? value : {}) as Partial<Record<keyof Settings, unknown>>;
  const bool = (key: 'skipShapes' | 'mergeTints' | 'mergeSimilar' | 'mergeColors') =>
    typeof input[key] === 'boolean' ? input[key] as boolean : DEFAULT_SETTINGS[key];
  const scales = Array.isArray(input.scales) ? input.scales.filter(s => s === 2 || s === 3) as number[] : DEFAULT_SETTINGS.scales.slice(1);
  return {
    scales: [1, ...[...new Set(scales)].sort()],
    effects: input.effects === 'svg' ? 'svg' : 'png',
    skipShapes: bool('skipShapes'), mergeTints: bool('mergeTints'),
    mergeSimilar: bool('mergeSimilar'), mergeColors: bool('mergeColors'),
    background: ['auto', 'checker', 'light', 'dark'].includes(input.background as string) ? input.background as Settings['background'] : 'auto'
  };
}

// Arabic/Persian letters are transliterated so Arabic layer names still produce readable file names.
const TRANSLITERATION: Record<string, string> = {
  'ا': 'a', 'أ': 'a', 'إ': 'i', 'آ': 'a', 'ٱ': 'a', 'ب': 'b', 'ت': 't', 'ث': 'th', 'ج': 'j', 'ح': 'h', 'خ': 'kh',
  'د': 'd', 'ذ': 'dh', 'ر': 'r', 'ز': 'z', 'س': 's', 'ش': 'sh', 'ص': 's', 'ض': 'd', 'ط': 't', 'ظ': 'z', 'ع': 'a',
  'غ': 'gh', 'ف': 'f', 'ق': 'q', 'ك': 'k', 'ل': 'l', 'م': 'm', 'ن': 'n', 'ه': 'h', 'ة': 'a', 'و': 'w', 'ؤ': 'w',
  'ي': 'y', 'ى': 'a', 'ئ': 'y', 'ء': '', 'پ': 'p', 'چ': 'ch', 'ژ': 'zh', 'گ': 'g', 'ک': 'k', 'ی': 'y',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9'
};

/** File-system and Dart friendly snake_case name. */
export function slug(value: string, max = 55, fallback = 'asset'): string {
  const latin = Array.from(value.replace(/[ً-ٰٟـ]/g, ''), ch => TRANSLITERATION[ch] ?? ch).join('');
  const result = latin.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max).replace(/_+$/, '');
  return result || fallback;
}

export function uniqueSlug(base: string, used: Set<string>): string {
  let candidate = base, index = 1;
  while (used.has(candidate)) candidate = `${base}_${++index}`;
  used.add(candidate);
  return candidate;
}

// Reserved words, plus Object members that a static field may not shadow.
const DART_RESERVED = new Set(('abstract as assert async await base break case catch class const continue covariant default deferred do ' +
  'dynamic else enum export extends extension external factory false final finally for Function get hide if implements import in ' +
  'interface is late library mixin new null of on operator part required rethrow return sealed set show static super switch sync ' +
  'this throw true try type typedef var void when while with yield hashCode runtimeType toString noSuchMethod').split(' '));

export const camelCase = (value: string) => slug(value, 80, '').replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** A valid, unique lowerCamelCase Dart identifier. `separator` is placed before the numeric suffix of a duplicate. */
export function dartIdentifier(name: string, used: Set<string>, prefix: string, separator = ''): string {
  let base = camelCase(name);
  if (!/^[a-z]/.test(base) || DART_RESERVED.has(base)) base = `${prefix}${base.charAt(0).toUpperCase()}${base.slice(1)}`;
  let id = base, index = 1;
  while (used.has(id)) id = `${base}${separator}${++index}`;
  used.add(id);
  return id;
}

export function weightFromStyle(style: string): number {
  const s = style.toLowerCase().replace(/[\s_-]+/g, '');
  if (/thin|hairline/.test(s)) return 100;
  if (/extralight|ultralight/.test(s)) return 200;
  if (/light/.test(s)) return 300;
  if (/medium/.test(s)) return 500;
  if (/semibold|demibold/.test(s)) return 600;
  if (/extrabold|ultrabold/.test(s)) return 800;
  if (/black|heavy/.test(s)) return 900;
  if (/bold/.test(s)) return 700;
  return 400;
}
