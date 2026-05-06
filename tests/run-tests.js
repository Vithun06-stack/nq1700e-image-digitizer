const assert = require("assert");
const { preprocessImage, quantizePalette, validateImageInput, visibleMask, connectedRegions } = require("../src/imagePreprocess");
const { createStitchProject } = require("../src/stitchPlanner");
const { exportBrotherNQ1700E, writeDst, validateDst, encodeDelta, splitRecord } = require("../src/dstWriter");
const { readDst } = require("../src/dstReader");
const { validateDstForProject } = require("../src/dstValidator");
const { writePes, validatePes, closestBrotherThread } = require("../src/pesWriter");
const { readPes } = require("../src/pesReader");
const { validatePesForProject } = require("../src/pesValidator");
const { safeUsbFilename } = require("../src/brotherProfile");
const { createBrotherUsbPackage } = require("../src/usbPackage");
const { renderSvgPreview, renderPngPreview } = require("../src/previewRenderer");
const { convertImageToEmbroidery } = require("../src/exportController");
const { validateSemanticStructure } = require("../src/semanticPreservation");

function rgbaImage(width, height, paint, fileName = "sample.png") {
  const rgba = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      rgba.push(...paint(x, y));
    }
  }
  return {
    fileName,
    fileType: "image/png",
    fileSize: width * height * 4,
    hoopWidthIn: 4,
    hoopHeightIn: 4,
    maxColors: 6,
    stitchDensity: 0.4,
    fillSpacingMm: 0.4,
    stitchLengthMm: 2.5,
    minLineWidthMm: 1,
    minRegionSize: undefined,
    removeTransparent: true,
    image: { width, height, rgba }
  };
}

function transparentTextImage() {
  return rgbaImage(40, 24, (x, y) => {
    const inBar = (x > 4 && x < 8 && y > 4 && y < 20) || (x > 8 && x < 18 && y > 4 && y < 8) || (x > 8 && x < 18 && y > 12 && y < 16);
    return inBar ? [0, 0, 0, 255] : [255, 255, 255, 0];
  }, "black_text.png");
}

function threeColorLogo() {
  return rgbaImage(36, 36, (x, y) => {
    if (x < 3 || y < 3 || x > 32 || y > 32) return [255, 255, 255, 255];
    if (x < 18 && y < 18) return [10, 110, 180, 255];
    if (x >= 18 && y < 18) return [220, 40, 40, 255];
    return [240, 190, 30, 255];
  }, "three_colour_logo.png");
}

function flowerIcon() {
  return rgbaImage(42, 42, (x, y) => {
    const dx = x - 21;
    const dy = y - 21;
    const center = dx * dx + dy * dy < 30;
    const petal = [[21, 10], [21, 32], [10, 21], [32, 21]].some(([px, py]) => (x - px) ** 2 + (y - py) ** 2 < 70);
    if (center) return [245, 190, 35, 255];
    if (petal) return [210, 45, 120, 255];
    return [255, 255, 255, 0];
  }, "flower_icon.png");
}

function smallCenteredFlowerCanvas() {
  return rgbaImage(180, 180, (x, y) => {
    const dx = x - 90;
    const dy = y - 90;
    const petal = [[90, 78], [90, 102], [78, 90], [102, 90]].some(([px, py]) => (x - px) ** 2 + (y - py) ** 2 < 58);
    const center = dx * dx + dy * dy < 22;
    if (center) return [245, 190, 35, 255];
    if (petal) return [210, 45, 120, 255];
    return [255, 255, 255, 0];
  }, "small_centered_flower.png");
}

function photoLikeImage() {
  return rgbaImage(42, 42, (x, y) => {
    const r = Math.round((x / 41) * 255);
    const g = Math.round((y / 41) * 255);
    const b = Math.round(((x + y) / 82) * 220);
    return [r, g, b, 255];
  }, "photo_like.png");
}

function thinLineDrawing() {
  return rgbaImage(42, 42, (x, y) => {
    const line = x === y || x === 41 - y || y === 21 || x === 21;
    return line ? [15, 15, 15, 255] : [255, 255, 255, 0];
  }, "thin_line_art.png");
}

function nikeLikeDesign() {
  return rgbaImage(72, 48, (x, y) => {
    const bg = [255, 255, 255, 255];
    const pink = [245, 75, 170, 255];
    const white = [252, 250, 250, 255];
    const black = [20, 20, 20, 255];
    const letterBoxes = [
      [5, 6, 18, 24],
      [20, 6, 33, 24],
      [35, 6, 48, 24],
      [50, 6, 64, 24]
    ];
    for (const [x1, y1, x2, y2] of letterBoxes) {
      if (x >= x1 && x <= x2 && y >= y1 && y <= y2) {
        const border = x - x1 < 2 || x2 - x < 2 || y - y1 < 2 || y2 - y < 2;
        return border ? pink : white;
      }
    }
    const swoosh = y > 30 && y < 38 && x > 8 && x < 64 && y > 39 - x * 0.14 && y < 43 - x * 0.08;
    return swoosh ? black : bg;
  }, "nike_stitch_outline_logo.png");
}

function nikeMissingTextDesign() {
  return rgbaImage(72, 48, (x, y) => {
    const bg = [255, 255, 255, 255];
    const blue = [80, 150, 220, 255];
    const dark = [20, 20, 20, 255];
    const mascot = (x - 36) ** 2 + (y - 21) ** 2 < 95;
    const eye = ((x - 31) ** 2 + (y - 18) ** 2 < 8) || ((x - 41) ** 2 + (y - 18) ** 2 < 8);
    const swoosh = y > 34 && y < 41 && x > 8 && x < 64 && y > 43 - x * 0.14 && y < 47 - x * 0.08;
    if (eye || swoosh) return dark;
    if (mascot) return blue;
    return bg;
  }, "nike_stitch_outline_logo.png");
}

function nikeStitchOverlayDesign() {
  return rgbaImage(84, 56, (x, y) => {
    const bg = [255, 255, 255, 255];
    const pink = [238, 112, 158, 255];
    const lightPink = [250, 174, 196, 255];
    const cream = [248, 222, 214, 255];
    const black = [20, 20, 20, 255];
    const letterBoxes = [
      [5, 8, 22, 29],
      [24, 8, 37, 29],
      [39, 8, 56, 29],
      [58, 8, 78, 29]
    ];
    for (const [x1, y1, x2, y2] of letterBoxes) {
      if (x >= x1 && x <= x2 && y >= y1 && y <= y2) {
        const border = x - x1 < 2 || x2 - x < 2 || y - y1 < 2 || y2 - y < 2;
        if (border) return pink;
      }
    }
    const body = (x - 33) ** 2 + (y - 19) ** 2 < 42;
    const head = (x - 37) ** 2 + (y - 17) ** 2 < 56;
    const earL = (x - 27) ** 2 + (y - 12) ** 2 < 24;
    const earR = (x - 46) ** 2 + (y - 11) ** 2 < 28;
    const face = (x - 38) ** 2 + (y - 18) ** 2 < 18;
    const eye = ((x - 35) ** 2 + (y - 16) ** 2 < 4) || ((x - 41) ** 2 + (y - 16) ** 2 < 4);
    const swoosh = y > 37 && y < 45 && x > 9 && x < 76 && y > 47 - x * 0.13 && y < 51 - x * 0.08;
    if (eye) return black;
    if (face) return cream;
    if (body || head || earL || earR) return lightPink;
    if (swoosh) return pink;
    return bg;
  }, "nike_stitch_overlay.png");
}

