import {analysisNotes, analyzeScan, assetPath, assignNames, buildZip, categoryOf, groupAssets, mergeStats, revokeAnalysis, type Analyzed, type AssetGroup} from './prepare-export';
import {buildGradients, buildPalette, buildTextStyles, cssColor, paletteOrder, type ColorToken, type GradientToken, type TextToken} from './tokens';
import {dartIdentifier, normalizeSettings, SCAN_SETTINGS, type Kind, type Note, type ScanResult, type Settings} from './shared';

// ---------- DOM ----------
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector(selector) as T;
const ui = {
  selection: $('#selection'), scan: $<HTMLButtonElement>('#scan'), settingsButton: $<HTMLButtonElement>('#open-settings'),
  progress: $('#progress'), progressBar: $('#progress-bar'), progressText: $('#progress-text'), cancel: $<HTMLButtonElement>('#cancel'),
  tabs: $('#tabs'), toolbar: $('#toolbar'), content: $('#content'), footer: $('#footer'), summary: $('#summary'),
  download: $<HTMLButtonElement>('#download'), viewer: $('#viewer'), settings: $('#settings'), toast: $('#toast'), grip: $('#grip')
};
const svg = (body: string, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>'),
  close: svg('<path d="M18 6L6 18M6 6l12 12"/>'),
  left: svg('<path d="M15 18l-6-6 6-6"/>'), right: svg('<path d="M9 18l6-6-6-6"/>'),
  download: svg('<path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"/>'),
  locate: svg('<circle cx="12" cy="12" r="7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="1.5"/>'),
  scan: svg('<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10"/>'),
  auto: svg('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>'),
  checker: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 4h8v8H4zM12 12h8v8h-8z" fill="currentColor" stroke="none"/>'),
  light: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  dark: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>')
};
const ART = `<svg class="art" viewBox="0 0 96 76" fill="none" aria-hidden="true"><rect x="4" y="10" width="56" height="44" rx="6" fill="currentColor" opacity=".12"/><rect x="4" y="10" width="56" height="44" rx="6" stroke="currentColor" stroke-width="2"/><path d="M10 46l12-14 9 10 6-6 17 10" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/><circle cx="44" cy="23" r="4" fill="currentColor"/><rect x="48" y="30" width="44" height="40" rx="8" fill="var(--bg)" stroke="currentColor" stroke-width="2"/><path d="M62 50l6-8 6 8m-6-8v14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// ---------- State ----------
type Tab = 'images' | 'svgs' | 'colors' | 'text' | 'skipped';
type Phase = 'idle' | 'scanning' | 'analyzing' | 'ready' | 'exporting';
type ViewerState = {id: string; zoom: 'fit' | 'actual'; scale: number};
const state = {
  settings: normalizeSettings(null),
  selection: {count: 0, label: 'Loading…'},
  phase: 'idle' as Phase,
  progress: {done: 0, total: 0, text: ''},
  scan: null as ScanResult | null,
  items: [] as Analyzed[],
  groups: [] as AssetGroup[],
  names: new Map<string, string>(),
  dartNames: new Map<string, string>(),
  renames: new Map<string, string>(),   // keyed by stable ids: a:<nodeId>, c:<color>, g:<gradient>, t:<text style>
  excluded: new Set<string>(),
  colors: [] as ColorToken[], gradients: [] as GradientToken[], texts: [] as TextToken[],
  tab: 'images' as Tab, query: '', sort: 'order',
  variants: new Map<string, Map<number, Uint8Array>>(),
  variantFailures: new Map<string, string>(),
  error: '', autoScan: true, rescanAfter: false,
  viewer: null as ViewerState | null
};
const busy = () => state.phase === 'scanning' || state.phase === 'analyzing' || state.phase === 'exporting';

// ---------- Utilities ----------
const esc = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]!);
const post = (message: object) => parent.postMessage({pluginMessage: message}, '*');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const formatBytes = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const dims = (w: number, h: number) => `${Math.round(w)}×${Math.round(h)}`;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(message: string, kind: 'info' | 'error' = 'info') {
  ui.toast.textContent = message; ui.toast.className = `toast show${kind === 'error' ? ' error' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { ui.toast.className = 'toast'; }, kind === 'error' ? 4000 : 2200);
}
function copyText(text: string) {
  // The plugin iframe has no clipboard permission, so use a temporary selection.
  const active = document.activeElement as HTMLElement | null, area = document.createElement('textarea');
  area.value = text; area.setAttribute('readonly', ''); area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(area); area.select();
  let copied = false; try { copied = document.execCommand('copy'); } catch { copied = false; }
  area.remove(); active?.focus();
  if (!copied) navigator.clipboard?.writeText(text).catch(() => {});
  toast(`Copied ${text.length > 48 ? `${text.slice(0, 48)}…` : text}`);
}
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const fileUrls = new Map<string, string>();
function fileUrl(item: Analyzed, scale = 1): string {
  const id = `${item.key}@${scale}`;
  let url = fileUrls.get(id);
  if (!url) {
    const bytes = scale === 1 ? item.raw.bytes : state.variants.get(item.key)?.get(scale);
    if (!bytes) return fileUrl(item, 1);
    url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], {type: item.kind === 'svg' ? 'image/svg+xml' : 'image/png'}));
    fileUrls.set(id, url);
  }
  return url;
}
function resetFiles() { for (const url of fileUrls.values()) URL.revokeObjectURL(url); fileUrls.clear(); }

