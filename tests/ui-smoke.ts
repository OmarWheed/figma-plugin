// End-to-end check of the real plugin UI with a fake Figma sandbox behind `parent.postMessage`.
// Loaded before the UI bundle, so the fake parent is in place when the UI posts "ready".
import JSZip from 'jszip';
type Msg = {type: string; [key: string]: any};
const sent: Msg[] = [];
const downloads: Promise<{name: string; blob: Blob}>[] = [];
const checks: string[] = [];
const encode = (s: string) => new TextEncoder().encode(s);
const deliver = (msg: Msg) => setTimeout(() => window.dispatchEvent(new MessageEvent('message', {data: {pluginMessage: msg}})), 0);
const svg = (body: string, size = 24) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none">${body}</svg>`;
const bell = (color: string) => `<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0" stroke="${color}" stroke-width="2" stroke-linecap="round"/>`;
async function photo(width: number, height: number) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d')!, g = ctx.createLinearGradient(0, 0, width, height);
  g.addColorStop(0, '#2a6'); g.addColorStop(1, '#a42'); ctx.fillStyle = g; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#fc0'; ctx.beginPath(); ctx.arc(width * 0.3, height * 0.4, width * 0.15, 0, 7); ctx.fill();
  const blob = await new Promise<Blob>(resolve => canvas.toBlob(b => resolve(b!), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}
const asset = (key: string, kind: 'svg' | 'image', name: string, bytes: Uint8Array, width = 24, height = 24) =>
  ({key, kind, name, layerName: 'Vector', figmaNodeId: `node_${key}`, screen: 'Home', screenNodeId: 'screen1', width, height, bytes,
    occurrences: [{figmaNodeId: `node_${key}`, screen: 'Home', screenNodeId: 'screen1'}], effects: []});

async function scanResult() {
  return {
    zipName: 'home_assets.zip', screens: [{name: 'Home', figmaNodeId: 'screen1'}], durationMs: 5,
    assets: [
      asset('a1', 'svg', 'Bell', encode(svg(bell('#111111')))),
      asset('a2', 'svg', 'Bell', encode(svg(bell('#9E9E9E')))),
      asset('a3', 'image', 'Hero image', await photo(200, 150), 200, 150),
      asset('a4', 'image', 'Hero image', await photo(100, 75), 100, 75),
      asset('a5', 'svg', 'Search', encode(svg('<circle cx="11" cy="11" r="7" stroke="#111111" stroke-width="2"/>')))
    ],
    colors: [{key: '1E65D6FF', r: 30, g: 101, b: 214, a: 1, uses: 5, nodeIds: ['n1'], names: ['Brand/Primary']},
      {key: 'FFFFFFFF', r: 255, g: 255, b: 255, a: 1, uses: 3, nodeIds: ['n2'], names: []}],
    gradients: [{key: 'g1', type: 'linear', transform: [[1, 0, 0], [0, 1, 0]], uses: 1, nodeIds: ['n3'], names: [],
      stops: [{r: 255, g: 0, b: 0, a: 1, position: 0}, {r: 0, g: 0, b: 255, a: 1, position: 1}]}],
    typography: [{key: 't1', fontFamily: 'Inter', fontStyle: 'Bold', fontWeight: 700, italic: false, fontSize: 24,
      lineHeight: {unit: 'PIXELS', value: 32}, letterSpacing: {unit: 'PIXELS', value: 0}, uses: 12, nodeIds: ['n4'], names: []}],
    fonts: [{fontFamily: 'Inter', fontStyle: 'Bold', uses: 12}],
    skipped: [{nodeId: 'n9', name: 'Rectangle 4', reason: 'Simple shape: build it in Flutter (Container, DecoratedBox or Divider)'}]
  };
}

// The fake sandbox.
Object.defineProperty(window, 'parent', {configurable: true, value: {postMessage(data: {pluginMessage: Msg}) {
  const msg = data.pluginMessage; sent.push(msg);
  if (msg.type === 'ready') deliver({type: 'init', settings: {}, selection: {count: 1, label: 'Frame “Home”'}});
  if (msg.type === 'scan') { deliver({type: 'progress', text: 'Exporting assets… 1/5', done: 1, total: 5}); void scanResult().then(scan => deliver({type: 'scan-result', scan})); }
  if (msg.type === 'variants') {
    void (async () => {
      for (const item of msg.items) for (const scale of item.scales) deliver({type: 'variant', requestId: msg.requestId, key: item.key, scale, bytes: await photo(200 * scale, 150 * scale)});
      deliver({type: 'variants-done', requestId: msg.requestId, failed: []});
    })();
  }
}}});
HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
  const name = this.download;
  downloads.push(fetch(this.href).then(r => r.blob()).then(blob => ({name, blob})));
};

