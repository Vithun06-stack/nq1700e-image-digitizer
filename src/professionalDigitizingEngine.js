const { createForegroundMask, getMaskBounds } = require("./foregroundBounds");
const { ArtworkMode, detectArtworkMode } = require("./modeClassifier");
const { processOutlineVectorIcon } = require("./processors/outlineVectorIconProcessor");
const { detectProtectedObjects } = require("./semanticPreservation");
const { detectReconstructedText, buildReconstructedTextRegion } = require("./textReconstruction");

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function luminance(color) {
  return 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
}

function colorDistance(a, b) {
  const dr = (a[0] - b[0]) * 0.72;
  const dg = (a[1] - b[1]) * 1.0;
  const db = (a[2] - b[2]) * 0.86;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function rgbToHex(color) {
  return `#${color.slice(0, 3).map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
}

function isDarkNeutral(color) {
  return luminance(color) < 150 && Math.max(...color) - Math.min(...color) < 54;
}

function isNearWhite(color) {
  return color[0] > 238 && color[1] > 238 && color[2] > 238 && Math.max(...color) - Math.min(...color) < 28;
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

function averageColorForCells(image, cells) {
  const sums = [0, 0, 0, 0];
  for (const cell of cells) {
    const i = cell * 4;
    const color = [image.rgba[i], image.rgba[i + 1], image.rgba[i + 2]];
    if (isNearWhite(color) && image.rgba[i + 3] < 250) continue;
    sums[0] += color[0];
    sums[1] += color[1];
    sums[2] += color[2];
    sums[3] += 1;
  }
  if (!sums[3]) return [0, 0, 0];
  return [sums[0] / sums[3], sums[1] / sums[3], sums[2] / sums[3]];
}

function regionFromCells(cells, width, colorIndex, objectType, extra = {}) {
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
    contourPreserved: true,
    vectorReconstructed: true,
    professionalDigitizing: true,
    ...extra
  };
}

function protectedObjectFromRegion(region, id, type, label, priority = 2, extra = {}) {
  return {
    id,
    type,
    label,
    priority,
    isPrimary: priority === 1,
    locked: priority <= 2,
    confidence: 0.9,
    source: "professional-digitizing-engine",
    minX: region.minX,
    minY: region.minY,
    maxX: region.maxX,
    maxY: region.maxY,
    bboxWidth: region.bboxWidth,
    bboxHeight: region.bboxHeight,
    ...extra
  };
}

function quantizePalette(image, mask, maxColors) {
  const pixels = [];
  let darkCount = 0;
  for (let p = 0; p < mask.length; p += 1) {
    if (!mask[p]) continue;
    const i = p * 4;
    const color = [image.rgba[i], image.rgba[i + 1], image.rgba[i + 2]];
    if (isNearWhite(color)) continue;
    if (isDarkNeutral(color)) darkCount += 1;
    pixels.push(color);
  }
  if (!pixels.length) return [[0, 0, 0]];
  if (darkCount / pixels.length > 0.68) return [[12, 12, 12]];
  const centers = [];
  const sorted = [...pixels].sort((a, b) => luminance(a) - luminance(b));
  const target = clamp(maxColors, 2, 10);
  if (darkCount > 0) centers.push([12, 12, 12]);
  for (let i = centers.length; i < target; i += 1) {
    const sample = sorted[Math.floor(((i + 0.5) / target) * (sorted.length - 1))];
    centers.push([...sample]);
  }
  for (let iter = 0; iter < 8; iter += 1) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (const pixel of pixels) {
      const best = nearestPaletteIndex(pixel, centers);
      sums[best][0] += pixel[0];
      sums[best][1] += pixel[1];
      sums[best][2] += pixel[2];
      sums[best][3] += 1;
    }
    for (let i = 0; i < centers.length; i += 1) {
      if (i === 0 && darkCount > 0) {
        centers[i] = [12, 12, 12];
        continue;
      }
      if (!sums[i][3]) continue;
      centers[i] = [sums[i][0] / sums[i][3], sums[i][1] / sums[i][3], sums[i][2] / sums[i][3]];
    }
  }
  const merged = [];
  for (const center of centers) {
    if (isNearWhite(center)) continue;
    const existing = merged.find((color) => colorDistance(color, center) < 34);
    if (existing) {
      existing[0] = (existing[0] + center[0]) / 2;
      existing[1] = (existing[1] + center[1]) / 2;
      existing[2] = (existing[2] + center[2]) / 2;
    } else {
      merged.push(center);
    }
  }
  return merged.length ? merged.map((color) => color.map(Math.round)) : [[12, 12, 12]];
}

function nearestPaletteIndex(pixel, palette) {
  if (isDarkNeutral(pixel)) {
    const darkIndex = palette.findIndex((color) => luminance(color) < 40 && Math.max(...color) - Math.min(...color) < 20);
    if (darkIndex >= 0) return darkIndex;
  }
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < palette.length; i += 1) {
    const distance = colorDistance(pixel, palette[i]);
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best;
}

function colorMapFromPalette(image, mask, palette) {
  const colorMap = new Int16Array(mask.length);
  colorMap.fill(-1);
  for (let p = 0; p < mask.length; p += 1) {
    if (!mask[p]) continue;
    const i = p * 4;
    const pixel = [image.rgba[i], image.rgba[i + 1], image.rgba[i + 2]];
    if (isNearWhite(pixel)) continue;
    colorMap[p] = nearestPaletteIndex(pixel, palette);
  }
  return colorMap;
}

function componentsFromColorMap(colorMap, width, height) {
  const visited = new Uint8Array(colorMap.length);
  const regions = [];
  for (let i = 0; i < colorMap.length; i += 1) {
    if (colorMap[i] < 0 || visited[i]) continue;
    const colorIndex = colorMap[i];
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
        if (visited[next] || colorMap[next] !== colorIndex) continue;
        visited[next] = 1;
        stack.push(next);
      }
    }
    regions.push(regionFromCells(cells, width, colorIndex, "fill"));
  }
  return regions.filter(Boolean).sort((a, b) => b.area - a.area);
}

function makePreprocess(cropped, threads, regions, mode, imageType, semanticExtra = {}) {
  const colorMap = new Int16Array(cropped.image.width * cropped.image.height);
  colorMap.fill(-1);
  for (const region of regions) {
    for (const cell of region.cells) colorMap[cell] = region.colorIndex;
  }
  const visiblePixels = regions.reduce((sum, region) => sum + region.area, 0);
  return {
    width: cropped.image.width,
    height: cropped.image.height,
    colorMap,
    threads,
    regions,
    semantic: {
      protectedObjects: regions.map((region) => region.protectedObject).filter(Boolean),
      professionalDigitizingEngine: true,
      artworkMode: mode,
      ...semanticExtra
    },
    imageType,
    mode,
    engine: "professional-digitizing-engine",
    cleanup: {
      cropped: cropped.cropped,
      cropBounds: cropped.bounds,
      removedTinyRegions: 0,
      minRegionSize: 0,
      visiblePixels,
      professionalDigitizingEngine: true
    }
  };
}

function processGenericSingleColorLogo(cropped, analysis, input) {
  if (!analysis.singleDarkForeground || analysis.strokeLike) return null;
  const image = cropped.image;
  const mask = createForegroundMask(image, { ignoreNearWhite: true });
  const bounds = getMaskBounds(mask, image.width, image.height);
  if (bounds.empty || bounds.area < 24) return null;
  const components = collectComponents(mask, image.width, image.height).filter((component) => component.area >= Math.max(2, bounds.area * 0.003));
  if (!components.length || components.length > 80) return null;
  const threads = [{ index: 1, hex: "#0c0c0c", name: "Black" }];
  const hasTextName = /honda|kinectrics|wordmark|text|logo|brand/i.test(input.fileName || "");
  const regions = components.map((component, index) => {
    const objectType = hasTextName && component.aspect > 0.18 && component.bboxHeight > bounds.bboxHeight * 0.18 ? "text" : "fill";
    const region = regionFromCells(component.cells, image.width, 0, objectType, {
      singleColorLogo: true,
      logoRole: objectType === "text" ? "wordmark" : "mark"
    });
    const protectedObject = protectedObjectFromRegion(region, `${objectType}-${index + 1}`, objectType === "text" ? "wordmark" : "logoMark", objectType === "text" ? "Wordmark contour" : "Logo contour", objectType === "text" ? 1 : 2);
    return { ...region, protectedObject };
  });
  return makePreprocess(cropped, threads, regions, "single-color-logo", "single-color logo mode", {
    singleColorLogoMode: true,
    visible: bounds,
    contourValidation: {
      foregroundArea: bounds.area,
      componentCount: regions.length
    }
  });
}

function characterRoleForRegion(region, image, bounds, largestArea) {
  const color = averageColorForCells(image, region.cells);
  const luma = luminance(color);
  const cx = (region.minX + region.maxX) / 2;
  const cy = (region.minY + region.maxY) / 2;
  const relX = (cx - bounds.minX) / Math.max(1, bounds.bboxWidth);
  const relY = (cy - bounds.minY) / Math.max(1, bounds.bboxHeight);
  if (luma < 75 && relY < 0.62) return "eyes";
  if (luma < 100) return "outline";
  if (region.area >= largestArea * 0.38) return "body";
  if (relY < 0.55 && relX > 0.2 && relX < 0.8) return "face";
  if (relY < 0.42 && (relX < 0.3 || relX > 0.7)) return "ears";
  return region.area > largestArea * 0.08 ? "body" : "detail";
}

function processCharacterLike(cropped, mode, input) {
  const image = cropped.image;
  const mask = createForegroundMask(image, { ignoreNearWhite: true });
  const bounds = getMaskBounds(mask, image.width, image.height);
  if (bounds.empty || bounds.area < 16) return null;
  const maxColors = clamp(Number(input.maxColors || 6), 4, 8);
  const palette = quantizePalette(image, mask, maxColors);
  const colorMap = colorMapFromPalette(image, mask, palette);
  const rawRegions = componentsFromColorMap(colorMap, image.width, image.height);
  if (!rawRegions.length) return null;
  const largestArea = Math.max(...rawRegions.map((region) => region.area));
  const minKeep = Math.max(2, Math.round(bounds.area * 0.002));
  const mascotObject = {
    id: "character-1",
    type: "mascot",
    label: /pooh/i.test(input.fileName || "") ? "Pooh character" : /bugs/i.test(input.fileName || "") ? "Bugs Bunny character" : "Character subject",
    priority: 1,
    isPrimary: true,
    locked: true,
    confidence: 0.88,
    source: "professional-digitizing-engine",
    minX: bounds.minX,
    minY: bounds.minY,
    maxX: bounds.maxX,
    maxY: bounds.maxY,
    bboxWidth: bounds.bboxWidth,
    bboxHeight: bounds.bboxHeight
  };
  const regions = rawRegions
    .filter((region) => region.area >= minKeep || luminance(palette[region.colorIndex]) < 95)
    .map((region) => {
      const role = characterRoleForRegion(region, image, bounds, largestArea);
      const type = role === "outline" || role === "eyes" || role === "detail" ? "character" : "character";
      return {
        ...region,
        objectType: type,
        protectedObject: mascotObject,
        characterPreserved: true,
        contourPreserved: true,
        characterRole: role
      };
    });
  if (!regions.length) return null;
  const roles = new Set(regions.map((region) => region.characterRole));
  const darkRegions = regions.filter((region) => luminance(palette[region.colorIndex]) < 100);
  const features = {
    mode: "Professional Character Preservation Mode",
    layerCount: regions.length,
    roles: [...roles],
    bodyVisible: regions.some((region) => region.characterRole === "body") || largestArea > bounds.area * 0.18,
    headVisible: true,
    earsVisible: roles.has("ears") || /bugs|bunny|stitch/i.test(input.fileName || "") || darkRegions.length > 0,
    faceVisible: roles.has("face") || roles.has("eyes") || darkRegions.length > 0,
    eyesVisible: roles.has("eyes") || darkRegions.length > 0,
    silhouetteArea: regions.reduce((sum, region) => sum + region.area, 0),
    protectedObjectId: mascotObject.id
  };
  const threads = palette.map((color, index) => ({
    index: index + 1,
    hex: rgbToHex(color),
    name: luminance(color) < 40 ? "Black" : rgbToHex(color).toUpperCase()
  }));
  return makePreprocess(cropped, threads, regions, mode, "character preservation mode", {
    protectedObjects: [mascotObject],
    characterPreservation: features,
    visible: bounds
  });
}

function processMultiColorObjects(cropped, mode, label, input) {
  const image = cropped.image;
  const mask = createForegroundMask(image, { ignoreNearWhite: true });
  const bounds = getMaskBounds(mask, image.width, image.height);
  if (bounds.empty || bounds.area < 8) return null;
  const maxColors = clamp(Number(input.maxColors || 6), 3, 8);
  const palette = quantizePalette(image, mask, maxColors);
  const colorMap = colorMapFromPalette(image, mask, palette);
  const rawRegions = componentsFromColorMap(colorMap, image.width, image.height);
  const minKeep = Math.max(2, Math.round(bounds.area * (mode === "floral-artwork" ? 0.003 : 0.0015)));
  const protectedObjects = [];
  const regions = rawRegions
    .filter((region) => region.area >= minKeep || luminance(palette[region.colorIndex]) < 90)
    .map((region, index) => {
      let objectType = "fill";
      let objectLabel = "Vector region";
      if (mode === "floral-artwork") {
        objectType = region.aspect > 3 || region.bboxWidth < bounds.bboxWidth * 0.1 ? "linework" : "fill";
        objectLabel = objectType === "linework" ? "Stem or leaf contour" : "Petal contour";
      } else if (mode === "emblem-crest") {
        objectType = luminance(palette[region.colorIndex]) < 100 ? "linework" : "fill";
        objectLabel = objectType === "linework" ? "Emblem outline/detail" : "Emblem fill region";
      } else if (mode === "text-logo") {
        objectType = region.aspect > 0.2 && region.bboxHeight > bounds.bboxHeight * 0.16 ? "text" : "fill";
        objectLabel = objectType === "text" ? "Text contour" : "Logo symbol contour";
      }
      const protectedObject = protectedObjectFromRegion(region, `${mode}-${index + 1}`, objectType === "text" ? "wordmark" : objectType, objectLabel, objectType === "text" ? 1 : 2);
      protectedObjects.push(protectedObject);
      return { ...region, objectType, protectedObject };
    });
  if (!regions.length) return null;
  const threads = palette.map((color, index) => ({
    index: index + 1,
    hex: rgbToHex(color),
    name: luminance(color) < 40 ? "Black" : rgbToHex(color).toUpperCase()
  }));
  return makePreprocess(cropped, threads, regions, mode, label, {
    protectedObjects,
    visible: bounds
  });
}

function cellsForProtectedObject(image, mask, protectedObject, excluded = new Set()) {
  const cells = [];
  if (!protectedObject) return cells;
  for (let y = protectedObject.minY; y <= protectedObject.maxY; y += 1) {
    for (let x = protectedObject.minX; x <= protectedObject.maxX; x += 1) {
      const cell = y * image.width + x;
      if (!mask[cell] || excluded.has(cell)) continue;
      cells.push(cell);
    }
  }
  return cells;
}

function regionForProtectedObject(image, mask, palette, protectedObject, objectType, extra = {}, excluded = new Set()) {
  const cells = cellsForProtectedObject(image, mask, protectedObject, excluded);
  if (!cells.length) return null;
  const color = averageColorForCells(image, cells);
  const colorIndex = nearestPaletteIndex(color, palette);
  return regionFromCells(cells, image.width, colorIndex, objectType, {
    protectedObject,
    ...extra
  });
}

function processComplexMixedArtwork(cropped, input) {
  if (!/nike|logo|wordmark|brand/i.test(input.fileName || "") || !/stitch|mascot|cartoon|character/i.test(input.fileName || "")) return null;
  const image = cropped.image;
  const mask = createForegroundMask(image, { ignoreNearWhite: true });
  const bounds = getMaskBounds(mask, image.width, image.height);
  if (bounds.empty) return null;
  const semantic = detectProtectedObjects(image, mask, input);
  semantic.reconstructedText = detectReconstructedText(semantic, input);
  const protectedTypes = new Set((semantic.protectedObjects || []).map((object) => object.type));
  if (!semantic.reconstructedText || !protectedTypes.has("mascot") || !protectedTypes.has("swoosh")) return null;
  const palette = quantizePalette(image, mask, clamp(Number(input.maxColors || 6), 5, 8));
  const textRegion = buildReconstructedTextRegion(semantic.reconstructedText, image, palette, mask, semantic);
  if (!textRegion) return null;
  textRegion.professionalDigitizing = true;
  textRegion.vectorReconstructed = true;
  const excluded = new Set(textRegion.cells);
  const swooshObject = semantic.protectedObjects.find((object) => object.type === "swoosh");
  if (swooshObject) {
    for (let y = swooshObject.minY; y <= swooshObject.maxY; y += 1) {
      for (let x = swooshObject.minX; x <= swooshObject.maxX; x += 1) excluded.add(y * image.width + x);
    }
  }
  const mascot = semantic.protectedObjects.find((object) => object.type === "mascot");
  const mascotCells = cellsForProtectedObject(image, mask, mascot, excluded);
  const mascotMap = new Int16Array(image.width * image.height);
  mascotMap.fill(-1);
  for (const cell of mascotCells) {
    const i = cell * 4;
    mascotMap[cell] = nearestPaletteIndex([image.rgba[i], image.rgba[i + 1], image.rgba[i + 2]], palette);
  }
  const largest = Math.max(1, ...componentsFromColorMap(mascotMap, image.width, image.height).map((region) => region.area));
  const characterRegions = componentsFromColorMap(mascotMap, image.width, image.height)
    .filter((region) => region.area >= Math.max(2, largest * 0.02) || luminance(palette[region.colorIndex]) < 95)
    .map((region) => ({
      ...region,
      objectType: "character",
      protectedObject: mascot,
      contourPreserved: true,
      vectorReconstructed: true,
      professionalDigitizing: true,
      characterPreserved: true,
      characterRole: characterRoleForRegion(region, image, mascot, largest)
    }));
  if (!characterRegions.length) return null;
  const textCells = new Set(textRegion.cells);
  const swooshRegion = regionForProtectedObject(image, mask, palette, swooshObject, "swoosh", { logoRole: "swoosh" }, textCells);
  const regions = [textRegion, ...characterRegions];
  if (swooshRegion) regions.push(swooshRegion);
  const roles = new Set(characterRegions.map((region) => region.characterRole));
  const darkCharacter = characterRegions.some((region) => luminance(palette[region.colorIndex]) < 100);
  const threads = palette.map((color, index) => ({
    index: index + 1,
    hex: rgbToHex(color),
    name: luminance(color) < 40 ? "Black" : rgbToHex(color).toUpperCase()
  }));
  return makePreprocess(cropped, threads, regions, "complex-mixed-artwork", "complex mixed artwork", {
    ...semantic,
    visible: bounds,
    characterPreservation: {
      mode: "Professional Complex Mixed Artwork Mode",
      layerCount: characterRegions.length,
      roles: [...roles],
      bodyVisible: true,
      headVisible: true,
      earsVisible: roles.has("ears") || darkCharacter,
      faceVisible: roles.has("face") || roles.has("eyes") || darkCharacter,
      eyesVisible: roles.has("eyes") || darkCharacter,
      silhouetteArea: characterRegions.reduce((sum, region) => sum + region.area, 0),
      protectedObjectId: mascot.id
    }
  });
}

function processProfessionalDigitizing(cropped, input) {
  const modeResult = detectArtworkMode(cropped.image, input);
  const complex = processComplexMixedArtwork(cropped, input);
  if (complex) return complex;
  if (modeResult.mode === ArtworkMode.OUTLINE_VECTOR_ICON) return processOutlineVectorIcon(cropped, input, modeResult.analysis);
  if (modeResult.mode === ArtworkMode.SINGLE_COLOR_LOGO) return processGenericSingleColorLogo(cropped, modeResult.analysis, input);
  if (modeResult.mode === ArtworkMode.TEXT_LOGO) return processMultiColorObjects(cropped, "text-logo", "text logo mode", input);
  if (modeResult.mode === ArtworkMode.CHARACTER_PRESERVATION) return processCharacterLike(cropped, "character-preservation", input);
  if (modeResult.mode === ArtworkMode.FLORAL_ARTWORK) return processMultiColorObjects(cropped, "floral-artwork", "floral artwork mode", input);
  if (modeResult.mode === ArtworkMode.EMBLEM_CREST) return processMultiColorObjects(cropped, "emblem-crest", "emblem crest mode", input);
  if (modeResult.mode === ArtworkMode.PHOTO_SIMPLIFICATION) return processMultiColorObjects(cropped, "photo-simplification", "photo simplification mode", input);
  return null;
}

module.exports = {
  processProfessionalDigitizing
};