function nikeNContourDesign() {
  return rgbaImage(72, 48, (x, y) => {
    const bg = [255, 255, 255, 255];
    const pink = [245, 75, 170, 255];
    const black = [20, 20, 20, 255];
    const inN =
      (x >= 5 && x <= 8 && y >= 6 && y <= 24) ||
      (x >= 16 && x <= 19 && y >= 6 && y <= 24) ||
      (y >= 6 && y <= 24 && Math.abs(x - (6 + (y - 6) * 0.72)) <= 1.6);
    const iLetter = x >= 24 && x <= 27 && y >= 6 && y <= 24;
    const kLetter =
      (x >= 36 && x <= 39 && y >= 6 && y <= 24) ||
      (y >= 6 && y <= 15 && Math.abs(x - (39 + (15 - y) * 0.75)) <= 1.5) ||
      (y >= 15 && y <= 24 && Math.abs(x - (39 + (y - 15) * 0.75)) <= 1.5);
    const eLetter =
      (x >= 54 && x <= 57 && y >= 6 && y <= 24) ||
      (x >= 54 && x <= 66 && y >= 6 && y <= 9) ||
      (x >= 54 && x <= 64 && y >= 14 && y <= 16) ||
      (x >= 54 && x <= 66 && y >= 21 && y <= 24);
    const swoosh = y > 32 && y < 39 && x > 8 && x < 64 && y > 41 - x * 0.12 && y < 45 - x * 0.08;
    if (inN || iLetter || kLetter || eLetter) return pink;
    if (swoosh) return black;
    return bg;
  }, "nike_stitch_outline_logo.png");
}

function simpleBlackNikeLogo() {
  return rgbaImage(86, 48, (x, y) => {
    const bg = [255, 255, 255, 0];
    const black = [10, 10, 10, 255];
    const inN =
      (x >= 6 && x <= 9 && y >= 8 && y <= 27) ||
      (x >= 20 && x <= 23 && y >= 8 && y <= 27) ||
      (y >= 8 && y <= 27 && Math.abs(x - (8 + (y - 8) * 0.76)) <= 1.8);
    const iLetter = x >= 29 && x <= 33 && y >= 8 && y <= 27;
    const kLetter =
      (x >= 40 && x <= 44 && y >= 8 && y <= 27) ||
      (y >= 8 && y <= 17 && Math.abs(x - (44 + (17 - y) * 0.9)) <= 1.8) ||
      (y >= 17 && y <= 27 && Math.abs(x - (44 + (y - 17) * 0.85)) <= 1.8);
    const eLetter =
      (x >= 62 && x <= 66 && y >= 8 && y <= 27) ||
      (x >= 62 && x <= 80 && y >= 8 && y <= 11) ||
      (x >= 62 && x <= 77 && y >= 16 && y <= 19) ||
      (x >= 62 && x <= 80 && y >= 24 && y <= 27);
    const swoosh = y > 32 && y < 41 && x > 7 && x < 82 && y > 43 - x * 0.11 && y < 48 - x * 0.07;
    return inN || iLetter || kLetter || eLetter || swoosh ? black : bg;
  }, "simple_black_nike_logo.png");
}

function distanceToSegment(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSquared));
  const px = x1 + t * dx;
  const py = y1 + t * dy;
  return Math.hypot(x - px, y - py);
}

function cleanShoeOutlineIcon() {
  return rgbaImage(96, 60, (x, y) => {
    const segments = [
      [11, 42, 83, 42],
      [14, 38, 80, 38],
      [12, 28, 12, 42],
      [12, 28, 26, 24],
      [26, 24, 43, 14],
      [43, 14, 66, 22],
      [66, 22, 82, 34],
      [82, 34, 83, 42],
      [28, 25, 43, 38],
      [44, 20, 57, 36],
      [58, 25, 73, 33],
      [21, 45, 75, 45],
      [31, 31, 54, 25],
      [54, 25, 69, 29]
    ];
    const distance = Math.min(...segments.map(([x1, y1, x2, y2]) => distanceToSegment(x, y, x1, y1, x2, y2)));
    if (distance <= 1.15) return [8, 8, 8, 255];
    if (distance <= 2.05) return [112, 112, 112, 150];
    return [255, 255, 255, 0];
  }, "black_shoe_outline_icon.png");
}

function hondaLogoImage() {
  return rgbaImage(120, 54, (x, y) => {
    const black = [6, 6, 6, 255];
    const hMark =
      (x >= 8 && x <= 13 && y >= 8 && y <= 32) ||
      (x >= 29 && x <= 34 && y >= 8 && y <= 32) ||
      (x >= 8 && x <= 34 && y >= 18 && y <= 23);
    const textBars = [
      [45, 14, 49, 38], [53, 14, 69, 18], [53, 24, 68, 28], [53, 34, 69, 38],
      [75, 14, 79, 38], [83, 14, 99, 18], [83, 34, 99, 38],
      [104, 14, 108, 38], [112, 14, 116, 38]
    ].some(([x1, y1, x2, y2]) => x >= x1 && x <= x2 && y >= y1 && y <= y2);
    if (hMark || textBars) return black;
    return [255, 255, 255, 0];
  }, "honda_logo.png");
}

function kinectricsLogoImage() {
  return rgbaImage(140, 44, (x, y) => {
    const blue = [0, 113, 188, 255];
    const black = [8, 8, 8, 255];
    const mark = (x >= 8 && x <= 30 && y >= 12 && y <= 32) && (Math.abs((x - 19) - (y - 22)) < 8);
    const text = [
      [40, 12, 44, 32], [48, 12, 62, 16], [48, 21, 60, 25], [48, 28, 63, 32],
      [68, 12, 72, 32], [76, 12, 90, 16], [76, 28, 90, 32],
      [96, 12, 100, 32], [104, 12, 118, 16], [104, 21, 116, 25], [104, 28, 119, 32]
    ].some(([x1, y1, x2, y2]) => x >= x1 && x <= x2 && y >= y1 && y <= y2);
    if (mark) return blue;
    if (text) return black;
    return [255, 255, 255, 0];
  }, "kinectrics_logo.png");
}

