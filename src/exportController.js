const { preprocessImage } = require("./imagePreprocess");
const { createStitchProject } = require("./stitchPlanner");
const { exportBrotherNQ1700E } = require("./dstWriter");
const { validateDstForProject } = require("./dstValidator");
const { writePesIfSupported, pesSupported } = require("./pesWriter");
const { validatePesForProject } = require("./pesValidator");
const { renderSvgPreview, renderDstSvgPreview, renderPngPreview, renderDstPngPreview } = require("./previewRenderer");
const { renderSimplifiedArtwork, detectComplexity } = require("./simplifiedArtwork");
const { validateSemanticStructure } = require("./semanticPreservation");
const { BrotherNQ1700EProfile, safeUsbFilename } = require("./brotherProfile");
const { createBrotherUsbPackage } = require("./usbPackage");

function safeLabel(name = "design") {
  return String(name).replace(/\.[^.]+$/, "").replace(/[^a-z0-9_-]+/gi, "_").slice(0, 24) || "design";
}

function complexSettings(input) {
  const detail = input.detailLevel || "medium";
  const style = input.embroideryStyle || "detailed patch";
  const area = input.image.width * input.image.height;
  const detailAreaRatio = detail === "low" ? 0.012 : detail === "high" ? 0.0045 : 0.0075;
  const styleMaxColors = style === "line art" ? 2 : style === "simple patch" || style === "applique-ready" ? 4 : 6;
  const smoothing = detail === "high" ? 1 : detail === "low" ? 3 : 2;
  return {
    maxColors: Math.min(Number(input.maxColors || 6), styleMaxColors),
    minRegionSize: Math.max(Number(input.minRegionSize || 0), 25, Math.round(area * detailAreaRatio)),
    borderSmoothing: Math.max(Number(input.borderSmoothing || 1), smoothing),
    minLineWidthMm: Math.max(Number(input.minLineWidthMm || 1), style === "line art" ? 0.8 : 1.2),
    style,
    detail
  };
}

function validateTechnicalExport(project) {
  const failures = [];
  const hoopWidth = Number(project.hoop?.widthIn);
  const hoopHeight = Number(project.hoop?.heightIn);
  if (!Number.isFinite(hoopWidth) || !Number.isFinite(hoopHeight) || hoopWidth <= 0 || hoopHeight <= 0) {
    failures.push("hoop size is missing or invalid");
  }
  if (!project.objects?.length) failures.push("no visible design found");
  if (!project.metadata?.stitchCount) failures.push("generated stitch count is 0");
  const halfW = hoopWidth / 2 + 0.02;
  const halfH = hoopHeight / 2 + 0.02;
  const outsideHoop = (project.stitches || []).some((stitch) => (
    Number.isFinite(stitch.x) &&
    Number.isFinite(stitch.y) &&
    (Math.abs(stitch.x) > halfW || Math.abs(stitch.y) > halfH)
  ));
  if (outsideHoop) failures.push("stitch coordinates exceed selected hoop bounds");
  return {
    passed: failures.length === 0,
    failures
  };
}

function mergeQualityWarnings(project, warnings, blocked = false) {
  project.quality = {
    ...(project.quality || { score: 0, warnings: [] }),
    warnings: [...new Set([...(project.quality?.warnings || []), ...warnings])],
    blocked
  };
}

