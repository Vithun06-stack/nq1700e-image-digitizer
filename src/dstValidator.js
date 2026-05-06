const { readDst, DST_UNITS_PER_INCH } = require("./dstReader");

function boundsForCommands(commands) {
  const stitchLike = commands.filter((command) => command.type === "stitch" || command.type === "jump" || command.type === "stop");
  const xs = stitchLike.map((command) => command.xIn);
  const ys = stitchLike.map((command) => command.yIn);
  return {
    minX: Math.min(0, ...xs),
    maxX: Math.max(0, ...xs),
    minY: Math.min(0, ...ys),
    maxY: Math.max(0, ...ys),
    widthIn: Math.max(0, ...xs) - Math.min(0, ...xs),
    heightIn: Math.max(0, ...ys) - Math.min(0, ...ys)
  };
}

function commandCounts(commands) {
  return commands.reduce((counts, command) => {
    counts[command.type] = (counts[command.type] || 0) + 1;
    return counts;
  }, { stitch: 0, jump: 0, stop: 0 });
}

function stitchCountsByColorSection(commands) {
  const sections = [0];
  for (const command of commands) {
    if (command.type === "stop") {
      sections.push(0);
      continue;
    }
    if (command.type === "stitch") sections[sections.length - 1] += 1;
  }
  while (sections.length > 1 && sections[sections.length - 1] === 0) sections.pop();
  return sections;
}

function horizontalBandMetrics(commands) {
  const stitches = commands.filter((command) => command.type === "stitch");
  const yBuckets = new Map();
  for (const command of stitches) {
    const key = Math.round((command.yMm || 0) * 2) / 2;
    yBuckets.set(key, (yBuckets.get(key) || 0) + 1);
  }
  const sortedBuckets = [...yBuckets.entries()].sort((a, b) => b[1] - a[1]);
  const topFive = sortedBuckets.slice(0, 5).reduce((sum, [, count]) => sum + count, 0);
  return {
    uniqueYBuckets: yBuckets.size,
    dominantFiveRatio: stitches.length ? Number((topFive / stitches.length).toFixed(3)) : 0,
    dominantRows: sortedBuckets.slice(0, 5).map(([yMm, count]) => ({ yMm, count }))
  };
}

function pointToSourcePixel(project, xIn, yIn) {
  const sourceWidth = Math.max(1, project.metadata?.sourceWidth || 1);
  const sourceHeight = Math.max(1, project.metadata?.sourceHeight || 1);
  const bounds = project.metadata?.foregroundBounds || { minX: 0, minY: 0, bboxWidth: sourceWidth, bboxHeight: sourceHeight };
  const widthIn = Math.max(0.001, project.metadata?.widthIn || project.hoop?.widthIn || 1);
  const heightIn = Math.max(0.001, project.metadata?.heightIn || project.hoop?.heightIn || 1);
  return {
    x: Math.round(bounds.minX + ((xIn + widthIn / 2) / widthIn) * Math.max(1, bounds.bboxWidth - 1)),
    y: Math.round(bounds.minY + ((heightIn / 2 - yIn) / heightIn) * Math.max(1, bounds.bboxHeight - 1))
  };
}

function addCoveragePoint(covered, width, height, x, y, radius) {
  for (let yy = y - radius; yy <= y + radius; yy += 1) {
    for (let xx = x - radius; xx <= x + radius; xx += 1) {
      if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
      if ((xx - x) ** 2 + (yy - y) ** 2 <= radius ** 2) covered.add(yy * width + xx);
    }
  }
}

