function bboxGap(a, b) {
  const xGap = Math.max(0, Math.max(a.minX, b.minX) - Math.min(a.maxX, b.maxX) - 1);
  const yGap = Math.max(0, Math.max(a.minY, b.minY) - Math.min(a.maxY, b.maxY) - 1);
  return Math.hypot(xGap, yGap);
}

function rgbFromHex(hex = "#000000") {
  const value = hex.replace("#", "");
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16)
  ];
}

function isNearWhiteThread(region, threads) {
  const thread = threads[region.colorIndex];
  if (!thread) return false;
  const [r, g, b] = rgbFromHex(thread.hex);
  return r > 235 && g > 235 && b > 235 && Math.max(r, g, b) - Math.min(r, g, b) < 28;
}

function mergeRegionPair(a, b) {
  const cells = [...a.cells, ...b.cells];
  const minX = Math.min(a.minX, b.minX);
  const minY = Math.min(a.minY, b.minY);
  const maxX = Math.max(a.maxX, b.maxX);
  const maxY = Math.max(a.maxY, b.maxY);
  const bboxWidth = maxX - minX + 1;
  const bboxHeight = maxY - minY + 1;
  return {
    colorIndex: a.colorIndex,
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
    perimeter: a.perimeter + b.perimeter,
    objectType: a.objectType === "swoosh" || b.objectType === "swoosh" ? "swoosh" : a.objectType === "text" || b.objectType === "text" ? "text" : a.objectType,
    protectedObject: a.protectedObject || b.protectedObject || null,
    contourPreserved: Boolean(a.contourPreserved || b.contourPreserved),
    characterPreserved: Boolean(a.characterPreserved || b.characterPreserved),
    characterRole: a.characterRole === b.characterRole ? a.characterRole : (a.characterRole || b.characterRole || null),
    singleColorLogo: Boolean(a.singleColorLogo || b.singleColorLogo),
    logoRole: a.logoRole || b.logoRole || null
  };
}

function mergeProtectedRegions(regions) {
  const grouped = new Map();
  const loose = [];
  for (const region of regions) {
    if (!region.protectedObject) {
      loose.push(region);
      continue;
    }
    const key = `${region.protectedObject.id}:${region.colorIndex}`;
    if (!grouped.has(key)) grouped.set(key, region);
    else grouped.set(key, mergeRegionPair(grouped.get(key), region));
  }
  return [...grouped.values(), ...loose];
}

function normalizeProtectedLogoColors(regions) {
  const dominantByProtected = new Map();
  for (const region of regions) {
    if (region.protectedObject?.type !== "swoosh") continue;
    const key = region.protectedObject.id;
    const current = dominantByProtected.get(key);
    if (!current || region.area > current.area) dominantByProtected.set(key, { colorIndex: region.colorIndex, area: region.area });
  }
  return regions.map((region) => {
    if (region.protectedObject?.type !== "swoosh") return region;
    const dominant = dominantByProtected.get(region.protectedObject.id);
    if (!dominant) return region;
    return { ...region, colorIndex: dominant.colorIndex, objectType: "swoosh" };
  });
}

function mergeNearbyObjectRegions(regions) {
  let changed = true;
  let merged = [...regions].sort((a, b) => a.minX - b.minX || a.minY - b.minY);
  while (changed) {
    changed = false;
    const next = [];
    for (const region of merged) {
      const mergeable = ["text", "linework", "swoosh"].includes(region.objectType);
      let placed = false;
      for (let i = 0; i < next.length; i += 1) {
        const existing = next[i];
        const sameClass = existing.objectType === region.objectType || (["text", "linework"].includes(existing.objectType) && ["text", "linework"].includes(region.objectType));
        const sameProtected = (existing.protectedObject?.id || null) === (region.protectedObject?.id || null);
        if (mergeable && existing.colorIndex === region.colorIndex && sameClass && sameProtected && bboxGap(existing, region) <= 10) {
          next[i] = mergeRegionPair(existing, region);
          placed = true;
          changed = true;
          break;
        }
      }
      if (!placed) next.push(region);
    }
    merged = next;
  }
  return merged;
}

function objectClassFor(region, imageType) {
  if (region.objectType === "reconstructed-text" || region.reconstructedText) return "ReconstructedTextObject";
  if (region.outlineVectorIcon || region.objectType === "outline-path") return region.estimatedStrokeWidthPx > 3.2 ? "SatinColumn" : "RunningLine";
  if (region.singleColorLogo && region.objectType === "text") return "TextObject";
  if (region.objectType === "character" && ["eyes", "detail"].includes(region.characterRole)) return region.area > 12 ? "SatinColumn" : "RunningLine";
  if (region.protectedObject?.type === "letter") {
    return region.protectedObject.outlineDominant || region.fillRatio < 0.5 ? "SatinBorderObject" : "TextObject";
  }
  if (region.protectedObject?.type === "swoosh") return "FillObject";
  if (region.protectedObject?.type === "mascot") return "TatamiRegion";
  if (region.objectType === "swoosh") return "FillObject";
  if (region.objectType === "text") return "TextObject";
  if (region.objectType === "linework") return region.area > 40 ? "SatinColumn" : "RunningLine";
  if (region.objectType === "detail") return "RunningLine";
  if (imageType === "complex illustration" || imageType === "photo") return "TatamiRegion";
  return "FillObject";
}

