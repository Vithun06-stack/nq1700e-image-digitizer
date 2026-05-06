const { createForegroundMask, getMaskBounds } = require("../foregroundBounds");

function rgbToHex(color) {
  return `#${color.slice(0, 3).map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
}

function luminance(color) {
  return 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
}

function averageForegroundColor(image, mask) {
  const sums = [0, 0, 0, 0];
  for (let p = 0; p < mask.length; p += 1) {
    if (!mask[p]) continue;
    const i = p * 4;
    sums[0] += image.rgba[i];
    sums[1] += image.rgba[i + 1];
    sums[2] += image.rgba[i + 2];
    sums[3] += 1;
  }
  if (!sums[3]) return [0, 0, 0];
  const average = [sums[0] / sums[3], sums[1] / sums[3], sums[2] / sums[3]];
  return luminance(average) > 238 ? [30, 30, 30] : average;
}

function componentFromCells(cells, width, colorIndex) {
  let minX = width;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  let perimeter = 0;
  const set = new Set(cells);
  for (const cell of cells) {
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
    cells,
    area: cells.length,
    minX,
    minY,
    maxX,
    maxY,
    perimeter,
    bboxWidth,
    bboxHeight,
    fillRatio: cells.length / Math.max(1, bboxWidth * bboxHeight),
    aspect: bboxWidth / Math.max(1, bboxHeight),
    objectType: "fill",
    universalSafeDst: true
  };
}

function collectComponents(mask, width, height) {
  const visited = new Uint8Array(mask.length);
  const components = [];
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i] || visited[i]) continue;
    const stack = [i];
    const cells = [];
    visited[i] = 1;
    while (stack.length) {
      const cell = stack.pop();
      cells.push(cell);
      const x = cell % width;
      const y = Math.floor(cell / width);
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
    components.push(cells);
  }
  return components.sort((a, b) => b.length - a.length);
}

function processUniversalSafeDst(cropped) {
  const image = cropped.image;
  const foregroundMask = createForegroundMask(image, { ignoreNearWhite: true });
  const bounds = getMaskBounds(foregroundMask, image.width, image.height);
  if (bounds.empty || bounds.area < 4) return null;
  const components = collectComponents(foregroundMask, image.width, image.height)
    .filter((cells) => cells.length >= Math.max(2, Math.round(bounds.area * 0.001)));
  if (!components.length) return null;
  const colorMap = new Int16Array(image.width * image.height);
  colorMap.fill(-1);
  const regions = components.map((cells) => componentFromCells(cells, image.width, 0));
  for (const region of regions) {
    for (const cell of region.cells) colorMap[cell] = 0;
  }
  const threadHex = rgbToHex(averageForegroundColor(image, foregroundMask));
  return {
    width: image.width,
    height: image.height,
    colorMap,
    threads: [{ index: 1, hex: threadHex, name: threadHex.toUpperCase() }],
    regions,
    semantic: {
      protectedObjects: [],
      visible: bounds,
      artworkMode: "UNIVERSAL_SAFE_DST"
    },
    imageType: "universal safe dst mode",
    mode: "universal-safe-dst",
    cleanup: {
      cropped: cropped.cropped,
      cropBounds: cropped.bounds,
      foregroundBounds: bounds,
      removedTinyRegions: 0,
      minRegionSize: 0,
      visiblePixels: regions.reduce((sum, region) => sum + region.area, 0),
      universalSafeDstMode: true
    }
  };
}

module.exports = {
  processUniversalSafeDst
};
