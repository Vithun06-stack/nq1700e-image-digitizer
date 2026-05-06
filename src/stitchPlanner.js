const { createEmbroideryObjects } = require("./embroideryObjects");
const { fitForegroundToHoop } = require("./foregroundBounds");

const MACHINE_TARGET = "Brother Innov-is NQ1700E";

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function luminance(color) {
  return 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
}

function pushMove(stitches, from, to, type, thread, stitchKind = "tatami-fill", objectId = null) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const maxStep = type === "stitch" ? 0.098 : 0.18;
  const steps = Math.max(1, Math.ceil(distance / maxStep));
  for (let i = 1; i <= steps; i += 1) {
    stitches.push({
      x: Number((from.x + (dx * i) / steps).toFixed(3)),
      y: Number((from.y + (dy * i) / steps).toFixed(3)),
      type,
      stitchKind,
      objectId,
      threadIndex: thread.index,
      threadHex: thread.hex
    });
  }
}

function addJumpIfNeeded(stitches, cursor, target, thread, objectId) {
  const distance = Math.hypot(cursor.x - target.x, cursor.y - target.y);
  if (distance <= 0.08) return cursor;
  pushMove(stitches, cursor, target, "jump", thread, "travel", objectId);
  if (distance > 0.45) {
    stitches.push({ x: target.x, y: target.y, type: "trim", stitchKind: "trim", objectId, threadIndex: thread.index, threadHex: thread.hex });
  }
  return target;
}

function toInchesFactory(width, height, design) {
  const bounds = design.foregroundBounds || { minX: 0, minY: 0, bboxWidth: width, bboxHeight: height };
  return (x, y, offset = 0) => ({
    x: Number((((x - bounds.minX) / Math.max(1, bounds.bboxWidth - 1)) * design.widthIn - design.widthIn / 2 + offset).toFixed(3)),
    y: Number((design.heightIn / 2 - ((y - bounds.minY) / Math.max(1, bounds.bboxHeight - 1)) * design.heightIn - offset).toFixed(3))
  });
}

function objectContains(object) {
  if (!object._cellSet) object._cellSet = new Set(object.region.cells);
  return (x, y) => object._cellSet.has(y * object._width + x);
}

function collectFillRuns(object, rowStep, direction = "horizontal") {
  const contains = objectContains(object);
  const runs = [];
  if (direction === "vertical") {
    for (let x = object.region.minX; x <= object.region.maxX; x += rowStep) {
      let start = -1;
      let segmentIndex = 0;
      for (let y = object.region.minY; y <= object.region.maxY; y += 1) {
        const match = contains(x, y);
        if (match && start === -1) start = y;
        if ((!match || y === object.region.maxY) && start !== -1) {
          runs.push({ vertical: true, x, y1: start, y2: match && y === object.region.maxY ? y : y - 1, breakBefore: segmentIndex > 0 });
          segmentIndex += 1;
          start = -1;
        }
      }
    }
    return runs;
  }

  for (let y = object.region.minY; y <= object.region.maxY; y += rowStep) {
    let start = -1;
    let segmentIndex = 0;
    for (let x = object.region.minX; x <= object.region.maxX; x += 1) {
      const match = contains(x, y);
      if (match && start === -1) start = x;
      if ((!match || x === object.region.maxX) && start !== -1) {
        runs.push({ y, x1: start, x2: match && x === object.region.maxX ? x : x - 1, breakBefore: segmentIndex > 0 });
        segmentIndex += 1;
        start = -1;
      }
    }
  }
  return runs;
}

