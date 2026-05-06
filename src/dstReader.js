const DST_UNITS_PER_INCH = 254;
const DST_UNITS_PER_MM = 10;

function decodeAxis(b0, b1, b2, axis) {
  if (axis === "x") {
    return (
      (b0 & 0x01 ? 1 : 0) - (b0 & 0x02 ? 1 : 0) +
      (b1 & 0x01 ? 3 : 0) - (b1 & 0x02 ? 3 : 0) +
      (b0 & 0x04 ? 9 : 0) - (b0 & 0x08 ? 9 : 0) +
      (b1 & 0x04 ? 27 : 0) - (b1 & 0x08 ? 27 : 0) +
      (b2 & 0x04 ? 81 : 0) - (b2 & 0x08 ? 81 : 0)
    );
  }
  return (
    (b0 & 0x80 ? 1 : 0) - (b0 & 0x40 ? 1 : 0) +
    (b1 & 0x80 ? 3 : 0) - (b1 & 0x40 ? 3 : 0) +
    (b0 & 0x20 ? 9 : 0) - (b0 & 0x10 ? 9 : 0) +
    (b1 & 0x20 ? 27 : 0) - (b1 & 0x10 ? 27 : 0) +
    (b2 & 0x20 ? 81 : 0) - (b2 & 0x10 ? 81 : 0)
  );
}

function recordType(b0, b1, b2) {
  if (b0 === 0x00 && b1 === 0x00 && b2 === 0xf3) return "end";
  if ((b2 & 0xc0) === 0xc0) return "stop";
  if ((b2 & 0x80) === 0x80) return "jump";
  return "stitch";
}

function parseHeader(buffer) {
  const text = buffer.slice(0, 512).toString("ascii");
  const readNumber = (key) => {
    const match = text.match(new RegExp(`${key}:\\s*([+-]?\\d+)`));
    return match ? Number(match[1]) : null;
  };
  return {
    raw: text,
    label: (text.match(/LA:([^\r\n]+)/)?.[1] || "").trim(),
    stitchRecords: readNumber("ST"),
    colorStops: readNumber("CO"),
    plusX: readNumber("\\+X"),
    minusX: readNumber("-X"),
    plusY: readNumber("\\+Y"),
    minusY: readNumber("-Y")
  };
}

function readDst(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error("DST reader expected a Buffer.");
  if (buffer.length < 515) throw new Error("DST file is too small.");
  if (buffer.slice(0, 3).toString("ascii") !== "LA:") throw new Error("DST header is missing.");
  if ((buffer.length - 512) % 3 !== 0) throw new Error("DST record section is not divisible into 3-byte commands.");
  const header = parseHeader(buffer);
  const records = [];
  const commands = [];
  const corruptedRecords = [];
  let x = 0;
  let y = 0;
  let colorIndex = 1;
  let sawEnd = false;
  for (let offset = 512; offset < buffer.length; offset += 3) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const b2 = buffer[offset + 2];
    const type = recordType(b0, b1, b2);
    if ((b2 & 0x03) !== 0x03) corruptedRecords.push({ offset, bytes: [b0, b1, b2], reason: "low control bits not set" });
    if (type === "end") {
      sawEnd = true;
      records.push({
        offset,
        bytes: [b0, b1, b2],
        type,
        command: "end",
        dx: 0,
        dy: 0,
        x,
        y,
        xIn: x / DST_UNITS_PER_INCH,
        yIn: y / DST_UNITS_PER_INCH,
        xMm: x / DST_UNITS_PER_MM,
        yMm: y / DST_UNITS_PER_MM,
        colorIndex
      });
      break;
    }
    const dx = decodeAxis(b0, b1, b2, "x");
    const dy = decodeAxis(b0, b1, b2, "y");
    x += dx;
    y += dy;
    const record = {
      offset,
      bytes: [b0, b1, b2],
      type,
      dx,
      dy,
      x,
      y,
      xIn: x / DST_UNITS_PER_INCH,
      yIn: y / DST_UNITS_PER_INCH,
      xMm: x / DST_UNITS_PER_MM,
      yMm: y / DST_UNITS_PER_MM,
      dxIn: dx / DST_UNITS_PER_INCH,
      dyIn: dy / DST_UNITS_PER_INCH,
      dxMm: dx / DST_UNITS_PER_MM,
      dyMm: dy / DST_UNITS_PER_MM,
      command: type,
      colorIndex
    };
    records.push(record);
    commands.push(record);
    if (type === "stop") colorIndex += 1;
  }
  const stitchList = commands.map((command) => ({
    xMm: command.xMm,
    yMm: command.yMm,
    command: command.type,
    colorIndex: command.colorIndex
  }));
  if (sawEnd) {
    const endRecord = records.findLast ? records.findLast((record) => record.type === "end") : [...records].reverse().find((record) => record.type === "end");
    if (endRecord) stitchList.push({
      xMm: endRecord.xMm,
      yMm: endRecord.yMm,
      command: "end",
      colorIndex: endRecord.colorIndex
    });
  }
  const boundsMm = stitchList
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
    header,
    records,
    commands,
    stitches: stitchList,
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
  DST_UNITS_PER_INCH,
  DST_UNITS_PER_MM,
  readDst,
  decodeAxis
};
