const zlib = require("zlib");

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16)
  ];
}

function svgPoint(project, x, y, scale) {
  const sourceWidth = Math.max(1, project.metadata.sourceWidth || project.metadata.sourcePixelWidth || 1);
  const sourceHeight = Math.max(1, project.metadata.sourceHeight || project.metadata.sourcePixelHeight || 1);
  const bounds = project.metadata.foregroundBounds || { minX: 0, minY: 0, bboxWidth: sourceWidth, bboxHeight: sourceHeight };
  const stitchX = ((x - bounds.minX) / Math.max(1, bounds.bboxWidth - 1)) * project.metadata.widthIn - project.metadata.widthIn / 2;
  const stitchY = project.metadata.heightIn / 2 - ((y - bounds.minY) / Math.max(1, bounds.bboxHeight - 1)) * project.metadata.heightIn;
  return {
    x: (stitchX + project.hoop.widthIn / 2) * scale,
    y: (project.hoop.heightIn / 2 - stitchY) * scale
  };
}

function regionRuns(object, sourceWidth) {
  const cells = new Set(object.region.cells);
  const runs = [];
  for (let y = object.region.minY; y <= object.region.maxY; y += 1) {
    let start = -1;
    for (let x = object.region.minX; x <= object.region.maxX; x += 1) {
      const has = cells.has(y * sourceWidth + x);
      if (has && start === -1) start = x;
      if ((!has || x === object.region.maxX) && start !== -1) {
        runs.push({ x1: start, x2: has && x === object.region.maxX ? x : x - 1, y });
        start = -1;
      }
    }
  }
  return runs;
}

function objectPreviewPriority(object) {
  if (object.sourceType === "swoosh") return 10;
  if (["ReconstructedTextObject", "TextObject", "SatinBorderObject", "OutlineDominantTextObject"].includes(object.className)) return 20;
  if (object.sourceType === "character") return 30;
  return 40;
}

function renderObjectPreview(project, scale) {
  const sourceWidth = Math.max(1, project.metadata.sourceWidth || project.metadata.sourcePixelWidth || 1);
  const objects = [...(project.objects || [])].sort((a, b) => objectPreviewPriority(a) - objectPreviewPriority(b) || a.bounds.minY - b.bounds.minY || a.bounds.minX - b.bounds.minX);
  const defs = [];
  const groups = [];
  objects.forEach((object, index) => {
    const runs = regionRuns(object, sourceWidth);
    if (!runs.length) return;
    const clipId = `objclip-${index + 1}`;
    const rects = runs.map((run) => {
      const p1 = svgPoint(project, run.x1, run.y, scale);
      const p2 = svgPoint(project, run.x2 + 1, run.y + 1, scale);
      return `<rect x="${Math.min(p1.x, p2.x).toFixed(1)}" y="${Math.min(p1.y, p2.y).toFixed(1)}" width="${Math.abs(p2.x - p1.x).toFixed(1)}" height="${Math.abs(p2.y - p1.y).toFixed(1)}"/>`;
    });
    defs.push(`<clipPath id="${clipId}">${rects.join("")}</clipPath>`);
    const thread = project.threads[object.threadIndex - 1] || { hex: object.region.threadHex || "#222222" };
    const bboxA = svgPoint(project, object.region.minX, object.region.minY, scale);
    const bboxB = svgPoint(project, object.region.maxX + 1, object.region.maxY + 1, scale);
    const minX = Math.min(bboxA.x, bboxB.x);
    const maxX = Math.max(bboxA.x, bboxB.x);
    const minY = Math.min(bboxA.y, bboxB.y);
    const maxY = Math.max(bboxA.y, bboxB.y);
    const fillOpacity = object.className === "SatinBorderObject" ? 0.96 : 0.78;
    const shape = `<g clip-path="url(#${clipId})"><rect x="${minX.toFixed(1)}" y="${minY.toFixed(1)}" width="${(maxX - minX).toFixed(1)}" height="${(maxY - minY).toFixed(1)}" fill="${thread.hex}" fill-opacity="${fillOpacity}"/></g>`;
    const angle = object.strategy?.stitchAngleDeg || (object.sourceType === "swoosh" ? 24 : 12);
    const spacing = object.className === "SatinBorderObject" ? 8 : 13;
    const texture = [];
    for (let y = minY - (maxX - minX); y <= maxY + (maxX - minX); y += spacing) {
      texture.push(`<path d="M ${(minX - 20).toFixed(1)} ${y.toFixed(1)} L ${(maxX + 20).toFixed(1)} ${(y + Math.tan((angle * Math.PI) / 180) * (maxX - minX)).toFixed(1)}" stroke="${thread.hex}" stroke-width="${object.className === "SatinBorderObject" ? 3.4 : 1.6}" stroke-opacity="${object.className === "SatinBorderObject" ? 0.62 : 0.38}" fill="none" stroke-linecap="round"/>`);
    }
    groups.push(`<g data-object="${object.className}" data-thread="${object.threadIndex}">
      ${shape}
      <g clip-path="url(#${clipId})">${texture.join("\n      ")}</g>
    </g>`);
  });
  return { defs, groups };
}

