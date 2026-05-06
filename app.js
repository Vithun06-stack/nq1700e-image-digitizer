const $ = (id) => document.getElementById(id);

const els = {
  dropzone: $("dropzone"),
  fileInput: $("fileInput"),
  sourceCanvas: $("sourceCanvas"),
  simplifiedCanvas: $("simplifiedCanvas"),
  appPlanCanvas: $("appPlanCanvas"),
  stitchCanvas: $("stitchCanvas"),
  imageMeta: $("imageMeta"),
  simplifiedMeta: $("simplifiedMeta"),
  appPlanMeta: $("appPlanMeta"),
  stitchMeta: $("stitchMeta"),
  sampleBtn: $("sampleBtn"),
  statusTitle: $("statusTitle"),
  statusText: $("statusText"),
  progress: $("progress"),
  designWidth: $("designWidth"),
  designHeight: $("designHeight"),
  colorCount: $("colorCount"),
  embroideryStyle: $("embroideryStyle"),
  detailLevel: $("detailLevel"),
  stitchLength: $("stitchLength"),
  fillSpacing: $("fillSpacing"),
  minLineWidth: $("minLineWidth"),
  minRegionSize: $("minRegionSize"),
  transparentOnly: $("transparentOnly"),
  preserveText: $("preserveText"),
  rebuildText: $("rebuildText"),
  preserveTextStyle: $("preserveTextStyle"),
  showJumps: $("showJumps"),
  digitizeBtn: $("digitizeBtn"),
  fitHoop: $("fitHoop"),
  palette: $("palette"),
  qualityPanel: $("qualityPanel"),
  stitchCount: $("stitchCount"),
  stopCount: $("stopCount"),
  sizeReadout: $("sizeReadout"),
  downloadDst: $("downloadDst"),
  downloadPes: $("downloadPes"),
  downloadUsb: $("downloadUsb"),
  downloadSvg: $("downloadSvg"),
  downloadPng: $("downloadPng"),
  downloadJson: $("downloadJson")
};

const NQ1700E = {
  hoopWidthIn: 6,
  hoopHeightIn: 10,
  maxUploadBytes: 10 * 1024 * 1024,
  allowedTypes: new Set(["image/png", "image/jpeg", "image/jpg", "image/svg+xml", "image/webp"])
};

let sourceImage = null;
let sourceFile = null;
let sourceName = "design";
let conversion = null;

function setStatus(title, text, progress = 0) {
  els.statusTitle.textContent = title;
  els.statusText.textContent = text;
  els.progress.value = progress;
}

