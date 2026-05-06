const { createForegroundMask, getMaskBounds } = require("../foregroundBounds");

function rgbToHex(color) {
  return `#${color.slice(0, 3).map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
}

function luminance(color) {
  return 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
}

function collectComponents(mask, width, height) {
  const visited = new Uint8Array(mask.length);
  const components = [];
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i] || visited[i]) continue;
    const stack = [i];
    const cells = [];
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let perimeter = 0;
    visited[i] = 1;
    while (stack.length) {
      const cell = stack.pop();
      cells.push(cell);
      const x = cell % width;
      const y = Math.floor(cell / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
          perimeter += 1;
          continue;
        }
        const next = ny * width + nx;
        if (!mask[next]) {
          perimeter += 1;
          continue;
        }
        if (!visited[next]) {
          visited[next] = 1;
          stack.push(next);
        }
      }
    }
    const bboxWidth = maxX - minX + 1;
    const bboxHeight = maxY - minY + 1;
    components.push({
      cells,
      area: cells.length,
      minX,
      minY,
      maxX,
      maxY,
      bboxWidth,
      bboxHeight,
      aspect: bboxWidth / Math.max(1, bboxHeight),
      fillRatio: cells.length / Math.max(1, bboxWidth * bboxHeight),
      perimeter
    });
  }
  return components.sort((a, b) => b.area - a.area);
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
  return luminance(average) < 120 ? [18, 18, 18] : average;
}

function componentToRegion(component, width, index) {
  const estimatedStrokeWidthPx = Math.max(1, Math.min(component.bboxWidth, component.bboxHeight, (component.area * 2) / Math.max(1, component.perimeter)));
  return {
    colorIndex: 0,
    cells: component.cells,
    area: component.area,
    minX: component.minX,
    minY: component.minY,
    maxX: component.maxX,
    maxY: component.maxY,
    bboxWidth: component.bboxWidth,
    bboxHeight: component.bboxHeight,
    aspect: component.aspect,
    fillRatio: component.fillRatio,
    perimeter: component.perimeter,
    objectType: "outline-path",
    outlineVectorIcon: true,
    contourPreserved: true,
    estimatedStrokeWidthPx,
    protectedObject: {
      id: `outline-path-${index + 1}`,
      type: "outlinePath",
      label: `Outline path ${index + 1}`,
      priority: 1,
      isPrimary: index === 0,
      locked: true,
      confidence: 0.94,
      source: "outline-vector-icon",
      minX: component.minX,
      minY: component.minY,
      maxX: component.maxX,
      maxY: component.maxY,
      bboxWidth: component.bboxWidth,
      bboxHeight: component.bboxHeight
    }
  };
}

function processOutlineVectorIcon(cropped, input = {}, analysis = {}) {
  const image = cropped.image;
  const foregroundMask = createForegroundMask(image, { ignoreNearWhite: true });
  const bounds = getMaskBounds(foregroundMask, image.width, image.height);
  if (bounds.empty || bounds.area < 12) return null;
  const rawComponents = collectComponents(foregroundMask, image.width, image.height);
  const minArea = Math.max(2, Math.round(bounds.area * 0.0015));
  const components = rawComponents.filter((component) => (
    component.area >= minArea ||
    Math.max(component.bboxWidth, component.bboxHeight) >= Math.max(4, bounds.bboxWidth * 0.035)
  ));
  if (!components.length) return null;
  const colorMap = new Int16Array(image.width * image.height);
  colorMap.fill(-1);
  const regions = components.map((component, index) => componentToRegion(component, image.width, index));
  for (const region of regions) {
    for (const cell of region.cells) colorMap[cell] = 0;
  }
  const threadHex = rgbToHex(averageForegroundColor(image, foregroundMask));
  const totalPathArea = regions.reduce((sum, region) => sum + region.area, 0);
  const totalPerimeter = regions.reduce((sum, region) => sum + region.perimeter, 0);
  const fragmentRatio = Math.max(0, rawComponents.length - components.length) / Math.max(1, rawComponents.length);
  return {
    width: image.width,
    height: image.height,
    colorMap,
    threads: [{ index: 1, hex: threadHex, name: threadHex.toUpperCase() }],
    regions,
    semantic: {
      protectedObjects: regions.map((region) => region.protectedObject),
      visible: bounds,
      components: components.length,
      artworkMode: "OUTLINE_VECTOR_ICON",
      outlineValidation: {
        pathCount: regions.length,
        foregroundArea: totalPathArea,
        totalPerimeter,
        fragmentRatio,
        foregroundFillRatio: analysis.foregroundFillRatio || (bounds.area / Math.max(1, bounds.bboxWidth * bounds.bboxHeight)),
        continuousEnough: regions.length <= 80 && fragmentRatio < 0.55
      }
    },
    imageType: "outline vector icon mode",
    mode: "outline-vector-icon",
    cleanup: {
      cropped: cropped.cropped,
      cropBounds: cropped.bounds,
      foregroundBounds: bounds,
      removedTinyRegions: rawComponents.length - components.length,
      minRegionSize: minArea,
      visiblePixels: totalPathArea,
      outlineVectorIconMode: true
    }
  };
}

module.exports = {
  processOutlineVectorIcon
};
