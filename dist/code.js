"use strict";
(() => {
  // src/code.ts
  figma.showUI(__html__, { width: 410, height: 510, themeColors: true });
  var slug = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 55) || "asset";
  var unique = (base, counts) => {
    let candidate = base, index = 1;
    while (counts.has(candidate)) candidate = `${base}_${++index}`;
    counts.set(candidate, 1);
    return candidate;
  };
  var toHex = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0").toUpperCase();
  var hex = (c) => `#${toHex(c.r)}${toHex(c.g)}${toHex(c.b)}`;
  var isContainer = (n) => "children" in n;
  var isPaintNode = (n) => "fills" in n;
  var hasStrokes = (n) => "strokes" in n;
  var imageCandidate = (n) => isPaintNode(n) && Array.isArray(n.fills) && n.fills.some((p) => p.type === "IMAGE" && p.visible !== false && (p.opacity ?? 1) > 0);
  var namedSvgCandidate = (n) => /icon|ico\b|ic_|svg|symbol/i.test(n.name) && ["GROUP", "FRAME"].includes(n.type);
  var vectorSvgCandidate = (n) => ["VECTOR", "BOOLEAN_OPERATION", "RECTANGLE", "ELLIPSE", "POLYGON", "STAR", "LINE"].includes(n.type);
  var compositeSvgCandidate = (n) => namedSvgCandidate(n) || ["COMPONENT", "INSTANCE"].includes(n.type);
  var visible = (n) => n.visible && (!("opacity" in n) || n.opacity > 0);
  var analysisCache = /* @__PURE__ */ new Map();
  function analyze(n) {
    const cached = analysisCache.get(n.id);
    if (cached) return cached;
    const children = visible(n) && isContainer(n) ? n.children.map(analyze) : [];
    const result = {
      images: visible(n) && (imageCandidate(n) || children.some((c) => c.images)),
      vectors: visible(n) && (vectorSvgCandidate(n) && !imageCandidate(n) || children.some((c) => c.vectors)),
      text: visible(n) && (n.type === "TEXT" && n.characters.trim().length > 0 || children.some((c) => c.text)),
      system: visible(n) && (isSystemIndicator(n) || children.some((c) => c.system))
    };
    analysisCache.set(n.id, result);
    return result;
  }
  var containsImageFill = (n) => analyze(n).images;
  var containsVectorArtwork = (n) => analyze(n).vectors;
  var containsText = (n) => analyze(n).text;
  var containsSystemUI = (n) => analyze(n).system;
  var isMask = (n) => "isMask" in n && n.isMask && visible(n);
  var isSystemIndicator = (n) => {
    const name = n.name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    return /\b(?:status\s*bar|statusbar|home\s*indicator|homeindicator|bottom\s*(?:navigation\s*)?indicator|navigation\s*indicator|navigationindicator|navigator\s*indicator|navigatorindicator|nav\s*indicator|navindicator|gesture\s*(?:bar|indicator)|system\s*(?:status|navigation)(?:\s*(?:bar|indicator))?)\b/.test(name);
  };
  var fingerprint = (bytes) => {
    let hash = 2166136261;
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 16777619);
    }
    return `${bytes.length}:${hash >>> 0}`;
  };
  var sameBytes = (a, b) => a.length === b.length && a.every((byte, index) => byte === b[index]);
  function encodeUtf8(value) {
    const bytes = [];
    for (let i = 0; i < value.length; i++) {
      let code = value.charCodeAt(i);
      if (code >= 55296 && code <= 56319) {
        const low = value.charCodeAt(i + 1);
        if (low >= 56320 && low <= 57343) {
          code = 65536 + (code - 55296 << 10) + (low - 56320);
          i++;
        } else code = 65533;
      } else if (code >= 56320 && code <= 57343) code = 65533;
      if (code < 128) bytes.push(code);
      else if (code < 2048) bytes.push(192 | code >> 6, 128 | code & 63);
      else if (code < 65536) bytes.push(224 | code >> 12, 128 | code >> 6 & 63, 128 | code & 63);
      else bytes.push(240 | code >> 18, 128 | code >> 12 & 63, 128 | code >> 6 & 63, 128 | code & 63);
    }
    return new Uint8Array(bytes);
  }
  function descendants(root) {
    const result = [];
    const walk = (n) => {
      if (!visible(n) || isSystemIndicator(n)) return;
      result.push(n);
      if (isContainer(n)) for (const c of n.children) walk(c);
    };
    walk(root);
    return result;
  }
  async function run() {
    analysisCache.clear();
    const selection = figma.currentPage.selection;
    if (selection.length === 0) throw new Error("Select one or more Frames or Groups.");
    const invalid = selection.find((n) => !isContainer(n));
    if (invalid) throw new Error(`"${invalid.name}" is not a Frame or Group. Select only Frames or Groups.`);
    const selectedIds = new Set(selection.map((n) => n.id));
    const roots = selection.filter(isContainer).filter((n) => {
      let parent = n.parent;
      while (parent && parent.type !== "PAGE" && parent.type !== "DOCUMENT") {
        if (selectedIds.has(parent.id)) return false;
        parent = parent.parent;
      }
      return true;
    });
    const used = /* @__PURE__ */ new Map();
    const files = [];
    const manifest = [];
    const report = [];
    let completed = 0;
    const exportedContent = /* @__PURE__ */ new Map();
    const addUniqueAsset = (kind, name, node, screen, screenNodeId, bytes) => {
      const key = `${kind}:${fingerprint(bytes)}`;
      const matches = exportedContent.get(key) || [];
      const duplicate = matches.find((item) => sameBytes(item.bytes, bytes));
      if (duplicate) {
        duplicate.entry.uses++;
        duplicate.entry.occurrences.push({ figmaNodeId: node.id, screen, screenNodeId });
        return;
      }
      const base = unique(slug(name), used), extension = kind === "svg" ? "svg" : "png";
      const path = `assets/${kind === "svg" ? "icons" : "images"}/${base}.${extension}`;
      const entry = { id: base, figmaNodeId: node.id, name, type: kind, path, screen, screenNodeId, usage: name, uses: 1, occurrences: [{ figmaNodeId: node.id, screen, screenNodeId }] };
      matches.push({ bytes, entry });
      exportedContent.set(key, matches);
      files.push({ path, bytes });
      manifest.push(entry);
    };
    const colors = /* @__PURE__ */ new Map();
    const typography = /* @__PURE__ */ new Map();
    const fonts = /* @__PURE__ */ new Map();
    const addColors = (paints) => {
      if (!Array.isArray(paints)) return;
      for (const p of paints) {
        if (p.visible === false || (p.opacity ?? 1) === 0) continue;
        if (p.type === "SOLID") {
          const h = hex(p.color);
          colors.set(h, (colors.get(h) || 0) + 1);
        }
      }
    };
    for (const root of roots) {
      const screen = root.name;
      const nodes = descendants(root);
      for (const n of nodes) {
        if (isPaintNode(n) && n.type !== "TEXT") addColors(n.fills);
        if (hasStrokes(n)) addColors(n.strokes);
        if (n.type === "TEXT") {
          for (const segment of n.getStyledTextSegments(["fontName", "fontSize", "lineHeight", "fills"])) {
            const f = segment.fontName, size = segment.fontSize, lh = segment.lineHeight, uses = segment.end - segment.start;
            addColors(segment.fills);
            const fontKey = JSON.stringify([f.family, f.style]);
            const font = fonts.get(fontKey);
            if (font) font.uses += uses;
            else fonts.set(fontKey, { fontFamily: f.family, fontStyle: f.style, uses });
            const key = JSON.stringify([f.family, f.style, size, lh.unit, lh.unit === "AUTO" ? null : lh.value]);
            const found = typography.get(key);
            if (found) {
              found.uses += uses;
              continue;
            }
            let lhStr = "AUTO";
            if (lh.unit === "PIXELS") lhStr = `${lh.value}px`;
            if (lh.unit === "PERCENT") lhStr = `${lh.value}%`;
            typography.set(key, { fontFamily: f.family, fontStyle: f.style, fontSize: size, lineHeight: lhStr, uses });
          }
        }
      }
      const note = (n, reason) => report.push({ nodeId: n.id, name: n.name, reason });
      const exportAsset = async (n, kind, source = n) => {
        if (!("exportAsync" in n)) return false;
        try {
          const bounds = "absoluteRenderBounds" in n ? n.absoluteRenderBounds : null;
          if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
            note(source, "No visible render bounds");
            return true;
          }
          if (kind === "svg") {
            const svg = await n.exportAsync({ format: "SVG_STRING", svgIdAttribute: false, svgOutlineText: true });
            if (!/<(?:image|foreignObject)\b/i.test(svg)) {
              addUniqueAsset("svg", source.name, source, screen, root.id, encodeUtf8(svg.trim()));
            } else {
              const bytes = await n.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 } });
              addUniqueAsset("image", source.name, source, screen, root.id, bytes);
            }
          } else {
            const bytes = await n.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 } });
            addUniqueAsset("image", source.name, source, screen, root.id, bytes);
          }
          figma.ui.postMessage({ type: "progress", message: `Preparing assets\u2026 ${++completed}` });
          return true;
        } catch (error) {
          note(source, `Export failed: ${String(error)}`);
          return false;
        }
      };
      const visitChildren = async (parent) => {
        const children = [...parent.children];
        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          if (!isMask(child)) {
            await visit(child);
            continue;
          }
          let end = i + 1;
          while (end < children.length && !isMask(children[end])) end++;
          const span = children.slice(i, end);
          if (span.length < 2) {
            note(child, "Mask has no content");
            i = end - 1;
            continue;
          }
          if (span.some(containsSystemUI)) {
            note(child, "System UI mask span omitted");
            i = end - 1;
            continue;
          }
          let temporary;
          try {
            temporary = figma.createFrame();
            temporary.name = "Temporary asset export";
            temporary.fills = [];
            temporary.clipsContent = false;
            temporary.visible = true;
            const copies = span.map((original) => {
              const copy = original.clone();
              temporary.appendChild(copy);
              copy.relativeTransform = original.relativeTransform;
              return copy;
            });
            const group = figma.group(copies, temporary);
            await exportAsset(group, span.some(containsImageFill) ? "image" : "svg", child);
          } catch (error) {
            note(child, `Mask composition failed: ${String(error)}`);
          } finally {
            temporary?.remove();
          }
          i = end - 1;
        }
      };
      const visit = async (n) => {
        if (!visible(n)) {
          note(n, "Hidden or fully transparent layer");
          return;
        }
        if (isSystemIndicator(n)) {
          note(n, "System status/navigation indicator");
          return;
        }
        const container = isContainer(n);
        const images = containsImageFill(n), text = containsText(n);
        const systemChild = container && n.children.some(containsSystemUI);
        const directMasks = container && n.children.some(isMask);
        const imageName = /\b(photo|image|picture|illustration|avatar|thumbnail|collage|artwork|banner)\b/i.test(n.name.replace(/[_/-]+/g, " "));
        const explicitRaster = "exportSettings" in n && n.exportSettings.some((s) => s.format === "PNG" || s.format === "JPG");
        const grouped = container && ["GROUP", "COMPONENT", "INSTANCE"].includes(n.type);
        const layout = "layoutMode" in n && n.layoutMode !== "NONE";
        const imageComposition = images && (imageCandidate(n) || imageName || explicitRaster || !text && !layout);
        if (!systemChild && (imageComposition || directMasks && !text)) {
          await exportAsset(n, images ? "image" : "svg");
          return;
        }
        const vector = vectorSvgCandidate(n) && !images;
        const vectorComposition = !images && !text && !layout && (grouped || compositeSvgCandidate(n)) && containsVectorArtwork(n);
        if (!systemChild && (vector || vectorComposition)) {
          if (await exportAsset(n, "svg")) return;
        }
        if (container) await visitChildren(n);
      };
      if (visible(root) && !isSystemIndicator(root)) await visitChildren(root);
    }
    const result = { version: 1, screens: roots.map((root) => ({ name: root.name, figmaNodeId: root.id })), exportedAt: (/* @__PURE__ */ new Date()).toISOString(), assets: manifest };
    const colorsJson = { colors: [...colors].map(([value, uses]) => ({ hex: value, uses })) };
    const typeJson = { typography: [...typography.values()] };
    const constants = manifest.map((a) => `  static const String ${slug(a.id).replace(/_([a-z0-9])/g, (_, x) => x.toUpperCase())} = '${a.path}';`).join("\n");
    const dart = `// Generated by Flutter Assets Exporter.
abstract final class AppAssets {
${constants}
}
`;
    const json = (x) => encodeUtf8(JSON.stringify(x, null, 2));
    files.push({ path: "metadata/assets_manifest.json", bytes: json(result) });
    files.push({ path: "metadata/screen_mapping.json", bytes: json({ screens: roots.map((root) => ({ screen: root.name, figmaNodeId: root.id, assets: manifest.filter((a) => a.occurrences.some((o) => o.screenNodeId === root.id)).map((a) => ({ id: a.id, figmaNodeId: a.figmaNodeId, path: a.path, usage: a.usage, uses: a.uses })) })) }) });
    files.push({ path: "tokens/colors.json", bytes: json(colorsJson) });
    files.push({ path: "tokens/typography.json", bytes: json(typeJson) });
    files.push({ path: "tokens/fonts.json", bytes: json({ fonts: [...fonts.values()] }) });
    files.push({ path: "metadata/export_report.json", bytes: json({ skipped: report }) });
    files.push({ path: "lib/generated/app_assets.dart", bytes: encodeUtf8(dart) });
    files.push({ path: "metadata/README.md", bytes: encodeUtf8("Copy assets/ and lib/generated/ into your Flutter project. Vector artwork exports as SVG; image compositions and rasterized effects export as rendered PNG. Masks and grouped artwork stay together. Before ZIP creation, each asset is rendered to reject empty output. SVG comparison ignores generated IDs; PNG comparison uses full decoded pixels. Shared files retain every screen/node occurrence. Fonts, colors and typography styles are unique entries. See export_report.json for exclusions and failures. System UI detection uses layer names; composition detection uses structure and optional photo/image/icon names. Assets exceeding 32 megapixels or 16384 pixels per side are reported instead of downloaded.\n") });
    const zipName = roots.length === 1 ? `${slug(roots[0].name)}_assets.zip` : "figma_assets.zip";
    figma.ui.postMessage({ type: "export", name: zipName, files, summary: { screens: roots.length, images: manifest.filter((x) => x.type === "image").length, svgs: manifest.filter((x) => x.type === "svg").length, colors: colors.size, typography: typography.size } });
  }
  var running = false;
  figma.ui.onmessage = async (msg) => {
    if (msg.type !== "start" || running) return;
    running = true;
    try {
      await run();
    } catch (e) {
      figma.ui.postMessage({ type: "error", message: String(e instanceof Error ? e.message : e) });
    } finally {
      running = false;
    }
  };
})();
