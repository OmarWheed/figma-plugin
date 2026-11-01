import {analyzeScan, buildZip, canonicalSvg, groupAssets, assignNames, manifestEntries, mergeStats, renderPixels, tintSignature, type Analyzed} from '../src/prepare-export';
import {buildGradients, buildPalette, buildTextStyles, dartGradients, dartTextStyles, deltaE2000, generatedColorName, gradientGeometry, toLab} from '../src/tokens';
import {slug, type ScanAsset, type ScanResult} from '../src/shared';
const checks: string[] = [];
function assert(condition: unknown, message: string) { if (!condition) throw new Error(message); checks.push(message); }
const encode = (s: string) => new TextEncoder().encode(s);
const svg = (body: string, size = 24) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none">${body}</svg>`;
const bell = (color = '#111111') => `<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
const dot = '<circle cx="18" cy="5" r="3" fill="#111111"/>';

async function png(width: number, height: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  draw(canvas.getContext('2d')!, width, height);
  const blob = await new Promise<Blob>(resolve => canvas.toBlob(b => resolve(b!), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}
function photo(ctx: CanvasRenderingContext2D, w: number, h: number) {
  let seed = 1; const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const g = ctx.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#2a6'); g.addColorStop(1, '#a42'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 60; i++) { ctx.fillStyle = `hsl(${rand() * 360},70%,${30 + rand() * 40}%)`; ctx.beginPath(); ctx.arc(rand() * w, rand() * h, rand() * w * 0.15, 0, 7); ctx.fill(); }
}
function asset(key: string, kind: 'svg' | 'image', bytes: Uint8Array, {screen = 'screen1', uses = 1, name = key, reason = undefined as string | undefined} = {}): ScanAsset {
  return {key, kind, name, layerName: name, figmaNodeId: `${key}_0`, screen, screenNodeId: screen, width: 24, height: 24, bytes,
    occurrences: Array.from({length: uses}, (_, i) => ({figmaNodeId: `${key}_${i}`, screen, screenNodeId: screen})), effects: [], reason};
}
const scanOf = (assets: ScanAsset[]): ScanResult => ({zipName: 'test.zip', screens: [{name: 'First', figmaNodeId: 'screen1'}, {name: 'Second', figmaNodeId: 'screen2'}],
  assets, colors: [], gradients: [], typography: [], fonts: [{fontFamily: 'Inter', fontStyle: 'Regular', uses: 5}], skipped: [], durationMs: 1});
const near = (a: number, b: number, tolerance = 1e-4) => Math.abs(a - b) <= tolerance;

async function run() {
  // Rendering and canonical SVG comparison (kept from the original suite).
  const first = svg('<defs><clipPath id="clip_A"><rect width="24" height="24"/></clipPath></defs><path clip-path="url(#clip_A)" d="M2 2H20V20H2Z" fill="red"/>');
  const second = first.replaceAll('clip_A', 'clip_B');
  assert(canonicalSvg(first) === canonicalSvg(second), 'Generated SVG IDs do not create duplicates');
  assert(canonicalSvg(first) !== canonicalSvg(first.replace('red', 'blue')), 'Different SVG colors remain distinct');
  assert(!(await renderPixels(encode(svg('<path d=""/>')), 'svg')).painted, 'Empty path is rejected');
  assert(!(await renderPixels(encode(svg('<g opacity="0"><rect width="24" height="24"/></g>')), 'svg')).painted, 'Invisible SVG geometry is rejected');
  assert((await renderPixels(encode(svg('<path d="M2 2L20 20" stroke="black" stroke-width="0.25"/>')), 'svg')).painted, 'Thin visible strokes are kept');
  let rejected = false; try { canonicalSvg(svg('<image href="data:image/png;base64,AA=="/>')); } catch { rejected = true; }
  assert(rejected, 'Raster content is not accepted as vector SVG');
  assert(tintSignature(canonicalSvg(svg(bell('white'))))?.color === '#FFFFFF' && !tintSignature(canonicalSvg(svg(bell() + '<path d="M1 1" stroke="red"/>'))), 'Tint signature only for single-color SVGs');

  // Analysis and grouping.
  const red = await png(24, 24, (c) => { c.fillStyle = 'red'; c.fillRect(0, 0, 24, 24); });
  const redVariant = new Uint8Array(red.length + 3); redVariant.set(red); redVariant.set([1, 2, 3], red.length); // same pixels, different bytes
  const big = await png(200, 150, photo), small = await png(100, 75, photo);
  const scan = scanOf([
    asset('one', 'svg', encode(first), {uses: 2}),
    asset('two', 'svg', encode(second), {screen: 'screen2', uses: 3}),
    asset('blank', 'svg', encode(svg('<rect width="24" height="24" fill="none"/>'))),
    asset('photo', 'image', red),
    asset('photo_copy', 'image', redVariant, {screen: 'screen2'}),
    asset('bell', 'svg', encode(svg(bell()))),
    asset('bell_gray', 'svg', encode(svg(bell('#9E9E9E'))), {screen: 'screen2'}),
    asset('bell_large', 'svg', encode(svg(bell(), 48))),
    asset('bell_badge', 'svg', encode(svg(bell() + dot))),
    asset('hero_small', 'image', small, {reason: 'Shadow/blur kept by exporting PNG'}),
    asset('hero', 'image', big)
  ]);
  const items = await analyzeScan(scan);
  const byKey = (key: string) => items.find(i => i.key === key) as Analyzed;
  assert(byKey('blank').status === 'empty', 'Transparent SVG is detected as empty');
  assert(byKey('two').duplicateOf === 'one' && byKey('photo_copy').duplicateOf === 'photo', 'Exact SVG structure and exact pixels are duplicates');
  assert(byKey('hero').width === 200 && byKey('hero').thumb?.startsWith('blob:'), 'Rendered size and preview thumbnail recorded');

  const groups = groupAssets(items, {mergeTints: true, mergeSimilar: true});
  const groupOf = (key: string) => groups.find(g => g.members.some(m => m.item.key === key))!;
  assert(groupOf('two') === groupOf('one') && groupOf('one').occurrences.length === 5, 'All SVG occurrences survive deduplication');
  assert(groupOf('bell_gray') === groupOf('bell') && groupOf('bell').tints.join() === '#111111,#9E9E9E', 'Recolored icon merged into one tintable SVG');
  assert(groupOf('bell').occurrences.find(o => o.figmaNodeId === 'bell_gray_0')?.tint === '#9E9E9E', 'Each occurrence keeps its tint color');
  assert(groupOf('bell_large') === groupOf('bell'), 'Same icon at 48 px merged with the 24 px one');
  assert(groupOf('bell_badge') !== groupOf('bell'), 'Icon with an extra badge dot is not merged');
  assert(groupOf('hero_small') === groupOf('hero') && groupOf('hero').primary.key === 'hero', 'Same photo at half size merged; the larger PNG is kept');
  assert(groupOf('hero').first.key === 'hero_small', 'Merged group keeps design order for naming');
  assert(groups.length === 5, 'Eleven inputs become five files');
  const plain = groupAssets(items, {mergeTints: false, mergeSimilar: false});
  assert(plain.length === 8, 'Merging recolored and resized artwork can be turned off');
  const stats = mergeStats(groups);
  assert(stats.tint === 1 && stats.similar === 2 && stats.files + stats.exact + stats.tint + stats.similar === stats.occurrences, 'Merge statistics add up');

  // ZIP contents.
  const names = assignNames(groups, new Map([[`a:${groupOf('hero').id}`, 'Hero Banner']]));
  assert(names.get(groupOf('hero').id) === 'hero_banner', 'User renames become file names');
  const variants = new Map([[byKey('hero').key, new Map([[2, new Uint8Array([2])], [3, new Uint8Array([3])]])]]);
  const included = groups.filter(g => g !== groupOf('bell_badge'));
  const zip = buildZip({scan, groups: included, names, variants, scales: [1, 2, 3], colors: [], gradients: [], textStyles: [], notes: [],
    excludedAssets: [{id: names.get(groupOf('bell_badge').id)!, path: 'assets/icons/bell_badge.svg'}]});
  const files = Object.keys(zip.files);
  assert(files.includes('assets/images/hero_banner.png') && files.includes('assets/images/2.0x/hero_banner.png') && files.includes('assets/images/3.0x/hero_banner.png'), 'PNG exported with Flutter 2.0x/3.0x variants');
  assert(!files.some(f => f.includes('blank') || f.includes('photo_copy') || f.includes('bell_badge') || f.includes('bell_gray')), 'ZIP omits empty, duplicate, merged and excluded files');
  const manifest = JSON.parse(await zip.file('metadata/assets_manifest.json')!.async('string'));
  const bellEntry = manifest.assets.find((a: {id: string}) => a.id === 'bell');
  assert(manifest.version === 3 && bellEntry.tintable && bellEntry.tints.length === 2 && bellEntry.uses === 3, 'Manifest records tintable icons and every use');
  const mapping = JSON.parse(await zip.file('metadata/screen_mapping.json')!.async('string'));
  const secondScreen = mapping.screens.find((s: {figmaNodeId: string}) => s.figmaNodeId === 'screen2');
  assert(secondScreen.assets.find((a: {id: string}) => a.id === 'one').figmaNodeIds[0] === 'two_0', 'Screen mapping uses the correct source node after merging');
  const report = JSON.parse(await zip.file('metadata/export_report.json')!.async('string'));
  assert(report.summary.excludedByUser === 1 && report.excludedByUser[0].path.endsWith('bell_badge.svg'), 'Report lists assets excluded by the user');
  const dart = await zip.file('lib/generated/app_assets.dart')!.async('string');
  assert(dart.includes("static const String heroBanner = 'assets/images/hero_banner.png';") && dart.includes('tintable'), 'AppAssets constants generated');
  assert((await zip.file('metadata/pubspec_snippet.yaml')!.async('string')).includes('- assets/icons/'), 'pubspec snippet generated');
  const entries = manifestEntries([{...groups[0], id: 'x1'}, {...groups[0], id: 'x2'}, {...groups[0], id: 'x3'}, {...groups[0], id: 'x4'}],
    new Map([['x1', 'icon_1'], ['x2', 'icon1'], ['x3', 'class'], ['x4', '123']]), new Map(), [1]);
  const ids = entries.map(e => e.dartName);
  assert(new Set(ids).size === 4 && ids.every(n => /^[a-zA-Z]/.test(n) && n !== 'class'), 'Dart identifiers are valid and unique');
  await zip.generateAsync({type: 'uint8array'});

  // Colors.
  assert(near(deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485]), 2.0425) && near(deltaE2000([50, 2.5, 0], [73, 25, -18]), 27.1492)
    && near(deltaE2000([60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387]), 1.2644), 'CIEDE2000 matches published reference values');
  assert(near(toLab({r: 255, g: 255, b: 255, a: 1})[0], 100, 0.01), 'sRGB to Lab');
  const raw = (key: string, r: number, g: number, b: number, uses: number, names: string[] = [], a = 1) => ({key, r, g, b, a, uses, nodeIds: [key], names});
  const palette = buildPalette([raw('a', 30, 101, 214, 10), raw('b', 30, 101, 215, 2), raw('c', 255, 255, 255, 4), raw('d', 242, 242, 242, 3),
    raw('e', 0, 0, 0, 2, [], 0.1), raw('f', 103, 80, 164, 1, ['Brand/Primary']), raw('g', 103, 80, 165, 1, ['Brand/Accent'])], true);
  assert(palette.length === 6 && palette.find(c => c.hex === '#1E65D6')?.aliases[0] === '#1E65D7', 'Imperceptible color differences merged into the most used color');
  assert(palette.some(c => c.name === 'white') && palette.some(c => c.name === 'gray100') && palette.some(c => c.name === 'blackAlpha10'), 'Generated color names');
  assert(palette.some(c => c.name === 'brandPrimary') && palette.some(c => c.name === 'brandAccent'), 'Figma style/variable names win and are never merged together');
  assert(buildPalette([raw('a', 30, 101, 214, 10), raw('b', 30, 101, 215, 2)], false).length === 2, 'Color merging can be turned off');
  assert(generatedColorName({r: 59, g: 130, b: 246, a: 1}) === 'blue500', 'Hue family and lightness step');

  // Gradients and text styles.
  const geometry = gradientGeometry([[0, 1, 0], [-1, 0, 1]]);
  assert(near(geometry.begin.x, 0.5) && near(geometry.begin.y, 0) && near(geometry.end.y, 1), 'Figma gradient transform converted to handles');
  const gradients = buildGradients([{key: 'k', type: 'linear', transform: [[0, 1, 0], [-1, 0, 1]], uses: 2, nodeIds: [], names: [],
    stops: [{r: 255, g: 0, b: 0, a: 1, position: 0}, {r: 0, g: 0, b: 255, a: 1, position: 1}]}]);
  const gradientDart = dartGradients(gradients)!;
  assert(gradients[0].name === 'redToBlue' && gradientDart.includes('begin: Alignment(0.0, -1.0)') && gradientDart.includes('Color(0xFFFF0000)'), 'LinearGradient constant generated');
  const texts = buildTextStyles([
    {key: 'a', fontFamily: 'Inter', fontStyle: 'Semi Bold', fontWeight: 600, italic: false, fontSize: 16, lineHeight: {unit: 'PIXELS', value: 24}, letterSpacing: {unit: 'PERCENT', value: -2}, uses: 30, nodeIds: [], names: []},
    {key: 'b', fontFamily: 'Inter', fontStyle: 'Semi Bold', fontWeight: 600, italic: false, fontSize: 16, lineHeight: {unit: 'PIXELS', value: 20}, letterSpacing: {unit: 'PIXELS', value: 0}, uses: 3, nodeIds: [], names: []},
    {key: 'c', fontFamily: 'Inter', fontStyle: 'Bold', fontWeight: 700, italic: false, fontSize: 32, lineHeight: {unit: 'AUTO', value: 0}, letterSpacing: {unit: 'PIXELS', value: 0}, uses: 5, nodeIds: [], names: ['Heading/H1']}
  ]);
  const textDart = dartTextStyles(texts)!;
  const textNames = texts.map(t => t.name).sort().join();
  assert(textNames === 'headingH1,interSemiBold16,interSemiBold16H20', `Text style names are unique and readable (${textNames})`);
  assert(textDart.includes('fontWeight: FontWeight.w600') && textDart.includes('height: 1.5') && textDart.includes('letterSpacing: -0.32'), 'TextStyle constants generated');
  assert(slug('الرئيسية') === 'alryysya' && slug('HomeIcon') === 'home_icon', 'Arabic and camelCase layer names become readable file names');

  document.body.textContent = JSON.stringify({passed: checks.length, checks});
  document.title = 'PASS';
}
run().catch(error => { document.title = 'FAIL'; document.body.textContent = JSON.stringify({error: String(error), checks}); });