function poohCharacterImage() {
  return rgbaImage(82, 70, (x, y) => {
    const yellow = [237, 181, 41, 255];
    const dark = [32, 22, 12, 255];
    const red = [180, 46, 35, 255];
    const head = (x - 40) ** 2 / 320 + (y - 25) ** 2 / 230 < 1;
    const body = (x - 42) ** 2 / 430 + (y - 47) ** 2 / 260 < 1;
    const ear = (x - 25) ** 2 + (y - 17) ** 2 < 58 || (x - 55) ** 2 + (y - 17) ** 2 < 58;
    const shirt = y >= 39 && y <= 52 && (x - 42) ** 2 / 390 + (y - 47) ** 2 / 180 < 1;
    const eyes = (x - 34) ** 2 + (y - 23) ** 2 < 5 || (x - 47) ** 2 + (y - 23) ** 2 < 5;
    const nose = (x - 41) ** 2 + (y - 30) ** 2 < 8;
    if (eyes || nose) return dark;
    if (shirt) return red;
    if (head || body || ear) return yellow;
    return [255, 255, 255, 0];
  }, "sleeping_pooh_character.png");
}

function bugsBunnyImage() {
  return rgbaImage(84, 80, (x, y) => {
    const grey = [158, 160, 164, 255];
    const cream = [238, 225, 210, 255];
    const black = [16, 16, 16, 255];
    const earL = (x - 30) ** 2 / 45 + (y - 18) ** 2 / 260 < 1;
    const earR = (x - 51) ** 2 / 45 + (y - 18) ** 2 / 260 < 1;
    const head = (x - 41) ** 2 / 340 + (y - 45) ** 2 / 300 < 1;
    const muzzle = (x - 41) ** 2 / 180 + (y - 53) ** 2 / 90 < 1;
    const eyes = (x - 35) ** 2 + (y - 39) ** 2 < 5 || (x - 47) ** 2 + (y - 39) ** 2 < 5;
    const nose = (x - 41) ** 2 + (y - 48) ** 2 < 7;
    if (eyes || nose) return black;
    if (muzzle) return cream;
    if (earL || earR || head) return grey;
    return [255, 255, 255, 0];
  }, "bugs_bunny_character.png");
}

function tigerCrestImage() {
  return rgbaImage(96, 96, (x, y) => {
    const orange = [224, 105, 31, 255];
    const black = [18, 18, 18, 255];
    const gold = [230, 174, 42, 255];
    const dx = x - 48;
    const dy = y - 48;
    const ring = Math.abs(Math.hypot(dx, dy) - 34) < 2;
    const ray = (Math.abs(dx) < 3 || Math.abs(dy) < 3 || Math.abs(dx - dy) < 3 || Math.abs(dx + dy) < 3) && Math.hypot(dx, dy) > 34 && Math.hypot(dx, dy) < 44;
    const face = dx * dx / 360 + dy * dy / 300 < 1;
    const stripes = face && ((x + y) % 13 < 3 || Math.abs(dx) < 3 || (x - y + 96) % 17 < 3);
    const eyes = (x - 39) ** 2 + (y - 43) ** 2 < 7 || (x - 57) ** 2 + (y - 43) ** 2 < 7;
    const mouth = y > 55 && y < 63 && Math.abs(dx) < 10;
    if (ring || stripes || eyes || mouth) return black;
    if (face) return orange;
    if (ray) return gold;
    return [255, 255, 255, 0];
  }, "tiger_crest.png");
}

function filledHeartImage() {
  return rgbaImage(96, 84, (x, y) => {
    const nx = (x - 48) / 31;
    const ny = (42 - y) / 31;
    const value = (nx * nx + ny * ny - 1) ** 3 - nx * nx * ny ** 3;
    return value <= 0 ? [41, 111, 212, 255] : [255, 255, 255, 0];
  }, "blue_heart_fill.png");
}

function letterOWithHoleImage() {
  return rgbaImage(86, 86, (x, y) => {
    const outer = (x - 43) ** 2 / 900 + (y - 43) ** 2 / 980 <= 1;
    const inner = (x - 43) ** 2 / 360 + (y - 43) ** 2 / 410 <= 1;
    return outer && !inner ? [10, 10, 10, 255] : [255, 255, 255, 0];
  }, "letter_o_with_hole.png");
}

function filledSwooshImage() {
  return rgbaImage(112, 64, (x, y) => {
    const lower = 48 - x * 0.18 + Math.sin(x / 17) * 2;
    const upper = 34 - x * 0.08 + Math.sin(x / 24) * 1.5;
    const tapered = x > 8 && x < 106 && y >= upper && y <= lower && y < 54 && y > 12;
    const tail = x < 30 && y > 38 && y < 57 - x * 0.25;
    return tapered || tail ? [225, 44, 107, 255] : [255, 255, 255, 0];
  }, "filled_swoosh.png");
}

function filledFlowerPetalImage() {
  return rgbaImage(88, 88, (x, y) => {
    const petal = (x - 44) ** 2 / 250 + (y - 38) ** 2 / 980 <= 1 && y < 76;
    const center = (x - 44) ** 2 + (y - 67) ** 2 < 60;
    if (center) return [233, 178, 38, 255];
    return petal ? [220, 54, 136, 255] : [255, 255, 255, 0];
  }, "filled_flower_petal.png");
}

function filledMascotBodyImage() {
  return rgbaImage(96, 92, (x, y) => {
    const blue = [88, 154, 220, 255];
    const cream = [245, 225, 202, 255];
    const black = [18, 18, 18, 255];
    const body = (x - 48) ** 2 / 640 + (y - 58) ** 2 / 520 <= 1;
    const head = (x - 48) ** 2 / 520 + (y - 32) ** 2 / 420 <= 1;
    const earL = (x - 24) ** 2 / 120 + (y - 24) ** 2 / 260 <= 1;
    const earR = (x - 72) ** 2 / 120 + (y - 24) ** 2 / 260 <= 1;
    const face = (x - 48) ** 2 / 260 + (y - 35) ** 2 / 170 <= 1;
    const eyes = (x - 40) ** 2 + (y - 31) ** 2 < 13 || (x - 56) ** 2 + (y - 31) ** 2 < 13;
    if (eyes) return black;
    if (face) return cream;
    if (body || head || earL || earR) return blue;
    return [255, 255, 255, 0];
  }, "filled_mascot_body.png");
}

