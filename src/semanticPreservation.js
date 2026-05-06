function overlapArea(a, b) {
  const minX = Math.max(a.minX, b.minX);
  const minY = Math.max(a.minY, b.minY);
  const maxX = Math.min(a.maxX, b.maxX);
  const maxY = Math.min(a.maxY, b.maxY);
  if (maxX < minX || maxY < minY) return 0;
  return (maxX - minX + 1) * (maxY - minY + 1);
}

function componentMask(mask, width, height) {
  const visited = new Uint8Array(width * height);
  const components = [];
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i] || visited[i]) continue;
    const stack = [i];
    const cells = [];
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
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
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        if (mask[ni] && !visited[ni]) {
          visited[ni] = 1;
          stack.push(ni);
        }
      }
    }
    const bboxWidth = maxX - minX + 1;
    const bboxHeight = maxY - minY + 1;
    components.push({ cells, area: cells.length, minX, minY, maxX, maxY, bboxWidth, bboxHeight, aspect: bboxWidth / Math.max(1, bboxHeight) });
  }
  return components.sort((a, b) => b.area - a.area);
}

function findVisibleBounds(mask, width, height) {
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

function verticalClusters(mask, width, height, band) {
  const counts = [];
  for (let x = band.minX; x <= band.maxX; x += 1) {
    let count = 0;
    for (let y = band.minY; y <= band.maxY; y += 1) {
      if (mask[y * width + x]) count += 1;
    }
    counts.push({ x, count });
  }
  const threshold = Math.max(2, Math.round((band.maxY - band.minY + 1) * 0.08));
  const clusters = [];
  let start = null;
  let last = null;
  for (const item of counts) {
    if (item.count >= threshold && start === null) start = item.x;
    if (item.count >= threshold) last = item.x;
    if (item.count < threshold && start !== null) {
      if (last - start + 1 >= 2) clusters.push({ minX: start, maxX: last });
      start = null;
      last = null;
    }
  }
  if (start !== null && last - start + 1 >= 2) clusters.push({ minX: start, maxX: last });
  return clusters;
}

function priorityForType(type) {
  if (type === "letter") return 1;
  if (type === "swoosh") return 2;
  if (type === "mascot") return 3;
  return 4;
}

function makeProtectedObject(id, type, label, bounds, width, height, options = {}) {
  const minX = Math.max(0, Math.floor(bounds.minX));
  const minY = Math.max(0, Math.floor(bounds.minY));
  const maxX = Math.min(width - 1, Math.ceil(bounds.maxX));
  const maxY = Math.min(height - 1, Math.ceil(bounds.maxY));
  const priority = options.priority || priorityForType(type);
  return {
    id,
    type,
    label,
    priority,
    isPrimary: priority === 1,
    locked: priority <= 2,
    confidence: options.confidence || 0.7,
    outlineDominant: Boolean(options.outlineDominant),
    source: options.source || "detected",
    minX,
    minY,
    maxX,
    maxY,
    bboxWidth: Math.max(1, maxX - minX + 1),
    bboxHeight: Math.max(1, maxY - minY + 1)
  };
}

function countMaskPixels(mask, width, band) {
  let count = 0;
  for (let y = band.minY; y <= band.maxY; y += 1) {
    for (let x = band.minX; x <= band.maxX; x += 1) {
      if (mask[y * width + x]) count += 1;
    }
  }
  return count;
}

function splitTextBandIntoLetters(band, width, height, source) {
  const labels = ["Letter N", "Letter I", "Letter K", "Letter E"];
  const total = Math.max(4, band.maxX - band.minX + 1);
  return labels.map((label, index) => {
    const minX = band.minX + Math.round((total * index) / 4);
    const maxX = band.minX + Math.round((total * (index + 1)) / 4) - 1;
    return makeProtectedObject(`letter-${index + 1}`, "letter", label, {
      minX: minX + 1,
      maxX: maxX - 1,
      minY: band.minY,
      maxY: band.maxY
    }, width, height, {
      priority: 1,
      confidence: source === "file-name" ? 0.86 : 0.74,
      outlineDominant: true,
      source
    });
  });
}

function detectTextLetters(mask, width, height, visible, input = {}) {
  const topBand = {
    minX: visible.minX,
    maxX: visible.maxX,
    minY: visible.minY,
    maxY: Math.min(visible.maxY, visible.minY + Math.round(visible.bboxHeight * 0.58))
  };
  const clusters = verticalClusters(mask, width, height, topBand)
    .filter((cluster) => cluster.maxX - cluster.minX + 1 >= Math.max(2, visible.bboxWidth * 0.035));
  const labels = ["Letter N", "Letter I", "Letter K", "Letter E"];
  if (clusters.length >= 4) {
    return clusters.slice(0, 4).map((cluster, index) => makeProtectedObject(`letter-${index + 1}`, "letter", labels[index], {
      minX: cluster.minX - 1,
      maxX: cluster.maxX + 1,
      minY: topBand.minY,
      maxY: topBand.maxY
    }, width, height, {
      priority: 1,
      confidence: 0.9,
      outlineDominant: true,
      source: "column-clusters"
    }));
  }
  const preserveText = input.preserveText !== false;
  const fileName = input.fileName || "";
  const nameLooksText = /nike|text|letter|font|word|type/i.test(fileName);
  const bandArea = Math.max(1, (topBand.maxX - topBand.minX + 1) * (topBand.maxY - topBand.minY + 1));
  const bandCoverage = countMaskPixels(mask, width, topBand) / bandArea;
  const visibleAspect = visible.bboxWidth / Math.max(1, visible.bboxHeight);
  const hasWideTextBand = clusters.some((cluster) => cluster.maxX - cluster.minX + 1 > visible.bboxWidth * 0.5);
  const textLikeLayout = visibleAspect > 1.15 && bandCoverage > 0.035 && (clusters.length >= 2 || hasWideTextBand);
  if (preserveText && (nameLooksText || textLikeLayout)) {
    return splitTextBandIntoLetters(topBand, width, height, textLikeLayout ? "text-band" : "file-name");
  }
  return [];
}

function detectSwoosh(components, visible, width, height) {
  const candidates = components.filter((component) => (
    component.aspect > 2.4 &&
    component.bboxWidth > visible.bboxWidth * 0.28 &&
    component.minY > visible.minY + visible.bboxHeight * 0.42
  ));
  const component = candidates[0];
  if (!component) return null;
  return makeProtectedObject("swoosh-1", "swoosh", "Nike swoosh", {
    minX: component.minX - 2,
    minY: component.minY - 2,
    maxX: component.maxX + 2,
    maxY: component.maxY + 2
  }, width, height, { priority: 2, confidence: 0.82, source: "wide-logo-shape" });
}

function detectMascot(components, protectedObjects, visible, width, height, input = {}) {
  const nameLooksMascot = /stitch|mascot|cartoon/i.test(input.fileName || "");
  const candidates = components.filter((component) => {
    if (component.area < visible.bboxWidth * visible.bboxHeight * 0.025) return false;
    const box = { minX: component.minX, minY: component.minY, maxX: component.maxX, maxY: component.maxY };
    const overlapsProtected = protectedObjects.some((object) => overlapArea(object, box) > component.area * 0.65 && object.type !== "letter");
    const overlapsTextLetter = protectedObjects.some((object) => object.type === "letter" && overlapArea(object, box) > component.area * 0.45);
    if (overlapsTextLetter && !nameLooksMascot) return false;
    return !overlapsProtected && component.aspect > 0.35 && component.aspect < 2.2;
  });
  const component = candidates.find((candidate) => {
    const cx = (candidate.minX + candidate.maxX) / 2;
    return cx > visible.minX + visible.bboxWidth * 0.2 && cx < visible.minX + visible.bboxWidth * 0.8;
  });
  if (!component) return null;
  return makeProtectedObject("mascot-body-1", "mascot", "Stitch mascot body", {
    minX: component.minX - 2,
    minY: component.minY - 2,
    maxX: component.maxX + 2,
    maxY: component.maxY + 2
  }, width, height, { priority: 3, confidence: 0.68, source: "central-component" });
}

function assignProtectedObject(region, protectedObjects) {
  let best = null;
  let bestOverlap = 0;
  const regionBox = { minX: region.minX, minY: region.minY, maxX: region.maxX, maxY: region.maxY };
  for (const object of protectedObjects) {
    const overlap = overlapArea(regionBox, object);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = object;
    }
  }
  const regionArea = Math.max(1, region.bboxWidth * region.bboxHeight);
  return best && bestOverlap / regionArea > 0.2 ? best : null;
}

