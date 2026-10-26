# Flutter Assets Exporter

## Build
1. Install Node.js 20+.
2. Run `npm install`, then `npm run build`.
3. In Figma Desktop choose Plugins > Development > Import plugin from manifest, select `manifest.json`. If you create the plugin with Figma first, keep Figma's generated plugin ID instead of the placeholder `REPLACE_WITH_FIGMA_GENERATED_PLUGIN_ID`.
4. Select one or more Frames or Groups. Run Plugins > Development > Flutter Assets Exporter. Nested selections are scanned once.
5. Click **Export Selected Frames as ZIP**. Unzip into the Flutter project root, copying `assets/`, `metadata/`, `tokens/`, and `lib/generated/`.
6. Copy `flutter-example/.cursor/rules/figma-assets.mdc` to the actual Flutter project's `.cursor/rules/figma-assets.mdc`.
7. In `pubspec.yaml` register `assets/icons/` and `assets/images/`; run `flutter pub add flutter_svg` and `flutter pub get`.
8. Use `AppAssets` constants from `lib/generated/app_assets.dart`, e.g. `SvgPicture.asset(AppAssets.iconHome)`.

## Export behavior
- Vector artwork exports as SVG. Pure vector groups/components stay together without requiring special names. Frames named `icon/...` can also export as combined vector artwork.
- Photos and image compositions export as rendered PNG. Non-layout compositions without text are combined automatically, including overlays and masks. For mixed artwork with text, name the enclosing container `photo`, `image`, `illustration`, `collage`, `avatar`, or `banner` to make the asset boundary explicit. Ordinary layouts are traversed instead of flattened as a screenshot.
- Sibling masks are exported with their affected siblings. Temporary copies are removed in `finally`, including when export fails. Original layers are not edited. Complex ancestor effects/clipping can still depend on where the asset boundary is placed: group the complete composition when necessary.
- Hidden/fully transparent layers and named system status/home/navigation indicators are excluded. Ordinary app navigation is retained. System UI detection uses layer names, so generically named system shapes cannot always be identified automatically.
- Every exported SVG/PNG is rendered in the plugin UI before ZIP creation. Fully transparent, malformed, or unrenderable files are omitted and reported. SVGs that contain rasterized Figma output are exported as PNG instead.
- SVG deduplication compares normalized XML, including generated IDs and references. PNG deduplication compares full decoded RGBA pixels with collision checks, so encoding differences do not produce copies. Different dimensions, crops, colors, or vector geometry are retained; there is no lossy similarity matching.
- A shared asset has one file, one manifest entry and one Dart constant. All source nodes and screen usages are retained in `occurrences` and `screen_mapping.json`.
- Colors, typography styles and font family/style pairs are unique token entries. Text is read by styled runs; typography/font usage counts characters. Fonts are metadata, not downloadable font binaries. Colors currently include solid RGB fills/strokes, without gradients or opacity variants.
- `metadata/export_report.json` lists empty outputs, duplicate counts, skipped layers and export/rendering failures. Assets over 32 megapixels or 16,384 pixels per side are omitted with a validation-limit reason to bound browser memory use.
- Processing is local, with no network or AI service. The ZIP is downloaded for manual extraction into Flutter.

## Checks
Run `npm run check`, `npm test`, then `npm run build`. Tests cover extraction with Figma API mocks and actual SVG/PNG rendering plus ZIP contents in headless Chrome/Edge. Set `CHROME_BINARY` if the browser is installed elsewhere. A live Figma design still needs an in-app export to validate its particular composition boundaries.
