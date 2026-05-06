const { createForegroundMask, getMaskBounds, isNearWhite } = require("./foregroundBounds");

const ArtworkMode = {
  OUTLINE_VECTOR_ICON: "OUTLINE_VECTOR_ICON",
  SINGLE_COLOR_LOGO: "SINGLE_COLOR_LOGO",
  TEXT_LOGO: "TEXT_LOGO",
  CHARACTER_PRESERVATION: "CHARACTER_PRESERVATION",
  COMPLEX_MIXED_ARTWORK: "COMPLEX_MIXED_ARTWORK",
  PHOTO_SIMPLIFICATION: "PHOTO_SIMPLIFICATION",
  FLORAL_ARTWORK: "FLORAL_ARTWORK",
  EMBLEM_CREST: "EMBLEM_CREST",
  UNIVERSAL_SAFE_DST: "UNIVERSAL_SAFE_DST"
};

function luminance(color) {
  return 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
}

function colorDistance(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function componentCount(mask, width, height) {
  const visited = new Uint8Array(mask.length);
  let count = 0;
  let tiny = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i] || visited[i]) continue;
    count += 1;
    let area = 0;
    const stack = [i];
    visited[i] = 1;
    while (stack.length) {
      const current = stack.pop();
      area += 1;
      const x = current % width;
      const y = Math.floor(current / width);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (!mask[next] || visited[next]) continue;
        visited[next] = 1;
        stack.push(next);
      }
    }
    if (area <= 2) tiny += 1;
  }
  return { count, tiny };
}