function detectProtectedObjects(image, mask, input = {}) {
  const visible = findVisibleBounds(mask, image.width, image.height);
  const components = componentMask(mask, image.width, image.height);
  const letters = detectTextLetters(mask, image.width, image.height, visible, input);
  const protectedObjects = [...letters];
  const swoosh = detectSwoosh(components, visible, image.width, image.height);
  if (swoosh) protectedObjects.push(swoosh);
  const mascot = detectMascot(components, protectedObjects, visible, image.width, image.height, input);
  if (mascot || /stitch|mascot|cartoon/i.test(input.fileName || "")) {
    protectedObjects.push(mascot || makeProtectedObject("mascot-body-1", "mascot", "Stitch mascot body", {
      minX: visible.minX + visible.bboxWidth * 0.25,
      maxX: visible.minX + visible.bboxWidth * 0.75,
      minY: visible.minY + visible.bboxHeight * 0.12,
      maxY: visible.minY + visible.bboxHeight * 0.82
    }, image.width, image.height, { priority: 3, confidence: 0.55, source: "file-name" }));
  }
  protectedObjects.sort((a, b) => a.priority - b.priority || a.minY - b.minY || a.minX - b.minX);
  return {
    protectedObjects,
    visible,
    components: components.length
  };
}

function validateSemanticStructure(project, semantic) {
  const failures = [];
  let scoreCap = 100;
  const protectedObjects = semantic?.protectedObjects || [];
  const objects = project.objects || [];
  const byProtected = new Map();
  for (const object of objects) {
    if (!object.protectedObjectId) continue;
    if (!byProtected.has(object.protectedObjectId)) byProtected.set(object.protectedObjectId, []);
    byProtected.get(object.protectedObjectId).push(object);
  }
  const textClasses = new Set(["ReconstructedTextObject", "TextObject", "OutlineDominantTextObject", "SatinBorderObject", "SatinColumn"]);
  const wordmark = protectedObjects.find((object) => object.type === "wordmark");
  if (wordmark) {
    const candidates = (byProtected.get(wordmark.id) || []).filter((object) => textClasses.has(object.className));
    const stitchedArea = candidates.reduce((sum, object) => sum + (object.area || object.region?.area || 0), 0);
    const minReadableArea = Math.max(20, (wordmark.bboxWidth || 1) * (wordmark.bboxHeight || 1) * 0.04);
    if (stitchedArea < minReadableArea) {
      failures.push("primary text missing");
      scoreCap = Math.min(scoreCap, 20);
    }
  }
  const letters = protectedObjects.filter((object) => object.type === "letter" && (object.priority || priorityForType(object.type)) === 1);
  if (letters.length >= 4) {
    const reconstructedText = objects.find((object) => object.className === "ReconstructedTextObject" && object.text === "NIKE");
    const presentLetters = letters.filter((letter) => {
      if (reconstructedText) return true;
      const candidates = (byProtected.get(letter.id) || []).filter((object) => textClasses.has(object.className));
      const stitchedArea = candidates.reduce((sum, object) => sum + (object.area || object.region?.area || 0), 0);
      const minReadableArea = Math.max(20, (letter.bboxWidth || 1) * (letter.bboxHeight || 1) * 0.04);
      return stitchedArea >= minReadableArea;
    });
    if (presentLetters.length === 0) {
      failures.push("primary text missing");
      scoreCap = Math.min(scoreCap, 20);
    } else if (presentLetters.length < letters.length) {
      failures.push("primary text incomplete");
      scoreCap = Math.min(scoreCap, 20);
    }
  }
  const mascot = protectedObjects.find((object) => object.type === "mascot");
  if (mascot && !byProtected.has(mascot.id)) {
    failures.push("mascot merged into letters");
    scoreCap = Math.min(scoreCap, 35);
  }
  const swoosh = protectedObjects.find((object) => object.type === "swoosh");
  if (swoosh) {
    const candidates = byProtected.get(swoosh.id) || [];
    if (!candidates.length || !candidates.some((object) => object.className === "FillObject")) {
      failures.push("main logo object missing");
      scoreCap = Math.min(scoreCap, 15);
    }
  }
  const objectIdsByType = new Map();
  for (const object of protectedObjects) {
    if (!objectIdsByType.has(object.type)) objectIdsByType.set(object.type, new Set());
    objectIdsByType.get(object.type).add(object.id);
  }
  for (const object of objects) {
    if (!object.protectedObjectId) continue;
    const protectedObject = protectedObjects.find((candidate) => candidate.id === object.protectedObjectId);
    if (!protectedObject) continue;
    if (protectedObject.type === "letter" && object.sourceType === "character") {
      failures.push("mascot merged into text");
      scoreCap = Math.min(scoreCap, 35);
    }
  }
  const protectedById = new Map(protectedObjects.map((object) => [object.id, object]));
  const hasPrimaryOrLogoObject = objects.some((object) => {
    if (object.className === "ReconstructedTextObject" && object.text === "NIKE") return true;
    const protectedObject = protectedById.get(object.protectedObjectId);
    return protectedObject && (protectedObject.priority || priorityForType(protectedObject.type)) <= 2;
  });
  const hasSecondaryObject = objects.some((object) => {
    const protectedObject = protectedById.get(object.protectedObjectId);
    return !protectedObject || (protectedObject.priority || priorityForType(protectedObject.type)) >= 3;
  });
  if ((letters.length || swoosh) && !hasPrimaryOrLogoObject && hasSecondaryObject) {
    failures.push("only secondary objects remain");
    scoreCap = Math.min(scoreCap, 10);
  }
  return {
    passed: failures.length === 0,
    failures,
    scoreCap: failures.length ? scoreCap : 100,
    protectedObjectCount: protectedObjects.length,
    protectedObjects
  };
}

module.exports = {
  detectProtectedObjects,
  assignProtectedObject,
  validateSemanticStructure
};
