const { DST_UNITS_PER_INCH } = require("./dstReader");
const { readPes } = require("./pesReader");
const { BrotherNQ1700EProfile, safeUsbBaseName } = require("./brotherProfile");

const PEC_MAX_DELTA = 2047;
const PES_VERSION = "#PES0001";
const PEC_MAGIC = "#PEC0001";
const TRUNCATED_PES_V1_PEC_OFFSET = 0x16;

const BROTHER_PEC_THREADS = [
  { index: 1, code: "007", name: "Prussian Blue", hex: "#1a0a94" },
  { index: 2, code: "000", name: "Blue", hex: "#0f75ff" },
  { index: 3, code: "534", name: "Teal Green", hex: "#00934c" },
  { index: 5, code: "800", name: "Red", hex: "#ec0000" },
  { index: 11, code: "214", name: "Deep Gold", hex: "#e4a945" },
  { index: 13, code: "000", name: "Yellow", hex: "#ffe600" },
  { index: 20, code: "900", name: "Black", hex: "#000000" },
  { index: 23, code: "707", name: "Dark Gray", hex: "#626262" },
  { index: 29, code: "001", name: "White", hex: "#f0f0f0" },
  { index: 37, code: "000", name: "Leaf Green", hex: "#37a923" },
  { index: 43, code: "000", name: "Pink", hex: "#ff99d7" },
  { index: 54, code: "507", name: "Emerald Green", hex: "#228927" },
  { index: 57, code: "124", name: "Flesh Pink", hex: "#fea9dc" }
];

function rgbFromHex(hex = "#000000") {
  const value = hex.replace("#", "");
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16)
  ];
}

function distanceSq(a, b) {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

function closestBrotherThread(hex) {
  const rgb = rgbFromHex(hex);
  return BROTHER_PEC_THREADS
    .map((thread) => ({ ...thread, distance: distanceSq(rgb, rgbFromHex(thread.hex)) }))
    .sort((a, b) => a.distance - b.distance)[0] || BROTHER_PEC_THREADS[6];
}

function writeUInt24LE(value) {
  return Buffer.from([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff]);
}

function writeInt16LE(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), 0);
  return buffer;
}

function writeUInt16LE(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(value))), 0);
  return buffer;
}

function writeUInt16BE(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(Math.max(0, Math.min(65535, Math.round(value))), 0);
  return buffer;
}

class ByteWriter {
  constructor() {
    this.bytes = [];
  }

  get length() {
    return this.bytes.length;
  }

  writeBuffer(buffer) {
    for (const byte of buffer) this.bytes.push(byte);
  }

  writeString(value) {
    this.writeBuffer(Buffer.from(value, "utf8"));
  }

  writeUInt8(value) {
    this.bytes.push(value & 0xff);
  }

  writeInt16LE(value) {
    const buffer = Buffer.alloc(2);
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), 0);
    this.writeBuffer(buffer);
  }

  writeUInt16LE(value) {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16LE(value & 0xffff, 0);
    this.writeBuffer(buffer);
  }

  writeUInt32LE(value) {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value >>> 0, 0);
    this.writeBuffer(buffer);
  }

  writeFloatLE(value) {
    const buffer = Buffer.alloc(4);
    buffer.writeFloatLE(Number(value) || 0, 0);
    this.writeBuffer(buffer);
  }

  patchUInt16LE(offset, value) {
    this.bytes[offset] = value & 0xff;
    this.bytes[offset + 1] = (value >> 8) & 0xff;
  }

  patchUInt32LE(offset, value) {
    this.bytes[offset] = value & 0xff;
    this.bytes[offset + 1] = (value >> 8) & 0xff;
    this.bytes[offset + 2] = (value >> 16) & 0xff;
    this.bytes[offset + 3] = (value >> 24) & 0xff;
  }

  toBuffer() {
    return Buffer.from(this.bytes);
  }
}

function writePesString16(writer, value) {
  const text = String(value || "");
  writer.writeUInt16LE(text.length);
  writer.writeString(text);
}