function collectDenseFillRuns(object, scanStepPx, direction = "horizontal") {
  const contains = objectContains(object);
  const step = Math.max(0.15, Number(scanStepPx) || 1);
  const runs = [];
  if (direction === "vertical") {
    for (let scanX = object.region.minX; scanX <= object.region.maxX + 0.001; scanX += step) {
      const x = clamp(Math.round(scanX), object.region.minX, object.region.maxX);
      let start = -1;
      let segmentIndex = 0;
      for (let y = object.region.minY; y <= object.region.maxY; y += 1) {
        const match = contains(x, y);
        if (match && start === -1) start = y;
        if ((!match || y === object.region.maxY) && start !== -1) {
          runs.push({
            vertical: true,
            x: scanX,
            y1: start,
            y2: match && y === object.region.maxY ? y : y - 1,
            breakBefore: segmentIndex > 0
          });
          segmentIndex += 1;
          start = -1;
        }
      }
    }
    return runs;
  }

  for (let scanY = object.region.minY; scanY <= object.region.maxY + 0.001; scanY += step) {
    const y = clamp(Math.round(scanY), object.region.minY, object.region.maxY);
    let start = -1;
    let segmentIndex = 0;
    for (let x = object.region.minX; x <= object.region.maxX; x += 1) {
      const match = contains(x, y);
      if (match && start === -1) start = x;
      if ((!match || x === object.region.maxX) && start !== -1) {
        runs.push({
          y: scanY,
          x1: start,
          x2: match && x === object.region.maxX ? x : x - 1,
          breakBefore: segmentIndex > 0
        });
        segmentIndex += 1;
        start = -1;
      }
    }
  }
  return runs;
}

function collectBoundaryRuns(object, rowStep = 1) {
  const contains = objectContains(object);
  const runs = [];
  for (let y = object.region.minY; y <= object.region.maxY; y += rowStep) {
    let start = -1;
    for (let x = object.region.minX; x <= object.region.maxX; x += 1) {
      const edge = contains(x, y) && (!contains(x - 1, y) || !contains(x + 1, y) || !contains(x, y - 1) || !contains(x, y + 1));
      if (edge && start === -1) start = x;
      if ((!edge || x === object.region.maxX) && start !== -1) {
        runs.push({ y, x1: start, x2: edge && x === object.region.maxX ? x : x - 1 });
        start = -1;
      }
    }
  }
  return runs;
}

function collectCenterUnderlayRuns(object, rowStep) {
  const horizontalRuns = collectFillRuns(object, Math.max(1, rowStep), "horizontal");
  const cy = (object.region.minY + object.region.maxY) / 2;
  return horizontalRuns
    .filter((run) => (run.x2 - run.x1 + 1) >= 2)
    .sort((a, b) => Math.abs(a.y - cy) - Math.abs(b.y - cy) || (b.x2 - b.x1) - (a.x2 - a.x1))
    .slice(0, Math.max(1, Math.min(3, Math.ceil(object.region.bboxHeight / Math.max(8, rowStep * 4)))))
    .sort((a, b) => a.y - b.y);
}

function stitchRuns(stitches, runs, cursor, thread, toInches, stitchKind, objectId) {
  let reverse = false;
  for (const run of runs) {
    const start = run.vertical
      ? toInches(run.x, reverse ? run.y2 : run.y1)
      : toInches(reverse ? run.x2 : run.x1, run.y);
    const end = run.vertical
      ? toInches(run.x, reverse ? run.y1 : run.y2)
      : toInches(reverse ? run.x1 : run.x2, run.y);
    const travelDistance = Math.hypot(cursor.x - start.x, cursor.y - start.y);
    if (run.breakBefore || travelDistance > 0.08) {
      cursor = addJumpIfNeeded(stitches, cursor, start, thread, objectId);
    } else if (travelDistance > 0.002) {
      pushMove(stitches, cursor, start, "stitch", thread, `${stitchKind}-connector`, objectId);
      cursor = start;
    } else {
      cursor = start;
    }
    pushMove(stitches, cursor, end, "stitch", thread, stitchKind, objectId);
    cursor = end;
    reverse = !reverse;
  }
  return cursor;
}

function stitchDoubleRuns(stitches, runs, cursor, thread, toInches, stitchKind, objectId) {
  cursor = stitchRuns(stitches, runs, cursor, thread, toInches, stitchKind, objectId);
  const reverseRuns = [...runs].reverse().map((run) => (
    run.vertical
      ? { ...run, y1: run.y2, y2: run.y1 }
      : { ...run, x1: run.x2, x2: run.x1 }
  ));
  return stitchRuns(stitches, reverseRuns, cursor, thread, toInches, stitchKind, objectId);
}

function stitchBoundaryLoop(stitches, object, cursor, thread, toInches, stitchKind = "satin-border") {
  const runs = collectBoundaryRuns(object, 1);
  if (!runs.length) return cursor;
  return stitchRuns(stitches, runs, cursor, thread, toInches, stitchKind, object.id);
}