function renderJumpPreview(project, scale) {
  let cursor = { x: 0, y: 0 };
  const paths = [];
  for (const command of project.stitches) {
    if (command.type === "stop" || command.type === "trim") {
      cursor = command;
      continue;
    }
    if (command.type !== "jump") {
      cursor = command;
      continue;
    }
    const x1 = (cursor.x + project.hoop.widthIn / 2) * scale;
    const y1 = (project.hoop.heightIn / 2 - cursor.y) * scale;
    const x2 = (command.x + project.hoop.widthIn / 2) * scale;
    const y2 = (project.hoop.heightIn / 2 - command.y) * scale;
    paths.push(`<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}" stroke="${command.threadHex}" stroke-width="1" fill="none" stroke-opacity="0.12" stroke-dasharray="6 8"/>`);
    cursor = command;
  }
  return paths;
}

function renderSvgPreview(project, options = {}) {
  const scale = 254;
  const width = Math.round(project.hoop.widthIn * scale);
  const height = Math.round(project.hoop.heightIn * scale);
  const showJumps = options.showJumps === true;
  const objectPreview = renderObjectPreview(project, scale);
  const jumpPaths = showJumps ? renderJumpPreview(project, scale) : [];

  return `<svg xmlns="http://www.w3.org/2000/svg" data-preview-source="internal-stitch-plan" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>${objectPreview.defs.join("\n  ")}</defs>
  ${objectPreview.groups.join("\n  ")}
  ${jumpPaths.join("\n  ")}
</svg>`;
}

function colorForSequence(project, sequenceIndex) {
  const item = project.sequence?.[Math.min(sequenceIndex, Math.max(0, (project.sequence || []).length - 1))];
  return item?.hex || project.threads?.[0]?.hex || "#222222";
}