function strategyFor(className, region) {
  if (className === "ReconstructedTextObject") return {
    fill: region.textStyle === "solid" ? "vector-satin-text" : "outline-satin-text",
    border: "satin",
    underlay: ["edge-run"],
    pullCompensationMm: 0.3,
    stitchAngleDeg: 10
  };
  if (className === "SatinBorderObject") return {
    fill: "satin-border-only",
    border: "satin",
    underlay: ["edge-run"],
    pullCompensationMm: 0.3,
    stitchAngleDeg: 12
  };
  if (className === "TextObject") return {
    fill: region.singleColorLogo ? "single-color-logo-satin" : "tatami",
    border: "satin",
    underlay: region.singleColorLogo ? ["edge-run"] : ["edge-run", "zigzag"],
    pullCompensationMm: region.singleColorLogo ? 0.3 : 0.25,
    stitchAngleDeg: region.singleColorLogo ? -12 : 12
  };
  if (className === "FillObject" && region.objectType === "swoosh") return {
    fill: "directional-tatami",
    border: "satin",
    underlay: ["center-walk", "edge-run"],
    pullCompensationMm: 0.2,
    stitchAngleDeg: region.aspect > 1 ? 24 : 0
  };
  if (className === "TatamiRegion" || className === "FillObject") return {
    fill: "tatami",
    border: "satin",
    underlay: ["center-walk"],
    pullCompensationMm: 0.15,
    stitchAngleDeg: region.aspect > 1.2 ? 18 : 45
  };
  if (className === "SatinColumn") return {
    fill: "satin-column",
    border: "none",
    underlay: ["center-walk"],
    pullCompensationMm: 0.2,
    stitchAngleDeg: 0
  };
  if (region.outlineVectorIcon) return {
    fill: region.estimatedStrokeWidthPx > 1.7 ? "double-running" : "running",
    border: "none",
    underlay: [],
    pullCompensationMm: 0,
    stitchAngleDeg: 0
  };
  return {
    fill: region.outlineVectorIcon && region.estimatedStrokeWidthPx > 1.7 ? "double-running" : "running",
    border: "none",
    underlay: [],
    pullCompensationMm: 0,
    stitchAngleDeg: 0
  };
}

function objectPriority(object) {
  if (object.className === "ReconstructedTextObject" || object.className === "TextObject" || object.className === "SatinBorderObject") return 10;
  if (object.className === "FillObject" && object.region.objectType === "swoosh") return 40;
  if (object.className === "TatamiRegion") return 30;
  if (object.className === "SatinColumn") return 20;
  if (object.className === "RunningLine") return 50;
  return 60;
}

function createEmbroideryObjects(preprocessed) {
  const regions = mergeNearbyObjectRegions(mergeProtectedRegions(normalizeProtectedLogoColors(preprocessed.regions)))
    .filter((region) => !(region.protectedObject?.type === "letter" && region.protectedObject.outlineDominant && isNearWhiteThread(region, preprocessed.threads)));
  return regions.map((region, index) => {
    const className = objectClassFor(region, preprocessed.imageType);
    return {
      id: `obj-${index + 1}`,
      className,
      sourceType: region.objectType,
      colorIndex: region.colorIndex,
      threadIndex: region.colorIndex + 1,
      protectedObjectId: region.protectedObject?.id || null,
      protectedObjectLabel: region.protectedObject?.label || null,
      text: region.reconstructedText?.text || null,
      textStyle: region.textStyle || region.reconstructedText?.textStyle || null,
      originalTextStyle: region.reconstructedText?.originalTextStyle || region.textStyle || null,
      reconstructionMode: region.reconstructedText?.reconstructionMode || null,
      contourPreserved: Boolean(region.contourPreserved || region.reconstructedText?.reconstructionMode === "contour-preserving"),
      brandProtected: Boolean(region.brandProtected || region.reconstructedText?.brandProtected),
      singleColorLogo: Boolean(region.singleColorLogo),
      outlineVectorIcon: Boolean(region.outlineVectorIcon),
      estimatedStrokeWidthPx: region.estimatedStrokeWidthPx || null,
      logoRole: region.logoRole || null,
      characterRole: region.characterRole || null,
      characterPreserved: Boolean(region.characterPreserved),
      reconstructed: Boolean(region.reconstructedText),
      region,
      strategy: strategyFor(className, region),
      bounds: {
        minX: region.minX,
        minY: region.minY,
        maxX: region.maxX,
        maxY: region.maxY,
        width: region.bboxWidth,
        height: region.bboxHeight
      },
      area: region.area
    };
  }).sort((a, b) => objectPriority(a) - objectPriority(b) || a.bounds.minY - b.bounds.minY || a.bounds.minX - b.bounds.minX);
}

module.exports = {
  createEmbroideryObjects,
  mergeNearbyObjectRegions
};
