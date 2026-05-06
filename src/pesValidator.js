const { readPes } = require("./pesReader");
const {
  boundsForCommands,
  commandCounts,
  horizontalBandMetrics,
  objectCoverageMetrics,
  stitchCountsByColorSection
} = require("./dstValidator");
const { DST_UNITS_PER_INCH } = require("./dstReader");

function matchingPlanCoordinates(decoded, project, toleranceIn = 0.014) {
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
    const expectedType = expected.type === "trim" ? "trim" : expected.type;
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

function validatePesForProject(buffer, project) {
  const failures = [];
  let decoded;
  try {
    decoded = readPes(buffer);
  } catch (error) {
    return {
      passed: false,
      failures: [error.message || "PES could not be decoded."],
      decoded: null,
      metrics: {}
    };
  }
  if (!decoded.header.version.startsWith("#PES")) failures.push("PES header is missing.");
  if (decoded.header.pecOffset < 12) failures.push("PES PEC seek value is invalid.");
  if (decoded.header.pecMagic !== "#PEC0001") failures.push("PES Brother PEC section is missing.");
  if (decoded.header.stitchOffset <= decoded.header.pecOffset) failures.push("PES stitch section offset is invalid.");
  if (!decoded.sawEnd) failures.push("PES END command is missing.");
  if (decoded.corruptedRecords.length) failures.push("PES contains corrupted stitch commands.");

  const counts = commandCounts(decoded.commands);
  if (!counts.stitch) failures.push("PES stitch section has no stitches.");
  const expectedStitches = project.metadata?.stitchCount || 0;
  const stitchTolerance = Math.max(2, Math.ceil(expectedStitches * 0.01));
  if (Math.abs(counts.stitch - expectedStitches) > stitchTolerance) {
    failures.push(`Decoded PES stitch count ${counts.stitch} does not match expected ${expectedStitches}.`);
  }

  const expectedStops = project.metadata?.stopCount || 0;
  if (counts.stop !== expectedStops) {
    failures.push(`Decoded PES colour stop count ${counts.stop} does not match expected ${expectedStops}.`);
  }

  const bounds = boundsForCommands(decoded.commands);
  const hoopWidth = Number(project.hoop?.widthIn || 0);
  const hoopHeight = Number(project.hoop?.heightIn || 0);
  if (hoopWidth <= 0 || hoopHeight <= 0) failures.push("Hoop size is invalid.");
  if (Math.abs(bounds.minX) > hoopWidth / 2 + 0.02 || Math.abs(bounds.maxX) > hoopWidth / 2 + 0.02 ||
      Math.abs(bounds.minY) > hoopHeight / 2 + 0.02 || Math.abs(bounds.maxY) > hoopHeight / 2 + 0.02) {
    failures.push("Decoded PES bounds exceed selected hoop.");
  }

  const expectedWidth = Number(project.metadata?.widthIn || 0);
  const expectedHeight = Number(project.metadata?.heightIn || 0);
  if (expectedWidth > 0 && Math.abs(bounds.widthIn - expectedWidth) > Math.max(0.08, expectedWidth * 0.08)) {
    failures.push("Decoded PES width does not match planned design size.");
  }
  if (expectedHeight > 0 && Math.abs(bounds.heightIn - expectedHeight) > Math.max(0.08, expectedHeight * 0.08)) {
    failures.push("Decoded PES height does not match planned design size.");
  }

  const maxAbsDelta = Math.max(0, ...decoded.commands.map((command) => Math.max(Math.abs(command.dx), Math.abs(command.dy))));
  if (maxAbsDelta > 2047) failures.push("A PES movement exceeds the PEC per-command range.");
  const hugeJump = decoded.commands.find((command) => ["jump", "trim"].includes(command.type) && Math.hypot(command.dxIn, command.dyIn) > 0.55);
  if (hugeJump) failures.push("PES contains an unexpected huge jump movement.");

  const planMatch = matchingPlanCoordinates(decoded, project);
  if (!planMatch.passed) failures.push("Decoded PES movement path differs from the stitch plan.");
  const coverage = planMatch.passed ? objectCoverageMetrics(decoded, project) : { coverageRadiusPx: 0, objects: [], failures: ["Path mismatch prevented fill coverage validation."] };
  failures.push(...coverage.failures.map((failure) => `Fill completeness failed: ${failure}`));

  const decodedSectionCounts = stitchCountsByColorSection(decoded.commands);
  const expectedSectionCounts = (project.sequence || []).map((item) => item.stitchCount || 0);
  if (expectedSectionCounts.length && decodedSectionCounts.length !== expectedSectionCounts.length) {
    failures.push("Decoded PES colour sections do not match the planned thread order.");
  }
  if (expectedSectionCounts.length === decodedSectionCounts.length) {
    for (let i = 0; i < expectedSectionCounts.length; i += 1) {
      const tolerance = Math.max(2, Math.ceil(expectedSectionCounts[i] * 0.03));
      if (Math.abs(decodedSectionCounts[i] - expectedSectionCounts[i]) > tolerance) {
        failures.push("Decoded PES colour section stitch counts do not match the planned thread order.");
        break;
      }
    }
  }

  const banding = horizontalBandMetrics(decoded.commands);
  if (counts.stitch > 80 && bounds.heightIn > 0.5 && banding.uniqueYBuckets <= 4) {
    failures.push("Decoded PES collapsed into too few horizontal stitch bands.");
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
      maxAbsDelta,
      planMatch,
      colorSectionStitchCounts: decodedSectionCounts,
      expectedColorSectionStitchCounts: expectedSectionCounts,
      horizontalBandMetrics: banding,
      fillCompleteness: coverage
    }
  };
}

module.exports = {
  matchingPlanCoordinates,
  validatePesForProject
};
