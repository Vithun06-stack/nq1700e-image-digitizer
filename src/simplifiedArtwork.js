function visualPriority(object) {
  if (object.sourceType === "swoosh") return 10;
  if (object.className === "ReconstructedTextObject" || object.sourceType === "reconstructed-text" || object.sourceType === "text") return 20;
  if (object.sourceType === "character") return 30;
  return 40;
}

function renderSimplifiedArtwork(preprocessed, project) {
  const scale = 10;
  const width = preprocessed.width * scale;
  const height = preprocessed.height * scale;
  const runs = [];
  const objects = [...(project.objects || [])].sort((a, b) => visualPriority(a) - visualPriority(b) || a.bounds.minY - b.bounds.minY || a.bounds.minX - b.bounds.minX);
  for (const object of objects) {
    const thread = project.threads[object.threadIndex - 1];
    if (!thread) continue;
    const cells = new Set(object.region.cells);
    for (let y = object.region.minY; y <= object.region.maxY; y += 1) {
      let start = -1;
      for (let x = object.region.minX; x <= object.region.maxX; x += 1) {
        const has = cells.has(y * preprocessed.width + x);
        if (has && start === -1) start = x;
        if ((!has || x === object.region.maxX) && start !== -1) {
          const end = has && x === object.region.maxX ? x : x - 1;
          runs.push(`<rect x="${start * scale}" y="${y * scale}" width="${(end - start + 1) * scale}" height="${scale}" fill="${thread.hex}" data-object="${object.className}"/>`);
          start = -1;
        }
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  ${runs.join("\n  ")}
</svg>`;
}

function detectComplexity(preprocessed, project, input = {}) {
  if (preprocessed.mode === "outline-vector-icon" || preprocessed.imageType === "outline vector icon mode") {
    return { level: "simple", label: "Outline Vector Icon Mode", recommendedStyle: "outline vector icon", fallback: "" };
  }
  if (preprocessed.mode === "single-color-logo" || preprocessed.imageType === "single-color logo mode") {
    return { level: "simple", label: "Single-Color Logo Mode", recommendedStyle: "single-color logo", fallback: "" };
  }
  if (preprocessed.mode === "character-preservation" || preprocessed.imageType === "character preservation mode") {
    const hasText = (project.objects || []).some((object) => ["ReconstructedTextObject", "TextObject", "SatinBorderObject", "OutlineDominantTextObject"].includes(object.className));
    const hasLogo = (project.objects || []).some((object) => object.sourceType === "swoosh" || object.logoRole === "swoosh");
    return {
      level: "standard",
      label: hasText && hasLogo ? "Mixed: Text + Character + Logo" : "Character Preservation Mode",
      recommendedStyle: "character preservation",
      fallback: ""
    };
  }
  if (preprocessed.mode === "universal-safe-dst" || preprocessed.imageType === "universal safe dst mode") {
    return { level: "standard", label: "Universal Safe DST Mode", recommendedStyle: "safe fallback", fallback: "Export available with warnings. Preview before stitching." };
  }
  if (preprocessed.mode === "text-logo" || preprocessed.imageType === "text logo mode") {
    return { level: "simple", label: "Text Logo Mode", recommendedStyle: "contour logo", fallback: "" };
  }
  if (preprocessed.mode === "floral-artwork" || preprocessed.imageType === "floral artwork mode") {
    return { level: "standard", label: "Floral Artwork Mode", recommendedStyle: "floral contour fill", fallback: "" };
  }
  if (preprocessed.mode === "emblem-crest" || preprocessed.imageType === "emblem crest mode") {
    return { level: "standard", label: "Emblem Crest Mode", recommendedStyle: "emblem contour fill", fallback: "" };
  }
  if (preprocessed.mode === "photo-simplification" || preprocessed.imageType === "photo simplification mode") {
    return { level: "complex", label: "Photo Simplification Mode", recommendedStyle: "posterized patch", fallback: "Photo embroidery needs simplification. Preview before stitching." };
  }
  const classes = new Set((project.objects || []).map((object) => object.className));
  const hasText = classes.has("ReconstructedTextObject") || classes.has("TextObject") || classes.has("OutlineDominantTextObject") || classes.has("SatinBorderObject") || /nike|text|letter|font/i.test(input.fileName || "");
  const hasCharacter = preprocessed.imageType === "complex illustration" || preprocessed.imageType === "photo" || /stitch|mascot|cartoon/i.test(input.fileName || "");
  const hasLogoShape = [...classes].some((name) => ["FillObject", "SatinColumn", "RunningLine"].includes(name));
  const brandProtectedLogo = (project.objects || []).some((object) => object.brandProtected || object.reconstructionMode === "contour-preserving") &&
    hasLogoShape &&
    !hasCharacter &&
    (project.objects || []).length <= 3;
  if (brandProtectedLogo) {
    return { level: "simple", label: "brand logo protected mode", recommendedStyle: "simple patch", fallback: "" };
  }
  const manyObjects = (project.objects || []).length >= 5;
  if ((hasText && hasCharacter && hasLogoShape) || manyObjects || preprocessed.threads.length > 4) {
    return {
      level: "complex",
      label: hasText && hasCharacter ? "complex mixed artwork with text, cartoon, and logo shapes" : "complex mixed artwork",
      recommendedStyle: "detailed patch",
      fallback: "This image is too complex for automatic embroidery at this size. Try increasing hoop size, lowering detail, or using patch mode."
    };
  }
  if (preprocessed.imageType === "logo or icon" || preprocessed.imageType === "line art") {
    return { level: "simple", label: preprocessed.imageType, recommendedStyle: "simple patch", fallback: "" };
  }
  return { level: "standard", label: preprocessed.imageType, recommendedStyle: "detailed patch", fallback: "" };
}

module.exports = {
  renderSimplifiedArtwork,
  detectComplexity
};