function machineSafePattern(kind) {
  return rgbaImage(72, 72, (x, y) => {
    const black = [10, 10, 10, 255];
    const red = [220, 40, 40, 255];
    const gold = [230, 184, 38, 255];
    const blue = [40, 90, 190, 255];
    const green = [58, 145, 76, 255];
    if (kind === "square") {
      return x >= 18 && x <= 54 && y >= 18 && y <= 54 ? black : [255, 255, 255, 0];
    }
    if (kind === "circle") {
      return (x - 36) ** 2 + (y - 36) ** 2 <= 18 ** 2 ? black : [255, 255, 255, 0];
    }
    if (kind === "oval") {
      return (x - 36) ** 2 / 560 + (y - 36) ** 2 / 220 <= 1 ? blue : [255, 255, 255, 0];
    }
    if (kind === "three-color-circle") {
      const radius = Math.hypot(x - 36, y - 36);
      if (radius <= 11) return gold;
      if (radius <= 18) return red;
      if (radius <= 25) return blue;
      return [255, 255, 255, 0];
    }
    if (kind === "satin-border-rectangle") {
      const outer = x >= 15 && x <= 57 && y >= 18 && y <= 54;
      const inner = x >= 21 && x <= 51 && y >= 24 && y <= 48;
      return outer && !inner ? black : [255, 255, 255, 0];
    }
    if (kind === "satin-line") {
      return Math.abs(y - 36) <= 2 && x >= 10 && x <= 62 ? black : [255, 255, 255, 0];
    }
    if (kind === "running-line") {
      return Math.abs(x - y) <= 1 && x >= 12 && x <= 60 ? black : [255, 255, 255, 0];
    }
    const dx = x - 36;
    const dy = y - 36;
    const petal = [[36, 22], [36, 50], [22, 36], [50, 36]].some(([px, py]) => (x - px) ** 2 + (y - py) ** 2 < 88);
    const stem = x >= 34 && x <= 38 && y >= 45 && y <= 66;
    const leaf = (x - 45) ** 2 / 80 + (y - 54) ** 2 / 26 < 1;
    if (stem || leaf) return green;
    if (dx * dx + dy * dy < 36) return gold;
    if (petal) return red;
    return [255, 255, 255, 0];
  }, `${kind}_machine_safe.png`);
}

function stitchPixel(project, stitch) {
  const bounds = project.metadata.foregroundBounds || { minX: 0, minY: 0, bboxWidth: project.metadata.sourceWidth, bboxHeight: project.metadata.sourceHeight };
  return {
    x: Math.round(bounds.minX + ((stitch.x + project.metadata.widthIn / 2) / project.metadata.widthIn) * Math.max(1, bounds.bboxWidth - 1)),
    y: Math.round(bounds.minY + ((project.metadata.heightIn / 2 - stitch.y) / project.metadata.heightIn) * Math.max(1, bounds.bboxHeight - 1))
  };
}

function insideRegion(region, width, x, y, tolerance = 1) {
  const cells = new Set(region.cells);
  for (let dy = -tolerance; dy <= tolerance; dy += 1) {
    for (let dx = -tolerance; dx <= tolerance; dx += 1) {
      if (cells.has((y + dy) * width + x + dx)) return true;
    }
  }
  return false;
}

function projectFrom(input) {
  const preprocessed = preprocessImage(input);
  return createStitchProject(preprocessed, input);
}

function testUploadValidation() {
  assert.doesNotThrow(() => validateImageInput(threeColorLogo()));
  assert.throws(() => validateImageInput({ ...threeColorLogo(), fileType: "application/pdf" }), /Unsupported/);
  assert.throws(() => validateImageInput({ ...threeColorLogo(), fileSize: 20 * 1024 * 1024 }), /smaller than 10 MB/);
}

function testBackgroundRemoval() {
  const input = transparentTextImage();
  const mask = visibleMask(input.image, true, true);
  assert.ok(mask.some(Boolean));
  assert.ok(mask.filter(Boolean).length < input.image.width * input.image.height * 0.35);
}

function testPaletteReduction() {
  const input = photoLikeImage();
  input.maxColors = 4;
  const preprocessed = preprocessImage(input);
  assert.ok(preprocessed.threads.length <= 4);
}

function testSmallRegionRemoval() {
  const input = threeColorLogo();
  const p = (5 * input.image.width + 5) * 4;
  input.image.rgba[p] = 0;
  input.image.rgba[p + 1] = 255;
  input.image.rgba[p + 2] = 0;
  input.minRegionSize = 20;
  const preprocessed = preprocessImage(input);
  assert.ok(preprocessed.cleanup.removedTinyRegions >= 1);
}

function testSmoothContours() {
  const preprocessed = preprocessImage(flowerIcon());
  const regions = connectedRegions(preprocessed.colorMap, preprocessed.width, preprocessed.height);
  assert.ok(regions.length > 0);
  assert.ok(regions.every((region) => region.perimeter > 0));
}

function testStitchJsonCreation() {
  const project = projectFrom(threeColorLogo());
  assert.strictEqual(project.version, "1.0");
  assert.strictEqual(project.machineTarget, "Brother Innov-is NQ1700E");
  assert.ok(project.stitches.some((s) => s.type === "stitch"));
  assert.ok(project.stitches.some((s) => s.stitchKind === "fill" || s.stitchKind === "satin-border"));
  assert.ok(project.sequence.length >= 1);
}

function testStopInsertion() {
  const project = projectFrom(threeColorLogo());
  assert.ok(project.stitches.some((s) => s.type === "stop"));
  assert.strictEqual(project.metadata.stopCount, project.sequence.length - 1);
}

function testImageTypeDetection() {
  assert.match(preprocessImage(thinLineDrawing()).imageType, /outline vector icon|line art|text-heavy/);
  assert.match(preprocessImage(photoLikeImage()).imageType, /photo|complex illustration/);
}

function testDstGeneration() {
  for (let v = -121; v <= 121; v += 1) {
    const sum = encodeDelta(v).reduce((acc, [weight, sign]) => acc + weight * sign, 0);
    assert.strictEqual(sum, v);
  }
  const dst = writeDst(projectFrom(threeColorLogo()), "sample");
  assert.ok(dst.length > 515);
  assert.strictEqual(dst.slice(0, 3).toString("ascii"), "LA:");
  assert.doesNotThrow(() => validateDst(dst));
}

function testDstRoundTripMachineValidation() {
  const project = projectFrom(threeColorLogo());
  const dst = writeDst(project, "roundtrip");
  const decoded = readDst(dst);
  const validation = validateDstForProject(dst, project);
  assert.strictEqual(validation.passed, true, validation.failures.join("; "));
  assert.strictEqual(decoded.sawEnd, true);
  assert.ok(decoded.stitches.some((stitch) => stitch.command === "stitch" && Number.isFinite(stitch.xMm) && Number.isFinite(stitch.yMm)));
  assert.ok(decoded.boundsMm.width > 0);
  assert.strictEqual(validation.metrics.commandCounts.stitch, project.metadata.stitchCount);
  assert.strictEqual(validation.metrics.commandCounts.stop, project.metadata.stopCount);
  assert.deepStrictEqual(validation.metrics.colorSectionStitchCounts, project.sequence.map((item) => item.stitchCount));
  assert.strictEqual(validation.metrics.planMatch.passed, true);
}