function assert(condition: unknown, message: string) { if (!condition) throw new Error(message); checks.push(message); }
async function waitFor<T>(probe: () => T, what: string, timeout = 15000): Promise<NonNullable<T>> {
  const start = performance.now();
  for (;;) {
    const value = probe();
    if (value) return value as NonNullable<T>;
    if (performance.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector(selector) as T | null;
const count = (tab: string) => Number($(`[data-tab="${tab}"] .count`)?.textContent);
const click = (selector: string) => { const el = $(selector); if (!el) throw new Error(`Missing ${selector}`); el.click(); };

async function run() {
  await waitFor(() => document.querySelectorAll('.card').length, 'preview cards');
  assert(sent.some(m => m.type === 'scan' && m.settings?.scales), 'Opening with a selection scans automatically');
  assert(count('images') === 1 && count('svgs') === 2 && count('colors') === 3 && count('text') === 1 && count('skipped') === 1, 'Tabs show unique counts after merging');
  assert($('#summary')!.textContent!.includes('3 files') && $('#summary')!.textContent!.includes('1 recolored'), 'Footer summarises files and merges');
  assert($('.card .badge.similar'), 'Resized photo copy is merged and badged');

  click('[data-tab="svgs"]');
  await waitFor(() => document.querySelectorAll('.card').length === 2, 'SVG cards');
  const bellCard = await waitFor(() => [...document.querySelectorAll<HTMLElement>('.card')].find(c => c.textContent!.includes('bell')), 'bell card');
  assert(bellCard.querySelectorAll('.dot').length === 2, 'Recolored icon shows its colors');
  bellCard.click();
  const nameInput = await waitFor(() => $<HTMLInputElement>('#viewer:not([hidden]) .name-input'), 'viewer');
  assert(nameInput.value === 'bell' && $('#viewer')!.textContent!.includes('colorFilter'), 'Viewer shows the asset with its Flutter usage');
  nameInput.value = 'Notification Bell'; nameInput.dispatchEvent(new Event('change', {bubbles: true}));
  await waitFor(() => $<HTMLInputElement>('#viewer .name-input')?.value === 'notification_bell', 'rename');
  click('#viewer [data-act="close"]');
  assert($('#viewer')!.hidden && [...document.querySelectorAll('.card .name')].some(n => n.textContent === 'notification_bell'), 'Rename updates the gallery');

  const searchToggle = await waitFor(() => [...document.querySelectorAll<HTMLElement>('.card')].find(c => c.textContent!.includes('search'))?.querySelector<HTMLInputElement>('input[data-toggle]'), 'search toggle');
  searchToggle.click();
  assert(searchToggle.closest('.card')!.classList.contains('off') && $('#summary')!.textContent!.includes('2 files'), 'Excluding an asset updates the summary');

  click('[data-tab="colors"]');
  await waitFor(() => document.querySelectorAll('.swatch').length === 3, 'swatches');
  click('.swatch[data-open="c:1E65D6FF"]');
  await waitFor(() => $('#viewer:not([hidden])')?.textContent?.includes('AppColors.brandPrimary'), 'color viewer');
  click('#viewer [data-act="locate"]');
  assert(sent.some(m => m.type === 'select' && m.ids?.[0] === 'n1'), 'Locate selects the layers that use a color');
  document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
  assert($('#viewer')!.hidden, 'Escape closes the viewer');

  click('#open-settings');
  const tints = await waitFor(() => $<HTMLInputElement>('#settings [data-setting="mergeTints"]'), 'settings');
  tints.click();
  await waitFor(() => count('svgs') === 3, 'unmerged recolored icon');
  assert(sent.some(m => m.type === 'save-settings' && m.settings.mergeTints === false), 'Settings are saved');
  $<HTMLInputElement>('#settings [data-setting="mergeTints"]')!.click();
  await waitFor(() => count('svgs') === 2, 'merged again');
  click('#settings [data-act="close"]');

  const search = $<HTMLInputElement>('#search')!;
  click('[data-tab="images"]');
  search.value = 'zzz'; search.dispatchEvent(new Event('input', {bubbles: true}));
  await waitFor(() => $('.none')?.textContent?.includes('No matches'), 'empty search');
  search.value = ''; search.dispatchEvent(new Event('input', {bubbles: true}));
  await waitFor(() => document.querySelectorAll('.card').length === 1, 'search cleared');

  await waitFor(() => sent.some(m => m.type === 'variants') && !$('#summary')!.textContent!.includes('@2x/@3x'), '@2x/@3x prefetch');
  click('#download');
  const file = await waitFor(() => downloads[0], 'ZIP download').then(p => p);
  assert(file.name === 'home_assets.zip', 'ZIP is named after the screen');
  const zip = await JSZip.loadAsync(await file.blob.arrayBuffer());
  const files = Object.keys(zip.files);
  for (const path of ['assets/icons/notification_bell.svg', 'assets/images/hero_image.png', 'assets/images/2.0x/hero_image.png', 'assets/images/3.0x/hero_image.png',
    'lib/generated/app_assets.dart', 'lib/generated/app_colors.dart', 'lib/generated/app_gradients.dart', 'lib/generated/app_text_styles.dart',
    'tokens/colors.json', 'metadata/assets_manifest.json', 'metadata/export_report.json']) assert(files.includes(path), `ZIP contains ${path}`);
  assert(!files.some(f => f.includes('search')), 'Excluded asset is not in the ZIP');
  assert((await zip.file('lib/generated/app_colors.dart')!.async('string')).includes('static const Color brandPrimary = Color(0xFF1E65D6);'), 'AppColors uses the Figma variable name');
  assert((await zip.file('assets/images/hero_image.png')!.async('uint8array')).length > 0 && sent.some(m => m.type === 'notify'), 'Download completes and notifies Figma');
  click('[data-tab="skipped"]');
  await waitFor(() => $('.skipped [data-locate="n9"]'), 'skipped list');
  checks.push('Skipped layers are listed with a Locate action');
  document.title = 'PASS';
  document.body.setAttribute('data-result', JSON.stringify({passed: checks.length, checks}));
}
window.addEventListener('load', () => {
  run().catch(error => { document.title = 'FAIL'; document.body.setAttribute('data-result', JSON.stringify({error: String(error), checks})); });
});
