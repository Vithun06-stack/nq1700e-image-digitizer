const { brotherUsbReadme, safeUsbFilename } = require("./brotherProfile");

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

function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function writeLocalHeader(name, data, date) {
  const nameBuffer = Buffer.from(name, "utf8");
  const { time, day } = dosDateTime(date);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(day, 12);
  header.writeUInt32LE(crc32(data), 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBuffer.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBuffer, data]);
}

function writeCentralHeader(name, data, offset, date) {
  const nameBuffer = Buffer.from(name, "utf8");
  const { time, day } = dosDateTime(date);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(time, 12);
  header.writeUInt16LE(day, 14);
  header.writeUInt32LE(crc32(data), 16);
  header.writeUInt32LE(data.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(nameBuffer.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, nameBuffer]);
}

function createZip(entries) {
  const now = new Date();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), "utf8");
    const local = writeLocalHeader(entry.name, data, now);
    localParts.push(local);
    centralParts.push(writeCentralHeader(entry.name, data, offset, now));
    offset += local.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, central, end]);
}

function createBrotherUsbPackage({ pes, png, baseName = "design" }) {
  if (!Buffer.isBuffer(pes) || !pes.length) throw new Error("USB package requires a PES file.");
  if (!Buffer.isBuffer(png) || !png.length) throw new Error("USB package requires a PNG preview.");
  const pesFilename = safeUsbFilename(baseName, "pes");
  const pngFilename = safeUsbFilename(`${baseName}_preview`, "png");
  return {
    filename: safeUsbFilename(`${baseName}_brother_usb_package`, "zip"),
    pesFilename,
    pngFilename,
    readmeFilename: "README.txt",
    buffer: createZip([
      { name: pesFilename, data: pes },
      { name: pngFilename, data: png },
      { name: "README.txt", data: brotherUsbReadme(pesFilename) }
    ])
  };
}

module.exports = {
  createBrotherUsbPackage,
  createZip
};