function addUnderlay(stitches, object, cursor, thread, toInches, rowStep) {
  if (object.strategy.underlay.includes("center-walk")) {
    const underlayRuns = collectCenterUnderlayRuns(object, Math.max(1, rowStep * 2));
    cursor = stitchRuns(stitches, underlayRuns, cursor, thread, toInches, "center-walk-underlay", object.id);
  }
  if (object.strategy.underlay.includes("zigzag")) {
    const zigzagRuns = collectFillRuns(object, Math.max(2, rowStep * 3), object.region.aspect > 1 ? "horizontal" : "vertical");
    cursor = stitchRuns(stitches, zigzagRuns, cursor, thread, toInches, "zigzag-underlay", object.id);
  }
  if (object.strategy.underlay.includes("edge-run")) {
    cursor = stitchBoundaryLoop(stitches, object, cursor, thread, toInches, "edge-run-underlay");
  }
  return cursor;
}

function objectCenter(object, toInches) {
  return toInches((object.region.minX + object.region.maxX) / 2, (object.region.minY + object.region.maxY) / 2);
}

function embroideryPriority(object) {
  if (["ReconstructedTextObject", "TextObject", "SatinBorderObject", "OutlineDominantTextObject"].includes(object.className)) return 10;
  if (object.sourceType === "swoosh") return 20;
  if (object.sourceType === "character") return 30;
  if (object.className === "SatinColumn") return 40;
  if (object.className === "RunningLine") return 50;
  return 60;
}

function orderObjectsNearest(objects, cursor, toInches) {
  const remaining = [...objects];
  const ordered = [];
  while (remaining.length) {
    let bestIndex = 0;
    let bestCost = Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const center = objectCenter(remaining[i], toInches);
      const distance = Math.hypot(cursor.x - center.x, cursor.y - center.y);
      const classBias = embroideryPriority(remaining[i]) * 0.01;
      const cost = distance + classBias + remaining[i].region.minY * 0.0005 + remaining[i].region.minX * 0.0002;
      if (cost < bestCost) {
        bestCost = cost;
        bestIndex = i;
      }
    }
    const [object] = remaining.splice(bestIndex, 1);
    ordered.push(object);
    cursor = objectCenter(object, toInches);
  }
  return ordered;
}

function orderObjectsForColorPasses(objects, cursor, toInches) {
  const groups = new Map();
  for (const object of objects) {
    if (!groups.has(object.threadIndex)) groups.set(object.threadIndex, []);
    groups.get(object.threadIndex).push(object);
  }
  const entries = [...groups.entries()].map(([threadIndex, group]) => ({
    threadIndex,
    group,
    priority: Math.min(...group.map(embroideryPriority)),
    minY: Math.min(...group.map((object) => object.region.minY)),
    minX: Math.min(...group.map((object) => object.region.minX))
  })).sort((a, b) => a.priority - b.priority || a.minY - b.minY || a.minX - b.minX || a.threadIndex - b.threadIndex);

  const ordered = [];
  let groupCursor = cursor;
  for (const entry of entries) {
    const groupOrder = orderObjectsNearest(entry.group, groupCursor, toInches);
    ordered.push(...groupOrder);
    if (groupOrder.length) groupCursor = objectCenter(groupOrder[groupOrder.length - 1], toInches);
  }
  return ordered;
}

function estimateMinutes(stitchCount) {
  return Math.max(1, Math.ceil(stitchCount / 650));
}

function stitchToPixel(stitch, width, height, design) {
  const bounds = design.foregroundBounds || { minX: 0, minY: 0, bboxWidth: width, bboxHeight: height };
  return {
    x: Math.round(bounds.minX + ((stitch.x + design.widthIn / 2) / design.widthIn) * Math.max(1, bounds.bboxWidth - 1)),
    y: Math.round(bounds.minY + ((design.heightIn / 2 - stitch.y) / design.heightIn) * Math.max(1, bounds.bboxHeight - 1))
  };
}