function signed7(value) {
  const rounded = Math.round(value);
  if (rounded < -64 || rounded > 63) throw new Error("PEC short movement exceeds range.");
  return rounded & 0x7f;
}

function signed12(value) {
  const rounded = Math.round(value);
  if (rounded < -2048 || rounded > 2047) throw new Error("PEC long movement exceeds range.");
  return rounded & 0x0fff;
}

function encodeLongCoordinate(value, commandBits = 0) {
  const encoded = signed12(value);
  return [0x80 | commandBits | ((encoded >> 8) & 0x0f), encoded & 0xff];
}

function encodePecMove(dx, dy, type = "stitch") {
  const commandBits = type === "jump" || type === "trim" ? (type === "trim" ? 0x20 : 0x10) : 0;
  const useLong = commandBits || dx < -64 || dx > 63 || dy < -64 || dy > 63;
  if (!useLong) return [signed7(dx), signed7(dy)];
  return [
    ...encodeLongCoordinate(dx, commandBits),
    ...encodeLongCoordinate(dy, commandBits)
  ];
}

function splitPecMove(dx, dy, type) {
  const maxDelta = type === "stitch" ? 63 : 120;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / maxDelta));
  if (steps > Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / PEC_MAX_DELTA) + 80) {
    throw new Error("PES movement splitting failed.");
  }
  const records = [];
  let sentX = 0;
  let sentY = 0;
  for (let i = 1; i <= steps; i += 1) {
    const nextX = Math.round((dx * i) / steps);
    const nextY = Math.round((dy * i) / steps);
    records.push(...encodePecMove(nextX - sentX, nextY - sentY, type));
    sentX = nextX;
    sentY = nextY;
  }
  return records;
}

function pecColorByte(sequenceIndex) {
  return sequenceIndex % 2 === 0 ? 2 : 1;
}

function stitchBoundsUnits(project) {
  const points = (project.stitches || []).filter((stitch) => stitch.type !== "stop").map((stitch) => ({
    x: Math.round(stitch.x * DST_UNITS_PER_INCH),
    y: Math.round(stitch.y * DST_UNITS_PER_INCH)
  }));
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    minX: Math.min(0, ...xs),
    maxX: Math.max(0, ...xs),
    minY: Math.min(0, ...ys),
    maxY: Math.max(0, ...ys),
    width: Math.max(1, Math.max(0, ...xs) - Math.min(0, ...xs)),
    height: Math.max(1, Math.max(0, ...ys) - Math.min(0, ...ys))
  };
}

function absoluteStitchUnits(project) {
  return (project.stitches || []).map((stitch) => ({
    x: Math.round(stitch.x * DST_UNITS_PER_INCH),
    y: Math.round(stitch.y * DST_UNITS_PER_INCH),
    type: stitch.type,
    threadIndex: stitch.threadIndex || 1
  }));
}

function pecPaletteIndexes(project) {
  const sequence = project.sequence?.length ? project.sequence : project.threads.map((thread, index) => ({ threadIndex: index + 1, hex: thread.hex }));
  return sequence.slice(0, 64).map((item) => {
    const thread = project.threads[item.threadIndex - 1] || item;
    return Math.max(0, Math.min(63, closestBrotherThread(thread.hex || item.hex).index - 1));
  });
}

function buildPecStitches(project) {
  const bytes = [];
  let cursor = { x: 0, y: 0 };
  let stopIndex = 0;
  for (const stitch of project.stitches || []) {
    if (stitch.type === "stop") {
      bytes.push(0xfe, 0xb0, pecColorByte(stopIndex));
      stopIndex += 1;
      continue;
    }
    const dx = Math.round(stitch.x * DST_UNITS_PER_INCH) - Math.round(cursor.x * DST_UNITS_PER_INCH);
    const dy = Math.round(stitch.y * DST_UNITS_PER_INCH) - Math.round(cursor.y * DST_UNITS_PER_INCH);
    bytes.push(...splitPecMove(dx, dy, stitch.type === "trim" ? "trim" : stitch.type === "jump" ? "jump" : "stitch"));
    cursor = stitch;
  }
  bytes.push(0xff);
  return Buffer.from(bytes);
}