// ---------- Derived data ----------
function regroup(full = true) {
  const scan = state.scan, s = state.settings;
  if (!scan) return;
  if (full) state.groups = groupAssets(state.items, s);
  state.names = assignNames(state.groups, state.renames);
  const used = new Set<string>();
  state.dartNames = new Map(state.groups.map(g => [g.id, dartIdentifier(state.names.get(g.id)!, used, 'asset')]));
  state.colors = buildPalette(scan.colors, s.mergeColors, state.renames);
  state.gradients = buildGradients(scan.gradients, state.renames);
  state.texts = buildTextStyles(scan.typography, state.renames);
}
const assetId = (g: AssetGroup) => `a:${g.id}`;
const included = (id: string) => !state.excluded.has(id);
function allNotes(): Note[] {
  const notes = [...(state.scan?.skipped ?? []), ...analysisNotes(state.items)];
  for (const [id, reason] of state.variantFailures) {
    const [key, scale] = id.split('@'), item = state.items.find(i => i.key === key);
    if (item) notes.push({nodeId: item.raw.figmaNodeId, name: item.raw.layerName, reason: `@${scale}x not exported: ${reason}`});
  }
  return notes;
}
const matchesQuery = (...values: (string | undefined)[]) => !state.query || values.some(v => v?.toLowerCase().includes(state.query));
function visibleGroups(kind: Kind): AssetGroup[] {
  const list = state.groups.filter(g => g.kind === kind && matchesQuery(state.names.get(g.id), g.first.raw.layerName, g.first.raw.screen));
  const by: Record<string, (a: AssetGroup, b: AssetGroup) => number> = {
    uses: (a, b) => b.occurrences.length - a.occurrences.length,
    name: (a, b) => state.names.get(a.id)!.localeCompare(state.names.get(b.id)!),
    size: (a, b) => b.primary.size - a.primary.size
  };
  return by[state.sort] ? [...list].sort(by[state.sort]) : list;
}
function backgroundFor(item: Analyzed): string {
  const mode = state.settings.background;
  if (mode !== 'auto') return `bg-${mode}`;
  if (!item.transparent) return 'bg-checker';
  return item.luminance > 0.72 ? 'bg-dark' : 'bg-light'; // white icons get a dark backdrop automatically
}
function colorName(hex: string): string | null {
  return state.colors.find(c => c.a === 1 && c.hex === hex)?.name ?? null;
}
function usageSnippet(g: AssetGroup): string {
  const name = `AppAssets.${state.dartNames.get(g.id)}`;
  if (g.kind === 'image') return `Image.asset(${name})`;
  if (!g.tints.length) return `SvgPicture.asset(${name})`;
  const tint = g.tints[0], token = colorName(tint);
  return `SvgPicture.asset(${name}, colorFilter: const ColorFilter.mode(${token ? `AppColors.${token}` : `Color(0xFF${tint.slice(1)})`}, BlendMode.srcIn))`;
}

// ---------- Scan ----------
function startScan() {
  if (busy()) { if (state.phase === 'scanning' || state.phase === 'analyzing') state.rescanAfter = true; return; }
  if (!state.selection.count) { toast('Select frames, groups or layers in Figma first'); return; }
  cancelVariantWait();
  state.phase = 'scanning'; state.error = ''; state.rescanAfter = false;
  state.progress = {done: 0, total: 0, text: 'Scanning selection…'};
  closeViewer(); renderAll();
  post({type: 'scan', settings: state.settings});
}

async function onScanResult(scan: ScanResult) {
  revokeAnalysis(state.items); resetFiles();
  state.scan = scan; state.items = []; state.variants.clear(); state.variantFailures.clear();
  state.phase = 'analyzing';
  state.progress = {done: 0, total: scan.assets.length, text: 'Rendering previews…'}; renderProgress();
  try {
    state.items = await analyzeScan(scan, (done, total) => { state.progress = {done, total, text: `Rendering previews… ${done}/${total}`}; renderProgress(); });
  } catch (error) { state.phase = 'idle'; state.error = `Preview failed: ${errorText(error)}`; renderAll(); return; }
  regroup();
  state.phase = 'ready';
  const counts = tabCounts();
  if (!counts[state.tab]) state.tab = (['images', 'svgs', 'colors', 'text', 'skipped'] as Tab[]).find(t => counts[t]) ?? 'images';
  renderAll();
  ui.content.scrollTop = 0;
  if (state.rescanAfter) { state.rescanAfter = false; startScan(); return; }
  void prefetchVariants();
}

// ---------- @2x/@3x variants: exported in the background while the user reviews ----------
type VariantJob = {id: number; total: number; done: number; resolve: () => void; promise: Promise<void>};
let variantJob: VariantJob | null = null, variantSeq = 0;
function missingVariants(groups: AssetGroup[]) {
  const scales = state.settings.scales.filter(s => s > 1);
  return groups.filter(g => g.kind === 'image').map(g => ({key: g.primary.key, scales: scales.filter(s =>
    !state.variants.get(g.primary.key)?.has(s) && !state.variantFailures.has(`${g.primary.key}@${s}`))})).filter(i => i.scales.length);
}
async function requestVariants(groups: AssetGroup[]): Promise<void> {
  while (variantJob) await variantJob.promise;
  const items = missingVariants(groups);
  if (!items.length) return;
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  variantJob = {id: ++variantSeq, total: items.reduce((n, i) => n + i.scales.length, 0), done: 0, resolve, promise};
  post({type: 'variants', requestId: variantJob.id, items});
  renderFooter();
  return promise;
}
const prefetchVariants = () => requestVariants(state.groups.filter(g => included(assetId(g))));
function cancelVariantWait() { const job = variantJob; variantJob = null; job?.resolve(); }

// ---------- Download ----------
function includedGroups() { return state.groups.filter(g => included(assetId(g))); }
async function downloadZip() {
  const scan = state.scan;
  if (!scan || busy()) return;
  const groups = includedGroups();
  const colors = state.colors.filter(c => included(c.id)), gradients = state.gradients.filter(g => included(g.id)), texts = state.texts.filter(t => included(t.id));
  if (!groups.length && !colors.length && !gradients.length && !texts.length) { toast('Nothing is selected for export'); return; }
  state.phase = 'exporting'; renderAll();
  try {
    if (state.settings.scales.some(s => s > 1) && groups.some(g => g.kind === 'image')) {
      setProgress('Exporting @2x/@3x PNGs…', variantJob?.done ?? 0, variantJob?.total ?? 0);
      await requestVariants(groups);
    }
    setProgress('Compressing ZIP…', 0, 100);
    const zip = buildZip({
      scan, groups, names: state.names, variants: state.variants, scales: state.settings.scales, colors, gradients, textStyles: texts, notes: allNotes(),
      excludedAssets: state.groups.filter(g => !included(assetId(g))).map(g => ({id: state.names.get(g.id)!, path: assetPath(g.kind, state.names.get(g.id)!)}))
    });
    const blob = await zip.generateAsync({type: 'blob', compression: 'DEFLATE', compressionOptions: {level: 6}},
      meta => setProgress(`Compressing ZIP… ${Math.round(meta.percent)}%`, meta.percent, 100));
    saveBlob(blob, scan.zipName);
    toast(`Downloaded ${scan.zipName} · ${plural(groups.length, 'file')}`);
    post({type: 'notify', message: `Exported ${plural(groups.length, 'asset')} to ${scan.zipName}`});
  } catch (error) { toast(`ZIP error: ${errorText(error)}`, 'error'); }
  finally { state.phase = 'ready'; renderAll(); }
}
function downloadOne(g: AssetGroup, scale: number) {
  const name = state.names.get(g.id)!, bytes = scale > 1 ? state.variants.get(g.primary.key)?.get(scale) : g.primary.raw.bytes;
  if (!bytes) return;
  saveBlob(new Blob([bytes as unknown as BlobPart], {type: g.kind === 'svg' ? 'image/svg+xml' : 'image/png'}), `${name}${scale > 1 ? `@${scale}x` : ''}.${g.kind === 'svg' ? 'svg' : 'png'}`);
}