function isInsideObjectMask(object, x, y, tolerance = 1) {
  const contains = objectContains(object);
  for (let dy = -tolerance; dy <= tolerance; dy += 1) {
    for (let dx = -tolerance; dx <= tolerance; dx += 1) {
      if (contains(x + dx, y + dy)) return true;
    }
  }
  return false;
}

function validateStitchGeometry(stitches, objects, width, height, design) {
  const objectById = new Map(objects.map((object) => [object.id, object]));
  const invalid = [];
  let checked = 0;
  for (const stitch of stitches) {
    if (stitch.type !== "stitch" || !stitch.objectId) continue;
    const object = objectById.get(stitch.objectId);
    if (!object) continue;
    checked += 1;
    const pixel = stitchToPixel(stitch, width, height, design);
    if (!isInsideObjectMask(object, pixel.x, pixel.y, 1)) {
      invalid.push({
        objectId: object.id,
        objectClass: object.className,
        x: stitch.x,
        y: stitch.y,
        pixelX: pixel.x,
        pixelY: pixel.y,
        stitchKind: stitch.stitchKind
      });
      if (invalid.length >= 25) break;
    }
  }
  return {
    passed: invalid.length === 0,
    checkedStitchCount: checked,
    invalidStitchCount: invalid.length,
    sampledInvalidStitches: invalid
  };
}

function runObject(stitches, object, cursor, thread, toInches, rowStep, fillStepPx, satinStepPx) {
  cursor = addUnderlay(stitches, object, cursor, thread, toInches, rowStep);
  if (object.className === "ReconstructedTextObject") {
    if (object.textStyle === "solid") {
      const fillRuns = collectDenseFillRuns(object, fillStepPx, object.region.aspect > 1 ? "vertical" : "horizontal");
      cursor = stitchRuns(stitches, fillRuns, cursor, thread, toInches, "contour-text-fill", object.id);
      return stitchBoundaryLoop(stitches, object, cursor, thread, toInches);
    }
    const satinRuns = collectDenseFillRuns(object, satinStepPx, object.region.aspect > 1 ? "vertical" : "horizontal");
    cursor = stitchRuns(stitches, satinRuns, cursor, thread, toInches, "outline-satin-column", object.id);
    return stitchBoundaryLoop(stitches, object, cursor, thread, toInches);
  }
  if (object.className === "SatinBorderObject" || object.className === "OutlineDominantTextObject") {
    const satinRuns = collectDenseFillRuns(object, satinStepPx, object.region.aspect > 1 ? "vertical" : "horizontal");
    cursor = stitchRuns(stitches, satinRuns, cursor, thread, toInches, "satin-column", object.id);
    return stitchBoundaryLoop(stitches, object, cursor, thread, toInches);
  }
  if (object.className === "RunningLine") {
    const runs = collectFillRuns(object, 1);
    if (object.strategy.fill === "double-running") return stitchDoubleRuns(stitches, runs, cursor, thread, toInches, "double-running", object.id);
    return stitchRuns(stitches, runs, cursor, thread, toInches, "running", object.id);
  }
  if (object.className === "SatinColumn") {
    cursor = stitchRuns(stitches, collectDenseFillRuns(object, satinStepPx, object.region.aspect > 1 ? "vertical" : "horizontal"), cursor, thread, toInches, "satin-column", object.id);
    return cursor;
  }
  if (object.strategy.fill === "single-color-logo-satin") {
    const direction = object.region.aspect > 1 ? "vertical" : "horizontal";
    cursor = stitchRuns(
      stitches,
      collectDenseFillRuns(object, satinStepPx, direction),
      cursor,
      thread,
      toInches,
      "logo-satin-fill",
      object.id
    );
    return stitchBoundaryLoop(stitches, object, cursor, thread, toInches);
  }

  const direction = object.strategy.fill === "directional-tatami" ? "vertical" : "horizontal";
  const kind = object.strategy.fill === "directional-tatami" ? "directional-fill" : "tatami-fill";
  cursor = stitchRuns(stitches, collectDenseFillRuns(object, fillStepPx, direction), cursor, thread, toInches, kind, object.id);
  if (object.strategy.border === "satin") cursor = stitchBoundaryLoop(stitches, object, cursor, thread, toInches);
  return cursor;
}

