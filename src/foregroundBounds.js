const TRANSPARENT_ALPHA = 35;
const WHITE_THRESHOLD = 242;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isNearWhite(r, g, b) {
  return r >= WHITE_THRESHOLD && g >= WHITE_THRESHOLD && b >= WHITE_THRESHOLD && Math.max(r, g, b) - Math.min(r, g, b) < 24;
}

function isVisibleForegroundPixel(image, cell, options = {}) {
  const alphaThreshold = options.alphaThreshold ?? TRANSPARENT_ALPHA;
  const i = cell * 4;
  const r = image.rgba[i];
  const g = image.rgba[i + 1];
  const b = image.rgba[i + 2];
  const a = image.rgba[i + 3];
  if (a < alphaThreshold) return false;
  if (options.ignoreNearWhite !== false && isNearWhite(r, g, b)) return false;
  return true;
}

function createForegroundMask(image, options = {}) {
  const mask = new Uint8Array(image.width * image.height);
  for (let p = 0; p < mask.length; p += 1) {
    mask[p] = isVisibleForegroundPixel(image, p, options) ? 1 : 0;
  }
  return mask;
}

function getMaskBounds(mask, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let area = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      area += 1;
    }
  }
  if (maxX < minX) {
    return { minX: 0, minY: 0, maxX: width - 1, maxY: height - 1, bboxWidth: width, bboxHeight: height, area: 0, empty: true };
  }
  return { minX, minY, maxX, maxY, bboxWidth: maxX - minX + 1, bboxHeight: maxY - minY + 1, area, empty: false };
}

function expandBounds(bounds, width, height, ratio = 0.03) {
  if (bounds.empty) return bounds;
  const padX = Math.max(1, Math.round(bounds.bboxWidth * ratio));
  const padY = Math.max(1, Math.round(bounds.bboxHeight * ratio));
  const minX = clamp(bounds.minX - padX, 0, width - 1);
  const minY = clamp(bounds.minY - padY, 0, height - 1);
  const maxX = clamp(bounds.maxX + padX, 0, width - 1);
  const maxY = clamp(bounds.maxY + padY, 0, height - 1);
  return {
    ...bounds,
    minX,
    minY,
    maxX,
    maxY,
    bboxWidth: maxX - minX + 1,
    bboxHeight: maxY - minY + 1
  };
}

function getVisibleForegroundBounds(image, options = {}) {
  const mask = createForegroundMask(image, options);
  return expandBounds(getMaskBounds(mask, image.width, image.height), image.width, image.height, options.paddingRatio ?? 0.03);
}

function fitForegroundToHoop(foregroundBounds, hoopWidthIn, hoopHeightIn, paddingPercent = 0.03) {
  const hoopWidth = Number(hoopWidthIn);
  const hoopHeight = Number(hoopHeightIn);
  if (!Number.isFinite(hoopWidth) || !Number.isFinite(hoopHeight) || hoopWidth <= 0 || hoopHeight <= 0) {
    throw new Error("Hoop width and height must be greater than 0.");
  }
  const bounds = foregroundBounds || {};
  const sourceWidth = Math.max(1, Number(bounds.bboxWidth || bounds.width || 1));
  const sourceHeight = Math.max(1, Number(bounds.bboxHeight || bounds.height || 1));
  const safePadding = clamp(Number(paddingPercent) || 0, 0, 0.2);
  const usableWidth = Math.max(0.1, hoopWidth * (1 - safePadding * 2));
  const usableHeight = Math.max(0.1, hoopHeight * (1 - safePadding * 2));
  const scaleFactor = Math.min(usableWidth / sourceWidth, usableHeight / sourceHeight);
  const finalWidthIn = sourceWidth * scaleFactor;
  const finalHeightIn = sourceHeight * scaleFactor;
  return {
    finalWidthIn: Number(finalWidthIn.toFixed(4)),
    finalHeightIn: Number(finalHeightIn.toFixed(4)),
    scaleFactor: Number(scaleFactor.toFixed(8)),
    offsetX: Number(((hoopWidth - finalWidthIn) / 2).toFixed(4)),
    offsetY: Number(((hoopHeight - finalHeightIn) / 2).toFixed(4)),
    paddingPercent: safePadding
  };
}

module.exports = {
  createForegroundMask,
  fitForegroundToHoop,
  getMaskBounds,
  getVisibleForegroundBounds,
  isNearWhite,
  isVisibleForegroundPixel
};