// ---------- Rendering ----------
function setProgress(text: string, done = 0, total = 0) { state.progress = {text, done, total}; renderProgress(); }
function renderProgress() {
  const show = busy();
  ui.progress.hidden = !show;
  if (!show) return;
  const {done, total, text} = state.progress;
  ui.progress.classList.toggle('indeterminate', !total);
  ui.progressBar.style.width = total ? `${Math.min(100, done / total * 100)}%` : '';
  ui.progressText.textContent = text;
  ui.cancel.hidden = state.phase !== 'scanning';
}
function renderHeader() {
  ui.selection.textContent = state.selection.label;
  ui.selection.title = state.selection.label;
  ui.scan.disabled = busy() || !state.selection.count;
  ui.scan.innerHTML = `${ICON.scan}<span>${state.scan ? 'Rescan' : 'Scan selection'}</span>`;
}
function tabCounts(): Record<Tab, number> {
  return {
    images: state.groups.filter(g => g.kind === 'image').length, svgs: state.groups.filter(g => g.kind === 'svg').length,
    colors: state.colors.length + state.gradients.length, text: state.texts.length, skipped: allNotes().length
  };
}
const TAB_LABELS: Record<Tab, string> = {images: 'Images', svgs: 'SVGs', colors: 'Colors', text: 'Text', skipped: 'Skipped'};
function renderTabs() {
  const show = !!state.scan && state.phase !== 'scanning';
  ui.tabs.hidden = !show;
  if (!show) return;
  const counts = tabCounts();
  ui.tabs.innerHTML = (Object.keys(TAB_LABELS) as Tab[]).map(tab =>
    `<button class="tab" role="tab" type="button" data-tab="${tab}" aria-selected="${state.tab === tab}">${TAB_LABELS[tab]}<span class="count">${counts[tab]}</span></button>`).join('');
}
function renderToolbar() {
  const show = !!state.scan && state.phase !== 'scanning';
  ui.toolbar.hidden = !show;
  if (!show) return;
  const assets = state.tab === 'images' || state.tab === 'svgs';
  $<HTMLSelectElement>('#sort').hidden = !assets;
  $('#bg').hidden = !assets;
  $('#all-wrap').hidden = state.tab === 'skipped';
  $('#bg').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.bg === state.settings.background)));
  const ids = currentIds();
  const all = $<HTMLInputElement>('#all');
  all.checked = ids.length > 0 && ids.every(included);
  all.indeterminate = !all.checked && ids.some(included);
}
function currentIds(): string[] {
  if (state.tab === 'images' || state.tab === 'svgs') return visibleGroups(state.tab === 'images' ? 'image' : 'svg').map(assetId);
  if (state.tab === 'colors') return [...state.colors, ...state.gradients].filter(t => matchesQuery(t.name, t.figmaName, 'hex' in t ? t.hex : '')).map(t => t.id);
  if (state.tab === 'text') return state.texts.filter(t => matchesQuery(t.name, t.figmaName, t.fontFamily)).map(t => t.id);
  return [];
}