function testDstMovementSplittingAndBrotherExport() {
  const records = splitRecord(300, -300, "jump");
  assert.ok(records.length > 1);
  const project = {
    hoop: { widthIn: 6, heightIn: 6 },
    metadata: { stopCount: 0, stitchCount: 1, widthIn: 4, heightIn: 4 },
    stitches: [
      { x: 0, y: 0, type: "jump" },
      { x: 2, y: -2, type: "stitch" }
    ]
  };
  const dst = writeDst(project, "long_move");
  const decoded = readDst(dst);
  assert.ok(decoded.commands.length > project.stitches.length);
  assert.ok(Math.max(...decoded.commands.map((command) => Math.max(Math.abs(command.dx), Math.abs(command.dy)))) <= 121);
  const finalCommand = decoded.commands[decoded.commands.length - 1];
  assert.ok(Math.abs(finalCommand.xIn - 2) < 0.01);
  assert.ok(Math.abs(finalCommand.yIn + 2) < 0.01);
  assert.doesNotThrow(() => exportBrotherNQ1700E(project, "brother_safe"));
  assert.throws(() => exportBrotherNQ1700E({ ...project, hoop: { widthIn: 1, heightIn: 1 } }, "too_small"), /outside the selected hoop/);
}

function testPesHeaderAndRoundTripValidation() {
  const project = projectFrom(threeColorLogo());
  const pes = writePes(project, "pes_roundtrip");
  assert.ok(pes.length > 600);
  assert.strictEqual(pes.slice(0, 8).toString("ascii"), "#PES0001");
  assert.doesNotThrow(() => validatePes(pes));
  const decoded = readPes(pes);
  const validation = validatePesForProject(pes, project);
  const pecOffset = pes.readUInt32LE(8);
  assert.strictEqual(pecOffset, 0x16);
  assert.strictEqual(pes.slice(pecOffset, pecOffset + 8).toString("ascii"), "#PEC0001");
  assert.strictEqual(pes.slice(pecOffset + 8, pecOffset + 11).toString("ascii"), "LA:");
  assert.strictEqual(pes[pecOffset + 8 + 19], 0x0d);
  assert.strictEqual(pes[pecOffset + 8 + 32], 0xff);
  assert.strictEqual(pes[pecOffset + 8 + 34], 0x06);
  assert.strictEqual(pes[pecOffset + 8 + 35], 0x26);
  assert.strictEqual(pes[pecOffset + 8 + 512 + 5], 0x31);
  assert.strictEqual(pes[pecOffset + 8 + 512 + 6], 0xff);
  assert.strictEqual(pes[pecOffset + 8 + 512 + 7], 0xf0);
  assert.strictEqual(decoded.header.pecMagic, "#PEC0001");
  assert.strictEqual(decoded.sawEnd, true);
  assert.ok(decoded.commands.some((command) => command.type === "stitch"));
  assert.strictEqual(validation.passed, true, validation.failures.join("; "));
  const malformed = Buffer.from(pes);
  malformed.write("BROKEN!!", pecOffset, "ascii");
  const malformedValidation = validatePesForProject(malformed, project);
  assert.strictEqual(malformedValidation.passed, false);
  assert.ok(malformedValidation.failures.some((failure) => /PEC|label/i.test(failure)));
  assert.deepStrictEqual(validation.metrics.colorSectionStitchCounts, project.sequence.map((item) => item.stitchCount));
  assert.ok(validation.metrics.boundsMm.width <= project.metadata.widthMm + 4);
  assert.ok(closestBrotherThread("#000000").name === "Black");
}

function testPesNoBackgroundAndMachinePreview() {
  const result = convertImageToEmbroidery(cleanShoeOutlineIcon());
  assert.ok(result.files.pes);
  assert.strictEqual(result.metadata.pesSupported, true);
  assert.strictEqual(result.metadata.primaryFormat, "PES");
  assert.strictEqual(result.metadata.machineValidation.format, "PES");
  assert.strictEqual(result.metadata.machineValidation.previewSource, "decoded-pes-bytes");
  assert.strictEqual(result.metadata.pesValidation.passed, true, result.metadata.pesValidation.failures.join("; "));
  const decoded = readPes(Buffer.from(result.files.pes, "base64"));
  assert.ok(decoded.stitchCount > 0);
  assert.ok(decoded.boundsMm.width <= result.metadata.widthMm + 4);
  assert.ok(decoded.boundsMm.height <= result.metadata.heightMm + 4);
  assert.ok(result.files.svg.includes('data-preview-source="decoded-pes-bytes"'));
  assert.ok(!JSON.stringify(result.metadata.threadOrder).includes("f6f6f6"));
}

function zipContains(buffer, filename) {
  return buffer.includes(Buffer.from(filename, "utf8"));
}

function testSafeFilenameAndUsbPackage() {
  assert.strictEqual(safeUsbFilename("My Cool Design!!.pes", "pes"), "My_Cool_Design.pes");
  assert.match(safeUsbFilename("bad name @@@", "dst"), /^[A-Za-z0-9_-]+\.dst$/);
  const result = convertImageToEmbroidery(flowerIcon());
  const zip = Buffer.from(result.files.usbPackage, "base64");
  assert.strictEqual(zip.readUInt32LE(0), 0x04034b50);
  assert.ok(zipContains(zip, result.metadata.pesFilename));
  assert.ok(zipContains(zip, "README.txt"));
  assert.ok(zip.includes(Buffer.from("root directory of the USB drive", "utf8")));

  const manual = createBrotherUsbPackage({
    pes: Buffer.from(result.files.pes, "base64"),
    png: Buffer.from(result.files.png, "base64"),
    baseName: "manual_test"
  });
  assert.ok(zipContains(manual.buffer, "manual_test.pes"));
  assert.ok(zipContains(manual.buffer, "README.txt"));
}

function testSvgPreviewGeneration() {
  const svg = renderSvgPreview(projectFrom(flowerIcon()));
  assert.ok(svg.startsWith("<svg"));
  assert.ok(svg.includes("<path"));
  assert.ok(!svg.includes("Object digitized"));
  assert.ok(!svg.includes("<text"));
}

function testPngPreviewGeneration() {
  const png = renderPngPreview(projectFrom(flowerIcon()));
  assert.strictEqual(png.slice(1, 4).toString("ascii"), "PNG");
}

function testPreviewResemblesEmbroideryNotRawPixels() {
  const svg = renderSvgPreview(projectFrom(thinLineDrawing()));
  assert.ok(svg.includes("stroke-linecap=\"round\""));
  assert.ok(!svg.includes("<image"));
}

