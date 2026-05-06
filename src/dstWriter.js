const DST_MAX_DELTA = 121;
const { readDst, DST_UNITS_PER_INCH } = require("./dstReader");
const { BrotherNQ1700EProfile } = require("./brotherProfile");

function encodeDelta(value) {
  const target = Math.round(value);
  const weights = [81, 27, 9, 3, 1];
  let best = [];
  let bestError = Infinity;
  function search(index, sum, picks) {
    if (index === weights.length) {
      const error = Math.abs(target - sum);
      if (error < bestError) {
        bestError = error;
        best = picks;
      }
      return;
    }
    for (const sign of [-1, 0, 1]) {
      search(index + 1, sum + weights[index] * sign, sign ? [...picks, [weights[index], sign]] : picks);
      if (bestError === 0) return;
    }
  }
  search(0, 0, []);
  if (bestError !== 0) throw new Error(`DST delta ${target} cannot be encoded exactly.`);
  return best;
}

function applyAxisBits(bytes, axis, value) {
  for (const [weight, sign] of encodeDelta(value)) {
    const positive = sign > 0;
    if (axis === "x") {
      if (weight === 1) bytes[0] |= positive ? 0x01 : 0x02;
      if (weight === 3) bytes[1] |= positive ? 0x01 : 0x02;
      if (weight === 9) bytes[0] |= positive ? 0x04 : 0x08;
      if (weight === 27) bytes[1] |= positive ? 0x04 : 0x08;
      if (weight === 81) bytes[2] |= positive ? 0x04 : 0x08;
    } else {
      if (weight === 1) bytes[0] |= positive ? 0x80 : 0x40;
      if (weight === 3) bytes[1] |= positive ? 0x80 : 0x40;
      if (weight === 9) bytes[0] |= positive ? 0x20 : 0x10;
      if (weight === 27) bytes[1] |= positive ? 0x20 : 0x10;
      if (weight === 81) bytes[2] |= positive ? 0x20 : 0x10;
    }
  }
}

function dstRecord(dx, dy, type = "stitch") {
  if (Math.abs(dx) > DST_MAX_DELTA || Math.abs(dy) > DST_MAX_DELTA) throw new Error("DST movement exceeds per-command range.");
  const bytes = [0, 0, 0x03];
  applyAxisBits(bytes, "x", dx);
  applyAxisBits(bytes, "y", dy);
  if (type === "jump" || type === "trim") bytes[2] |= 0x80;
  if (type === "stop") bytes[2] |= 0xc0;
  return bytes;
}

function splitRecord(dx, dy, type) {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / DST_MAX_DELTA));
  const records = [];
  let sentX = 0;
  let sentY = 0;
  for (let i = 1; i <= steps; i += 1) {
    const nextX = Math.round((dx * i) / steps);
    const nextY = Math.round((dy * i) / steps);
    const partX = nextX - sentX;
    const partY = nextY - sentY;
    records.push(dstRecord(partX, partY, type));
    sentX = nextX;
    sentY = nextY;
  }
  return records;
}

function makeHeader(project, recordCount, label = "DESIGN") {
  const xs = project.stitches.map((s) => Math.round(s.x * DST_UNITS_PER_INCH));
  const ys = project.stitches.map((s) => Math.round(s.y * DST_UNITS_PER_INCH));
  const minX = Math.min(0, ...xs);
  const maxX = Math.max(0, ...xs);
  const minY = Math.min(0, ...ys);
  const maxY = Math.max(0, ...ys);
  const safeLabel = label.toUpperCase().replace(/[^A-Z0-9_-]/g, "_").slice(0, 16) || "DESIGN";
  const lines = [
    `LA:${safeLabel}`,
    `ST:${String(recordCount).padStart(7, " ")}`,
    `CO:${String(project.metadata.stopCount).padStart(3, " ")}`,
    `+X:${String(Math.max(0, maxX)).padStart(5, " ")}`,
    `-X:${String(Math.max(0, -minX)).padStart(5, " ")}`,
    `+Y:${String(Math.max(0, maxY)).padStart(5, " ")}`,
    `-Y:${String(Math.max(0, -minY)).padStart(5, " ")}`,
    "AX:+00000",
    "AY:+00000",
    "MX:+00000",
    "MY:+00000",
    "PD:******"
  ];
  const text = `${lines.join("\r")}\r\x1a`;
  const header = Buffer.alloc(512, 0x20);
  header.write(text.slice(0, 512), 0, "ascii");
  return header;
}

function writeDst(project, label) {
  const records = [];
  let cursor = { x: 0, y: 0 };
  for (const stitch of project.stitches) {
    const dx = Math.round(stitch.x * DST_UNITS_PER_INCH) - Math.round(cursor.x * DST_UNITS_PER_INCH);
    const dy = Math.round(stitch.y * DST_UNITS_PER_INCH) - Math.round(cursor.y * DST_UNITS_PER_INCH);
    records.push(...splitRecord(dx, dy, stitch.type));
    cursor = stitch;
  }
  records.push([0x00, 0x00, 0xf3]);
  const header = makeHeader(project, records.length, label);
  const body = Buffer.from(records.flat());
  const file = Buffer.concat([header, body]);
  validateDst(file);
  return file;
}

function exportBrotherNQ1700E(project, label) {
  const hoopWidthMm = Number(project.hoop?.widthIn || 0) * 25.4;
  const hoopHeightMm = Number(project.hoop?.heightIn || 0) * 25.4;
  if (!Number.isFinite(hoopWidthMm) || !Number.isFinite(hoopHeightMm) || hoopWidthMm <= 0 || hoopHeightMm <= 0) {
    throw new Error("Brother DST export requires a valid hoop size.");
  }
  for (const stitch of project.stitches || []) {
    const xMm = stitch.x * 25.4;
    const yMm = stitch.y * 25.4;
    if (Math.abs(xMm) > hoopWidthMm / 2 + 0.5 || Math.abs(yMm) > hoopHeightMm / 2 + 0.5) {
      throw new Error("Brother DST export has stitches outside the selected hoop.");
    }
  }
  return writeDst(project, label);
}

function validateDst(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 515) throw new Error("DST export failed validation.");
  if (buffer.slice(0, 3).toString("ascii") !== "LA:") throw new Error("DST header is invalid.");
  if ((buffer.length - 512) % 3 !== 0) throw new Error("DST command records are invalid.");
  const end = buffer.slice(buffer.length - 3);
  if (end[0] !== 0x00 || end[1] !== 0x00 || end[2] !== 0xf3) throw new Error("DST end command is missing.");
  const decoded = readDst(buffer);
  if (!decoded.sawEnd) throw new Error("DST end command is missing.");
  if (decoded.corruptedRecords.length) throw new Error("DST command records are invalid.");
  return true;
}

module.exports = {
  BrotherNQ1700EProfile,
  exportBrotherNQ1700E,
  writeDst,
  validateDst,
  encodeDelta,
  splitRecord
};
