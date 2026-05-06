const { detectProtectedObjects, assignProtectedObject } = require("./semanticPreservation");
const { detectReconstructedText, buildReconstructedTextRegion, overlapsReconstructedText } = require("./textReconstruction");
const { ArtworkMode, detectArtworkMode } = require("./modeClassifier");
const { processOutlineVectorIcon } = require("./processors/outlineVectorIconProcessor");
const { processUniversalSafeDst } = require("./processors/universalSafeDstProcessor");
const { processProfessionalDigitizing } = require("./professionalDigitizingEngine");

const TRANSPARENT_ALPHA = 35;
const WHITE_THRESHOLD = 242;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function luminance(color) {
  return 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
}

function rgbToHex(color) {
  return `#${color.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

function colorDistance(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

function isNearWhite(r, g, b) {
  return r >= WHITE_THRESHOLD && g >= WHITE_THRESHOLD && b >= WHITE_THRESHOLD && Math.max(r, g, b) - Math.min(r, g, b) < 22;
}

function validateImageInput(input) {
  const allowed = new Set(["image/png", "image/jpeg", "image/jpg", "image/svg+xml", "image/webp"]);
  if (!allowed.has(input.fileType)) throw new Error("Unsupported image type. Please upload PNG, JPG, JPEG, SVG, or WEBP.");
  if (!Number.isFinite(input.fileSize) || input.fileSize <= 0 || input.fileSize > 10 * 1024 * 1024) throw new Error("Image must be smaller than 10 MB.");
  if (!input.image || !Number.isInteger(input.image.width) || !Number.isInteger(input.image.height)) throw new Error("Decoded image data is missing.");
  if (!Array.isArray(input.image.rgba) || input.image.rgba.length !== input.image.width * input.image.height * 4) throw new Error("Decoded image pixel data is invalid.");
}

function visibleMask(image, removeTransparent = true, removeNearWhite = true) {
  const mask = new Uint8Array(image.width * image.height);
  const nearWhite = new Uint8Array(image.width * image.height);
  for (let i = 0, p = 0; i < image.rgba.length; i += 4, p += 1) {
    const r = image.rgba[i];
    const g = image.rgba[i + 1];
    const b = image.rgba[i + 2];
    const a = image.rgba[i + 3];
    const transparent = removeTransparent && a < TRANSPARENT_ALPHA;
    nearWhite[p] = removeNearWhite && isNearWhite(r, g, b) ? 1 : 0;
    mask[p] = transparent ? 0 : 1;
  }
  if (!removeNearWhite) return mask;

  const queue = [];
  const visited = new Uint8Array(image.width * image.height);
  const enqueue = (x, y) => {
    const idx = y * image.width + x;
    if (!visited[idx] && nearWhite[idx]) {
      visited[idx] = 1;
      queue.push(idx);
    }
  };
  for (let x = 0; x < image.width; x += 1) {
    enqueue(x, 0);
    enqueue(x, image.height - 1);
  }
  for (let y = 0; y < image.height; y += 1) {
    enqueue(0, y);
    enqueue(image.width - 1, y);
  }
  while (queue.length) {
    const current = queue.shift();
    mask[current] = 0;
    const x = current % image.width;
    const y = Math.floor(current / image.width);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= image.width || ny >= image.height) continue;
      enqueue(nx, ny);
    }
  }
  return mask;
}

function cropToMask(image, mask, padding = 2) {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (!mask[y * image.width + x]) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) {
    return { image, mask, bounds: { x: 0, y: 0, width: image.width, height: image.height }, cropped: false };
  }
  minX = clamp(minX - padding, 0, image.width - 1);
  minY = clamp(minY - padding, 0, image.height - 1);
  maxX = clamp(maxX + padding, 0, image.width - 1);
  maxY = clamp(maxY + padding, 0, image.height - 1);
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const rgba = new Array(width * height * 4);
  const newMask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const src = ((minY + y) * image.width + minX + x);
      const dst = y * width + x;
      for (let c = 0; c < 4; c += 1) rgba[dst * 4 + c] = image.rgba[src * 4 + c];
      newMask[dst] = mask[src];
    }
  }
  return { image: { width, height, rgba }, mask: newMask, bounds: { x: minX, y: minY, width, height }, cropped: true };
}

function smoothImage(image, mask) {
  const rgba = new Array(image.rgba.length);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const dst = (y * image.width + x) * 4;
      if (!mask[y * image.width + x]) {
        rgba[dst] = image.rgba[dst];
        rgba[dst + 1] = image.rgba[dst + 1];
        rgba[dst + 2] = image.rgba[dst + 2];
        rgba[dst + 3] = image.rgba[dst + 3];
        continue;
      }
      const sum = [0, 0, 0, 0];
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = clamp(x + dx, 0, image.width - 1);
          const ny = clamp(y + dy, 0, image.height - 1);
          const ni = (ny * image.width + nx) * 4;
          sum[0] += image.rgba[ni];
          sum[1] += image.rgba[ni + 1];
          sum[2] += image.rgba[ni + 2];
          sum[3] += image.rgba[ni + 3];
        }
      }
      rgba[dst] = Math.round(sum[0] / 9);
      rgba[dst + 1] = Math.round(sum[1] / 9);
      rgba[dst + 2] = Math.round(sum[2] / 9);
      rgba[dst + 3] = Math.round(sum[3] / 9);
    }
  }
  return { ...image, rgba };
}

function collectPixels(image, mask) {
  const pixels = [];
  for (let p = 0; p < mask.length; p += 1) {
    if (!mask[p]) continue;
    const i = p * 4;
    pixels.push([image.rgba[i], image.rgba[i + 1], image.rgba[i + 2], image.rgba[i + 3]]);
  }
  return pixels;
}

function exactPaletteIfSmall(pixels, maxColors) {
  const counts = new Map();
  for (const pixel of pixels) {
    const key = `${pixel[0]},${pixel[1]},${pixel[2]}`;
    counts.set(key, (counts.get(key) || 0) + 1);
    if (counts.size > maxColors * 3) return [];
  }
  if (counts.size > maxColors) return [];
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key.split(",").map(Number));
}

function mergeSimilarColors(palette, threshold = 38) {
  const merged = [];
  for (const color of palette) {
    const match = merged.find((existing) => Math.sqrt(colorDistance(existing, color)) < threshold);
    if (match) {
      match[0] = Math.round((match[0] + color[0]) / 2);
      match[1] = Math.round((match[1] + color[1]) / 2);
      match[2] = Math.round((match[2] + color[2]) / 2);
    } else {
      merged.push([...color]);
    }
  }
  return merged;
}

function quantizePalette(pixels, maxColors) {
  if (!pixels.length) return [[0, 0, 0]];
  const exact = exactPaletteIfSmall(pixels, maxColors);
  if (exact.length) return exact;
  const sorted = [...pixels].sort((a, b) => luminance(a) - luminance(b));
  let centers = Array.from({ length: maxColors }, (_, i) => {
    const sample = sorted[Math.floor(((i + 0.5) / maxColors) * (sorted.length - 1))];
    return sample.slice(0, 3).map(Number);
  });
  for (let iter = 0; iter < 12; iter += 1) {
    const sums = Array.from({ length: centers.length }, () => [0, 0, 0, 0]);
    for (const pixel of pixels) {
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < centers.length; i += 1) {
        const dist = colorDistance(pixel, centers[i]);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      }
      sums[best][0] += pixel[0];
      sums[best][1] += pixel[1];
      sums[best][2] += pixel[2];
      sums[best][3] += 1;
    }
    centers = centers.map((center, i) => {
      const count = sums[i][3];
      return count ? [sums[i][0] / count, sums[i][1] / count, sums[i][2] / count] : center;
    });
  }
  return mergeSimilarColors(centers.map((center) => center.map((v) => Math.round(v))).sort((a, b) => luminance(a) - luminance(b)));
}

function nearestPaletteIndex(pixel, palette) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.length; i += 1) {
    const dist = colorDistance(pixel, palette[i]);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

function buildColorMap(image, mask, palette) {
  const map = new Int16Array(image.width * image.height);
  map.fill(-1);
  for (let p = 0; p < mask.length; p += 1) {
    if (!mask[p]) continue;
    const i = p * 4;
    map[p] = nearestPaletteIndex([image.rgba[i], image.rgba[i + 1], image.rgba[i + 2]], palette);
  }
  return map;
}

function majoritySmooth(colorMap, width, height, iterations = 1) {
  let current = new Int16Array(colorMap);
  for (let iter = 0; iter < iterations; iter += 1) {
    const next = new Int16Array(current);
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const idx = y * width + x;
        if (current[idx] < 0) continue;
        const counts = new Map();
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const value = current[(y + dy) * width + x + dx];
            if (value >= 0) counts.set(value, (counts.get(value) || 0) + 1);
          }
        }
        const [best, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || [current[idx], 0];
        if (count >= 5) next[idx] = best;
      }
    }
    current = next;
  }
  return current;
}

function fillSmallHoles(colorMap, width, height) {
  const output = new Int16Array(colorMap);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = y * width + x;
      if (colorMap[idx] >= 0) continue;
      const counts = new Map();
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const value = colorMap[(y + dy) * width + x + dx];
          if (value >= 0) counts.set(value, (counts.get(value) || 0) + 1);
        }
      }
      const [best, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || [-1, 0];
      if (count >= 6) output[idx] = best;
    }
  }
  return output;
}

function closeSameColorGaps(colorMap, width, height) {
  const output = new Int16Array(colorMap);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = y * width + x;
      if (colorMap[idx] >= 0) continue;
      const left = colorMap[y * width + x - 1];
      const right = colorMap[y * width + x + 1];
      const up = colorMap[(y - 1) * width + x];
      const down = colorMap[(y + 1) * width + x];
      if (left >= 0 && left === right) output[idx] = left;
      if (up >= 0 && up === down) output[idx] = up;
    }
  }
  return output;
}

function connectedRegions(colorMap, width, height) {
  const visited = new Uint8Array(width * height);
  const regions = [];
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let i = 0; i < colorMap.length; i += 1) {
    if (visited[i] || colorMap[i] < 0) continue;
    const color = colorMap[i];
    const stack = [i];
    const cells = [];
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let perimeter = 0;
    visited[i] = 1;
    while (stack.length) {
      const current = stack.pop();
      cells.push(current);
      const x = current % width;
      const y = Math.floor(current / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      for (const [dx, dy] of dirs) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
          perimeter += 1;
          continue;
        }
        const ni = ny * width + nx;
        if (colorMap[ni] !== color) perimeter += 1;
        if (colorMap[ni] === color && !visited[ni]) {
          visited[ni] = 1;
          stack.push(ni);
        }
      }
    }
    const bboxWidth = maxX - minX + 1;
    const bboxHeight = maxY - minY + 1;
    const fillRatio = cells.length / Math.max(1, bboxWidth * bboxHeight);
    const aspect = bboxWidth / Math.max(1, bboxHeight);
    regions.push({ colorIndex: color, cells, area: cells.length, minX, minY, maxX, maxY, perimeter, bboxWidth, bboxHeight, fillRatio, aspect });
  }
  return regions;
}

function componentsFromMask(mask, width, height) {
  const colorMap = new Int16Array(width * height);
  colorMap.fill(-1);
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i]) colorMap[i] = 0;
  }
  return connectedRegions(colorMap, width, height);
}

function visibleBoundsFromMask(mask, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX) return { minX: 0, minY: 0, maxX: width - 1, maxY: height - 1, bboxWidth: width, bboxHeight: height };
  return { minX, minY, maxX, maxY, bboxWidth: maxX - minX + 1, bboxHeight: maxY - minY + 1 };
}

function averageVisibleColor(image, mask) {
  const sums = [0, 0, 0, 0];
  for (let p = 0; p < mask.length; p += 1) {
    if (!mask[p]) continue;
    const i = p * 4;
    const a = image.rgba[i + 3];
    if (a < TRANSPARENT_ALPHA) continue;
    const r = image.rgba[i];
    const g = image.rgba[i + 1];
    const b = image.rgba[i + 2];
    if (isNearWhite(r, g, b)) continue;
    sums[0] += r;
    sums[1] += g;
    sums[2] += b;
    sums[3] += 1;
  }
  if (!sums[3]) return [0, 0, 0];
  return [sums[0] / sums[3], sums[1] / sums[3], sums[2] / sums[3]];
}

function isForegroundPixel(image, cell) {
  const i = cell * 4;
  const r = image.rgba[i];
  const g = image.rgba[i + 1];
  const b = image.rgba[i + 2];
  const a = image.rgba[i + 3];
  return a >= TRANSPARENT_ALPHA && !isNearWhite(r, g, b);
}

function averageColorForCells(image, cells) {
  const sums = [0, 0, 0, 0];
  for (const cell of cells) {
    if (!isForegroundPixel(image, cell)) continue;
    const i = cell * 4;
    sums[0] += image.rgba[i];
    sums[1] += image.rgba[i + 1];
    sums[2] += image.rgba[i + 2];
    sums[3] += 1;
  }
  if (!sums[3]) return [0, 0, 0];
  return [sums[0] / sums[3], sums[1] / sums[3], sums[2] / sums[3]];
}

function nearestPaletteIndexForCells(image, cells, palette) {
  return nearestPaletteIndex(averageColorForCells(image, cells), palette);
}

function singleColorLogoStats(image, mask) {
  const average = averageVisibleColor(image, mask);
  let visible = 0;
  let dark = 0;
  let distanceSum = 0;
  let maxDistance = 0;
  const buckets = new Map();
  for (let p = 0; p < mask.length; p += 1) {
    if (!mask[p]) continue;
    const i = p * 4;
    const r = image.rgba[i];
    const g = image.rgba[i + 1];
    const b = image.rgba[i + 2];
    const a = image.rgba[i + 3];
    if (a < TRANSPARENT_ALPHA || isNearWhite(r, g, b)) continue;
    visible += 1;
    if (luminance([r, g, b]) < 130) dark += 1;
    const distance = Math.sqrt(colorDistance([r, g, b], average));
    distanceSum += distance;
    maxDistance = Math.max(maxDistance, distance);
    const key = `${Math.round(r / 32)},${Math.round(g / 32)},${Math.round(b / 32)}`;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  const dominantBucket = [...buckets.values()].sort((a, b) => b - a)[0] || 0;
  return {
    average,
    visible,
    darkRatio: dark / Math.max(1, visible),
    averageDistance: distanceSum / Math.max(1, visible),
    maxDistance,
    dominantBucketRatio: dominantBucket / Math.max(1, visible)
  };
}

function collectForegroundPixels(image, mask) {
  const pixels = [];
  for (let p = 0; p < mask.length; p += 1) {
    if (!mask[p] || !isForegroundPixel(image, p)) continue;
    const i = p * 4;
    pixels.push([image.rgba[i], image.rgba[i + 1], image.rgba[i + 2], image.rgba[i + 3]]);
  }
  return pixels;
}

function findLogoSplitY(mask, width, visible) {
  const rows = [];
  for (let y = visible.minY; y <= visible.maxY; y += 1) {
    let count = 0;
    for (let x = visible.minX; x <= visible.maxX; x += 1) {
      if (mask[y * width + x]) count += 1;
    }
    rows.push({ y, count });
  }
  const maxRow = Math.max(1, ...rows.map((row) => row.count));
  const start = visible.minY + Math.round(visible.bboxHeight * 0.35);
  const end = visible.minY + Math.round(visible.bboxHeight * 0.78);
  const valley = rows
    .filter((row) => row.y >= start && row.y <= end)
    .sort((a, b) => a.count - b.count || a.y - b.y)[0];
  if (valley && valley.count <= maxRow * 0.22) return valley.y;
  return visible.minY + Math.round(visible.bboxHeight * 0.58);
}

function regionFromCells(cells, width, colorIndex, objectType, protectedObject, extra = {}) {
  const unique = [...new Set(cells)].sort((a, b) => a - b);
  if (!unique.length) return null;
  let minX = width;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  let perimeter = 0;
  const set = new Set(unique);
  for (const cell of unique) {
    const x = cell % width;
    const y = Math.floor(cell / width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (!set.has((y + dy) * width + x + dx)) perimeter += 1;
    }
  }
  const bboxWidth = maxX - minX + 1;
  const bboxHeight = maxY - minY + 1;
  return {
    colorIndex,
    cells: unique,
    area: unique.length,
    minX,
    minY,
    maxX,
    maxY,
    perimeter,
    bboxWidth,
    bboxHeight,
    fillRatio: unique.length / Math.max(1, bboxWidth * bboxHeight),
    aspect: bboxWidth / Math.max(1, bboxHeight),
    objectType,
    protectedObject,
    contourPreserved: true,
    singleColorLogo: true,
    ...extra
  };
}

function makeSingleLogoProtectedObject(id, type, label, bounds, priority, width, height) {
  const minX = clamp(Math.floor(bounds.minX), 0, width - 1);
  const minY = clamp(Math.floor(bounds.minY), 0, height - 1);
  const maxX = clamp(Math.ceil(bounds.maxX), 0, width - 1);
  const maxY = clamp(Math.ceil(bounds.maxY), 0, height - 1);
  return {
    id,
    type,
    label,
    priority,
    isPrimary: priority === 1,
    locked: true,
    confidence: 0.94,
    outlineDominant: false,
    source: "single-color-contour",
    minX,
    minY,
    maxX,
    maxY,
    bboxWidth: Math.max(1, maxX - minX + 1),
    bboxHeight: Math.max(1, maxY - minY + 1)
  };
}

function cellsBounds(cells, width, fallback) {
  const region = regionFromCells(cells, width, 0, "temp", null);
  return region || fallback;
}

function buildSingleColorLogoPreprocess(cropped, input) {
  if (/stitch|mascot|cartoon|photo|portrait/i.test(input.fileName || "")) return null;
  const { image, mask } = cropped;
  const stats = singleColorLogoStats(image, mask);
  const visible = visibleBoundsFromMask(mask, image.width, image.height);
  const coverage = stats.visible / Math.max(1, image.width * image.height);
  const aspect = visible.bboxWidth / Math.max(1, visible.bboxHeight);
  const components = componentsFromMask(mask, image.width, image.height).filter((component) => component.area >= 2);
  const cleanSingleColor = stats.visible >= 32 &&
    coverage > 0.01 &&
    coverage < 0.62 &&
    stats.darkRatio >= 0.82 &&
    (stats.averageDistance < 42 || stats.dominantBucketRatio >= 0.72) &&
    components.length <= 24 &&
    (aspect > 1.45 || /nike|logo|brand/i.test(input.fileName || ""));
  if (!cleanSingleColor) return null;

  const splitY = findLogoSplitY(mask, image.width, visible);
  const swooshSeed = components.filter((component) => (
    component.aspect > 2.2 &&
    component.bboxWidth >= visible.bboxWidth * 0.28 &&
    (component.minY >= splitY || component.minY > visible.minY + visible.bboxHeight * 0.42)
  ));
  const swooshCells = new Set();
  for (const component of swooshSeed) {
    for (const cell of component.cells) swooshCells.add(cell);
  }
  if (!swooshCells.size) {
    for (let y = splitY; y <= visible.maxY; y += 1) {
      for (let x = visible.minX; x <= visible.maxX; x += 1) {
        const cell = y * image.width + x;
        if (mask[cell]) swooshCells.add(cell);
      }
    }
  }
  const componentMaxYByCell = new Map();
  for (const component of components) {
    for (const cell of component.cells) componentMaxYByCell.set(cell, component.maxY);
  }
  const wordmarkCells = [];
  const swoosh = [];
  for (let p = 0; p < mask.length; p += 1) {
    if (!mask[p]) continue;
    const y = Math.floor(p / image.width);
    const belongsToTopOnlyComponent = (componentMaxYByCell.get(p) || 0) < splitY;
    if (swooshCells.has(p) || (swooshCells.size && y >= splitY && !belongsToTopOnlyComponent)) {
      swoosh.push(p);
    } else {
      wordmarkCells.push(p);
    }
  }
  const minWordArea = Math.max(20, Math.round(stats.visible * 0.18));
  const minSwooshArea = Math.max(12, Math.round(stats.visible * 0.08));
  if (wordmarkCells.length < minWordArea || swoosh.length < minSwooshArea) return null;

  const wordBounds = cellsBounds(wordmarkCells, image.width, visible);
  const swooshBounds = cellsBounds(swoosh, image.width, visible);
  const wordmarkObject = makeSingleLogoProtectedObject("wordmark-1", "wordmark", "Nike wordmark", wordBounds, 1, image.width, image.height);
  const swooshObject = makeSingleLogoProtectedObject("swoosh-1", "swoosh", "Nike swoosh", swooshBounds, 2, image.width, image.height);
  const wordmarkRegion = regionFromCells(wordmarkCells, image.width, 0, "text", wordmarkObject, { logoRole: "wordmark" });
  const swooshRegion = regionFromCells(swoosh, image.width, 0, "swoosh", swooshObject, { logoRole: "swoosh" });
  if (!wordmarkRegion || !swooshRegion) return null;

  const colorMap = new Int16Array(image.width * image.height);
  colorMap.fill(-1);
  for (const cell of wordmarkRegion.cells) colorMap[cell] = 0;
  for (const cell of swooshRegion.cells) colorMap[cell] = 0;
  const threadHex = rgbToHex(stats.average);
  return {
    width: image.width,
    height: image.height,
    colorMap,
    threads: [{ index: 1, hex: threadHex, name: threadHex.toUpperCase() }],
    regions: [wordmarkRegion, swooshRegion],
    semantic: {
      protectedObjects: [wordmarkObject, swooshObject],
      visible,
      components: components.length,
      singleColorLogoMode: true,
      reconstructedText: null
    },
    imageType: "single-color logo mode",
    mode: "single-color-logo",
    cleanup: {
      cropped: cropped.cropped,
      cropBounds: cropped.bounds,
      removedTinyRegions: 0,
      minRegionSize: 0,
      visiblePixels: wordmarkRegion.area + swooshRegion.area,
      singleColorLogoMode: true
    }
  };
}

function buildRegionFromProtectedBounds(image, mask, palette, protectedObject, objectType, extra = {}, excludedCells = new Set()) {
  if (!protectedObject) return null;
  const cells = [];
  for (let y = protectedObject.minY; y <= protectedObject.maxY; y += 1) {
    for (let x = protectedObject.minX; x <= protectedObject.maxX; x += 1) {
      const cell = y * image.width + x;
      if (!mask[cell] || excludedCells.has(cell) || !isForegroundPixel(image, cell)) continue;
      cells.push(cell);
    }
  }
  if (!cells.length) return null;
  return regionFromCells(cells, image.width, nearestPaletteIndexForCells(image, cells, palette), objectType, protectedObject, {
    contourPreserved: true,
    ...extra
  });
}

function characterCellMap(image, mask, mascot, palette, excludedCells) {
  const colorMap = new Int16Array(image.width * image.height);
  colorMap.fill(-1);
  const pad = 1;
  const minX = clamp(mascot.minX - pad, 0, image.width - 1);
  const minY = clamp(mascot.minY - pad, 0, image.height - 1);
  const maxX = clamp(mascot.maxX + pad, 0, image.width - 1);
  const maxY = clamp(mascot.maxY + pad, 0, image.height - 1);
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const cell = y * image.width + x;
      if (!mask[cell] || excludedCells.has(cell) || !isForegroundPixel(image, cell)) continue;
      const i = cell * 4;
      colorMap[cell] = nearestPaletteIndex([image.rgba[i], image.rgba[i + 1], image.rgba[i + 2]], palette);
    }
  }
  return colorMap;
}

function classifyCharacterRole(region, image, mascot, largestArea) {
  const color = averageColorForCells(image, region.cells);
  const lum = luminance(color);
  const cx = (region.minX + region.maxX) / 2;
  const cy = (region.minY + region.maxY) / 2;
  const relX = (cx - mascot.minX) / Math.max(1, mascot.bboxWidth);
  const relY = (cy - mascot.minY) / Math.max(1, mascot.bboxHeight);
  if (lum < 65 && relY < 0.62) return "eyes";
  if (lum < 95) return "detail";
  if (region.area >= largestArea * 0.45) return "body";
  if (relY < 0.64 && relX > 0.25 && relX < 0.75) return "face";
  if (relY < 0.45 && (relX <= 0.28 || relX >= 0.72)) return "ears";
  return region.area >= largestArea * 0.16 ? "body" : "detail";
}

function characterRegionsFromMascot(image, mask, palette, mascot, excludedCells) {
  const colorMap = characterCellMap(image, mask, mascot, palette, excludedCells);
  const rawRegions = connectedRegions(colorMap, image.width, image.height);
  if (!rawRegions.length) return [];
  const largestArea = Math.max(...rawRegions.map((region) => region.area));
  const minLayerArea = Math.max(3, Math.round(largestArea * 0.018));
  return rawRegions
    .map((region) => ({
      ...region,
      objectType: "character",
      protectedObject: mascot,
      contourPreserved: true,
      characterPreserved: true,
      characterRole: classifyCharacterRole(region, image, mascot, largestArea)
    }))
    .filter((region) => {
      if (region.characterRole === "eyes") return region.area >= 2;
      if (region.characterRole === "face") return region.area >= 3;
      if (region.characterRole === "ears") return region.area >= 3;
      return region.area >= minLayerArea;
    });
}

function characterFeatureSummary(regions, mascot, width) {
  const characterCells = regions.flatMap((region) => region.cells);
  const allBounds = cellsBounds(characterCells, width, mascot);
  const roles = new Set(regions.map((region) => region.characterRole));
  const topCells = characterCells.filter((cell) => Math.floor(cell / width) <= mascot.minY + mascot.bboxHeight * 0.42);
  const leftTop = topCells.some((cell) => {
    const x = cell % width;
    return x <= mascot.minX + mascot.bboxWidth * 0.34;
  });
  const rightTop = topCells.some((cell) => {
    const x = cell % width;
    return x >= mascot.minX + mascot.bboxWidth * 0.66;
  });
  const bodyArea = regions.filter((region) => region.characterRole === "body").reduce((sum, region) => sum + region.area, 0);
  return {
    mode: "Character Preservation Mode",
    layerCount: regions.length,
    roles: [...roles],
    bodyVisible: bodyArea >= Math.max(12, mascot.bboxWidth * mascot.bboxHeight * 0.08),
    headVisible: Boolean(allBounds && allBounds.minY <= mascot.minY + mascot.bboxHeight * 0.35),
    earsVisible: roles.has("ears") || (leftTop && rightTop),
    faceVisible: roles.has("face") || roles.has("eyes"),
    eyesVisible: roles.has("eyes"),
    silhouetteArea: characterCells.length,
    protectedObjectId: mascot.id
  };
}

function buildCharacterPreservationPreprocess(cropped, input, semantic) {
  if (/photo|portrait|picture/i.test(input.fileName || "")) return null;
  const mascot = (semantic?.protectedObjects || []).find((object) => object.type === "mascot");
  const protectedTypes = new Set((semantic?.protectedObjects || []).map((object) => object.type));
  const explicitCharacterName = /stitch|mascot|cartoon|character|anime|pet|person/i.test(input.fileName || "");
  const detectedMascot = Boolean(mascot) && mascot.source !== "file-name";
  const mixedCharacterLogo = protectedTypes.has("letter") && protectedTypes.has("swoosh") && detectedMascot;
  const hasCharacterSignal = detectedMascot && (explicitCharacterName || mixedCharacterLogo);
  if (!hasCharacterSignal) return null;
  const { image, mask } = cropped;
  const stats = singleColorLogoStats(image, mask);
  if (!explicitCharacterName && stats.averageDistance > 74 && stats.dominantBucketRatio < 0.26) return null;
  const maxColors = clamp(Math.max(Number(input.maxColors || 6), 6), 3, 10);
  const foregroundPixels = collectForegroundPixels(image, mask);
  if (!foregroundPixels.length) return null;
  const palette = quantizePalette(foregroundPixels, maxColors);
  const threads = palette.map((color, index) => ({
    index: index + 1,
    hex: rgbToHex(color),
    name: rgbToHex(color).toUpperCase()
  }));
  const textRegion = buildReconstructedTextRegion(semantic.reconstructedText, image, palette, mask, semantic);
  const excludedFromCharacter = new Set(textRegion?.cells || []);
  const swooshObject = (semantic.protectedObjects || []).find((object) => object.type === "swoosh");
  if (swooshObject) {
    for (let y = swooshObject.minY; y <= swooshObject.maxY; y += 1) {
      for (let x = swooshObject.minX; x <= swooshObject.maxX; x += 1) excludedFromCharacter.add(y * image.width + x);
    }
  }
  const characterRegions = characterRegionsFromMascot(image, mask, palette, mascot, excludedFromCharacter);
  if (!characterRegions.length) return null;
  const characterFeatures = characterFeatureSummary(characterRegions, mascot, image.width);
  if (!characterFeatures.faceVisible && !characterFeatures.eyesVisible && characterRegions.length < 4) return null;
  const textCells = new Set(textRegion?.cells || []);
  const swooshRegion = buildRegionFromProtectedBounds(image, mask, palette, swooshObject, "swoosh", { logoRole: "swoosh" }, textCells);
  const colorMap = new Int16Array(image.width * image.height);
  colorMap.fill(-1);
  const regions = [];
  if (textRegion) regions.push(textRegion);
  regions.push(...characterRegions);
  if (swooshRegion) regions.push(swooshRegion);
  for (const region of regions) {
    for (const cell of region.cells) colorMap[cell] = region.colorIndex;
  }
  return {
    width: image.width,
    height: image.height,
    colorMap,
    threads,
    regions,
    semantic: {
      ...semantic,
      characterPreservation: characterFeatures
    },
    imageType: "character preservation mode",
    mode: "character-preservation",
    cleanup: {
      cropped: cropped.cropped,
      cropBounds: cropped.bounds,
      removedTinyRegions: 0,
      minRegionSize: 0,
      visiblePixels: regions.reduce((sum, region) => sum + region.area, 0),
      characterPreservationMode: true
    }
  };
}

function removeTinyRegions(colorMap, width, height, minRegionSize, semantic = null) {
  const output = new Int16Array(colorMap);
  const regions = connectedRegions(colorMap, width, height);
  let removed = 0;
  for (const region of regions) {
    const protectedObject = assignProtectedObject(region, semantic?.protectedObjects || []);
    const protectedPrimary = protectedObject && protectedObject.priority <= 2;
    if (region.area >= minRegionSize || protectedPrimary) continue;
    removed += 1;
    const neighborCounts = new Map();
    for (const cell of region.cells) {
      const x = cell % width;
      const y = Math.floor(cell / width);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const value = colorMap[ny * width + nx];
        if (value >= 0 && value !== region.colorIndex) neighborCounts.set(value, (neighborCounts.get(value) || 0) + 1);
      }
    }
    const replacement = neighborCounts.size ? [...neighborCounts.entries()].sort((a, b) => b[1] - a[1])[0][0] : -1;
    for (const cell of region.cells) output[cell] = replacement;
  }
  return { colorMap: output, removed };
}

function classifyImage({ image, palette, regions, visiblePixels, fileName = "", semantic = null }) {
  const protectedTypes = new Set((semantic?.protectedObjects || []).map((object) => object.type));
  if (semantic?.reconstructedText) return "complex mixed artwork";
  if (protectedTypes.has("letter") && protectedTypes.has("mascot") && protectedTypes.has("swoosh")) return "complex mixed artwork";
  const area = image.width * image.height;
  const coverage = visiblePixels / Math.max(1, area);
  const regionCount = regions.length;
  const paletteCount = palette.length;
  const thinRegions = regions.filter((r) => Math.min(r.maxX - r.minX + 1, r.maxY - r.minY + 1) <= 2).length;
  const nameLooksText = /text|font|letter|word|name/i.test(fileName);
  if (/line|drawing|outline|sketch/i.test(fileName)) return "line art";
  if (/photo|portrait|picture/i.test(fileName)) return "photo";
  if (nameLooksText || (thinRegions > 5 && coverage < 0.28)) return "text-heavy image";
  if (paletteCount <= 3 && coverage < 0.22) return "line art";
  if (paletteCount <= 3 && coverage < 0.35 && thinRegions >= Math.max(1, regionCount * 0.3)) return "line art";
  if (paletteCount >= 5 && regionCount > 28) return "photo";
  if (paletteCount <= 6 && regionCount <= 24) return "logo or icon";
  return "complex illustration";
}

function classifyRegion(region, imageType, designArea, protectedObject = null) {
  if (region.objectType === "reconstructed-text") return "reconstructed-text";
  if (protectedObject?.type === "reconstructedText") return "reconstructed-text";
  if (protectedObject?.type === "letter") return "text";
  if (protectedObject?.type === "swoosh") return "swoosh";
  if (protectedObject?.type === "mascot") return "character";
  const areaRatio = region.area / Math.max(1, designArea);
  const narrow = Math.min(region.bboxWidth, region.bboxHeight) <= 3 || region.fillRatio < 0.18;
  if (region.aspect > 2.8 && areaRatio > 0.025 && region.fillRatio <= 0.72) return "swoosh";
  if ((imageType === "line art" || imageType === "text-heavy image") && areaRatio > 0.015 && region.bboxHeight > 6 && region.aspect > 0.25 && region.aspect < 4.2) return "text";
  if (imageType === "text-heavy image" || (region.bboxWidth > 8 && region.bboxHeight > 8 && region.fillRatio < 0.72 && region.aspect > 0.35 && region.aspect < 3.8)) return "text";
  if (narrow) return "linework";
  if (areaRatio < 0.012) return "detail";
  if (imageType === "complex illustration" || imageType === "photo") return "character";
  return "fill";
}

function shouldRemoveRasterTextRegion(region, reconstructedTextRegion, semantic) {
  if (!semantic?.reconstructedText || !overlapsReconstructedText(region, semantic.reconstructedText)) return false;
  if (!reconstructedTextRegion) return false;
  if (region.protectedObject?.type === "mascot" || region.protectedObject?.type === "swoosh") return false;
  if (region.protectedObject?.type === "letter") return true;
  const textArea = Math.max(1, reconstructedTextRegion.bboxWidth * reconstructedTextRegion.bboxHeight);
  const areaRatio = region.area / textArea;
  const cx = (region.minX + region.maxX) / 2;
  const cy = (region.minY + region.maxY) / 2;
  const bounds = semantic.reconstructedText.bounds;
  const central = cx > bounds.minX + (bounds.maxX - bounds.minX) * 0.22 &&
    cx < bounds.minX + (bounds.maxX - bounds.minX) * 0.78 &&
    cy > bounds.minY - (bounds.maxY - bounds.minY) * 0.15 &&
    cy < bounds.maxY + (bounds.maxY - bounds.minY) * 0.25;
  if (central && areaRatio > 0.012 && region.colorIndex !== reconstructedTextRegion.colorIndex) return false;
  if (central && areaRatio > 0.035) return false;
  return region.colorIndex === reconstructedTextRegion.colorIndex || areaRatio < 0.03;
}

function looksLikeMascotOverlay(region, reconstructedTextRegion, semantic) {
  if (!semantic?.reconstructedText || !reconstructedTextRegion || !overlapsReconstructedText(region, semantic.reconstructedText)) return false;
  if (region.protectedObject?.type === "mascot") return true;
  if (region.protectedObject?.type === "letter" || region.protectedObject?.type === "swoosh") return false;
  const bounds = semantic.reconstructedText.bounds;
  const cx = (region.minX + region.maxX) / 2;
  const cy = (region.minY + region.maxY) / 2;
  const central = cx > bounds.minX + (bounds.maxX - bounds.minX) * 0.2 &&
    cx < bounds.minX + (bounds.maxX - bounds.minX) * 0.8 &&
    cy > bounds.minY - (bounds.maxY - bounds.minY) * 0.18 &&
    cy < bounds.maxY + (bounds.maxY - bounds.minY) * 0.3;
  const areaRatio = region.area / Math.max(1, reconstructedTextRegion.bboxWidth * reconstructedTextRegion.bboxHeight);
  return central && areaRatio > 0.008 && region.colorIndex !== reconstructedTextRegion.colorIndex;
}

function preprocessImage(input) {
  validateImageInput(input);
  const maxColors = clamp(Number(input.maxColors || 6), 1, 10);
  const rawMinRegionSize = Number(input.minRegionSize);
  const removeTransparent = input.removeTransparent !== false;
  const initialMask = visibleMask(input.image, removeTransparent, true);
  const cropped = cropToMask(input.image, initialMask);
  const initialMode = detectArtworkMode(cropped.image, input);
  if (initialMode.mode === ArtworkMode.OUTLINE_VECTOR_ICON) {
    const outlineIcon = processOutlineVectorIcon(cropped, input, initialMode.analysis);
    if (outlineIcon) return outlineIcon;
  }
  if (initialMode.mode === ArtworkMode.SINGLE_COLOR_LOGO) {
    const singleColorLogo = buildSingleColorLogoPreprocess(cropped, input);
    if (singleColorLogo) return singleColorLogo;
  }
  const professional = processProfessionalDigitizing(cropped, input);
  if (professional) return professional;
  const semantic = detectProtectedObjects(cropped.image, cropped.mask, input);
  semantic.reconstructedText = detectReconstructedText(semantic, input);
  const characterPreservation = buildCharacterPreservationPreprocess(cropped, input, semantic);
  if (characterPreservation) return characterPreservation;
  const smoothed = smoothImage(cropped.image, cropped.mask);
  const pixels = collectPixels(smoothed, cropped.mask);
  const defaultMinRegion = Math.max(4, Math.round(cropped.image.width * cropped.image.height * 0.005));
  const minRegionSize = clamp(Number.isFinite(rawMinRegionSize) ? rawMinRegionSize : defaultMinRegion, 0, 5000);
  const palette = quantizePalette(pixels, maxColors);
  let colorMap = buildColorMap(smoothed, cropped.mask, palette);
  colorMap = closeSameColorGaps(colorMap, smoothed.width, smoothed.height);
  colorMap = fillSmallHoles(colorMap, smoothed.width, smoothed.height);
  colorMap = majoritySmooth(colorMap, smoothed.width, smoothed.height, Number(input.borderSmoothing || 1));
  const removedResult = removeTinyRegions(colorMap, smoothed.width, smoothed.height, minRegionSize, semantic);
  colorMap = closeSameColorGaps(removedResult.colorMap, smoothed.width, smoothed.height);
  colorMap = majoritySmooth(fillSmallHoles(colorMap, smoothed.width, smoothed.height), smoothed.width, smoothed.height, 1);
  const threads = palette.map((color, index) => ({
    index: index + 1,
    hex: rgbToHex(color),
    name: rgbToHex(color).toUpperCase()
  }));
  const reconstructedTextRegion = buildReconstructedTextRegion(semantic.reconstructedText, cropped.image, palette, cropped.mask, semantic);
  let regions = connectedRegions(colorMap, smoothed.width, smoothed.height).map((region) => {
    const protectedObject = assignProtectedObject(region, semantic.protectedObjects);
    return {
      ...region,
      protectedObject
    };
  }).filter((r) => (
    !shouldRemoveRasterTextRegion(r, reconstructedTextRegion, semantic) &&
    (r.area >= Math.max(1, Math.floor(minRegionSize / 2)) || r.protectedObject?.priority <= 2)
  ));
  const visiblePixels = regions.reduce((sum, region) => sum + region.area, 0);
  const imageType = classifyImage({ image: smoothed, palette, regions, visiblePixels, fileName: input.fileName, semantic });
  regions = regions.map((region) => ({
    ...region,
    objectType: looksLikeMascotOverlay(region, reconstructedTextRegion, semantic) ? "character" : classifyRegion(region, imageType, smoothed.width * smoothed.height, region.protectedObject)
  }));
  if (reconstructedTextRegion) regions.unshift(reconstructedTextRegion);
  if (!regions.length) {
    const universalSafe = processUniversalSafeDst(cropped, input);
    if (universalSafe) return universalSafe;
  }
  return {
    width: smoothed.width,
    height: smoothed.height,
    colorMap,
    threads,
    regions,
    semantic,
    imageType,
    cleanup: {
      cropped: cropped.cropped,
      cropBounds: cropped.bounds,
      removedTinyRegions: removedResult.removed,
      minRegionSize,
      visiblePixels
    }
  };
}

module.exports = {
  preprocessImage,
  quantizePalette,
  validateImageInput,
  rgbToHex,
  visibleMask,
  cropToMask,
  connectedRegions,
  majoritySmooth
};
