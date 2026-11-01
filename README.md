# Flutter Assets Exporter

## Build
1. Install Node.js 20+.
2. Run `npm install`, then `npm run build`.
3. In Figma Desktop choose Plugins > Development > Import plugin from manifest, select `manifest.json`. If you create the plugin with Figma first, keep Figma's generated plugin ID instead of the placeholder `REPLACE_WITH_FIGMA_GENERATED_PLUGIN_ID`.
4. Select one or more Frames or Groups. Run Plugins > Development > Flutter Assets Exporter. Nested selections are scanned once.
5. Unzip the download into the Flutter project root, copying `assets/`, `metadata/`, `tokens/`, and `lib/generated/`.
6. Copy `flutter-example/.cursor/rules/figma-assets.mdc` to the actual Flutter project's `.cursor/rules/figma-assets.mdc`.
7. Merge `metadata/pubspec_snippet.yaml` into `pubspec.yaml`; run `flutter pub add flutter_svg` and `flutter pub get`.
8. Use `AppAssets` constants from `lib/generated/app_assets.dart`, e.g. `SvgPicture.asset(AppAssets.iconHome)` for SVGs and `Image.asset(AppAssets.x)` for PNGs.

## Workflow
1. **Scan.** Opening the plugin with a selection scans it automatically. Nothing is downloaded yet.
2. **Review.** The preview gallery has tabs for Images, SVGs, Colors, Text and Skipped.
3. **Download.** Click **Download ZIP** to build the export. Nothing is written until then.

In the gallery, click any preview to open it full size. From there you can:
- Rename the asset.
- Include or exclude it from the export.
- Use **Locate in Figma** to jump to the source layer.
- Download a single file.
- Copy a Flutter snippet for it.

## Duplicates and merging
Repeats are reduced automatically. Each rule can be turned off in Settings.
- **Exact duplicates** are removed. One file and one Dart constant are kept, and every source node is recorded in `occurrences`.
- **Recolored single-color icons** are merged into one tintable SVG. Each occurrence records its `tint`. Use `colorFilter: ColorFilter.mode(color, BlendMode.srcIn)` with that color.
- **The same artwork at another size** is merged into one asset. The largest PNG is kept.
- **Near-identical colors** (CIEDE2000 difference of 1 or less) are merged.

## Colors and text
- The color palette uses Figma variable or style names when they exist. Otherwise it generates names such as `blue600`, `gray100` or `blackAlpha10`.
- Gradients are included in `app_gradients.dart`.
- Text styles are written to `app_text_styles.dart`.

## Effects
Vector art with a shadow or blur is exported as PNG by default, because `flutter_svg` ignores SVG filters. A setting keeps these as SVG instead.

## PNG resolutions
PNGs are exported at 1x. They are also exported to `assets/images/2.0x/` and `assets/images/3.0x/`. Flutter selects these variants automatically. The extra variants are prepared in the background while you review.

## Detection
- Plain rectangles, circles and lines are skipped. This can be turned off.
- Figma export settings on a node are respected.
- Icons wrapped in frames are kept whole.
- A row of separate icons is split into individual assets.
- Generic layer names such as `Vector 12` are replaced with the component name or a nearby text label.
- Arabic names are transliterated into ASCII identifiers.

## Speed
Exports run in parallel. The plugin bundle is minified. PNGs are stored in the ZIP without re-compression.

## ZIP contents
- `assets/icons/`: SVG icons
- `assets/images/`: PNG images, with `2.0x/` and `3.0x/` variants
- `lib/generated/app_assets.dart`, `app_colors.dart`, `app_gradients.dart`, `app_text_styles.dart`
- `tokens/*.json`: design tokens
- `metadata/assets_manifest.json` (version 3): every file with all of its Figma occurrences
- `metadata/screen_mapping.json`: screen usage for each asset
- `metadata/export_report.json`: skipped layers, duplicate counts, empty outputs and failures
- `metadata/pubspec_snippet.yaml`: the pubspec entries these files need
- `README.md`: notes on the export

## Checks
Run `npm run check`, `npm test`, then `npm run build`. Tests cover:
- Extraction with Figma API mocks (`npm test` runs the sandbox extraction tests).
- Browser rendering and ZIP contents in headless Chrome or Edge, plus an end-to-end UI test.

Set `CHROME_BINARY` if the browser is installed elsewhere. `npm run build` produces a minified bundle; use `node build.mjs --dev` for an unminified build. A live Figma design still needs an in-app export to validate its particular composition boundaries.
