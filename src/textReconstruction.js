function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function colorDistance(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16)
  ];
}

function rgbToHex(color) {
  return `#${color.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

function nearestPaletteIndex(hex, palette) {
  const rgb = hexToRgb(hex);
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < palette.length; i += 1) {
    const distance = colorDistance(rgb, palette[i]);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

function pixelAt(image, cell) {
  const i = cell * 4;
  return [image.rgba[i], image.rgba[i + 1], image.rgba[i + 2], image.rgba[i + 3]];
}

function isNearWhite([r, g, b]) {
  return r > 242 && g > 242 && b > 242 && Math.max(r, g, b) - Math.min(r, g, b) < 28;
}

function bucketKey(color) {
  return color.slice(0, 3).map((value) => Math.round(value / 16)).join(",");
}

function bucketCenter(key) {
  return key.split(",").map((value) => clamp(Number(value) * 16, 0, 255));
}

function boundsForCells(cells, width) {
  let minX = width;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (const cell of cells) {
    const x = cell % width;
    const y = Math.floor(cell / width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (maxX < minX) return null;
  return {
    minX,
    minY,
    maxX,
    maxY,
    bboxWidth: maxX - minX + 1,
    bboxHeight: maxY - minY + 1
  };
}

function averageColorForCells(image, cells) {
  const sums = [0, 0, 0, 0];
  for (const cell of cells) {
    const [r, g, b, a] = pixelAt(image, cell);
    if (a < 40 || isNearWhite([r, g, b])) continue;
    sums[0] += r;
    sums[1] += g;
    sums[2] += b;
    sums[3] += 1;
  }
  if (!sums[3]) return "#f04aa6";
  return rgbToHex([sums[0] / sums[3], sums[1] / sums[3], sums[2] / sums[3]]);
}

function detectBrand(semantic, input = {}) {
  const fileName = input.fileName || "";
  const labels = (semantic?.protectedObjects || []).map((object) => object.label || "").join(" ");
  if (/nike/i.test(fileName) || /Letter N.*Letter I.*Letter K.*Letter E/i.test(labels)) return "Nike";
  if (/adidas/i.test(fileName)) return "Adidas";
  if (/jordan/i.test(fileName)) return "Jordan";
  return null;
}

function detectReconstructedText(semantic, input = {}) {
  const preserveText = input.preserveText !== false;
  const rebuildText = input.rebuildText !== false;
  const letters = (semantic?.protectedObjects || []).filter((object) => object.type === "letter");
  const brand = detectBrand(semantic, input);
  const hasDetectedLetterEvidence = letters.some((letter) => letter.source !== "file-name");
  if (!preserveText || !rebuildText || letters.length < 4 || brand !== "Nike" || !hasDetectedLetterEvidence) return null;
  const minX = Math.min(...letters.map((letter) => letter.minX));
  const minY = Math.min(...letters.map((letter) => letter.minY));
  const maxX = Math.max(...letters.map((letter) => letter.maxX));
  const maxY = Math.max(...letters.map((letter) => letter.maxY));
  const padX = Math.max(1, Math.round((maxX - minX + 1) * 0.025));
  const padY = Math.max(1, Math.round((maxY - minY + 1) * 0.04));
  return {
    id: "reconstructed-text-1",
    type: "reconstructedText",
    text: "NIKE",
    textStyle: input.preserveTextStyle === false ? "solid" : "preserve-original",
    originalTextStyle: "unknown",
    source: "contour-reconstruction",
    reconstructionMode: "contour-preserving",
    contourSource: "original-artwork",
    brand,
    brandProtected: true,
    confidence: 0.92,
    protectedObjectIds: letters.map((letter) => letter.id),
    bounds: {
      minX: Math.max(0, minX - padX),
      minY: Math.max(0, minY - padY),
      maxX: maxX + padX,
      maxY: maxY + padY
    }
  };
}

function letterBounds(reconstruction, semantic) {
  const ids = new Set(reconstruction.protectedObjectIds || []);
  return (semantic?.protectedObjects || [])
    .filter((object) => object.type === "letter" && ids.has(object.id))
    .map((object) => ({
      minX: object.minX,
      minY: object.minY,
      maxX: object.maxX,
      maxY: object.maxY,
      bboxWidth: object.bboxWidth,
      bboxHeight: object.bboxHeight
    }));
}

function insideBounds(x, y, bounds) {
  return x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
}

function insideAnyBounds(x, y, boundsList) {
  return boundsList.some((bounds) => insideBounds(x, y, bounds));
}

function excludedObjects(semantic) {
  return (semantic?.protectedObjects || []).filter((object) => (
    object.type === "mascot" ||
    object.type === "swoosh"
  ));
}

function isInsideExcludedObject(x, y, semantic) {
  return excludedObjects(semantic).some((object) => insideBounds(x, y, object));
}

function dominantContourColor(image, mask, boundsList, semantic) {
  const buckets = new Map();
  for (const bounds of boundsList) {
    const edgeBand = Math.max(1, Math.round(Math.min(bounds.bboxWidth, bounds.bboxHeight) * 0.16));
    for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
      for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
        const cell = y * image.width + x;
        if (!mask[cell] || isInsideExcludedObject(x, y, semantic)) continue;
        const color = pixelAt(image, cell);
        if (color[3] < 40 || isNearWhite(color)) continue;
        const edgeDistance = Math.min(x - bounds.minX, bounds.maxX - x, y - bounds.minY, bounds.maxY - y);
        const weight = edgeDistance <= edgeBand ? 4 : 1;
        const key = bucketKey(color);
        buckets.set(key, (buckets.get(key) || 0) + weight);
      }
    }
  }
  const [key] = [...buckets.entries()].sort((a, b) => b[1] - a[1])[0] || [];
  return key ? bucketCenter(key) : null;
}

function collectContourCells(image, mask, reconstruction, semantic, threshold) {
  const letters = letterBounds(reconstruction, semantic);
  const boundsList = letters.length ? letters : [reconstruction.bounds];
  const dominant = dominantContourColor(image, mask, boundsList, semantic);
  const cells = [];
  const cellSet = new Set();
  for (const bounds of boundsList) {
    const minX = clamp(Math.floor(bounds.minX), 0, image.width - 1);
    const minY = clamp(Math.floor(bounds.minY), 0, image.height - 1);
    const maxX = clamp(Math.ceil(bounds.maxX), 0, image.width - 1);
    const maxY = clamp(Math.ceil(bounds.maxY), 0, image.height - 1);
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        if (letters.length && !insideAnyBounds(x, y, letters)) continue;
        if (isInsideExcludedObject(x, y, semantic)) continue;
        const cell = y * image.width + x;
        if (!mask[cell]) continue;
        const color = pixelAt(image, cell);
        if (color[3] < 40 || isNearWhite(color)) continue;
        if (dominant && colorDistance(color, dominant) > threshold * threshold) continue;
        if (cellSet.has(cell)) continue;
        cellSet.add(cell);
        cells.push(cell);
      }
    }
  }
  return cells;
}

function closeSinglePixelGaps(cells, width, height, bounds) {
  const set = new Set(cells);
  const added = [];
  for (let y = Math.max(1, bounds.minY); y <= Math.min(height - 2, bounds.maxY); y += 1) {
    for (let x = Math.max(1, bounds.minX); x <= Math.min(width - 2, bounds.maxX); x += 1) {
      const cell = y * width + x;
      if (set.has(cell)) continue;
      const left = set.has(y * width + x - 1);
      const right = set.has(y * width + x + 1);
      const up = set.has((y - 1) * width + x);
      const down = set.has((y + 1) * width + x);
      if ((left && right) || (up && down)) added.push(cell);
    }
  }
  for (const cell of added) set.add(cell);
  return [...set].sort((a, b) => a - b);
}

function removeTinyIslands(cells, width, minArea) {
  const set = new Set(cells);
  const visited = new Set();
  const kept = [];
  for (const cell of cells) {
    if (visited.has(cell)) continue;
    const stack = [cell];
    const component = [];
    visited.add(cell);
    while (stack.length) {
      const current = stack.pop();
      component.push(current);
      const x = current % width;
      const y = Math.floor(current / width);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const next = (y + dy) * width + x + dx;
        if (!set.has(next) || visited.has(next)) continue;
        visited.add(next);
        stack.push(next);
      }
    }
    if (component.length >= minArea) kept.push(...component);
  }
  return kept.sort((a, b) => a - b);
}

function styleFromContour(cells, bounds, requestedStyle) {
  if (requestedStyle === "solid") return "solid";
  const fillRatio = cells.length / Math.max(1, bounds.bboxWidth * bounds.bboxHeight);
  return fillRatio >= 0.48 ? "solid" : "outline";
}

function buildReconstructedTextRegion(reconstruction, image, palette, mask, semantic) {
  if (!reconstruction || !mask) return null;
  const rawBounds = {
    minX: clamp(Math.floor(reconstruction.bounds.minX), 0, image.width - 1),
    minY: clamp(Math.floor(reconstruction.bounds.minY), 0, image.height - 1),
    maxX: clamp(Math.ceil(reconstruction.bounds.maxX), 0, image.width - 1),
    maxY: clamp(Math.ceil(reconstruction.bounds.maxY), 0, image.height - 1)
  };
  const expectedArea = Math.max(8, Math.round((rawBounds.maxX - rawBounds.minX + 1) * (rawBounds.maxY - rawBounds.minY + 1) * 0.01));
  let cells = collectContourCells(image, mask, reconstruction, semantic, 78);
  if (cells.length < expectedArea) cells = collectContourCells(image, mask, reconstruction, semantic, 130);
  if (cells.length < expectedArea) return null;

  cells = closeSinglePixelGaps(cells, image.width, image.height, rawBounds);
  cells = removeTinyIslands(cells, image.width, Math.min(10, Math.max(2, Math.floor(cells.length * 0.002))));
  const bounds = boundsForCells(cells, image.width);
  if (!bounds || cells.length < expectedArea) return null;

  const colorHex = averageColorForCells(image, cells);
  const colorIndex = nearestPaletteIndex(colorHex, palette);
  const textStyle = styleFromContour(cells, bounds, reconstruction.textStyle);
  const rebuilt = {
    ...reconstruction,
    textStyle,
    originalTextStyle: textStyle,
    source: "contour-reconstruction",
    reconstructionMode: "contour-preserving",
    contourSource: "original-artwork"
  };
  return {
    colorIndex,
    cells,
    area: cells.length,
    minX: bounds.minX,
    minY: bounds.minY,
    maxX: bounds.maxX,
    maxY: bounds.maxY,
    bboxWidth: bounds.bboxWidth,
    bboxHeight: bounds.bboxHeight,
    fillRatio: cells.length / Math.max(1, bounds.bboxWidth * bounds.bboxHeight),
    aspect: bounds.bboxWidth / Math.max(1, bounds.bboxHeight),
    perimeter: cells.length,
    objectType: "reconstructed-text",
    reconstructedText: rebuilt,
    textStyle,
    contourPreserved: true,
    brandProtected: reconstruction.brandProtected,
    protectedObject: {
      id: reconstruction.id,
      type: "reconstructedText",
      label: reconstruction.text,
      priority: 1,
      isPrimary: true,
      locked: true,
      confidence: reconstruction.confidence,
      minX: bounds.minX,
      minY: bounds.minY,
      maxX: bounds.maxX,
      maxY: bounds.maxY,
      bboxWidth: bounds.bboxWidth,
      bboxHeight: bounds.bboxHeight
    }
  };
}

function overlapsReconstructedText(region, reconstruction) {
  if (!reconstruction) return false;
  const bounds = reconstruction.bounds;
  const minX = Math.max(region.minX, bounds.minX);
  const minY = Math.max(region.minY, bounds.minY);
  const maxX = Math.min(region.maxX, bounds.maxX);
  const maxY = Math.min(region.maxY, bounds.maxY);
  if (maxX < minX || maxY < minY) return false;
  const overlap = (maxX - minX + 1) * (maxY - minY + 1);
  const regionBox = Math.max(1, region.bboxWidth * region.bboxHeight);
  return overlap / regionBox > 0.18;
}

module.exports = {
  detectReconstructedText,
  buildReconstructedTextRegion,
  overlapsReconstructedText
};