function assessQuality(project) {
  const warnings = ["DST does not store RGB thread colours. Use the thread order shown here."];
  const stitchCount = project.metadata.stitchCount;
  const trimCount = project.metadata.trimCount;
  const objectCount = project.objects.length;
  const classCoverage = objectCount ? project.objects.filter((object) => object.className && object.strategy).length / objectCount : 0;
  const hasFill = project.objects.some((object) => ["ReconstructedTextObject", "TextObject", "OutlineDominantTextObject", "SatinBorderObject", "FillObject", "TatamiRegion"].includes(object.className));
  const hasBorders = project.stitches.some((stitch) => stitch.stitchKind === "satin-border");
  const trimRatio = trimCount / Math.max(1, objectCount);
  const segmentationFailed = project.metadata.complexity === "complex" && objectCount < 3;
  const hasLongDefaultTravel = project.metadata.longJumpCount > 0 && project.metadata.previewShowsJumps;
  const hasRepeatedThreadStops = project.metadata.repeatedThreadStopCount > 0;
  const excessiveStops = project.metadata.stopCount > 8;
  const shreddedText = project.metadata.shreddedText;
  const geometryFailed = project.metadata.geometryValidation?.passed === false;
  const nonContourRebuiltText = project.objects.some((object) => (
    object.className === "ReconstructedTextObject" &&
    object.reconstructionMode !== "contour-preserving"
  ));
  const solidRebuiltText = project.metadata.reconstructedTextStyle === "solid" && project.metadata.reconstructedTextOriginalStyle === "outline";
  const singleColorLogoMode = project.metadata.singleColorLogoMode;
  const outlineVectorIconMode = project.metadata.outlineVectorIconMode;
  const universalSafeDstMode = project.metadata.universalSafeDstMode;
  const blackLogoInvisible = singleColorLogoMode && project.threads.some((thread) => {
    const value = String(thread.hex || "#000000").replace("#", "");
    const rgb = [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
    return luminance(rgb) > 120;
  });
  if (outlineVectorIconMode) {
    if (geometryFailed || stitchCount === 0) return {
      score: geometryFailed ? 10 : 0,
      warnings: [...warnings, "Outline stitch generation failed, so export was blocked."]
    };
    const outline = project.metadata.outlineValidation || {};
    const threadSimple = project.threads.length === 1;
    const jumpRatio = project.metadata.jumpRecordCount / Math.max(1, stitchCount);
    let outlineScore = 100;
    if (!threadSimple) outlineScore -= 25;
    if (!outline.continuousEnough) outlineScore -= 18;
    outlineScore -= Math.min(10, Math.round((outline.fragmentRatio || 0) * 20));
    outlineScore -= Math.min(8, Math.round(jumpRatio * 20));
    if ((outline.foregroundFillRatio || 0) > 0.55) outlineScore -= 8;
    return { score: clamp(Math.max(85, outlineScore), 0, 100), warnings };
  }
  if (project.cleanup.removedTinyRegions > 0) warnings.push("Some fine details were removed because they are too small to embroider cleanly.");
  if (trimRatio > 2.5 && !singleColorLogoMode) warnings.push("This design still has more travel cuts than ideal. Simplifying separated details may improve stitch-out.");
  if (segmentationFailed) warnings.push("Object segmentation failed. Use patch mode, line art mode, or crop one object only.");
  if (hasLongDefaultTravel) warnings.push("Long travel lines are visible in the preview. Hide jumps or simplify the artwork.");
  if (hasRepeatedThreadStops) warnings.push("The same thread colour repeats across multiple stops. Colour routing needs consolidation.");
  if (excessiveStops) warnings.push("This design has too many colour stops for a simplified embroidery design.");
  if (shreddedText) warnings.push("Large lettering was fragmented during digitizing. Preserve letters as satin border objects.");
  if (geometryFailed) warnings.push("Geometry validation failed: stitches were generated outside the true object mask.");
  if (nonContourRebuiltText) warnings.push("Brand text was replaced instead of reconstructed from original contours.");
  if (solidRebuiltText) warnings.push("Detected outlined text was rebuilt as solid fill instead of outline-only embroidery.");
  if (project.metadata.estimatedTextTooSmall) warnings.push("Some text or thin line details may be too small for clean embroidery.");
  if (stitchCount > 45000) warnings.push("This design is very dense and may stitch slowly or pucker fabric.");
  if (project.imageType === "photo") warnings.push("Photo embroidery needs heavy simplification. This file was posterized into thread-colour layers.");
  if (universalSafeDstMode) warnings.push("Universal Safe DST fallback was used. The file is machine-readable, but the preview should be checked before stitching.");
  if (blackLogoInvisible) warnings.push("Black logo artwork became too light during colour planning.");
  let score = 100;
  if (classCoverage < 1) score -= 25;
  if (!hasFill) score -= 20;
  if (!hasBorders) score -= 10;
  score -= Math.min(5, Math.floor(trimRatio / 2));
  score -= Math.min(4, Math.floor(project.cleanup.removedTinyRegions / 2));
  if (project.metadata.estimatedTextTooSmall) score -= 6;
  if (hasLongDefaultTravel) score = Math.min(score, 50);
  if (hasRepeatedThreadStops) score = Math.min(score, 60);
  if (excessiveStops) score = Math.min(score, 65);
  if (shreddedText) score = Math.min(score, 50);
  if (geometryFailed) score = Math.min(score, 15);
  if (nonContourRebuiltText) score = Math.min(score, 20);
  if (solidRebuiltText) score = Math.min(score, 40);
  if (project.metadata.textReadability === "poor") score = Math.min(score, 60);
  if (segmentationFailed) score = Math.min(score, 55);
  if (singleColorLogoMode && !geometryFailed && !hasRepeatedThreadStops && project.objects.some((object) => object.logoRole === "wordmark") && project.objects.some((object) => object.logoRole === "swoosh")) {
    score = Math.max(score, 88);
  }
  if (singleColorLogoMode && !geometryFailed && project.threads.length === 1 && !blackLogoInvisible) {
    score = Math.max(score, 86);
  }
  if (blackLogoInvisible) score = Math.min(score, 10);
  if (universalSafeDstMode) score = Math.min(score, 72);
  return { score: clamp(score, 0, 100), warnings };
}

function foregroundBoundsFromRegions(preprocessed) {
  const regions = preprocessed.regions || [];
  if (!regions.length) {
    return { minX: 0, minY: 0, maxX: preprocessed.width - 1, maxY: preprocessed.height - 1, bboxWidth: preprocessed.width, bboxHeight: preprocessed.height, area: 0, empty: true };
  }
  let minX = preprocessed.width;
  let minY = preprocessed.height;
  let maxX = -1;
  let maxY = -1;
  let area = 0;
  for (const region of regions) {
    minX = Math.min(minX, region.minX);
    minY = Math.min(minY, region.minY);
    maxX = Math.max(maxX, region.maxX);
    maxY = Math.max(maxY, region.maxY);
    area += region.area || 0;
  }
  if (maxX < minX || maxY < minY) {
    return { minX: 0, minY: 0, maxX: preprocessed.width - 1, maxY: preprocessed.height - 1, bboxWidth: preprocessed.width, bboxHeight: preprocessed.height, area: 0, empty: true };
  }
  return { minX, minY, maxX, maxY, bboxWidth: maxX - minX + 1, bboxHeight: maxY - minY + 1, area, empty: false };
}

function normalizeHoop(options) {
  const widthIn = Number(options.hoopWidthIn || 4);
  const heightIn = Number(options.hoopHeightIn || 4);
  if (!Number.isFinite(widthIn) || !Number.isFinite(heightIn) || widthIn <= 0 || heightIn <= 0) {
    throw new Error("Hoop width and height must be greater than 0.");
  }
  if (widthIn > 12 || heightIn > 12) {
    throw new Error("Hoop size is too large for this automatic machine exporter. Use 12 x 12 inches or smaller.");
  }
  return {
    widthIn: Number(widthIn.toFixed(2)),
    heightIn: Number(heightIn.toFixed(2))
  };
}

function createStitchProject(preprocessed, options) {
  const hoop = normalizeHoop(options);
  const foregroundBounds = foregroundBoundsFromRegions(preprocessed);
  const fit = fitForegroundToHoop(foregroundBounds, hoop.widthIn, hoop.heightIn, Number(options.paddingPercent ?? 0.03));
  const design = {
    widthIn: fit.finalWidthIn,
    heightIn: fit.finalHeightIn,
    foregroundBounds
  };
  const stitchLengthMm = clamp(Number(options.stitchLengthMm || 2.5), 1, 6);
  const fillSpacingMm = clamp(Number(options.fillSpacingMm || options.stitchDensity || 0.4), 0.25, 2);
  const minLineWidthMm = clamp(Number(options.minLineWidthMm || 1), 0.5, 3);
  const pxPerMmY = foregroundBounds.bboxHeight / Math.max(1, design.heightIn * 25.4);
  const pxPerMmX = foregroundBounds.bboxWidth / Math.max(1, design.widthIn * 25.4);
  const rowStep = Math.max(1, Math.round(fillSpacingMm * pxPerMmY));
  const fillStepPx = Math.max(0.15, fillSpacingMm * pxPerMmY);
  const satinStepPx = Math.max(0.15, clamp(fillSpacingMm, 0.35, 0.45) * Math.max(pxPerMmX, pxPerMmY));
  const minLinePx = Math.max(1, Math.round(minLineWidthMm * (foregroundBounds.bboxWidth / Math.max(1, design.widthIn * 25.4))));
  const toInches = toInchesFactory(preprocessed.width, preprocessed.height, design);
  const objects = createEmbroideryObjects(preprocessed).map((object) => ({ ...object, _width: preprocessed.width, _height: preprocessed.height }));
  const stitches = [];
  const sequence = [];
  let cursor = { x: 0, y: 0 };
  let previousThreadIndex = null;
  let activeSequence = null;

  for (const object of orderObjectsForColorPasses(objects, cursor, toInches)) {
    const thread = preprocessed.threads[object.threadIndex - 1];
    if (!thread) continue;
    if (previousThreadIndex !== null && previousThreadIndex !== thread.index) {
      stitches.push({ x: cursor.x, y: cursor.y, type: "stop", stitchKind: "stop", objectId: object.id, threadIndex: thread.index, threadHex: thread.hex });
      if (activeSequence) sequence.push(activeSequence);
      activeSequence = null;
    }
    previousThreadIndex = thread.index;
    const startCount = stitches.filter((s) => s.type === "stitch").length;
    cursor = runObject(stitches, object, cursor, thread, toInches, object.className === "RunningLine" ? 1 : rowStep, fillStepPx, satinStepPx);
    const endCount = stitches.filter((s) => s.type === "stitch").length;
    const objectStitches = endCount - startCount;
    if (!activeSequence) {
      activeSequence = {
        stopNumber: sequence.length + 1,
        objectIds: [],
        objectClasses: [],
        stitchStrategies: [],
        threadIndex: thread.index,
        hex: thread.hex,
        name: thread.name,
        stitchCount: 0,
        estimatedTimeMin: 1,
        widthIn: design.widthIn,
        heightIn: design.heightIn,
        widthMm: Number((design.widthIn * 25.4).toFixed(1)),
        heightMm: Number((design.heightIn * 25.4).toFixed(1))
      };
    }
    activeSequence.objectIds.push(object.id);
    if (!activeSequence.objectClasses.includes(object.className)) activeSequence.objectClasses.push(object.className);
    if (!activeSequence.stitchStrategies.includes(object.strategy.fill)) activeSequence.stitchStrategies.push(object.strategy.fill);
    activeSequence.stitchCount += objectStitches;
    activeSequence.estimatedTimeMin = estimateMinutes(activeSequence.stitchCount);
  }
  if (activeSequence) sequence.push(activeSequence);

  const stitchCount = stitches.filter((stitch) => stitch.type === "stitch").length;
  const stopCount = stitches.filter((stitch) => stitch.type === "stop").length;
  const trimCount = stitches.filter((stitch) => stitch.type === "trim").length;
  const longJumpCount = stitches.filter((stitch, index) => {
    if (stitch.type !== "jump" || index === 0) return false;
    const prev = stitches[index - 1];
    return Math.hypot(stitch.x - prev.x, stitch.y - prev.y) > 1.2;
  }).length;
  const estimatedTextTooSmall = objects.some((object) => Math.min(object.region.bboxWidth, object.region.bboxHeight) < minLinePx);
  const textObjects = objects.filter((object) => ["ReconstructedTextObject", "TextObject", "OutlineDominantTextObject", "SatinBorderObject"].includes(object.className));
  const textReadability = textObjects.length && textObjects.some((object) => (
    object.region.bboxWidth < 6 ||
    object.region.bboxHeight < 6 ||
    (!["ReconstructedTextObject", "OutlineDominantTextObject", "SatinBorderObject"].includes(object.className) && object.region.fillRatio < 0.08)
  )) ? "poor" : "ok";
  const complexity = options.complexity || "standard";
  const sequenceThreadCounts = sequence.reduce((counts, item) => {
    counts.set(item.threadIndex, (counts.get(item.threadIndex) || 0) + 1);
    return counts;
  }, new Map());
  const repeatedThreadStopCount = [...sequenceThreadCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const letterObjectCounts = textObjects.reduce((counts, object) => {
    if (!object.protectedObjectId) return counts;
    if (object.className === "ReconstructedTextObject") return counts;
    counts.set(object.protectedObjectId, (counts.get(object.protectedObjectId) || 0) + 1);
    return counts;
  }, new Map());
  const shreddedText = [...letterObjectCounts.values()].some((count) => count > 1);
  const geometryValidation = validateStitchGeometry(stitches, objects, preprocessed.width, preprocessed.height, design);
  const reconstructedTextObject = objects.find((object) => object.className === "ReconstructedTextObject");
  const project = {
    version: "1.0",
    machineTarget: MACHINE_TARGET,
    digitizingPipeline: "object-first",
    hoop,
    threads: preprocessed.threads,
    objects: objects.map(({ _width, _height, ...object }) => object),
    stitches,
    sequence,
    imageType: preprocessed.imageType,
    cleanup: preprocessed.cleanup,
    metadata: {
      stitchCount,
      stopCount,
      trimCount,
      jumpCount: trimCount,
      jumpRecordCount: stitches.filter((stitch) => stitch.type === "jump").length,
      longJumpCount,
      objectCount: objects.length,
      complexity,
      singleColorLogoMode: preprocessed.mode === "single-color-logo" || preprocessed.imageType === "single-color logo mode",
      outlineVectorIconMode: preprocessed.mode === "outline-vector-icon" || preprocessed.imageType === "outline vector icon mode",
      universalSafeDstMode: preprocessed.mode === "universal-safe-dst" || preprocessed.imageType === "universal safe dst mode",
      outlineValidation: preprocessed.semantic?.outlineValidation || null,
      characterPreservationMode: preprocessed.mode === "character-preservation" || preprocessed.imageType === "character preservation mode",
      characterPreservation: preprocessed.semantic?.characterPreservation || null,
      previewShowsJumps: false,
      textReadability,
      repeatedThreadStopCount,
      shreddedText,
      geometryValidation,
      reconstructedTextStyle: reconstructedTextObject?.textStyle || null,
      reconstructedTextOriginalStyle: reconstructedTextObject?.originalTextStyle || null,
      reconstructedTextMode: reconstructedTextObject?.reconstructionMode || null,
      brandProtectedMode: Boolean(reconstructedTextObject?.brandProtected),
      professionalDigitizingEngine: preprocessed.engine === "professional-digitizing-engine" || Boolean(preprocessed.semantic?.professionalDigitizingEngine),
      sourceWidth: preprocessed.width,
      sourceHeight: preprocessed.height,
      foregroundBounds,
      hoopFit: fit,
      widthIn: design.widthIn,
      heightIn: design.heightIn,
      widthMm: Number((design.widthIn * 25.4).toFixed(1)),
      heightMm: Number((design.heightIn * 25.4).toFixed(1)),
      stitchLengthMm,
      fillSpacingMm,
      fillStepPx: Number(fillStepPx.toFixed(3)),
      satinStepPx: Number(satinStepPx.toFixed(3)),
      minLineWidthMm,
      estimatedTimeMin: estimateMinutes(stitchCount),
      estimatedTextTooSmall
    }
  };
  project.quality = assessQuality(project);
  return project;
}

module.exports = {
  createStitchProject
};