function testObjectAwareNikeLikeRouting() {
  const preprocessed = preprocessImage(nikeLikeDesign());
  assert.ok(preprocessed.regions.some((region) => region.objectType === "reconstructed-text"));
  assert.ok(preprocessed.regions.some((region) => region.objectType === "swoosh" || region.aspect > 2.5));
  const project = createStitchProject(preprocessed, nikeLikeDesign());
  assert.strictEqual(project.digitizingPipeline, "object-first");
  assert.ok(project.objects.every((object) => ["ReconstructedTextObject", "TextObject", "OutlineDominantTextObject", "SatinBorderObject", "BorderObject", "FillObject", "SatinColumn", "TatamiRegion", "RunningLine", "AppliqueRegion"].includes(object.className)));
  assert.ok(project.objects.some((object) => object.className === "ReconstructedTextObject" && object.text === "NIKE"));
  assert.ok(project.objects.some((object) => object.className === "ReconstructedTextObject" && object.textStyle === "outline" && object.region.fillRatio < 0.5));
  assert.ok(project.objects.some((object) => object.className === "FillObject" && object.strategy.fill === "directional-tatami"));
  assert.ok(project.stitches.some((stitch) => stitch.stitchKind === "satin-border"));
  assert.ok(project.stitches.some((stitch) => stitch.stitchKind === "directional-fill" || stitch.stitchKind === "tatami-fill"));
  assert.ok(project.metadata.jumpCount < project.metadata.stitchCount);
  assert.strictEqual(project.metadata.geometryValidation.passed, true);
  assert.strictEqual(project.metadata.repeatedThreadStopCount, 0);
  assert.strictEqual(project.metadata.shreddedText, false);
  assert.ok(project.quality.score > 85);
}

function testNikeNUsesContourMaskNotRectangle() {
  const project = projectFrom(nikeNContourDesign());
  const textObject = project.objects.find((object) => object.className === "ReconstructedTextObject" && object.text === "NIKE");
  assert.ok(textObject);
  const stitches = project.stitches.filter((stitch) => stitch.type === "stitch" && stitch.objectId === textObject.id);
  assert.ok(stitches.length >= 100);
  const stride = Math.max(1, Math.floor(stitches.length / 100));
  const sampled = stitches.filter((_, index) => index % stride === 0).slice(0, 100);
  for (const stitch of sampled) {
    const pixel = stitchPixel(project, stitch);
    assert.ok(insideRegion(textObject.region, project.metadata.sourceWidth, pixel.x, pixel.y), `stitch escaped rebuilt text contour at ${pixel.x},${pixel.y}`);
  }
  const boxOnlyPoints = [];
  for (let y = textObject.region.minY; y <= textObject.region.maxY; y += 1) {
    for (let x = textObject.region.minX; x <= textObject.region.maxX; x += 1) {
      if (!insideRegion(textObject.region, project.metadata.sourceWidth, x, y, 0)) boxOnlyPoints.push(`${x},${y}`);
    }
  }
  const stitchedPixels = new Set(stitches.map((stitch) => {
    const pixel = stitchPixel(project, stitch);
    return `${pixel.x},${pixel.y}`;
  }));
  assert.ok(boxOnlyPoints.some((point) => !stitchedPixels.has(point)));
  assert.strictEqual(project.metadata.geometryValidation.passed, true);
}

function testOutlinedTextPreservesMascotAndSwoosh() {
  const result = convertImageToEmbroidery(nikeStitchOverlayDesign());
  const text = result.project.objects.find((object) => object.className === "ReconstructedTextObject" && object.text === "NIKE");
  const mascot = result.project.objects.find((object) => object.sourceType === "character");
  const swoosh = result.project.objects.find((object) => object.sourceType === "swoosh" && object.className === "FillObject");
  const characterObjects = result.project.objects.filter((object) => object.sourceType === "character");
  assert.ok(text);
  assert.strictEqual(text.textStyle, "outline");
  assert.ok(text.region.fillRatio < 0.5);
  assert.ok(mascot);
  assert.ok(swoosh);
  assert.match(result.metadata.imageType, /character|mixed/i);
  assert.strictEqual(result.metadata.characterValidation.passed, true);
  assert.strictEqual(result.metadata.characterValidation.features.earsVisible, true);
  assert.strictEqual(result.metadata.characterValidation.features.faceVisible, true);
  assert.strictEqual(result.metadata.characterValidation.features.eyesVisible, true);
  assert.ok(characterObjects.length >= 3);
  assert.strictEqual(result.metadata.visualValidation.requiredObjects.text, true);
  assert.strictEqual(result.metadata.visualValidation.requiredObjects.mascot, true);
  assert.strictEqual(result.metadata.visualValidation.requiredObjects.swoosh, true);
  assert.strictEqual(result.metadata.exportBlocked, false);
  assert.ok(result.metadata.quality.score >= 70);
  assert.ok(result.files.dst);
}

function testBrandLogoUsesOriginalContoursNotFont() {
  const result = convertImageToEmbroidery(simpleBlackNikeLogo());
  const wordmark = result.project.objects.find((object) => object.logoRole === "wordmark");
  const swoosh = result.project.objects.find((object) => object.logoRole === "swoosh");
  assert.ok(wordmark);
  assert.ok(swoosh);
  assert.strictEqual(wordmark.contourPreserved, true);
  assert.strictEqual(swoosh.contourPreserved, true);
  assert.strictEqual(wordmark.strategy.fill, "single-color-logo-satin");
  assert.ok(!JSON.stringify(result.project).includes("block-athletic"));
  assert.strictEqual(result.metadata.imageType, "Single-Color Logo Mode");
  assert.strictEqual(result.metadata.visualValidation.requiredObjects.wordmark, true);
  assert.strictEqual(result.metadata.visualValidation.requiredObjects.swoosh, true);
  assert.strictEqual(result.metadata.exportBlocked, false);
  assert.ok(result.files.dst);
  assert.ok(result.metadata.quality.score > 85);
  assert.ok(result.metadata.sequence.length <= 3);
  assert.ok(result.metadata.stopCount <= 2);

  const whiteBackground = simpleBlackNikeLogo();
  for (let i = 0; i < whiteBackground.image.rgba.length; i += 4) {
    if (whiteBackground.image.rgba[i + 3] === 0) {
      whiteBackground.image.rgba[i] = 255;
      whiteBackground.image.rgba[i + 1] = 255;
      whiteBackground.image.rgba[i + 2] = 255;
      whiteBackground.image.rgba[i + 3] = 255;
    }
  }
  const whiteResult = convertImageToEmbroidery(whiteBackground);
  assert.strictEqual(whiteResult.metadata.imageType, "Single-Color Logo Mode");
  assert.strictEqual(whiteResult.metadata.exportBlocked, false);
  assert.ok(whiteResult.files.dst);
}