function renderDstSvgPreview(project, decodedDst, options = {}) {
  const scale = 254;
  const width = Math.round(project.hoop.widthIn * scale);
  const height = Math.round(project.hoop.heightIn * scale);
  const showJumps = options.showJumps === true;
  const previewSource = options.previewSource || "decoded-dst-bytes";
  const stitchPaths = [];
  const jumpPaths = [];
  let cursor = { xIn: 0, yIn: 0 };
  let sequenceIndex = 0;
  const commands = decodedDst?.commands || [];
  for (const command of commands) {
    if (command.type === "stop") {
      cursor = command;
      sequenceIndex += 1;
      continue;
    }
    const x1 = (cursor.xIn + project.hoop.widthIn / 2) * scale;
    const y1 = (project.hoop.heightIn / 2 - cursor.yIn) * scale;
    const x2 = (command.xIn + project.hoop.widthIn / 2) * scale;
    const y2 = (project.hoop.heightIn / 2 - command.yIn) * scale;
    if (command.type === "stitch") {
      stitchPaths.push(`<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}" stroke="${colorForSequence(project, sequenceIndex)}" stroke-width="1.7" stroke-opacity="0.78" fill="none" stroke-linecap="round"/>`);
    } else if (showJumps && command.type === "jump") {
      jumpPaths.push(`<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}" stroke="${colorForSequence(project, sequenceIndex)}" stroke-width="1" fill="none" stroke-opacity="0.12" stroke-dasharray="6 8"/>`);
    }
    cursor = command;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" data-preview-source="${previewSource}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  ${stitchPaths.join("\n  ")}
  ${jumpPaths.join("\n  ")}
</svg>`;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function setPixel(buffer, width, height, x, y, rgb, alpha = 255) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const i = (y * width + x) * 4;
  buffer[i] = rgb[0];
  buffer[i + 1] = rgb[1];
  buffer[i + 2] = rgb[2];
  buffer[i + 3] = alpha;
}

function drawLine(buffer, width, height, x0, y0, x1, y1, rgb, alpha = 255) {
  let dx = Math.abs(x1 - x0);
  let sx = x0 < x1 ? 1 : -1;
  let dy = -Math.abs(y1 - y0);
  let sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  while (true) {
    setPixel(buffer, width, height, x0, y0, rgb, alpha);
    setPixel(buffer, width, height, x0 + 1, y0, rgb, alpha);
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

function pngPoint(project, width, height, x, y, scale) {
  const sourceWidth = Math.max(1, project.metadata.sourceWidth || 1);
  const sourceHeight = Math.max(1, project.metadata.sourceHeight || 1);
  const bounds = project.metadata.foregroundBounds || { minX: 0, minY: 0, bboxWidth: sourceWidth, bboxHeight: sourceHeight };
  const stitchX = ((x - bounds.minX) / Math.max(1, bounds.bboxWidth - 1)) * project.metadata.widthIn - project.metadata.widthIn / 2;
  const stitchY = project.metadata.heightIn / 2 - ((y - bounds.minY) / Math.max(1, bounds.bboxHeight - 1)) * project.metadata.heightIn;
  return {
    x: Math.round(width / 2 + stitchX * scale),
    y: Math.round(height / 2 - stitchY * scale)
  };
}

function fillRect(buffer, width, height, x1, y1, x2, y2, rgb, alpha = 255) {
  const minX = Math.max(0, Math.min(x1, x2));
  const maxX = Math.min(width - 1, Math.max(x1, x2));
  const minY = Math.max(0, Math.min(y1, y2));
  const maxY = Math.min(height - 1, Math.max(y1, y2));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) setPixel(buffer, width, height, x, y, rgb, alpha);
  }
}

function renderPngPreview(project) {
  const width = 900;
  const height = 900;
  const pixels = Buffer.alloc(width * height * 4, 0);

  const scale = Math.min(width / project.hoop.widthIn, height / project.hoop.heightIn) * 0.94;
  const cx = width / 2;
  const cy = height / 2;
  const sourceWidth = Math.max(1, project.metadata.sourceWidth || 1);
  const objects = [...(project.objects || [])].sort((a, b) => objectPreviewPriority(a) - objectPreviewPriority(b) || a.bounds.minY - b.bounds.minY || a.bounds.minX - b.bounds.minX);
  for (const object of objects) {
    const thread = project.threads[object.threadIndex - 1];
    if (!thread) continue;
    const rgb = hexToRgb(thread.hex);
    const runs = regionRuns(object, sourceWidth);
    for (const run of runs) {
      const p1 = pngPoint(project, width, height, run.x1, run.y, scale);
      const p2 = pngPoint(project, width, height, run.x2 + 1, run.y + 1, scale);
      fillRect(pixels, width, height, p1.x, p1.y, p2.x, p2.y, rgb);
    }
    const spacing = object.className === "SatinBorderObject" ? 8 : 14;
    for (const run of runs.filter((_, index) => index % spacing === 0)) {
      const p1 = pngPoint(project, width, height, run.x1, run.y, scale);
      const p2 = pngPoint(project, width, height, run.x2 + 1, run.y + 1, scale);
      drawLine(pixels, width, height, p1.x, p1.y, p2.x, p2.y, rgb, 230);
    }
  }

  const rawRows = [];
  for (let y = 0; y < height; y += 1) {
    rawRows.push(Buffer.from([0]));
    rawRows.push(pixels.slice(y * width * 4, (y + 1) * width * 4));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(Buffer.concat(rawRows))),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function renderDstPngPreview(project, decodedDst) {
  const width = 900;
  const height = 900;
  const pixels = Buffer.alloc(width * height * 4, 0);
  const scale = Math.min(width / project.hoop.widthIn, height / project.hoop.heightIn) * 0.94;
  let cursor = { xIn: 0, yIn: 0 };
  let sequenceIndex = 0;
  for (const command of decodedDst?.commands || []) {
    if (command.type === "stop") {
      cursor = command;
      sequenceIndex += 1;
      continue;
    }
    if (command.type !== "stitch") {
      cursor = command;
      continue;
    }
    const rgb = hexToRgb(colorForSequence(project, sequenceIndex));
    const x1 = Math.round(width / 2 + cursor.xIn * scale);
    const y1 = Math.round(height / 2 - cursor.yIn * scale);
    const x2 = Math.round(width / 2 + command.xIn * scale);
    const y2 = Math.round(height / 2 - command.yIn * scale);
    drawLine(pixels, width, height, x1, y1, x2, y2, rgb, 235);
    cursor = command;
  }
  const rawRows = [];
  for (let y = 0; y < height; y += 1) {
    rawRows.push(Buffer.from([0]));
    rawRows.push(pixels.slice(y * width * 4, (y + 1) * width * 4));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(Buffer.concat(rawRows))),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

module.exports = {
  renderSvgPreview,
  renderDstSvgPreview,
  renderPngPreview,
  renderDstPngPreview
};