function colorCodeForThread(project, threadIndex) {
  const thread = project.threads?.[Math.max(0, (threadIndex || 1) - 1)] || project.threads?.[0] || { hex: "#000000" };
  return Math.max(0, Math.min(63, closestBrotherThread(thread.hex).index - 1));
}

function pesSegments(project) {
  const commands = absoluteStitchUnits(project);
  const segments = [];
  let previous = { x: 0, y: 0, threadIndex: 1 };
  let active = null;
  let currentThreadIndex = project.sequence?.[0]?.threadIndex || project.stitches?.find((stitch) => stitch.threadIndex)?.threadIndex || 1;

  const flush = () => {
    if (active && active.points.length) segments.push(active);
    active = null;
  };

  for (const command of commands) {
    if (command.type === "stop") {
      flush();
      currentThreadIndex = command.threadIndex || currentThreadIndex + 1;
      previous = { ...previous, threadIndex: currentThreadIndex };
      continue;
    }
    const colorCode = colorCodeForThread(project, command.threadIndex || currentThreadIndex);
    if (command.type === "jump" || command.type === "trim") {
      flush();
      segments.push({
        flag: 1,
        colorCode,
        points: [
          { x: previous.x, y: previous.y },
          { x: command.x, y: command.y }
        ]
      });
      previous = command;
      continue;
    }
    if (!active || active.flag !== 0 || active.colorCode !== colorCode) {
      flush();
      active = { flag: 0, colorCode, points: [] };
      if (previous.x !== command.x || previous.y !== command.y) active.points.push({ x: previous.x, y: previous.y });
    }
    active.points.push({ x: command.x, y: command.y });
    previous = command;
  }
  flush();
  return segments.filter((segment) => segment.points.length >= 2);
}

function buildPesBlocksV1(project) {
  const bounds = stitchBoundsUnits(project);
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const left = bounds.minX - cx;
  const top = bounds.minY - cy;
  const right = bounds.maxX - cx;
  const bottom = bounds.maxY - cy;
  const width = right - left;
  const height = bottom - top;
  const hoopWidth = 1300;
  const hoopHeight = 1800;
  const transX = 350 + hoopWidth / 2 - width / 2;
  const transY = 100 + height + hoopHeight / 2 - height / 2;
  const adjustX = bounds.minX;
  const adjustY = bounds.maxY;
  const writer = new ByteWriter();

  writePesString16(writer, "CEmbOne");
  for (let i = 0; i < 8; i += 1) writer.writeInt16LE(0);
  writer.writeFloatLE(1);
  writer.writeFloatLE(0);
  writer.writeFloatLE(0);
  writer.writeFloatLE(1);
  writer.writeFloatLE(transX);
  writer.writeFloatLE(transY);
  writer.writeInt16LE(1);
  writer.writeInt16LE(0);
  writer.writeInt16LE(0);
  writer.writeInt16LE(width);
  writer.writeInt16LE(height);
  writer.writeBuffer(Buffer.alloc(8, 0));
  const sectionCountOffset = writer.length;
  writer.writeUInt16LE(0);
  writer.writeUInt16LE(0xffff);
  writer.writeUInt16LE(0x0000);
  writePesString16(writer, "CSewSeg");

  let section = 0;
  const colorLog = [];
  let previousColorCode = -1;
  let wroteSection = false;
  for (const segment of pesSegments(project)) {
    if (wroteSection) writer.writeUInt16LE(0x8003);
    if (previousColorCode !== segment.colorCode) {
      colorLog.push({ section, colorCode: segment.colorCode });
      previousColorCode = segment.colorCode;
    }
    writer.writeInt16LE(segment.flag);
    writer.writeInt16LE(segment.colorCode);
    writer.writeInt16LE(segment.points.length);
    for (const point of segment.points) {
      writer.writeInt16LE(point.x - adjustX);
      writer.writeInt16LE(point.y - adjustY);
    }
    section += 1;
    wroteSection = true;
  }
  writer.writeUInt16LE(colorLog.length);
  for (const item of colorLog) {
    writer.writeUInt16LE(item.section);
    writer.writeUInt16LE(item.colorCode);
  }
  writer.patchUInt16LE(sectionCountOffset, section);
  writer.writeUInt16LE(0x0000);
  writer.writeUInt16LE(0x0000);
  return writer.toBuffer();
}