function testShoeOutlineIconUsesOutlineVectorMode() {
  const result = convertImageToEmbroidery(cleanShoeOutlineIcon());
  assert.strictEqual(result.metadata.imageType, "Outline Vector Icon Mode");
  assert.strictEqual(result.metadata.exportBlocked, false);
  assert.ok(result.files.dst);
  assert.ok(result.project.objects.length >= 1);
  assert.ok(result.project.objects.every((object) => object.outlineVectorIcon));
  assert.strictEqual(result.project.threads.length, 1);
  assert.ok(result.metadata.sequence.length <= 1);
  assert.ok(result.metadata.stopCount <= 1);
  assert.ok(result.metadata.quality.score >= 85);
  assert.strictEqual(result.metadata.outlineValidation.passed, true);
  assert.ok(result.metadata.outlineValidation.metrics.pathCount >= 1);
  assert.ok(!JSON.stringify(result.metadata.threadOrder).includes("f6f6f6"));
  assert.ok(!JSON.stringify(result.metadata.threadOrder).includes("dedede"));
  assert.ok(!JSON.stringify(result.metadata.threadOrder).includes("a6a6a6"));
}

function testForegroundFitsSelectedHoop() {
  const input = {
    ...smallCenteredFlowerCanvas(),
    hoopWidthIn: 6,
    hoopHeightIn: 10
  };
  const result = convertImageToEmbroidery(input);
  assert.strictEqual(result.metadata.exportBlocked, false);
  assert.ok(result.files.dst);
  assert.ok(result.metadata.widthIn > 5.4, `foreground width should fill hoop, got ${result.metadata.widthIn}`);
  assert.ok(result.metadata.widthIn <= 6);
  assert.ok(result.metadata.heightIn <= 10);
  assert.ok(result.metadata.foregroundBounds.bboxWidth < input.image.width / 2);
  assert.ok(!result.files.svg.includes("<text"));
}

function testProfessionalHondaLogo() {
  const result = convertImageToEmbroidery(hondaLogoImage());
  assert.match(result.metadata.imageType, /Single-Color Logo|Text Logo/);
  assert.strictEqual(result.metadata.exportBlocked, false);
  assert.ok(result.files.dst);
  assert.strictEqual(result.project.threads.length, 1);
  assert.ok(result.project.threads[0].hex.toLowerCase() === "#0c0c0c" || result.project.threads[0].hex.toLowerCase() === "#060606");
  assert.ok(!result.files.svg.includes("checkerboard"));
  assert.ok(!result.files.svg.includes("<text"));
}

function testProfessionalKinectricsTextLogo() {
  const result = convertImageToEmbroidery(kinectricsLogoImage());
  assert.strictEqual(result.metadata.imageType, "Text Logo Mode");
  assert.strictEqual(result.metadata.exportBlocked, false);
  assert.ok(result.files.dst);
  assert.ok(result.project.objects.some((object) => object.sourceType === "text"));
  assert.ok(result.metadata.foregroundBounds.bboxWidth < result.metadata.sourceWidth);
}

function testProfessionalCharacterPreservation() {
  for (const input of [poohCharacterImage(), bugsBunnyImage()]) {
    const result = convertImageToEmbroidery(input);
    assert.strictEqual(result.metadata.imageType, "Character Preservation Mode");
    assert.strictEqual(result.metadata.exportBlocked, false);
    assert.ok(result.files.dst);
    assert.ok(result.metadata.characterValidation.features.faceVisible);
    assert.ok(result.metadata.characterValidation.features.eyesVisible);
    assert.ok(result.project.objects.some((object) => object.sourceType === "character" && ["eyes", "outline"].includes(object.characterRole)));
    assert.ok(!result.files.svg.includes("<text"));
  }
}

function testProfessionalFlowerAndCrestModes() {
  const flower = convertImageToEmbroidery(flowerIcon());
  assert.strictEqual(flower.metadata.imageType, "Floral Artwork Mode");
  assert.strictEqual(flower.metadata.exportBlocked, false);
  assert.ok(flower.files.dst);
  assert.ok(flower.project.objects.length >= 2);

  const crest = convertImageToEmbroidery(tigerCrestImage());
  assert.strictEqual(crest.metadata.imageType, "Emblem Crest Mode");
  assert.strictEqual(crest.metadata.exportBlocked, false);
  assert.ok(crest.files.dst);
  assert.ok(crest.project.objects.some((object) => object.sourceType === "linework"));
}

function testMachineSafePatternExports() {
  for (const kind of ["square", "circle", "oval", "three-color-circle", "satin-border-rectangle", "flower", "satin-line", "running-line"]) {
    const result = convertImageToEmbroidery(machineSafePattern(kind));
    assert.strictEqual(result.metadata.exportBlocked, false, kind);
    assert.ok(result.files.dst, kind);
    assert.strictEqual(result.metadata.machineValidation.passed, true, `${kind}: ${result.metadata.machineValidation.failures.join("; ")}`);
    assert.ok(result.files.pes, kind);
    assert.strictEqual(result.metadata.pesValidation.passed, true, `${kind}: ${result.metadata.pesValidation.failures.join("; ")}`);
    assert.strictEqual(result.metadata.machineValidation.previewSource, "decoded-pes-bytes", kind);
    const decoded = readDst(Buffer.from(result.files.dst, "base64"));
    assert.strictEqual(decoded.sawEnd, true, kind);
    assert.ok(decoded.boundsMm.width <= result.metadata.widthMm + 4, kind);
    assert.ok(decoded.boundsMm.height <= result.metadata.heightMm + 4, kind);
    assert.ok(decoded.commands.filter((command) => command.type === "stitch").length > 0, kind);
    assert.ok(result.files.svg.includes("<path"), kind);
    assert.ok(result.files.svg.includes('data-preview-source="decoded-pes-bytes"'), kind);
    assert.ok(!result.files.svg.includes("<text"), kind);
  }
}

function assertDecodedFillComplete(input, label) {
  const result = convertImageToEmbroidery(input);
  assert.strictEqual(result.metadata.exportBlocked, false, label);
  assert.ok(result.files.dst, label);
  assert.strictEqual(result.metadata.machineValidation.passed, true, `${label}: ${result.metadata.machineValidation.failures.join("; ")}`);
  assert.strictEqual(result.metadata.machineValidation.previewSource, "decoded-pes-bytes", label);
  const completeness = result.metadata.machineValidation.metrics.fillCompleteness;
  assert.ok(completeness.objects.length > 0, label);
  for (const object of completeness.objects.filter((item) => item.area >= 20)) {
    assert.ok(
      object.fillCoveragePercent >= object.requiredPercent,
      `${label} ${object.objectId} coverage ${object.fillCoveragePercent}% below ${object.requiredPercent}%`
    );
  }
  assert.ok(result.metadata.machineValidation.metrics.horizontalBandMetrics.uniqueYBuckets > 4, label);
  assert.ok(result.files.svg.includes('data-preview-source="decoded-pes-bytes"'), label);
}