const checkbox = (id: string, label: string) => `<label class="check" title="${esc(label)}"><input type="checkbox" data-toggle="${esc(id)}"${included(id) ? ' checked' : ''} aria-label="${esc(label)}"><span></span></label>`;
function assetCard(g: AssetGroup): string {
  const id = assetId(g), name = state.names.get(g.id)!, p = g.primary;
  const badges: string[] = [];
  if (g.occurrences.length > 1) badges.push(`<span class="badge" title="Used ${g.occurrences.length} times in the design">×${g.occurrences.length}</span>`);
  if (g.tints.length) badges.push(`<span class="badge" title="One SVG used in ${g.tints.length} colors (tint with colorFilter)">${g.tints.slice(0, 4).map(t => `<i class="dot" style="background:${esc(t)}"></i>`).join('')}</span>`);
  const similar = g.members.filter(m => m.relation === 'similar').length;
  if (similar) badges.push(`<span class="badge similar" title="${similar} identical ${similar === 1 ? 'copy' : 'copies'} at another size merged">≈${similar}</span>`);
  const effects = [...new Set(g.members.flatMap(m => m.item.raw.effects))];
  if (effects.length) badges.push(`<span class="badge fx" title="${esc(p.raw.reason ?? `Effects: ${effects.join(', ')}`)}">FX</span>`);
  return `<div class="card${included(id) ? '' : ' off'}" data-open="${esc(id)}" tabindex="0" role="button" aria-label="Preview ${esc(name)}">
    ${checkbox(id, 'Include in ZIP')}<div class="badges">${badges.join('')}</div>
    <div class="thumb ${g.kind} ${backgroundFor(p)}"><img src="${p.thumb}" alt="" loading="lazy" decoding="async" draggable="false"></div>
    <div class="meta"><div class="name" title="${esc(name)}">${esc(name)}</div><div class="sub">${dims(p.width, p.height)} · ${formatBytes(p.size)}</div></div></div>`;
}
function colorSwatch(c: ColorToken): string {
  return `<div class="swatch${included(c.id) ? '' : ' off'}" data-open="${esc(c.id)}" tabindex="0" role="button" aria-label="${esc(`${c.name} ${c.hex}`)}">
    ${checkbox(c.id, 'Include in ZIP')}<div class="chip" style="--c:${esc(c.css)}"></div>
    <div class="meta"><div class="name" title="${esc(c.figmaName ?? c.name)}">${esc(c.name)}</div><div class="sub"><code>${c.hex}</code>${c.a < 1 ? ` ${Math.round(c.a * 100)}%` : ''} · ${c.uses}×</div></div></div>`;
}
function gradientSwatch(g: GradientToken): string {
  return `<div class="swatch${included(g.id) ? '' : ' off'}" data-open="${esc(g.id)}" tabindex="0" role="button" aria-label="${esc(g.name)}">
    ${checkbox(g.id, 'Include in ZIP')}<div class="grad-chip" style="--g:${esc(g.css)}"></div>
    <div class="meta"><div class="name" title="${esc(g.figmaName ?? g.name)}">${esc(g.name)}</div><div class="sub">${g.type} · ${g.stops.length} stops · ${g.uses}×</div></div></div>`;
}
const fontCss = (t: TextToken) => `font-family:&quot;${esc(t.fontFamily)}&quot;,system-ui,sans-serif;font-weight:${t.fontWeight};font-style:${t.italic ? 'italic' : 'normal'}`;
function textRow(t: TextToken): string {
  return `<div class="text-row${included(t.id) ? '' : ' off'}" data-open="${esc(t.id)}" tabindex="0" role="button" aria-label="${esc(t.name)}">
    ${checkbox(t.id, 'Include in ZIP')}<div class="sample" style="${fontCss(t)}">Ag</div>
    <div style="min-width:0"><div class="name">${esc(t.name)}</div><div class="sub">${esc(`${t.fontFamily} ${t.fontStyle} · ${t.fontSize}/${t.lineHeight}${t.letterSpacing ? ` · ls ${t.letterSpacing}` : ''}`)}</div></div>
    <div class="uses">${plural(t.uses, 'char')}</div></div>`;
}
const none = (text: string) => `<div class="none">${esc(text)}</div>`;

function renderContent() {
  const scrollTop = ui.content.scrollTop;
  ui.content.innerHTML = contentHtml();
  ui.content.scrollTop = scrollTop;
}
function contentHtml(): string {
  if (state.error && !state.scan) return `<div class="error">${esc(state.error)}</div>${emptyHtml()}`;
  if (!state.scan) {
    if (state.phase === 'scanning') return `<div class="grid">${'<div class="skeleton"></div>'.repeat(12)}</div>`;
    return emptyHtml();
  }
  if (state.phase === 'scanning' || state.phase === 'analyzing') return `<div class="grid">${'<div class="skeleton"></div>'.repeat(12)}</div>`;
  const error = state.error ? `<div class="error">${esc(state.error)}</div>` : '';
  if (state.tab === 'images' || state.tab === 'svgs') {
    const kind: Kind = state.tab === 'images' ? 'image' : 'svg', list = visibleGroups(kind);
    if (!state.groups.some(g => g.kind === kind)) return error + none(kind === 'svg' ? 'No vector artwork in this selection.' : 'No images in this selection.');
    return error + (list.length ? `<div class="grid">${list.map(assetCard).join('')}</div>` : none(`No matches for “${state.query}”.`));
  }
  if (state.tab === 'colors') {
    const colors = paletteOrder(state.colors.filter(c => matchesQuery(c.name, c.figmaName, c.hex)));
    const gradients = state.gradients.filter(g => matchesQuery(g.name, g.figmaName));
    if (!state.colors.length && !state.gradients.length) return error + none('No solid colors or gradients in this selection.');
    const merged = state.colors.reduce((n, c) => n + c.aliases.length, 0);
    let html = '';
    if (colors.length) html += `<div class="section-title"><span>Palette · ${colors.length}</span>${merged ? `<span title="Imperceptibly different colors (ΔE < 1) merged into one token">${plural(merged, 'near-duplicate')} merged</span>` : ''}</div><div class="swatches">${colors.map(colorSwatch).join('')}</div>`;
    if (gradients.length) html += `<div class="section-title"><span>Gradients · ${gradients.length}</span></div><div class="swatches">${gradients.map(gradientSwatch).join('')}</div>`;
    return error + (html || none(`No matches for “${state.query}”.`));
  }
  if (state.tab === 'text') {
    const list = state.texts.filter(t => matchesQuery(t.name, t.figmaName, t.fontFamily));
    if (!state.texts.length) return error + none('No text in this selection.');
    return error + (list.length ? `<div class="text-list">${list.map(textRow).join('')}</div>` : none(`No matches for “${state.query}”.`));
  }
  const notes = allNotes().filter(n => matchesQuery(n.name, n.reason));
  if (!notes.length) return error + none(state.query ? `No matches for “${state.query}”.` : 'Nothing was skipped.');
  const byReason = new Map<string, Note[]>();
  for (const n of notes) {
    const reason = n.reason.startsWith('Export failed') ? 'Export failed' : n.reason.startsWith('Validation failed') ? 'Could not be rendered' : n.reason.replace(/^@\dx not exported:.*/, 'High-resolution variant not exported');
    byReason.set(reason, [...(byReason.get(reason) ?? []), n]);
  }
  return error + `<div class="skipped">${[...byReason].map(([reason, list]) => `<details${list.length <= 6 ? ' open' : ''}><summary><span>${esc(reason)}</span><span class="muted">${list.length}</span></summary><ul>${
    list.slice(0, 400).map(n => `<li><span title="${esc(n.reason)}">${esc(n.name)}</span><button class="link-btn" type="button" data-locate="${esc(n.nodeId)}">Locate</button></li>`).join('')
  }</ul></details>`).join('')}</div>`;
}
function emptyHtml() {
  return `<div class="empty">${ART}<h2>Preview before you download</h2>
    <p>Select frames, groups or single layers in Figma, then press <b>Scan selection</b>. Nothing is downloaded until you choose <b>Download ZIP</b>.</p>
    <ul><li>Duplicates are removed: exact copies, recolored icons and the same artwork at another size.</li>
    <li>Click any preview to inspect it full size, rename it, or locate it in Figma.</li>
    <li>Colors, gradients and text styles become <code>AppColors</code>, <code>AppGradients</code> and <code>AppTextStyles</code>.</li>
    <li>PNGs include Flutter's 2.0x and 3.0x variants. Shadows and blur stay intact.</li></ul></div>`;
}
function renderFooter() {
  const show = !!state.scan && state.phase !== 'scanning' && state.phase !== 'analyzing';
  ui.footer.hidden = !show;
  if (!show) return;
  const groups = includedGroups(), svgs = groups.filter(g => g.kind === 'svg').length;
  const colors = state.colors.filter(c => included(c.id)).length + state.gradients.filter(g => included(g.id)).length;
  const texts = state.texts.filter(t => included(t.id)).length, stats = mergeStats(state.groups);
  const removed = [stats.exact && `${stats.exact} duplicate${stats.exact === 1 ? '' : 's'}`, stats.tint && `${stats.tint} recolored`, stats.similar && `${stats.similar} resized`].filter(Boolean);
  const variants = variantJob ? ` · @2x/@3x ${variantJob.done}/${variantJob.total}` : '';
  ui.summary.innerHTML = `<div class="line"><b>${plural(groups.length, 'file')}</b> · ${svgs} SVG · ${groups.length - svgs} PNG · ${plural(colors, 'color')} · ${plural(texts, 'text style')}</div>
    <div class="line hint">${removed.length ? `Merged ${removed.join(', ')}` : 'No duplicates found'}${variants}</div>`;
  ui.download.disabled = busy();
  ui.download.innerHTML = `${ICON.download}<span>Download ZIP</span>`;
}
function renderAll() { renderHeader(); renderProgress(); renderTabs(); renderToolbar(); renderContent(); renderFooter(); }

