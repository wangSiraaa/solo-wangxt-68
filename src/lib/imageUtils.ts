// 图像工具：加载、读像素、透明裁边、哈希、边缘扩色
import type { TrimRect } from './types';

export function uid(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

export function loadImageFromDataUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

export interface ImageLike {
  naturalWidth?: number;
  naturalHeight?: number;
  width: number;
  height: number;
}

export function imageToCanvas(img: HTMLImageElement | HTMLCanvasElement | ImageLike): HTMLCanvasElement {
  const c = document.createElement('canvas');
  const isImg = 'naturalWidth' in img && typeof img.naturalWidth === 'number' && img.naturalWidth > 0;
  c.width = isImg ? (img.naturalWidth as number) : img.width;
  c.height = isImg ? (img.naturalHeight as number) : img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img as CanvasImageSource, 0, 0);
  return c;
}

/**
 * 透明裁边：找到非透明像素的包围盒。
 * alpha 阈值默认 0——任何 alpha>0 的像素（包括边缘半透明像素）都保留，
 * 这样扩色时才不会丢掉抗锯齿边缘。
 * 返回的坐标位于原始画布坐标系；整帧透明时 empty=true。
 */
export function computeTrim(data: ImageData, alphaThreshold = 0): TrimRect {
  const { width: w, height: h, data: px } = data;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] > alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) {
    return { x: 0, y: 0, w: 0, h: 0, empty: true };
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, empty: false };
}

/**
 * 对原始图像计算 trim 与像素哈希（FNV-1a，RGBA 全参与）。
 * 哈希相同即视为相同像素帧，可共享纹理区域。
 */
export function analyzeImage(canvas: HTMLCanvasElement): { trim: TrimRect; hash: string } {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const trim = computeTrim(data);
  return { trim, hash: hashImageData(data) };
}

export function hashImageData(data: ImageData): string {
  // FNV-1a 32-bit，两遍（行序 + 列序）再混入尺寸，降低碰撞概率
  const px = data.data;
  let h1 = 0x811c9dc5;
  for (let i = 0; i < px.length; i += 4) {
    h1 ^= px[i];
    h1 = Math.imul(h1, 0x01000193);
    h1 ^= px[i + 1];
    h1 = Math.imul(h1, 0x01000193);
    h1 ^= px[i + 2];
    h1 = Math.imul(h1, 0x01000193);
    h1 ^= px[i + 3];
    h1 = Math.imul(h1, 0x01000193);
  }
  let h2 = 0x811c9dc5;
  const w = data.width;
  const h = data.height;
  for (let y = 0; y < h; y++) {
    const rowStart = y * w * 4;
    for (let x = w - 1; x >= 0; x--) {
      const i = rowStart + x * 4;
      h2 ^= px[i + 3];
      h2 = Math.imul(h2, 0x01000193);
      h2 ^= px[i + 2];
      h2 = Math.imul(h2, 0x01000193);
      h2 ^= px[i + 1];
      h2 = Math.imul(h2, 0x01000193);
      h2 ^= px[i];
      h2 = Math.imul(h2, 0x01000193);
    }
  }
  const mix = Math.imul(w, 0x9e3779b1) ^ Math.imul(h, 0x85ebca77);
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}${(mix >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * 为一个源生成「图块」canvas：中心是 trim 后的内容，四周边缘扩色（extrude）。
 * 扩色直接复制边缘行列像素（含半透明 alpha），边缘之外不补任何颜色；
 * 再外层的透明间距（padding）由装箱的占位尺寸保证，不在图块上绘制。
 *
 * 空（整帧透明）源返回 null——它不占图集像素，仅靠元数据保留原始尺寸。
 */
export function buildTile(
  sourceCanvas: HTMLCanvasElement,
  trim: TrimRect,
  extrude: number,
): HTMLCanvasElement | null {
  if (trim.empty) return null;
  const cw = trim.w;
  const ch = trim.h;
  const tile = document.createElement('canvas');
  tile.width = cw + extrude * 2;
  tile.height = ch + extrude * 2;
  const ctx = tile.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  // 内容
  ctx.drawImage(
    sourceCanvas,
    trim.x, trim.y, cw, ch,
    extrude, extrude, cw, ch,
  );
  if (extrude > 0) {
    // 上下边条（复制内容的第一行/最后一行）
    ctx.drawImage(tile, extrude, extrude, cw, 1, extrude, 0, cw, extrude);
    ctx.drawImage(tile, extrude, extrude + ch - 1, cw, 1, extrude, extrude + ch, cw, extrude);
    // 左右边条（复制内容的第一列/最后一列，拉通全高以覆盖四个角）
    ctx.drawImage(tile, extrude, 0, 1, tile.height, 0, 0, extrude, tile.height);
    ctx.drawImage(tile, extrude + cw - 1, 0, 1, tile.height, extrude + cw, 0, extrude, tile.height);
  }
  return tile;
}