function testClosedShapeFillCompleteness() {
  assertDecodedFillComplete(filledHeartImage(), "filled heart");
  assertDecodedFillComplete(letterOWithHoleImage(), "letter O with hole");
  assertDecodedFillComplete(filledSwooshImage(), "filled swoosh");
  assertDecodedFillComplete(filledFlowerPetalImage(), "flower petal");
  assertDecodedFillComplete(filledMascotBodyImage(), "mascot body");
}

function testBrotherPesRegressionImages() {
  const cases = [
    ["Honda logo", hondaLogoImage()],
    ["black Nike logo", simpleBlackNikeLogo()],
    ["Nike shoe outline", cleanShoeOutlineIcon()],
    ["NIKE Stitch swoosh", nikeStitchOverlayDesign()],
    ["Pooh character", poohCharacterImage()],
    ["Bugs Bunny character", bugsBunnyImage()],
    ["tiger crest", tigerCrestImage()],
    ["flower", flowerIcon()],
    ["Kinectrics logo", kinectricsLogoImage()]
  ];
  for (const [label, input] of cases) {
    const result = convertImageToEmbroidery(input);
    assert.ok(result.files.pes, label);
    assert.ok(result.files.png, label);
    assert.ok(result.metadata.threadOrder.length >= 1, label);
    assert.strictEqual(result.metadata.pesValidation.passed, true, `${label}: ${result.metadata.pesValidation.failures.join("; ")}`);
    assert.strictEqual(result.metadata.machineValidation.format, "PES", label);
    assert.ok(result.metadata.pesBytes > 600, label);
  }
}

function testComplexImageFallbackAndPreviewStages() {
  const result = convertImageToEmbroidery(nikeLikeDesign());
  assert.match(result.metadata.imageType, /complex mixed artwork/);
  assert.ok(!result.files.simplifiedSvg.includes("Simplified embroidery artwork"));
  assert.ok(!result.files.simplifiedSvg.includes("<text"));
  assert.ok(!result.files.svg.includes("dasharray"));
  assert.ok(result.files.svgWithJumps.includes("dasharray") || result.project.metadata.jumpRecordCount === 0);
  assert.ok(result.metadata.sequence.length <= 8);
  assert.strictEqual(new Set(result.metadata.sequence.map((item) => item.threadIndex)).size, result.metadata.sequence.length);
  assert.strictEqual(result.metadata.repeatedThreadStopCount, 0);
  assert.strictEqual(result.metadata.shreddedText, false);
  assert.strictEqual(result.metadata.geometryValidation.passed, true);
  assert.strictEqual(result.metadata.visualValidation.requiredObjects.text, true);
  assert.strictEqual(result.project.objects.some((object) => object.className === "ReconstructedTextObject" && object.text === "NIKE"), true);
  assert.ok(!result.files.svg.includes('stroke-opacity="0.72" rx="3"'));
  assert.ok(result.metadata.quality.score <= 100);
  assert.strictEqual(result.metadata.exportBlocked, false);
  assert.ok(result.metadata.semanticValidation.protectedObjects.some((object) => object.label === "Letter N"));
  assert.ok(result.metadata.semanticValidation.protectedObjects.some((object) => object.label === "Nike swoosh"));
  assert.strictEqual(Buffer.from(result.files.dst, "base64").slice(0, 3).toString("ascii"), "LA:");
}

function testSemanticValidationBlocksBrokenStructure() {
  const validation = validateSemanticStructure({
    objects: [],
    metadata: {},
    stitches: []
  }, {
    protectedObjects: [
      { id: "letter-1", type: "letter", label: "Letter N" },
      { id: "letter-2", type: "letter", label: "Letter I" },
      { id: "letter-3", type: "letter", label: "Letter K" },
      { id: "letter-4", type: "letter", label: "Letter E" },
      { id: "swoosh-1", type: "swoosh", label: "Nike swoosh" }
    ]
  });
  assert.strictEqual(validation.passed, false);
  assert.ok(validation.failures.includes("primary text missing"));
  assert.ok(validation.scoreCap <= 20);
}

function testMissingPrimaryTextBlocksExport() {
  const result = convertImageToEmbroidery(nikeMissingTextDesign());
  assert.strictEqual(result.metadata.exportBlocked, false);
  assert.ok(result.files.dst);
  assert.strictEqual(result.metadata.exportStatus, "PES ready with warnings");
  assert.ok(result.metadata.quality.score <= 20);
  assert.ok(result.metadata.semanticValidation.failures.includes("primary text missing"));
}

function testFullConversion() {
  const result = convertImageToEmbroidery(flowerIcon());
  assert.ok(result.files.dst);
  assert.ok(result.files.pes);
  assert.ok(result.files.usbPackage);
  assert.ok(result.files.svg.includes("<svg"));
  assert.ok(result.files.png);
  assert.ok(result.metadata.quality.score > 0);
  assert.strictEqual(result.metadata.pesSupported, true);
  assert.strictEqual(result.metadata.primaryFormat, "PES");
  assert.match(result.metadata.exportStatus, /PES/);
}

const tests = [
  testUploadValidation,
  testBackgroundRemoval,
  testPaletteReduction,
  testSmallRegionRemoval,
  testSmoothContours,
  testStitchJsonCreation,
  testStopInsertion,
  testImageTypeDetection,
  testDstGeneration,
  testDstRoundTripMachineValidation,
  testDstMovementSplittingAndBrotherExport,
  testPesHeaderAndRoundTripValidation,
  testPesNoBackgroundAndMachinePreview,
  testSafeFilenameAndUsbPackage,
  testSvgPreviewGeneration,
  testPngPreviewGeneration,
  testPreviewResemblesEmbroideryNotRawPixels,
  testObjectAwareNikeLikeRouting,
  testNikeNUsesContourMaskNotRectangle,
  testOutlinedTextPreservesMascotAndSwoosh,
  testBrandLogoUsesOriginalContoursNotFont,
  testShoeOutlineIconUsesOutlineVectorMode,
  testForegroundFitsSelectedHoop,
  testProfessionalHondaLogo,
  testProfessionalKinectricsTextLogo,
  testProfessionalCharacterPreservation,
  testProfessionalFlowerAndCrestModes,
  testMachineSafePatternExports,
  testClosedShapeFillCompleteness,
  testBrotherPesRegressionImages,
  testComplexImageFallbackAndPreviewStages,
  testSemanticValidationBlocksBrokenStructure,
  testMissingPrimaryTextBlocksExport,
  testFullConversion
];

for (const test of tests) {
  test();
  console.log(`ok - ${test.name}`);
}