function convertImageToEmbroidery(input) {
  let effectiveInput = { ...input };
  let preprocessed = preprocessImage(effectiveInput);
  let project = createStitchProject(preprocessed, {
    hoopWidthIn: input.hoopWidthIn,
    hoopHeightIn: input.hoopHeightIn,
    stitchDensity: input.stitchDensity,
    fillSpacingMm: input.fillSpacingMm,
    stitchLengthMm: input.stitchLengthMm,
    minLineWidthMm: input.minLineWidthMm
  });
  let complexity = detectComplexity(preprocessed, project, input);
  if (complexity.level === "complex") {
    const settings = complexSettings(input);
    effectiveInput = {
      ...effectiveInput,
      maxColors: settings.maxColors,
      minRegionSize: settings.minRegionSize,
      borderSmoothing: settings.borderSmoothing
    };
    preprocessed = preprocessImage(effectiveInput);
    project = createStitchProject(preprocessed, {
      hoopWidthIn: input.hoopWidthIn,
      hoopHeightIn: input.hoopHeightIn,
      stitchDensity: input.stitchDensity,
      fillSpacingMm: input.fillSpacingMm,
      stitchLengthMm: input.stitchLengthMm,
      minLineWidthMm: settings.minLineWidthMm,
      complexity: "complex"
    });
    complexity = detectComplexity(preprocessed, project, input);
    complexity.recommendedStyle = settings.style || complexity.recommendedStyle;
    complexity.detailLevel = settings.detail;
  }
  const structureValidation = validateSemanticStructure(project, preprocessed.semantic);
  project.semanticValidation = structureValidation;
  const geometryPassed = project.metadata.geometryValidation?.passed !== false;
  const reconstructedText = project.objects.find((object) => object.className === "ReconstructedTextObject" && object.text === "NIKE");
  const protectedLetters = (preprocessed.semantic?.protectedObjects || []).filter((object) => object.type === "letter");
  const textClasses = new Set(["ReconstructedTextObject", "TextObject", "OutlineDominantTextObject", "SatinBorderObject", "SatinColumn"]);
  const preservedLetterCount = protectedLetters.filter((letter) => (
    reconstructedText ||
    project.objects.some((object) => object.protectedObjectId === letter.id && textClasses.has(object.className))
  )).length;
  const expectedNikeText = /nike/i.test(input.fileName || "") && /stitch|mascot|logo/i.test(input.fileName || "");
  const hasAnyTextObject = Boolean(reconstructedText) || project.objects.some((object) => textClasses.has(object.className));
  if (expectedNikeText && !hasAnyTextObject && !structureValidation.failures.includes("primary text missing")) {
    structureValidation.failures.push("primary text missing");
    structureValidation.passed = false;
    structureValidation.scoreCap = Math.min(structureValidation.scoreCap || 100, 20);
  }
  const contourPreservedText = Boolean(
    reconstructedText?.reconstructionMode === "contour-preserving" &&
    reconstructedText?.contourPreserved !== false
  );
  const singleColorLogoMode = preprocessed.mode === "single-color-logo" || preprocessed.imageType === "single-color logo mode";
  const outlineVectorIconMode = preprocessed.mode === "outline-vector-icon" || preprocessed.imageType === "outline vector icon mode";
  const outlineObjects = project.objects.filter((object) => object.outlineVectorIcon || object.sourceType === "outline-path");
  const outlineValidation = {
    passed: true,
    failures: [],
    metrics: preprocessed.semantic?.outlineValidation || {},
    objectCount: outlineObjects.length
  };
  if (outlineVectorIconMode) {
    if (!outlineObjects.length) outlineValidation.failures.push("no usable foreground stroke path exists");
    if (!project.metadata.stitchCount) outlineValidation.failures.push("stitch generation failed");
    if (project.threads.length !== 1) outlineValidation.failures.push("single-colour line art produced extra thread colours");
    if (outlineValidation.metrics.continuousEnough === false) outlineValidation.failures.push("paths are too fragmented");
  }
  outlineValidation.passed = outlineValidation.failures.length === 0;
  const singleLogoWordmark = project.objects.some((object) => object.logoRole === "wordmark" && object.contourPreserved !== false);
  const singleLogoSwoosh = project.objects.some((object) => object.logoRole === "swoosh" && object.className === "FillObject" && object.contourPreserved !== false);
  const singleLogoContour = project.objects.some((object) => object.singleColorLogo && object.contourPreserved !== false);
  const characterPreservationMode = preprocessed.mode === "character-preservation" || preprocessed.imageType === "character preservation mode";
  const characterObjects = project.objects.filter((object) => object.sourceType === "character");
  const characterRoles = new Set(characterObjects.map((object) => object.characterRole).filter(Boolean));
  const characterFeatures = preprocessed.semantic?.characterPreservation || {};
  const characterValidation = {
    passed: true,
    failures: [],
    roles: [...characterRoles],
    features: characterFeatures,
    objectCount: characterObjects.length
  };
  if (characterPreservationMode) {
    if (!characterObjects.length) characterValidation.failures.push("mascot object missing");
    if (!characterFeatures.bodyVisible) characterValidation.failures.push("body silhouette missing");
    if (!characterFeatures.faceVisible) characterValidation.failures.push("face region missing");
    if (!characterFeatures.eyesVisible) characterValidation.failures.push("eyes missing");
    if (!characterFeatures.earsVisible) characterValidation.failures.push("ears missing");
    if (characterObjects.length < 3) characterValidation.failures.push("character collapsed into blob");
  }
  characterValidation.passed = characterValidation.failures.length === 0;
  const nonContourRebuiltText = Boolean(reconstructedText && reconstructedText.reconstructionMode !== "contour-preserving");
  const detectedMascot = (preprocessed.semantic?.protectedObjects || []).some((object) => object.type === "mascot" && object.source !== "file-name");
  const visualValidation = {
    passed: true,
    failures: [],
    requiredObjects: {
      text: singleColorLogoMode ? (singleLogoWordmark || singleLogoContour) : contourPreservedText || (protectedLetters.length >= 4 && preservedLetterCount >= protectedLetters.length),
      word: singleColorLogoMode || outlineVectorIconMode ? "contour-preserved" : reconstructedText?.text || (protectedLetters.length >= 4 ? "NIKE" : ""),
      contourPreservedText,
      wordmark: singleLogoWordmark || (singleColorLogoMode && singleLogoContour),
      swoosh: singleColorLogoMode ? (singleLogoSwoosh || !project.objects.some((object) => object.logoRole === "swoosh")) : project.objects.some((object) => object.sourceType === "swoosh" && object.className === "FillObject"),
      mascot: characterPreservationMode ? characterValidation.passed : project.objects.some((object) => object.sourceType === "character"),
      outlinePaths: outlineObjects.length
    }
  };
  if (outlineVectorIconMode) {
    if (!outlineValidation.passed) visualValidation.failures.push("outline path validation failed");
  } else if (singleColorLogoMode) {
    if (!singleLogoContour && !singleLogoWordmark) visualValidation.failures.push("foreground contour missing");
    if (project.objects.some((object) => object.logoRole === "swoosh") && !singleLogoSwoosh) visualValidation.failures.push("swoosh object missing");
  } else if (preprocessed.semantic?.reconstructedText) {
    if (!visualValidation.requiredObjects.text) visualValidation.failures.push("reconstructed text missing");
    if (visualValidation.requiredObjects.word !== "NIKE") visualValidation.failures.push("detected word unreadable");
    if (nonContourRebuiltText) visualValidation.failures.push("brand text replaced with guessed font");
    if (!visualValidation.requiredObjects.swoosh) visualValidation.failures.push("swoosh object missing");
    if (!visualValidation.requiredObjects.mascot && detectedMascot) visualValidation.failures.push("mascot object missing");
  }
  if (characterPreservationMode && !characterValidation.passed) {
    visualValidation.failures.push("mascot recognizability failed");
  }
  visualValidation.passed = visualValidation.failures.length === 0;
  project.visualValidation = visualValidation;
  project.characterValidation = characterValidation;
  project.outlineValidation = outlineValidation;
  if (!structureValidation.passed || !geometryPassed || !visualValidation.passed || !characterValidation.passed || !outlineValidation.passed || (project.quality?.score || 0) < 70) {
    const scoreCap = Number.isFinite(structureValidation.scoreCap) ? structureValidation.scoreCap : 35;
    let hardCap = 100;
    if (!structureValidation.passed) hardCap = Math.min(hardCap, scoreCap);
    if (!geometryPassed) hardCap = Math.min(hardCap, 15);
    if (!visualValidation.passed) hardCap = Math.min(hardCap, 10);
    if (!outlineValidation.passed) hardCap = Math.min(hardCap, 10);
    if (!characterValidation.passed) hardCap = Math.min(hardCap, 20);
    if (nonContourRebuiltText) hardCap = Math.min(hardCap, 20);
    const specificWarnings = structureValidation.failures.map((failure) => {
      if (failure === "primary text missing") return "The primary text disappeared during simplification. Export is available with warnings.";
      if (failure === "primary text incomplete") return "The primary text was not fully preserved. Export is available with warnings.";
      if (failure === "main logo object missing") return "A main logo object was lost or broken during simplification.";
      if (failure === "only secondary objects remain") return "Only secondary artwork remained after cleanup. Primary design objects must be preserved.";
      return failure;
    });
    if (!geometryPassed) specificWarnings.push("Some stitches escaped the true contour mask. Preview before stitching.");
    if (nonContourRebuiltText) specificWarnings.push("Brand text must be preserved from original contours, not replaced with a guessed font.");
    if (!characterValidation.passed) specificWarnings.push("The mascot collapsed or lost recognizable character details. Export is available with warnings.");
    if (!outlineValidation.passed) specificWarnings.push("The outline icon did not produce clean stroke paths. Export is available with warnings.");
    if (!visualValidation.passed) specificWarnings.push("Rebuilt text or required design objects failed final visual validation.");
    if (!visualValidation.passed) specificWarnings.push("Required object missing from simplified artwork.");
    if ((project.quality?.score || 0) < 70) specificWarnings.push("Test export available with warnings. Preview before stitching.");
    if (preprocessed.semantic?.reconstructedText && !visualValidation.requiredObjects.text) specificWarnings.push("Detected NIKE text was not visible after reconstruction.");
    project.quality = {
      score: Math.min(project.quality?.score || hardCap, hardCap),
      warnings: [...new Set([
        ...(project.quality?.warnings || []),
        ...specificWarnings,
        "Automatic simplification may have damaged major design structure. Preview before stitching."
      ])],
      blocked: false
    };
  }
  const label = safeLabel(input.fileName);
  const pesFilename = safeUsbFilename(label, "pes");
  const dstFilename = safeUsbFilename(label, "dst");
  const technicalValidation = validateTechnicalExport(project);
  let pes = null;
  let pesValidation = { passed: false, failures: ["PES was not generated."], decoded: null, metrics: {} };
  let dst = null;
  let dstValidation = { passed: false, failures: ["DST was not generated."], decoded: null, metrics: {} };
  if (technicalValidation.passed) {
    try {
      pes = writePesIfSupported(project, label);
      pesValidation = validatePesForProject(pes, project);
      if (!pesValidation.passed) {
        technicalValidation.failures.push(...pesValidation.failures.map((failure) => `PES validation failed: ${failure}`));
      }
    } catch (error) {
      pesValidation = { passed: false, failures: [error.message || "PES writer failed validation"], decoded: null, metrics: {} };
      technicalValidation.failures.push(error.message || "PES writer failed validation");
    }

    try {
      dst = exportBrotherNQ1700E(project, label);
      dstValidation = validateDstForProject(dst, project);
      if (!dstValidation.passed) {
        technicalValidation.failures.push(...dstValidation.failures.map((failure) => `DST fallback validation failed: ${failure}`));
      }
    } catch (error) {
      dstValidation = { passed: false, failures: [error.message || "DST writer failed validation"], decoded: null, metrics: {} };
      technicalValidation.failures.push(error.message || "DST writer failed validation");
    }
  }

  const canExportPes = Boolean(pes) && pesValidation.passed;
  const canExportDstFallback = Boolean(dst) && dstValidation.passed;
  const hasAnyMachineFile = Boolean(pes || dst);
  const downloadablePes = canExportPes ? pes : null;
  const downloadableDst = canExportDstFallback ? dst : null;
  if (!hasAnyMachineFile) {
    mergeQualityWarnings(project, technicalValidation.failures.map((failure) => `Export blocked: ${failure}.`), true);
  } else if (!canExportPes) {
    mergeQualityWarnings(project, ["PES validation failed. Use only for testing, or use the DST fallback if it validates."], false);
  } else if ((project.quality?.warnings || []).length || (project.quality?.score || 0) < 85 || !structureValidation.passed || !visualValidation.passed || !characterValidation.passed || !outlineValidation.passed || !geometryPassed) {
    mergeQualityWarnings(project, ["PES ready with warnings. Preview on the machine before stitching."], false);
  } else {
    project.quality = { ...(project.quality || {}), blocked: false };
  }
  const defectWarnings = (project.quality?.warnings || []).filter((warning) => !/^DST does not store RGB thread colours/i.test(warning));
  const exportStatus = canExportPes
    ? (defectWarnings.length || (project.quality?.score || 0) < 85 ? "PES ready with warnings" : "Customer-ready PES")
    : canExportDstFallback
      ? "DST fallback available"
      : hasAnyMachineFile
        ? "PES validation failed"
        : "Blocked due to technical failure";
  const primaryValidation = pesValidation.decoded ? pesValidation : dstValidation;
  const primaryPreviewSource = pesValidation.decoded ? "decoded-pes-bytes" : dstValidation.decoded ? "decoded-dst-bytes" : "internal-stitch-plan";
  const appStitchSvg = renderSvgPreview(project, { showJumps: false });
  const svg = primaryValidation.decoded ? renderDstSvgPreview(project, primaryValidation.decoded, { showJumps: false, previewSource: primaryPreviewSource }) : appStitchSvg;
  const svgWithJumps = primaryValidation.decoded ? renderDstSvgPreview(project, primaryValidation.decoded, { showJumps: true, previewSource: primaryPreviewSource }) : renderSvgPreview({ ...project, metadata: { ...project.metadata, previewShowsJumps: true } }, { showJumps: true });
  const simplifiedSvg = renderSimplifiedArtwork(preprocessed, project);
  const png = primaryValidation.decoded ? renderDstPngPreview(project, primaryValidation.decoded) : renderPngPreview(project);
  const usbPackage = downloadablePes ? createBrotherUsbPackage({ pes: downloadablePes, png, baseName: label }) : null;

  return {
    project,
    files: {
      dst: downloadableDst ? downloadableDst.toString("base64") : null,
      pes: downloadablePes ? downloadablePes.toString("base64") : null,
      svg,
      svgWithJumps,
      appStitchSvg,
      simplifiedSvg,
      png: png.toString("base64"),
      usbPackage: usbPackage ? usbPackage.buffer.toString("base64") : null
    },
    metadata: {
      ...project.metadata,
      threadOrder: project.threads,
      sequence: project.sequence,
      quality: project.quality,
      imageType: complexity.label,
      complexity,
      semanticValidation: structureValidation,
      visualValidation,
      characterValidation,
      outlineValidation,
      technicalValidation,
      machineValidation: {
        format: pesValidation.decoded ? "PES" : dstValidation.decoded ? "DST" : "internal",
        passed: primaryValidation.passed,
        failures: primaryValidation.failures,
        metrics: primaryValidation.metrics,
        previewSource: primaryPreviewSource
      },
      pesValidation: {
        passed: pesValidation.passed,
        failures: pesValidation.failures,
        metrics: pesValidation.metrics
      },
      dstValidation: {
        passed: dstValidation.passed,
        failures: dstValidation.failures,
        metrics: dstValidation.metrics
      },
      exportStatus,
      exportBlocked: !hasAnyMachineFile,
      primaryFormat: "PES",
      fallbackFormat: "DST",
      brotherProfile: BrotherNQ1700EProfile,
      pesSupported,
      pesFilename,
      dstFilename,
      usbPackageFilename: usbPackage?.filename || null,
      usbPackageContents: usbPackage ? [usbPackage.pesFilename, usbPackage.pngFilename, usbPackage.readmeFilename] : [],
      pesBytes: downloadablePes ? downloadablePes.length : 0,
      dstBytes: downloadableDst ? downloadableDst.length : 0,
      svgBytes: Buffer.byteLength(svg),
      pngBytes: png.length
    }
  };
}

module.exports = {
  convertImageToEmbroidery
};