function setIncluded(ids: string[], on: boolean) {
  for (const id of ids) on ? state.excluded.delete(id) : state.excluded.add(id);
  for (const id of ids) {
    document.querySelectorAll<HTMLElement>(`[data-open="${CSS.escape(id)}"]`).forEach(el => el.classList.toggle('off', !on));
    document.querySelectorAll<HTMLInputElement>(`input[data-toggle="${CSS.escape(id)}"]`).forEach(input => { input.checked = on; });
  }
  renderToolbar(); renderFooter();
}

// ---------- Viewer ----------
function viewerList(id: string): string[] {
  if (id.startsWith('a:')) {
    const group = state.groups.find(g => assetId(g) === id);
    return group ? visibleGroups(group.kind).map(assetId) : [];
  }
  if (id.startsWith('c:') || id.startsWith('g:')) return [...paletteOrder(state.colors), ...state.gradients].map(t => t.id);
  return state.texts.map(t => t.id);
}
function openViewer(id: string) {
  state.viewer = {id, zoom: 'fit', scale: 1};
  ui.viewer.hidden = false; renderViewer();
  ui.viewer.querySelector<HTMLElement>('[data-act=close]')?.focus();
}
function closeViewer() { state.viewer = null; ui.viewer.hidden = true; ui.viewer.innerHTML = ''; }
const codeRow = (label: string, code: string) => `<div class="code-row"><span class="label">${esc(label)}</span><code title="${esc(code)}">${esc(code)}</code><button class="copy" type="button" data-copy="${esc(code)}">Copy</button></div>`;
const fact = (label: string, value: string) => `<div class="fact"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
const seg = (act: string, options: [string, string, string][], current: string) =>
  `<div class="seg" role="group">${options.map(([value, label, title]) => `<button type="button" data-act="${act}" data-value="${value}" aria-pressed="${value === current}" title="${esc(title)}">${label}</button>`).join('')}</div>`;

function renderViewer() {
  const v = state.viewer; if (!v) return;
  const list = viewerList(v.id), index = list.indexOf(v.id);
  const nav = `<button class="nav prev" type="button" data-act="prev" aria-label="Previous"${index <= 0 ? ' disabled' : ''}>${ICON.left}</button><button class="nav next" type="button" data-act="next" aria-label="Next"${index < 0 || index >= list.length - 1 ? ' disabled' : ''}>${ICON.right}</button>`;
  const head = (name: string, pill: string) => `<div class="v-head"><input class="name-input" data-rename="${esc(v.id)}" value="${esc(name)}" spellcheck="false" aria-label="Name" title="Rename"><span class="pill">${esc(pill)}</span><button class="icon-btn" type="button" data-act="close" aria-label="Close">${ICON.close}</button></div>`;
  const include = `<label class="toggle"><input type="checkbox" data-toggle="${esc(v.id)}"${included(v.id) ? ' checked' : ''}> Include in ZIP</label>`;
  let html = '';
  if (v.id.startsWith('a:')) {
    const g = state.groups.find(x => assetId(x) === v.id);
    if (!g) return closeViewer();
    const p = g.primary, name = state.names.get(g.id)!, scales = [1, ...[2, 3].filter(s => state.variants.get(p.key)?.has(s))];
    if (!scales.includes(v.scale)) v.scale = 1;
    const screens = [...new Set(g.occurrences.map(o => o.screen))];
    const notes: string[] = [];
    if (g.tints.length) notes.push(`One SVG used in ${g.tints.length} colors (${g.tints.join(', ')}). Tint each use with <code>colorFilter</code>.`);
    const similar = g.members.filter(m => m.relation === 'similar');
    if (similar.length) notes.push(`Same artwork at ${[...new Set(similar.map(m => dims(m.item.width, m.item.height)))].join(', ')} merged; the ${g.kind === 'image' ? 'largest' : 'vector'} version is exported.`);
    const reasons = [...new Set(g.members.map(m => m.item.raw.reason).filter(Boolean))];
    for (const reason of reasons) notes.push(esc(reason));
    if (g.kind === 'image' && state.settings.scales.length > 1) notes.push(scales.length > 1 ? `Includes ${scales.slice(1).map(s => `${s}.0x`).join(' and ')} variants for high-density screens.` : 'High-density variants are being prepared…');
    html = `${head(name, `${g.kind === 'svg' ? 'SVG' : 'PNG'} · ${categoryOf(g)}`)}
      <div class="stage ${v.zoom} ${backgroundFor(p)}">${nav}<img src="${fileUrl(p, v.scale)}" alt="${esc(name)}" draggable="false"></div>
      <div class="stage-tools">${seg('bg', [['auto', ICON.auto, 'Automatic background'], ['checker', ICON.checker, 'Checkerboard'], ['light', ICON.light, 'Light'], ['dark', ICON.dark, 'Dark']], state.settings.background)}
        ${seg('zoom', [['fit', 'Fit', 'Fit to window'], ['actual', '1:1', 'Actual pixels']], v.zoom)}
        ${g.kind === 'image' && scales.length > 1 ? seg('scale', scales.map(s => [String(s), `${s}x`, `${s}x resolution`]), String(v.scale)) : ''}</div>
      <div class="info">
        <div class="facts">${fact('Size', `${dims(p.width, p.height)} px`)}${fact('File', formatBytes(p.size))}${fact('Uses', `${g.occurrences.length} on ${plural(screens.length, 'screen')}`)}</div>
        ${codeRow('Flutter', usageSnippet(g))}${codeRow('Path', assetPath(g.kind, name))}
        ${notes.length ? `<ul class="notes">${notes.map(n => `<li>${n}</li>`).join('')}</ul>` : ''}
        <div class="muted">Screens: ${esc(screens.join(', '))} · Layer: ${esc(g.first.raw.layerName)}</div>
      </div>
      <div class="v-actions">${include}<span class="spacer"></span>
        <button class="btn secondary" type="button" data-act="locate">${ICON.locate}<span>Locate</span></button>
        <button class="btn primary" type="button" data-act="download-one">${ICON.download}<span>Download${g.kind === 'image' ? ` @${v.scale}x` : ''}</span></button></div>`;
  } else if (v.id.startsWith('c:')) {
    const c = state.colors.find(x => x.id === v.id);
    if (!c) return closeViewer();
    const {r, g, b} = c;
    html = `${head(c.name, `${c.uses}× used`)}
      <div style="position:relative">${nav}<div class="color-hero" style="--c:${esc(c.css)}"><span>${c.hex}${c.a < 1 ? ` · ${Math.round(c.a * 100)}%` : ''}</span></div></div>
      <div class="info" style="max-height:none;flex:1">
        ${codeRow('Dart', `AppColors.${c.name}`)}${codeRow('Flutter', `Color(${c.argb})`)}${codeRow('HEX', c.hex)}${codeRow('CSS', c.a < 1 ? c.css : `rgb(${r}, ${g}, ${b})`)}
        ${c.figmaName || c.aliases.length ? `<ul class="notes">${c.figmaName ? `<li>Figma name: <b>${esc(c.figmaName)}</b></li>` : ''}${c.aliases.length ? `<li>Merged near-identical colors: ${esc(c.aliases.join(', '))}</li>` : ''}</ul>` : ''}
      </div>
      <div class="v-actions">${include}<span class="spacer"></span><button class="btn secondary" type="button" data-act="locate">${ICON.locate}<span>Select ${plural(c.nodeIds.length, 'layer')}</span></button></div>`;
  } else if (v.id.startsWith('g:')) {
    const gr = state.gradients.find(x => x.id === v.id);
    if (!gr) return closeViewer();
    html = `${head(gr.name, `${gr.type} · ${gr.uses}×`)}
      <div style="position:relative">${nav}<div class="color-hero" style="--c:transparent;background-image:${esc(gr.css)},var(--checker)"></div></div>
      <div class="info" style="max-height:none;flex:1">
        ${gr.type === 'linear' || gr.type === 'radial' ? codeRow('Dart', `AppGradients.${gr.name}`) : ''}${codeRow('CSS', gr.css)}
        <div class="chips">${gr.stops.map(s => `<span><i style="background:${esc(cssColor(s))}"></i>${esc(cssColor(s))} · ${Math.round(s.position * 100)}%</span>`).join('')}</div>
        ${gr.figmaName ? `<ul class="notes"><li>Figma name: <b>${esc(gr.figmaName)}</b></li></ul>` : ''}
        ${gr.type === 'angular' || gr.type === 'diamond' ? '<ul class="notes"><li>Flutter has no exact equivalent; this gradient is kept in tokens/gradients.json.</li></ul>' : ''}
      </div>
      <div class="v-actions">${include}<span class="spacer"></span><button class="btn secondary" type="button" data-act="locate">${ICON.locate}<span>Select ${plural(gr.nodeIds.length, 'layer')}</span></button></div>`;
  } else {
    const t = state.texts.find(x => x.id === v.id);
    if (!t) return closeViewer();
    const size = Math.min(t.fontSize, 40);
    html = `${head(t.name, plural(t.uses, 'character'))}
      <div style="position:relative">${nav}<div class="text-preview" style="${fontCss(t)};font-size:${size}px;line-height:${t.height ?? 'normal'};letter-spacing:${t.letterSpacing}px">The quick brown fox jumps over the lazy dog 0123456789</div></div>
      <div class="info" style="max-height:none;flex:1">
        <div class="facts">${fact('Font', `${t.fontFamily} ${t.fontStyle}`)}${fact('Size / line', `${t.fontSize} / ${t.lineHeight}`)}${fact('Weight', String(t.fontWeight))}${fact('Letter spacing', `${t.letterSpacing}px`)}</div>
        ${codeRow('Dart', `AppTextStyles.${t.name}`)}
        ${t.figmaName ? `<ul class="notes"><li>Figma text style: <b>${esc(t.figmaName)}</b></li></ul>` : ''}
        ${size < t.fontSize ? `<div class="muted">Preview capped at ${size}px.</div>` : ''}
      </div>
      <div class="v-actions">${include}<span class="spacer"></span><button class="btn secondary" type="button" data-act="locate">${ICON.locate}<span>Select ${plural(t.nodeIds.length, 'layer')}</span></button></div>`;
  }
  ui.viewer.innerHTML = html;
}
function stepViewer(delta: number) {
  const v = state.viewer; if (!v) return;
  const list = viewerList(v.id), index = list.indexOf(v.id) + delta;
  if (index < 0 || index >= list.length) return;
  state.viewer = {id: list[index], zoom: v.zoom, scale: 1};
  renderViewer();
}
function locate(id: string) {
  if (id.startsWith('a:')) { const g = state.groups.find(x => assetId(x) === id); if (g) post({type: 'select', ids: g.occurrences.map(o => o.figmaNodeId)}); return; }
  const token = [...state.colors, ...state.gradients, ...state.texts].find(t => t.id === id);
  if (token) post({type: 'select', ids: token.nodeIds});
}
function rename(id: string, value: string) {
  const current = id.startsWith('a:') ? state.names.get(id.slice(2)) : [...state.colors, ...state.gradients, ...state.texts].find(t => t.id === id)?.name;
  if (value.trim() === current) return;
  if (value.trim()) state.renames.set(id, value.trim()); else state.renames.delete(id);
  regroup(false);
  renderContent(); renderFooter(); renderViewer();
}

// ---------- Settings ----------
function updateSettings(patch: Partial<Settings>) {
  const before = state.settings;
  state.settings = normalizeSettings({...before, ...patch});
  post({type: 'save-settings', settings: state.settings});
  const changed = (key: keyof Settings) => JSON.stringify(before[key]) !== JSON.stringify(state.settings[key]);
  if (state.scan && SCAN_SETTINGS.some(changed)) { toast('Rescanning to apply the new setting…'); startScan(); return; }
  if (state.scan && (changed('mergeTints') || changed('mergeSimilar') || changed('mergeColors'))) regroup();
  if (state.scan && changed('scales')) void prefetchVariants();
  renderAll(); if (state.viewer) renderViewer();
}
function openSettings() {
  const s = state.settings;
  const option = (key: keyof Settings, title: string, detail: string) => `<label class="option"><input type="checkbox" data-setting="${key}"${s[key] ? ' checked' : ''}><span>${title}<small>${detail}</small></span></label>`;
  ui.settings.innerHTML = `<div class="v-head"><h2 style="flex:1;margin:0 0 0 2px;font-size:13px">Settings</h2><button class="icon-btn" type="button" data-act="close" aria-label="Close">${ICON.close}</button></div>
    <div class="sheet-body">
      <h3>PNG resolutions</h3><p class="hint">Flutter picks the right density automatically from 2.0x/ and 3.0x/ folders.</p>
      <div class="row"><label class="option"><input type="checkbox" checked disabled><span>1x</span></label>${[2, 3].map(scale =>
        `<label class="option"><input type="checkbox" data-scale="${scale}"${s.scales.includes(scale) ? ' checked' : ''}><span>${scale}x</span></label>`).join('')}</div>
      <h3>Shadows and blur in vector art</h3><p class="hint">flutter_svg cannot draw SVG filters.</p>
      <label class="option"><input type="radio" name="effects" value="png"${s.effects === 'png' ? ' checked' : ''}><span>Keep the look<small>Export that artwork as PNG so the shadow or blur is preserved.</small></span></label>
      <label class="option"><input type="radio" name="effects" value="svg"${s.effects === 'svg' ? ' checked' : ''}><span>Keep it vector<small>Export SVG; the effect is dropped in Flutter.</small></span></label>
      <h3>Smart cleanup</h3>
      ${option('skipShapes', 'Skip plain shapes', 'Solid rectangles, circles and lines are built in Flutter with Container, DecoratedBox or Divider.')}
      ${option('mergeTints', 'Merge recolored icons', 'One SVG per shape; each use records its color for ColorFilter.')}
      ${option('mergeSimilar', 'Merge identical artwork at other sizes', 'Keeps the vector, or the largest PNG.')}
      ${option('mergeColors', 'Merge near-identical colors', 'Colors closer than ΔE 1 (invisible difference) become one token.')}
    </div>`;
  ui.settings.hidden = false;
  ui.settings.querySelector<HTMLElement>('[data-act=close]')?.focus();
}

// ---------- Events ----------
window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data?.pluginMessage;
  if (!msg || typeof msg.type !== 'string') return;
  switch (msg.type) {
    case 'init':
      state.settings = normalizeSettings(msg.settings); state.selection = msg.selection;
      renderAll();
      if (state.autoScan && state.selection.count) startScan(); // opened with a selection: preview right away
      state.autoScan = false;
      break;
    case 'selection': state.selection = msg.selection; renderHeader(); break;
    case 'progress':
      if (state.phase === 'scanning') setProgress(msg.text, msg.done, msg.total);
      break;
    case 'scan-result': void onScanResult(msg.scan); break;
    case 'scan-cancelled': state.phase = state.scan ? 'ready' : 'idle'; renderAll(); toast('Scan cancelled'); break;
    case 'error':
      state.phase = state.scan ? 'ready' : 'idle'; state.error = msg.message; renderAll(); toast(msg.message, 'error');
      break;
    case 'variant':
      if (variantJob && msg.requestId === variantJob.id) {
        const map = state.variants.get(msg.key) ?? new Map<number, Uint8Array>();
        map.set(msg.scale, msg.bytes); state.variants.set(msg.key, map);
        variantJob.done++;
        if (state.phase === 'exporting') setProgress('Exporting @2x/@3x PNGs…', variantJob.done, variantJob.total);
        else renderFooter();
      }
      break;
    case 'variants-done':
      if (variantJob && msg.requestId === variantJob.id) {
        for (const f of msg.failed ?? []) state.variantFailures.set(`${f.key}@${f.scale}`, f.reason);
        cancelVariantWait(); renderFooter(); renderTabs();
        if (state.viewer?.id.startsWith('a:')) renderViewer();
      }
      break;
  }
});

ui.scan.addEventListener('click', startScan);
ui.cancel.addEventListener('click', () => { post({type: 'cancel'}); setProgress('Cancelling…'); });
ui.download.addEventListener('click', () => void downloadZip());
ui.settingsButton.innerHTML = ICON.settings;
ui.settingsButton.addEventListener('click', openSettings);
ui.tabs.addEventListener('click', e => {
  const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
  if (!tab) return;
  state.tab = tab.dataset.tab as Tab; renderTabs(); renderToolbar(); renderContent(); ui.content.scrollTop = 0;
});
ui.tabs.addEventListener('keydown', e => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const tabs = Object.keys(TAB_LABELS) as Tab[], next = tabs[(tabs.indexOf(state.tab) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  state.tab = next; renderTabs(); renderToolbar(); renderContent();
  ui.tabs.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
});

ui.toolbar.innerHTML = `<label class="search">${ICON.search}<input id="search" type="search" placeholder="Search names, screens, colors" aria-label="Search" autocomplete="off"></label>
  <select id="sort" class="select" aria-label="Sort"><option value="order">Design order</option><option value="uses">Most used</option><option value="name">Name</option><option value="size">File size</option></select>
  <div id="bg" class="seg" role="group" aria-label="Preview background">${([['auto', ICON.auto, 'Automatic background'], ['checker', ICON.checker, 'Checkerboard'], ['light', ICON.light, 'Light'], ['dark', ICON.dark, 'Dark']] as const)
    .map(([value, icon, title]) => `<button type="button" data-bg="${value}" title="${title}" aria-label="${title}">${icon}</button>`).join('')}</div>
  <label id="all-wrap" class="check-all" title="Include or exclude everything shown"><input id="all" type="checkbox"> All</label>`;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
$<HTMLInputElement>('#search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.query = (e.target as HTMLInputElement).value.trim().toLowerCase(); renderToolbar(); renderContent(); }, 90);
});
$<HTMLSelectElement>('#sort').addEventListener('change', e => { state.sort = (e.target as HTMLSelectElement).value; renderContent(); });
$('#bg').addEventListener('click', e => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-bg]'); if (b) updateSettings({background: b.dataset.bg as Settings['background']}); });
$<HTMLInputElement>('#all').addEventListener('change', e => setIncluded(currentIds(), (e.target as HTMLInputElement).checked));

ui.content.addEventListener('load', e => (e.target as HTMLElement).classList?.add('ready'), true);
ui.content.addEventListener('error', e => (e.target as HTMLElement).classList?.add('ready'), true);
ui.content.addEventListener('click', e => {
  const target = e.target as HTMLElement;
  const toggle = target.closest<HTMLInputElement>('input[data-toggle]');
  if (toggle) { setIncluded([toggle.dataset.toggle!], toggle.checked); return; }
  if (target.closest('.check')) return; // the label forwards a click to its checkbox
  const locateButton = target.closest<HTMLElement>('[data-locate]');
  if (locateButton) { post({type: 'select', ids: [locateButton.dataset.locate!]}); return; }
  const open = target.closest<HTMLElement>('[data-open]');
  if (open) openViewer(open.dataset.open!);
});
ui.content.addEventListener('keydown', e => {
  const item = (e.target as HTMLElement).closest<HTMLElement>('[data-open]');
  if (!item || e.target !== item) return;
  if (e.key === 'Enter') { e.preventDefault(); openViewer(item.dataset.open!); }
  if (e.key === ' ') { e.preventDefault(); setIncluded([item.dataset.open!], !included(item.dataset.open!)); }
});

ui.viewer.addEventListener('click', e => {
  const target = e.target as HTMLElement, v = state.viewer;
  if (!v) return;
  const toggle = target.closest<HTMLInputElement>('input[data-toggle]');
  if (toggle) { setIncluded([v.id], toggle.checked); return; }
  const copy = target.closest<HTMLElement>('[data-copy]');
  if (copy) { copyText(copy.dataset.copy!); return; }
  const button = target.closest<HTMLElement>('[data-act]');
  if (!button) return;
  const value = button.dataset.value!;
  switch (button.dataset.act) {
    case 'close': closeViewer(); break;
    case 'prev': stepViewer(-1); break;
    case 'next': stepViewer(1); break;
    case 'locate': locate(v.id); break;
    case 'zoom': v.zoom = value as ViewerState['zoom']; renderViewer(); break;
    case 'scale': v.scale = Number(value); renderViewer(); break;
    case 'bg': updateSettings({background: value as Settings['background']}); break;
    case 'download-one': { const g = state.groups.find(x => assetId(x) === v.id); if (g) downloadOne(g, v.scale); break; }
  }
});
ui.viewer.addEventListener('change', e => {
  const input = e.target as HTMLInputElement;
  if (input.dataset.rename) rename(input.dataset.rename, input.value);
});
ui.viewer.addEventListener('keydown', e => {
  const input = e.target as HTMLInputElement;
  if (input.dataset?.rename && e.key === 'Enter') { input.blur(); }
});

ui.settings.addEventListener('click', e => { if ((e.target as HTMLElement).closest('[data-act=close]')) ui.settings.hidden = true; });
ui.settings.addEventListener('change', e => {
  const input = e.target as HTMLInputElement;
  if (input.dataset.setting) updateSettings({[input.dataset.setting]: input.checked} as Partial<Settings>);
  else if (input.dataset.scale) {
    const scale = Number(input.dataset.scale);
    updateSettings({scales: input.checked ? [...state.settings.scales, scale] : state.settings.scales.filter(s => s !== scale)});
  } else if (input.name === 'effects') updateSettings({effects: input.value as Settings['effects']});
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!ui.settings.hidden) { ui.settings.hidden = true; ui.settingsButton.focus(); return; }
    if (state.viewer) { const id = state.viewer.id; closeViewer(); document.querySelector<HTMLElement>(`[data-open="${CSS.escape(id)}"]`)?.focus(); return; }
  }
  const typing = (e.target as HTMLElement).matches?.('input, select, textarea');
  if (state.viewer && !typing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); stepViewer(e.key === 'ArrowLeft' ? -1 : 1); }
  if (!state.viewer && !typing && e.key === '/' && !ui.toolbar.hidden) { e.preventDefault(); $<HTMLInputElement>('#search').focus(); }
});

// Resizable window: Figma plugin windows are resized from the sandbox.
ui.grip.addEventListener('pointerdown', e => {
  ui.grip.setPointerCapture(e.pointerId);
  let frame = 0;
  const move = (ev: PointerEvent) => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => post({type: 'resize', width: Math.round(ev.clientX + 6), height: Math.round(ev.clientY + 6)}));
  };
  const up = () => { ui.grip.removeEventListener('pointermove', move); ui.grip.removeEventListener('pointerup', up); };
  ui.grip.addEventListener('pointermove', move); ui.grip.addEventListener('pointerup', up);
});

renderAll();
post({type: 'ready'});