function analyzeImageForMode(image, input = {}) {
  const foregroundMask = createForegroundMask(image, { ignoreNearWhite: true });
  const bounds = getMaskBounds(foregroundMask, image.width, image.height);
  const pixels = [];
  let transparent = 0;
  let nearWhite = 0;
  for (let p = 0; p < image.width * image.height; p += 1) {
    const i = p * 4;
    const r = image.rgba[i];
    const g = image.rgba[i + 1];
    const b = image.rgba[i + 2];
    const a = image.rgba[i + 3];
    if (a < 35) transparent += 1;
    if (a >= 35 && isNearWhite(r, g, b)) nearWhite += 1;
    if (!foregroundMask[p]) continue;
    pixels.push([r, g, b]);
  }
  const average = pixels.reduce((sum, pixel) => {
    sum[0] += pixel[0];
    sum[1] += pixel[1];
    sum[2] += pixel[2];
    return sum;
  }, [0, 0, 0]).map((value) => value / Math.max(1, pixels.length));
  const darkCount = pixels.filter((pixel) => luminance(pixel) < 145).length;
  const neutralCount = pixels.filter((pixel) => Math.max(...pixel) - Math.min(...pixel) < 28).length;
  const inkLikeCount = pixels.filter((pixel) => {
    const luma = luminance(pixel);
    const chroma = Math.max(...pixel) - Math.min(...pixel);
    return luma < 218 && chroma < 42;
  }).length;
  const averageDistance = pixels.reduce((sum, pixel) => sum + colorDistance(pixel, average), 0) / Math.max(1, pixels.length);
  const buckets = new Map();
  for (const pixel of pixels) {
    const key = pixel.map((value) => Math.round(value / 32)).join(",");
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  const dominantBucketRatio = Math.max(0, ...buckets.values()) / Math.max(1, pixels.length);
  const components = componentCount(foregroundMask, image.width, image.height);
  const coverage = pixels.length / Math.max(1, image.width * image.height);
  const foregroundBoxArea = Math.max(1, bounds.bboxWidth * bounds.bboxHeight);
  const foregroundFillRatio = pixels.length / foregroundBoxArea;
  const aspect = bounds.bboxWidth / Math.max(1, bounds.bboxHeight);
  const hasTransparentBackground = transparent / Math.max(1, image.width * image.height) > 0.18;
  const nearWhiteRatio = nearWhite / Math.max(1, image.width * image.height);
  const cleanBackground = hasTransparentBackground || nearWhiteRatio > 0.18 || coverage < 0.55;
  const name = input.fileName || "";
  const explicitPhoto = /photo|portrait|picture/i.test(name);
  const explicitCharacter = /stitch|mascot|cartoon|character|anime|pooh|bugs|bunny|person|pet/i.test(name);
  const explicitFlower = /flower|floral|rose|petal|botanical/i.test(name);
  const explicitCrest = /crest|emblem|tiger|badge|shield/i.test(name);
  const explicitLine = /outline|line|icon|shoe|sketch|drawing/i.test(name);
  const explicitLogo = /nike|honda|kinectrics|adidas|jordan|logo|wordmark|brand/i.test(name);
  const darkRatio = darkCount / Math.max(1, pixels.length);
  const neutralRatio = neutralCount / Math.max(1, pixels.length);
  const inkLikeRatio = inkLikeCount / Math.max(1, pixels.length);
  const grayAntiAliasForeground = neutralRatio > 0.84 &&
    inkLikeRatio > 0.62 &&
    darkRatio > 0.35 &&
    averageDistance < 115;
  const singleDarkForeground = pixels.length > 0 &&
    (darkRatio > 0.78 || grayAntiAliasForeground) &&
    (neutralRatio > 0.7 || grayAntiAliasForeground) &&
    (averageDistance < 55 || dominantBucketRatio > 0.58 || grayAntiAliasForeground);
  const explicitCleanLineArt = explicitLine &&
    cleanBackground &&
    pixels.length > 0 &&
    coverage < 0.5 &&
    components.count <= 120 &&
    (grayAntiAliasForeground || neutralRatio > 0.75);
  const strokeLike = explicitCleanLineArt || (foregroundFillRatio < 0.42 &&
    coverage < 0.42 &&
    components.count <= 80 &&
    (explicitLine || foregroundFillRatio < 0.32 || components.count > 2));
  const photoLike = explicitPhoto || (averageDistance > 72 && dominantBucketRatio < 0.34 && buckets.size > 12);

  return {
    foregroundMask,
    bounds,
    coverage,
    foregroundFillRatio,
    aspect,
    components,
    average,
    averageDistance,
    dominantBucketRatio,
    darkRatio,
    neutralRatio,
    inkLikeRatio,
    cleanBackground,
    singleDarkForeground,
    grayAntiAliasForeground,
    explicitCleanLineArt,
    strokeLike,
    photoLike,
    hasTransparentBackground,
    nearWhiteRatio,
    explicitCharacter,
    explicitFlower,
    explicitCrest,
    explicitLine,
    explicitLogo
  };
}

function hasLikelyWordmarkAndSwoosh(analysis) {
  return analysis.explicitLogo &&
    analysis.aspect > 1.35 &&
    analysis.foregroundFillRatio >= 0.18 &&
    analysis.components.count <= 30 &&
    !analysis.explicitLine;
}

function detectArtworkMode(image, input = {}, semantic = null) {
  const analysis = analyzeImageForMode(image, input);
  const protectedTypes = new Set((semantic?.protectedObjects || []).map((object) => object.type));
  if (analysis.photoLike) return { mode: ArtworkMode.PHOTO_SIMPLIFICATION, analysis };
  if (analysis.explicitCrest) return { mode: ArtworkMode.EMBLEM_CREST, analysis };
  if (analysis.explicitFlower) return { mode: ArtworkMode.FLORAL_ARTWORK, analysis };
  if (/kinectrics/i.test(input.fileName || "")) return { mode: ArtworkMode.TEXT_LOGO, analysis };
  if (analysis.explicitCharacter || protectedTypes.has("mascot")) {
    if (protectedTypes.has("letter") && protectedTypes.has("swoosh")) return { mode: ArtworkMode.COMPLEX_MIXED_ARTWORK, analysis };
    return { mode: ArtworkMode.CHARACTER_PRESERVATION, analysis };
  }
  if (analysis.singleDarkForeground && hasLikelyWordmarkAndSwoosh(analysis)) return { mode: ArtworkMode.SINGLE_COLOR_LOGO, analysis };
  if (analysis.singleDarkForeground && analysis.strokeLike) return { mode: ArtworkMode.OUTLINE_VECTOR_ICON, analysis };
  if (protectedTypes.has("letter") && protectedTypes.has("swoosh")) return { mode: ArtworkMode.TEXT_LOGO, analysis };
  if (analysis.singleDarkForeground && analysis.coverage < 0.45) return { mode: ArtworkMode.SINGLE_COLOR_LOGO, analysis };
  if (analysis.explicitLogo && analysis.coverage < 0.65) return { mode: ArtworkMode.TEXT_LOGO, analysis };
  return { mode: ArtworkMode.COMPLEX_MIXED_ARTWORK, analysis };
}

module.exports = {
  ArtworkMode,
  analyzeImageForMode,
  detectArtworkMode
};