function cleanName(name) {
  return name.replace(/\.[^.]+$/, "").replace(/[^a-z0-9_-]+/gi, "_").slice(0, 24) || "design";
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function updateSizeReadout() {
  els.sizeReadout.textContent = `${Number(els.designWidth.value).toFixed(1)} x ${Number(els.designHeight.value).toFixed(1)} in`;
}

function validateFile(file) {
  if (!file) return "Choose an image file first.";
  if (!NQ1700E.allowedTypes.has(file.type)) return "Unsupported file. Please upload PNG, JPG, JPEG, SVG, or WEBP.";
  if (file.size > NQ1700E.maxUploadBytes) return "Image is too large. Please use a file smaller than 10 MB.";
  return "";
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function base64ToBlob(base64, type) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

function resetOutputs() {
  conversion = null;
  els.downloadDst.disabled = true;
  els.downloadPes.disabled = true;
  els.downloadUsb.disabled = true;
  els.downloadSvg.disabled = true;
  els.downloadPng.disabled = true;
  els.downloadJson.disabled = true;
  els.stitchCount.textContent = "0";
  els.stopCount.textContent = "0";
  els.appPlanMeta.textContent = "Waiting for conversion";
  els.stitchMeta.textContent = "Waiting for conversion";
  els.simplifiedMeta.textContent = "Generated before machine export";
  els.palette.className = "palette-empty";
  els.palette.textContent = "No palette yet";
  els.qualityPanel.className = "quality-empty";
  els.qualityPanel.textContent = "Convert artwork to see embroidery warnings.";
}

async function loadImageFile(file) {
  const error = validateFile(file);
  resetOutputs();
  if (error) {
    setStatus("Upload error", error, 0);
    return;
  }

  sourceFile = file;
  sourceName = cleanName(file.name);
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";
  image.onload = () => {
    sourceImage = image;
    drawSource();
    els.digitizeBtn.disabled = false;
    els.imageMeta.textContent = `${image.naturalWidth} x ${image.naturalHeight}px, ${(file.size / 1024).toFixed(0)} KB`;
    fitCurrentImageToHoop(false);
    setStatus("Loaded", "Press Make embroidery file to scan the artwork and create a PES file.", 0);
    URL.revokeObjectURL(url);
  };
  image.onerror = () => {
    setStatus("Could not load", "The image could not be decoded. Try a different PNG, JPG, SVG, or WEBP.", 0);
    URL.revokeObjectURL(url);
  };
  image.src = url;
}

function drawSource() {
  if (!sourceImage) return;
  const canvas = els.sourceCanvas;
  const ctx = canvas.getContext("2d");
  const side = 900;
  canvas.width = side;
  canvas.height = side;
  ctx.clearRect(0, 0, side, side);
  const scale = Math.min(side / sourceImage.naturalWidth, side / sourceImage.naturalHeight);
  const w = sourceImage.naturalWidth * scale;
  const h = sourceImage.naturalHeight * scale;
  ctx.drawImage(sourceImage, (side - w) / 2, (side - h) / 2, w, h);
}

function fitCurrentImageToHoop(forceLarge = true) {
  if (!sourceImage) return;
  if (forceLarge) {
    els.designWidth.value = NQ1700E.hoopWidthIn.toFixed(1);
    els.designHeight.value = NQ1700E.hoopHeightIn.toFixed(1);
  }
  updateSizeReadout();
}

function loadSampleDesign() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900" viewBox="0 0 900 900">
    <rect width="900" height="900" fill="none"/>
    <circle cx="450" cy="450" r="300" fill="#0e7c7b"/>
    <path d="M450 170 C560 315 725 350 735 505 C745 670 585 765 450 725 C315 765 155 670 165 505 C175 350 340 315 450 170Z" fill="#d95d39"/>
    <circle cx="360" cy="470" r="58" fill="#f7f5f0"/>
    <circle cx="540" cy="470" r="58" fill="#f7f5f0"/>
    <path d="M330 610 C405 675 495 675 570 610" fill="none" stroke="#172025" stroke-width="42" stroke-linecap="round"/>
    <path d="M450 250 L492 385 L635 385 L520 468 L562 600 L450 520 L338 600 L380 468 L265 385 L408 385Z" fill="#c4912d"/>
  </svg>`;
  loadImageFile(new File([svg], "nq1700e_sample.svg", { type: "image/svg+xml" }));
}

function getDecodedImageForApi() {
  const maxSide = 360;
  const scale = Math.min(1, maxSide / Math.max(sourceImage.naturalWidth, sourceImage.naturalHeight));
  const width = clamp(Math.round(sourceImage.naturalWidth * scale), 24, maxSide);
  const height = clamp(Math.round(sourceImage.naturalHeight * scale), 24, maxSide);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.clearRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(sourceImage, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  return {
    width,
    height,
    rgba: Array.from(imageData.data)
  };
}

function renderThreadOrderTable(sequence) {
  els.palette.className = "palette-list";
  els.palette.innerHTML = "";
  sequence.forEach((item) => {
    const row = document.createElement("div");
    row.className = "thread";
    row.innerHTML = `<span class="swatch" style="background:${item.hex}"></span><div><strong>Stop ${item.stopNumber}: ${item.hex}</strong><code>Thread no. ${item.threadIndex} / ${item.name || item.hex}</code><small>${item.stitchCount.toLocaleString()} stitches, about ${item.estimatedTimeMin} min, ${item.widthMm} x ${item.heightMm} mm</small></div>`;
    els.palette.appendChild(row);
  });
}

function renderQuality(metadata) {
  const quality = metadata.quality || { score: 100, warnings: [] };
  const exportStatus = metadata.exportStatus || (metadata.exportBlocked ? "Blocked" : "Ready");
  els.qualityPanel.className = "quality-list";
  els.qualityPanel.innerHTML = `<div class="quality-score"><strong>Quality score: ${quality.score}/100</strong><span>Detected mode: ${metadata.imageType || "artwork"}</span><span>Export status: ${exportStatus}</span><span>Final stitch size: ${metadata.widthMm} x ${metadata.heightMm} mm (${metadata.widthIn} x ${metadata.heightIn} in) / about ${metadata.estimatedTimeMin || 1} min</span></div>`;
  quality.warnings.forEach((warning) => {
    const div = document.createElement("div");
    div.className = "warning";
    div.textContent = warning;
    els.qualityPanel.appendChild(div);
  });
}

async function convert() {
  if (!sourceImage || !sourceFile) return;
  updateSizeReadout();
  resetOutputs();
  const hoopWidth = Number(els.designWidth.value);
  const hoopHeight = Number(els.designHeight.value);
  if (hoopWidth > NQ1700E.hoopWidthIn || hoopHeight > NQ1700E.hoopHeightIn) {
    setStatus("Too large", "Fit the design inside the Brother NQ1700E 6 x 10 inch embroidery area.", 0);
    return;
  }

  setStatus("Scanning", "Reading image pixels and preparing colour regions.", 20);
  els.digitizeBtn.disabled = true;
  try {
    await new Promise(requestAnimationFrame);
    const body = {
      fileName: sourceFile.name,
      fileType: sourceFile.type,
      fileSize: sourceFile.size,
      hoopWidthIn: hoopWidth,
      hoopHeightIn: hoopHeight,
      maxColors: Number(els.colorCount.value),
      stitchDensity: Number(els.fillSpacing.value),
      fillSpacingMm: Number(els.fillSpacing.value),
      stitchLengthMm: Number(els.stitchLength.value),
      minLineWidthMm: Number(els.minLineWidth.value),
      minRegionSize: Number(els.minRegionSize.value) || undefined,
      removeTransparent: els.transparentOnly.checked,
      preserveText: els.preserveText.checked,
      rebuildText: els.rebuildText.checked,
      preserveTextStyle: els.preserveTextStyle.checked,
      embroideryStyle: els.embroideryStyle.value,
      detailLevel: els.detailLevel.value,
      image: getDecodedImageForApi()
    };

    setStatus("Digitizing", "Creating stitch paths and machine export files.", 60);
    const response = await fetch("/api/convert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Conversion failed.");
    conversion = result;
    drawSvgToCanvas(result.files.simplifiedSvg, els.simplifiedCanvas);
    drawSvgToCanvas(result.files.appStitchSvg || result.files.svg, els.appPlanCanvas);
    if (result.metadata.exportBlocked) {
      drawBlockedPreview("Machine export could not be generated safely.");
    } else {
      drawPreviewFromSvg(els.showJumps.checked ? result.files.svgWithJumps : result.files.svg);
    }
    renderThreadOrderTable(result.metadata.sequence);
    renderQuality(result.metadata);
    els.stitchCount.textContent = result.metadata.stitchCount.toLocaleString();
    els.stopCount.textContent = result.metadata.stopCount.toLocaleString();
    els.appPlanMeta.textContent = `${result.metadata.stitchCount.toLocaleString()} planned stitches`;
    const previewSource = result.metadata.machineValidation?.previewSource === "decoded-pes-bytes"
      ? "decoded from PES bytes"
      : result.metadata.machineValidation?.previewSource === "decoded-dst-bytes"
        ? "decoded from DST bytes"
        : "internal stitch plan";
    els.stitchMeta.textContent = `${result.metadata.stitchCount.toLocaleString()} stitches, ${result.metadata.stopCount} stops, ${previewSource}`;
    els.simplifiedMeta.textContent = result.metadata.imageType || result.metadata.complexity?.recommendedStyle || "Simplified artwork";
    els.downloadPes.disabled = !result.files.pes;
    els.downloadDst.disabled = !result.files.dst;
    els.downloadUsb.disabled = !result.files.usbPackage;
    els.downloadSvg.disabled = false;
    els.downloadPng.disabled = false;
    els.downloadJson.disabled = false;
    setStatus(
      result.metadata.exportStatus || (result.metadata.exportBlocked ? "Blocked" : "Ready"),
      result.metadata.exportBlocked ? "Machine export could not be generated safely. SVG, PNG, and project JSON are still available." : "PES is the recommended Brother file. Review the decoded machine preview before stitching.",
      100
    );
  } catch (error) {
    setStatus("Conversion error", error.message, 0);
  } finally {
    els.digitizeBtn.disabled = false;
  }
}

function drawSvgToCanvas(svg, canvas) {
  const ctx = canvas.getContext("2d");
  const image = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  image.onload = () => {
    canvas.width = 980;
    canvas.height = 980;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const scale = Math.min(canvas.width / image.width, canvas.height / image.height) * 0.96;
    const w = image.width * scale;
    const h = image.height * scale;
    ctx.drawImage(image, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    URL.revokeObjectURL(url);
  };
  image.src = url;
}

function drawPreviewFromSvg(svg) {
  drawSvgToCanvas(svg, els.stitchCanvas);
}

function drawBlockedPreview(message) {
  const canvas = els.stitchCanvas;
  const ctx = canvas.getContext("2d");
  canvas.width = 980;
  canvas.height = 980;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#9fb2b7";
  ctx.lineWidth = 2;
  ctx.strokeRect(10, 10, canvas.width - 20, canvas.height - 20);
  ctx.fillStyle = "#172025";
  ctx.font = "700 30px Arial, sans-serif";
  ctx.fillText("Embroidery export blocked", 90, 430);
  ctx.fillStyle = "#63717a";
  ctx.font = "22px Arial, sans-serif";
  ctx.fillText(message, 90, 470);
}

els.fileInput.addEventListener("change", (event) => loadImageFile(event.target.files[0]));

["dragenter", "dragover"].forEach((name) => {
  els.dropzone.addEventListener(name, (event) => {
    event.preventDefault();
    els.dropzone.classList.add("is-over");
  });
});

["dragleave", "drop"].forEach((name) => {
  els.dropzone.addEventListener(name, (event) => {
    event.preventDefault();
    els.dropzone.classList.remove("is-over");
  });
});

els.dropzone.addEventListener("drop", (event) => {
  const file = event.dataTransfer.files[0];
  if (file) loadImageFile(file);
});

els.sampleBtn.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  loadSampleDesign();
});

els.fitHoop.addEventListener("click", () => fitCurrentImageToHoop(true));
els.digitizeBtn.addEventListener("click", convert);
els.showJumps.addEventListener("change", () => {
  if (!conversion) return;
  if (conversion.metadata.exportBlocked) {
    drawBlockedPreview("Machine export could not be generated safely.");
    return;
  }
  drawPreviewFromSvg(els.showJumps.checked ? conversion.files.svgWithJumps : conversion.files.svg);
});
[els.designWidth, els.designHeight].forEach((input) => input.addEventListener("input", updateSizeReadout));

els.downloadDst.addEventListener("click", () => {
  if (!conversion || !conversion.files.dst) return;
  downloadBlob(base64ToBlob(conversion.files.dst, "application/octet-stream"), conversion.metadata.dstFilename || `${sourceName}_nq1700e.dst`);
});

els.downloadPes.addEventListener("click", () => {
  if (!conversion || !conversion.files.pes) return;
  downloadBlob(base64ToBlob(conversion.files.pes, "application/octet-stream"), conversion.metadata.pesFilename || `${sourceName}_nq1700e.pes`);
});

els.downloadUsb.addEventListener("click", () => {
  if (!conversion || !conversion.files.usbPackage) return;
  downloadBlob(base64ToBlob(conversion.files.usbPackage, "application/zip"), conversion.metadata.usbPackageFilename || `${sourceName}_brother_usb_package.zip`);
});

els.downloadSvg.addEventListener("click", () => {
  if (!conversion) return;
  downloadBlob(new Blob([conversion.files.svg], { type: "image/svg+xml" }), `${sourceName}_preview.svg`);
});

els.downloadPng.addEventListener("click", () => {
  if (!conversion) return;
  downloadBlob(base64ToBlob(conversion.files.png, "image/png"), `${sourceName}_preview.png`);
});

els.downloadJson.addEventListener("click", () => {
  if (!conversion) return;
  downloadBlob(new Blob([JSON.stringify(conversion.project, null, 2)], { type: "application/json" }), `${sourceName}_project.json`);
});

updateSizeReadout();
