const { convertImageToEmbroidery } = require("../src/exportController");

function log(message) {
  process.stdout.write(`${message}\n`);
}

function smokeImage() {
  const width = 32;
  const height = 32;
  const rgba = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inCircle = (x - 16) ** 2 + (y - 16) ** 2 <= 9 ** 2;
      rgba.push(inCircle ? 20 : 255, inCircle ? 20 : 255, inCircle ? 20 : 255, inCircle ? 255 : 0);
    }
  }
  return {
    fileName: "build_check.png",
    fileType: "image/png",
    fileSize: width * height * 4,
    hoopWidthIn: 4,
    hoopHeightIn: 4,
    maxColors: 2,
    stitchDensity: 0.4,
    fillSpacingMm: 0.4,
    stitchLengthMm: 2.5,
    minLineWidthMm: 1,
    removeTransparent: true,
    image: { width, height, rgba }
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  log("Running NQ1700E build check...");
  const result = convertImageToEmbroidery(smokeImage());
  assert(result.project, "Project JSON was not generated.");
  assert(result.files?.pes, "PES export was not generated.");
  assert(result.files?.dst, "DST fallback was not generated.");
  assert(result.files?.svg, "SVG preview was not generated.");
  assert(result.files?.png, "PNG preview was not generated.");
  assert(Number(result.metadata?.stitchCount || 0) > 0, "Stitch count is zero.");
  assert(result.metadata?.pesValidation?.passed, `PES validation failed: ${(result.metadata?.pesValidation?.failures || []).join("; ")}`);
  assert(result.metadata?.dstValidation?.passed, `DST validation failed: ${(result.metadata?.dstValidation?.failures || []).join("; ")}`);
  log(`Build check passed: ${result.metadata.stitchCount} stitches, PES ${result.metadata.pesBytes} bytes, DST ${result.metadata.dstBytes} bytes.`);
} catch (error) {
  process.stderr.write(`Build check failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
}
