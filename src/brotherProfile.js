const BrotherNQ1700EProfile = {
  machine: "Brother Innov-is NQ1700E",
  primaryFormat: "PES",
  fallbackFormat: "DST",
  allowedFormats: ["PES", "DST", "PHC", "PEN"],
  recommendedFormat: "PES",
  defaultHoop: { widthIn: 5, heightIn: 7 },
  maxHoop: { widthIn: 6, heightIn: 10 },
  dstUnit: "0.1mm",
  origin: "centered",
  usb: {
    rootDirectory: true,
    oneDesignRecommended: true,
    maxFilenameStemLength: 16,
    safeFilenamePattern: /^[A-Za-z0-9_-]+$/,
    instructions: [
      "Copy the .pes file to the root directory of the USB drive.",
      "Do not place it inside a folder.",
      "Use a simple file name.",
      "Insert USB into the Brother machine.",
      "Press the USB pattern retrieval button.",
      "Select the design.",
      "Check size and orientation before stitching."
    ]
  }
};

function safeUsbBaseName(name = "design") {
  const cleaned = String(name)
    .replace(/\.[^.]+$/, "")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, BrotherNQ1700EProfile.usb.maxFilenameStemLength);
  return cleaned || "design_001";
}

function safeUsbFilename(name = "design", extension = "pes") {
  return `${safeUsbBaseName(name)}.${String(extension).replace(/^\./, "").toLowerCase()}`;
}

function brotherUsbReadme(pesFilename) {
  return [
    "Brother Innov-is NQ1700E USB transfer",
    "",
    `Recommended embroidery file: ${pesFilename}`,
    "",
    "1. Copy the .pes file to the root directory of the USB drive.",
    "2. Do not place it inside a folder.",
    "3. Use a simple file name with letters, numbers, dash, or underscore only.",
    "4. Keep only a small number of designs on the USB drive.",
    "5. If the machine says \"Reduce the number of patterns\", remove extra designs from the USB.",
    "6. Insert USB into the Brother machine.",
    "7. Press the USB pattern retrieval button.",
    "8. Select the design.",
    "9. Check size and orientation before stitching."
  ].join("\r\n");
}

module.exports = {
  BrotherNQ1700EProfile,
  brotherUsbReadme,
  safeUsbBaseName,
  safeUsbFilename
};
