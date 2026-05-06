const { DST_UNITS_PER_INCH } = require("./dstReader");

const PEC_MAGIC = "#PEC0001";

function signed7(byte) {
  const value = byte & 0x7f;
  return value & 0x40 ? value - 0x80 : value;
}

function signed12(value) {
  const raw = value & 0x0fff;
  return raw & 0x0800 ? raw - 0x1000 : raw;
}

function readPecCoordinate(buffer, offset) {
  const first = buffer[offset];
  if ((first & 0x80) === 0) {
    return {
      value: signed7(first),
      commandBits: 0,
      nextOffset: offset + 1
    };
  }
  if (offset + 1 >= buffer.length) throw new Error("PES/PEC coordinate is truncated.");
  const second = buffer[offset + 1];
  return {
    value: signed12(((first & 0x0f) << 8) | second),
    commandBits: first & 0x70,
    nextOffset: offset + 2
  };
}

function parsePesHeader(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error("PES reader expected a Buffer.");
  if (buffer.length < 16) throw new Error("PES file is too small.");
  const version = buffer.slice(0, 8).toString("ascii");
  if (!version.startsWith("#PES")) throw new Error("PES header is missing.");
  const pecOffset = buffer.readUInt32LE(8);
  if (pecOffset < 12 || pecOffset >= buffer.length) throw new Error("PES PEC offset is invalid.");
  const pecMagic = buffer.slice(pecOffset, pecOffset + 8).toString("ascii");
  const hasPecMagic = pecMagic === PEC_MAGIC;
  const pecHeaderOffset = hasPecMagic ? pecOffset + 8 : pecOffset;
  return { version, pecOffset, pecMagic: hasPecMagic ? pecMagic : "", hasPecMagic, pecHeaderOffset };
}

function parsePecLabel(buffer, pecHeaderOffset) {
  if (buffer.slice(pecHeaderOffset, pecHeaderOffset + 3).toString("ascii") !== "LA:") throw new Error("PES PEC label is missing.");
  return buffer.slice(pecHeaderOffset + 3, pecHeaderOffset + 19).toString("ascii").trim();
}

function readPes(buffer) {
  const header = parsePesHeader(buffer);
  const label = parsePecLabel(buffer, header.pecHeaderOffset);
  const secondHeaderOffset = header.pecHeaderOffset + 512;
  const stitchOffset = secondHeaderOffset + 20;
  if (stitchOffset >= buffer.length) throw new Error("PES stitch section is missing.");
  const commands = [];
  const stitches = [];
  const corruptedRecords = [];
  let x = 0;
  let y = 0;
  let colorIndex = 1;
  let sawEnd = false;
  for (let offset = stitchOffset; offset < buffer.length;) {
    const byte = buffer[offset];
    if (byte === 0xff) {
      sawEnd = true;
      stitches.push({ xMm: x / 10, yMm: y / 10, command: "end", colorIndex });
      break;
    }
    if (byte === 0xfe && buffer[offset + 1] === 0xb0) {
      const record = {
        offset,
        type: "stop",
        command: "stop",
        dx: 0,
        dy: 0,
        x,
        y,
        xIn: x / DST_UNITS_PER_INCH,
        yIn: y / DST_UNITS_PER_INCH,
        xMm: x / 10,
        yMm: y / 10,
        dxIn: 0,
        dyIn: 0,
        dxMm: 0,
        dyMm: 0,
        colorIndex,
        colorChangeByte: buffer[offset + 2]
      };
      commands.push(record);
      stitches.push({ xMm: record.xMm, yMm: record.yMm, command: "stop", colorIndex });
      colorIndex += 1;
      offset += 3;
      continue;
    }
    try {
      const xCoord = readPecCoordinate(buffer, offset);
      const yCoord = readPecCoordinate(buffer, xCoord.nextOffset);
      const commandBits = xCoord.commandBits || yCoord.commandBits;
      const type = commandBits & 0x20 ? "trim" : commandBits & 0x10 ? "jump" : "stitch";
      x += xCoord.value;
      y += yCoord.value;
      const record = {
        offset,
        type,
        command: type,
        dx: xCoord.value,
        dy: yCoord.value,
        x,
        y,
        xIn: x / DST_UNITS_PER_INCH,
        yIn: y / DST_UNITS_PER_INCH,
        xMm: x / 10,
        yMm: y / 10,
        dxIn: xCoord.value / DST_UNITS_PER_INCH,
        dyIn: yCoord.value / DST_UNITS_PER_INCH,
        dxMm: xCoord.value / 10,
        dyMm: yCoord.value / 10,
        colorIndex
      };
      commands.push(record);
      stitches.push({ xMm: record.xMm, yMm: record.yMm, command: type, colorIndex });
      offset = yCoord.nextOffset;
    } catch (error) {
      corruptedRecords.push({ offset, reason: error.message });
      break;
    }
  }
  const boundsMm = stitches
    .filter((stitch) => stitch.command !== "end")
    .reduce((bounds, stitch) => ({
      minX: Math.min(bounds.minX, stitch.xMm),
      maxX: Math.max(bounds.maxX, stitch.xMm),
      minY: Math.min(bounds.minY, stitch.yMm),
      maxY: Math.max(bounds.maxY, stitch.yMm)
    }), { minX: 0, maxX: 0, minY: 0, maxY: 0 });
  boundsMm.width = boundsMm.maxX - boundsMm.minX;
  boundsMm.height = boundsMm.maxY - boundsMm.minY;
  return {
    header: { ...header, label, secondHeaderOffset, stitchOffset },
    commands,
    stitches,
    boundsMm,
    stitchCount: commands.filter((command) => command.type === "stitch").length,
    stopCount: commands.filter((command) => command.type === "stop").length,
    corruptedRecords,
    sawEnd,
    unit: "0.1mm",
    unitsPerInch: DST_UNITS_PER_INCH
  };
}

module.exports = {
  PEC_MAGIC,
  readPes
};