function addCoverageLine(covered, width, height, a, b, radius) {
  let x0 = a.x;
  let y0 = a.y;
  const x1 = b.x;
  const y1 = b.y;
  let dx = Math.abs(x1 - x0);
  let sx = x0 < x1 ? 1 : -1;
  let dy = -Math.abs(y1 - y0);
  let sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  while (true) {
    addCoveragePoint(covered, width, height, x0, y0, radius);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

function objectCoverageThreshold(object) {
  if (object.className === "RunningLine") return 0.9;
  if (["SatinBorderObject", "OutlineDominantTextObject", "SatinColumn", "ReconstructedTextObject"].includes(object.className)) return 0.85;
  return 0.9;
}

function objectCoverageMetrics(decoded, project) {
  const objects = new Map((project.objects || []).map((object) => [object.id, object]));
  const sourceWidth = Math.max(1, project.metadata?.sourceWidth || 1);
  const sourceHeight = Math.max(1, project.metadata?.sourceHeight || 1);
  const bounds = project.metadata?.foregroundBounds || { bboxWidth: sourceWidth, bboxHeight: sourceHeight };
  const pxPerMmX = Math.max(0.1, (bounds.bboxWidth || sourceWidth) / Math.max(1, project.metadata?.widthMm || 25.4));
  const pxPerMmY = Math.max(0.1, (bounds.bboxHeight || sourceHeight) / Math.max(1, project.metadata?.heightMm || 25.4));
  const coverageRadius = Math.max(1, Math.ceil(Math.max(pxPerMmX, pxPerMmY) * 0.45));
  const coveredByObject = new Map();
  const commands = decoded.commands || [];
  const plan = project.stitches || [];
  let previous = { xIn: 0, yIn: 0 };
  for (let i = 0; i < Math.min(commands.length, plan.length); i += 1) {
    const command = commands[i];
    const planned = plan[i];
    if (command.type === "stitch" && planned?.objectId && objects.has(planned.objectId)) {
      if (!coveredByObject.has(planned.objectId)) coveredByObject.set(planned.objectId, new Set());
      addCoverageLine(
        coveredByObject.get(planned.objectId),
        sourceWidth,
        sourceHeight,
        pointToSourcePixel(project, previous.xIn || 0, previous.yIn || 0),
        pointToSourcePixel(project, command.xIn || 0, command.yIn || 0),
        coverageRadius
      );
    }
    previous = command;
  }

  const objectMetrics = [];
  const failures = [];
  for (const object of objects.values()) {
    if (!object.region?.cells?.length || object.region.cells.length < 6) continue;
    const covered = coveredByObject.get(object.id) || new Set();
    let coveredCells = 0;
    for (const cell of object.region.cells) {
      if (covered.has(cell)) coveredCells += 1;
    }
    const fillCoveragePercent = coveredCells / Math.max(1, object.region.cells.length);
    const threshold = objectCoverageThreshold(object);
    const metric = {
      objectId: object.id,
      className: object.className,
      sourceType: object.sourceType,
      area: object.region.cells.length,
      fillCoveragePercent: Number((fillCoveragePercent * 100).toFixed(1)),
      requiredPercent: Number((threshold * 100).toFixed(1))
    };
    objectMetrics.push(metric);
    if (object.region.cells.length >= 20 && fillCoveragePercent < threshold) {
      failures.push(`${object.className} ${object.id} decoded fill coverage ${metric.fillCoveragePercent}% is below ${metric.requiredPercent}%.`);
    }
  }
  return {
    coverageRadiusPx: coverageRadius,
    objects: objectMetrics,
    failures
  };
}

function matchingPlanCoordinates(decoded, project, toleranceIn = 0.012) {
  const commands = decoded.commands;
  const plan = project.stitches || [];
  if (commands.length !== plan.length) {
    return {
      passed: false,
      checked: Math.min(commands.length, plan.length),
      mismatchCount: Math.abs(commands.length - plan.length),
      examples: [{ reason: "command count mismatch", decoded: commands.length, plan: plan.length }]
    };
  }
  const examples = [];
  let mismatchCount = 0;
  for (let i = 0; i < plan.length; i += 1) {
    const expected = plan[i];
    const actual = commands[i];
    const expectedType = expected.type === "trim" ? "jump" : expected.type;
    const dx = Math.abs((actual.xIn || 0) - expected.x);
    const dy = Math.abs((actual.yIn || 0) - expected.y);
    if (actual.type !== expectedType || dx > toleranceIn || dy > toleranceIn) {
      mismatchCount += 1;
      if (examples.length < 8) {
        examples.push({
          index: i,
          expected: { type: expectedType, x: expected.x, y: expected.y },
          actual: { type: actual.type, x: actual.xIn, y: actual.yIn },
          dx,
          dy
        });
      }
    }
  }
  return {
    passed: mismatchCount === 0,
    checked: plan.length,
    mismatchCount,
    examples
  };
}

function validateDstForProject(buffer, project) {
  const failures = [];
  let decoded;
  try {
    decoded = readDst(buffer);
  } catch (error) {
    return {
      passed: false,
      failures: [error.message || "DST could not be decoded."],
      decoded: null
    };
  }
  if (!decoded.sawEnd) failures.push("END command is missing.");
  if (decoded.corruptedRecords.length) failures.push("DST contains corrupted command bytes.");

  const counts = commandCounts(decoded.commands);
  const expectedStitches = project.metadata?.stitchCount || 0;
  const expectedStops = project.metadata?.stopCount || 0;
  const stitchTolerance = Math.max(2, Math.ceil(expectedStitches * 0.01));
  if (Math.abs(counts.stitch - expectedStitches) > stitchTolerance) {
    failures.push(`Decoded stitch count ${counts.stitch} does not match expected ${expectedStitches}.`);
  }
  if (counts.stop !== expectedStops) {
    failures.push(`Decoded colour stop count ${counts.stop} does not match expected ${expectedStops}.`);
  }

  const maxAbsDelta = Math.max(0, ...decoded.commands.map((command) => Math.max(Math.abs(command.dx), Math.abs(command.dy))));
  if (maxAbsDelta > 121) failures.push("A DST movement exceeds the Tajima per-command range.");

  const hugeJump = decoded.commands.find((command) => command.type === "jump" && Math.hypot(command.dxIn, command.dyIn) > 0.55);
  if (hugeJump) failures.push("DST contains an unexpected huge jump movement.");

  const bounds = boundsForCommands(decoded.commands);
  const banding = horizontalBandMetrics(decoded.commands);
  const hoopWidth = Number(project.hoop?.widthIn || 0);
  const hoopHeight = Number(project.hoop?.heightIn || 0);
  if (hoopWidth <= 0 || hoopHeight <= 0) failures.push("Hoop size is invalid.");
  if (Math.abs(bounds.minX) > hoopWidth / 2 + 0.02 || Math.abs(bounds.maxX) > hoopWidth / 2 + 0.02 ||
      Math.abs(bounds.minY) > hoopHeight / 2 + 0.02 || Math.abs(bounds.maxY) > hoopHeight / 2 + 0.02) {
    failures.push("Decoded DST bounds exceed selected hoop.");
  }

  const expectedWidth = Number(project.metadata?.widthIn || 0);
  const expectedHeight = Number(project.metadata?.heightIn || 0);
  if (expectedWidth > 0 && Math.abs(bounds.widthIn - expectedWidth) > Math.max(0.08, expectedWidth * 0.08)) {
    failures.push("Decoded DST width does not match planned design size.");
  }
  if (expectedHeight > 0 && Math.abs(bounds.heightIn - expectedHeight) > Math.max(0.08, expectedHeight * 0.08)) {
    failures.push("Decoded DST height does not match planned design size.");
  }

  const planMatch = matchingPlanCoordinates(decoded, project);
  if (!planMatch.passed) failures.push("Decoded DST movement path differs from the stitch plan.");
  const coverage = planMatch.passed ? objectCoverageMetrics(decoded, project) : { coverageRadiusPx: 0, objects: [], failures: ["Path mismatch prevented fill coverage validation."] };
  failures.push(...coverage.failures.map((failure) => `Fill completeness failed: ${failure}`));

  const decodedSectionCounts = stitchCountsByColorSection(decoded.commands);
  const expectedSectionCounts = (project.sequence || []).map((item) => item.stitchCount || 0);
  if (expectedSectionCounts.length && decodedSectionCounts.length !== expectedSectionCounts.length) {
    failures.push("Decoded DST colour sections do not match the planned thread order.");
  }
  if (expectedSectionCounts.length === decodedSectionCounts.length) {
    for (let i = 0; i < expectedSectionCounts.length; i += 1) {
      const tolerance = Math.max(2, Math.ceil(expectedSectionCounts[i] * 0.03));
      if (Math.abs(decodedSectionCounts[i] - expectedSectionCounts[i]) > tolerance) {
        failures.push("Decoded DST colour section stitch counts do not match the planned thread order.");
        break;
      }
    }
  }
  if ((project.metadata?.repeatedThreadStopCount || 0) > 0) {
    failures.push("DST thread order repeats the same colour in separated stop groups.");
  }
  if (counts.stitch > 80 && bounds.heightIn > 0.5 && banding.uniqueYBuckets <= 4) {
    failures.push("Decoded DST collapsed into too few horizontal stitch bands.");
  }
  if (counts.stitch > 120 && bounds.heightIn > 0.8 && banding.dominantFiveRatio > 0.92) {
    failures.push("Decoded DST contains large unexplained horizontal stitch bands.");
  }

  return {
    passed: failures.length === 0,
    failures,
    decoded,
    metrics: {
      unit: "0.1mm",
      unitsPerInch: DST_UNITS_PER_INCH,
      commandCounts: counts,
      bounds,
      boundsMm: decoded.boundsMm,
      colorSectionStitchCounts: decodedSectionCounts,
      expectedColorSectionStitchCounts: expectedSectionCounts,
      horizontalBandMetrics: banding,
      fillCompleteness: coverage,
      maxAbsDelta,
      planMatch
    }
  };
}

module.exports = {
  validateDstForProject,
  boundsForCommands,
  commandCounts,
  objectCoverageMetrics,
  horizontalBandMetrics,
  stitchCountsByColorSection
};