function buildPecHeader(project, label, stitchData) {
  const palette = pecPaletteIndexes(project);
  const colorCountMinusOne = Math.max(0, palette.length - 1);
  const labelBuffer = Buffer.alloc(16, 0x20);
  labelBuffer.write(safeUsbBaseName(label).toUpperCase().slice(0, 16), 0, "ascii");
  const first = Buffer.alloc(512, 0x20);
  let offset = 0;
  first.write("LA:", offset, "ascii");
  offset += 3;
  labelBuffer.copy(first, offset);
  offset += labelBuffer.length;
  first[offset++] = 0x0d;
  first.fill(0x20, offset, offset + 12);
  offset += 12;
  first[offset++] = 0xff;
  first[offset++] = 0x00;
  first[offset++] = 0x06;
  first[offset++] = 0x26;
  first.fill(0x20, offset, offset + 12);
  offset += 12;
  first[offset++] = colorCountMinusOne;
  for (const index of palette) first[offset++] = index;

  const bounds = stitchBoundsUnits(project);
  const stitchBlockLength = 20 + stitchData.length;
  const second = Buffer.concat([
    Buffer.from([0x00, 0x00]),
    writeUInt24LE(stitchBlockLength),
    Buffer.from([0x31, 0xff, 0xf0]),
    writeInt16LE(bounds.width),
    writeInt16LE(bounds.height),
    writeUInt16LE(0x01e0),
    writeUInt16LE(0x01b0),
    writeUInt16BE(0x9000 - bounds.minX),
    writeUInt16BE(0x9000 - bounds.minY)
  ]);
  return Buffer.concat([Buffer.from(PEC_MAGIC, "ascii"), first, second]);
}

function blankPecGraphics(colorCount) {
  const thumbnailBytes = 6 * 38;
  return Buffer.alloc(thumbnailBytes * Math.max(1, colorCount + 1), 0x00);
}

function writePes(project, label = "design") {
  if (!project?.stitches?.length) throw new Error("PES export requires stitches.");
  const stitchData = buildPecStitches(project);
  const pecHeader = buildPecHeader(project, label, stitchData);
  const graphics = blankPecGraphics(project.sequence?.length || project.threads?.length || 1);
  const writer = new ByteWriter();
  writer.writeString(PES_VERSION);
  writer.writeUInt32LE(TRUNCATED_PES_V1_PEC_OFFSET);
  writer.writeBuffer(Buffer.alloc(TRUNCATED_PES_V1_PEC_OFFSET - writer.length, 0));
  writer.writeBuffer(pecHeader);
  writer.writeBuffer(stitchData);
  writer.writeBuffer(graphics);
  const file = writer.toBuffer();
  validatePes(file);
  return file;
}

function writePesIfSupported(project, label = "design") {
  return writePes(project, label);
}

function validatePes(buffer) {
  const decoded = readPes(buffer);
  if (!decoded.header.version.startsWith("#PES")) throw new Error("PES header is invalid.");
  if (decoded.header.pecMagic !== PEC_MAGIC) throw new Error("PES Brother PEC section is missing.");
  if (!decoded.sawEnd) throw new Error("PES end command is missing.");
  if (!decoded.commands.some((command) => command.type === "stitch")) throw new Error("PES contains no stitch commands.");
  return true;
}

module.exports = {
  BROTHER_PEC_THREADS,
  BrotherNQ1700EProfile,
  PEC_MAGIC,
  PES_VERSION,
  closestBrotherThread,
  encodePecMove,
  splitPecMove,
  validatePes,
  writePes,
  writePesIfSupported,
  pesSupported: true
};
