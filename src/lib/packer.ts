// maxrects 装箱：布局计算（纯逻辑）与图集渲染分离
//
// 旋转约定（与 TexturePacker / PixiJS groupD8.N 一致）：
//   rotate=6 表示内容在图集中被逆时针烘焙 90°（groupD8.N：纹理 U 轴朝北）。
//   图集中的 frame 是旋转后实际像素包围盒（宽高已互换）；
//   trim/orig 永远位于原始画布坐标系，轴心 pivot 也在原始画布坐标系。
import { MaxRectsPacker, Rectangle } from 'maxrects-packer';
import type {
  FrameSource,
  PackedPage,
  PackedRegion,
  PackResult,
  PackSettings,
} from './types';
import { buildTile } from './imageUtils';

export interface TileLayout {
  sourceId: string;
  /** 未旋转图块（trim 内容 + 两侧 extrude） */
  tileW: number;
  tileH: number;
  /** 装箱占位（图块 + 两侧对称 padding 留白） */
  slotW: number;
  slotH: number;
  empty: boolean;
  oversized: boolean;
}

export interface LaidOutRegion extends PackedRegion {
  binIndex: number;
}

export interface PackLayout {
  regions: LaidOutRegion[];
  overflow: string[];
  binBounds: { index: number; width: number; height: number }[];
}

const EMPTY_REGION = (sourceId: string): Omit<LaidOutRegion, 'binIndex'> => ({
  sourceId,
  page: 0,
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  contentX: 0,
  contentY: 0,
  contentW: 0,
  contentH: 0,
  rotated: false,
  rotate: 0,
  oversized: false,
});

/** 纯布局计算（不接触 DOM/canvas） */
export function computeLayout(
  sources: FrameSource[],
  settings: PackSettings,
): PackLayout {
  const {
    extrude,
    padding: gap,
    border,
    maxWidth,
    maxHeight,
    allowRotation,
  } = settings;

  const layouts = new Map<string, TileLayout>();
  const input: Rectangle[] = [];

  for (const s of sources) {
    const empty = s.trim.empty;
    const tileW = empty ? 0 : s.trim.w + extrude * 2;
    const tileH = empty ? 0 : s.trim.h + extrude * 2;
    const slotW = tileW + gap * 2;
    const slotH = tileH + gap * 2;
    const oversized =
      !empty &&
      (slotW + border * 2 > maxWidth ||
        slotH + border * 2 > maxHeight ||
        (!allowRotation &&
          (slotW > maxWidth || slotH > maxHeight)));
    layouts.set(s.id, { sourceId: s.id, tileW, tileH, slotW, slotH, empty, oversized });
    if (empty || oversized) continue;
    const r = new Rectangle(slotW, slotH, 0, 0, false, allowRotation);
    r.data = s.id;
    input.push(r);
  }

  const packer = new MaxRectsPacker(maxWidth, maxHeight, 0, {
    smart: true,
    pot: settings.pot,
    square: settings.square,
    allowRotation,
    border,
  });
  packer.addArray(input);

  const regions: LaidOutRegion[] = [];
  const binBounds: PackLayout['binBounds'] = [];

  packer.bins.forEach((bin, binIndex) => {
    let bw = border;
    let bh = border;
    for (const rect of bin.rects) {
      const sourceId = rect.data as string;
      const l = layouts.get(sourceId)!;
      const rotated = rect.rot;
      // 槽内边距对称：内容（trim 包围盒）在图集轴上的起点
      const contentX = rect.x + gap + extrude;
      const contentY = rect.y + gap + extrude;
      regions.push({
        sourceId,
        page: binIndex,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        contentX,
        contentY,
        // 旋转后内容在图集轴上的宽高与 trim 互换
        contentW: rotated ? l.tileH - extrude * 2 : l.tileW - extrude * 2,
        contentH: rotated ? l.tileW - extrude * 2 : l.tileH - extrude * 2,
        rotated,
        rotate: rotated ? 6 : 0,
        oversized: false,
        binIndex,
      });
      bw = Math.max(bw, rect.x + rect.width + border);
      bh = Math.max(bh, rect.y + rect.height + border);
    }
    binBounds.push({ index: binIndex, width: Math.max(1, bw), height: Math.max(1, bh) });
  });

  // 整帧透明源：不占图集像素，输出零尺寸区域，原始尺寸只存在于元数据
  for (const s of sources) {
    const l = layouts.get(s.id)!;
    if (l.empty) {
      regions.push({ ...EMPTY_REGION(s.id), binIndex: 0 });
    }
  }

  const overflow = sources.filter((s) => layouts.get(s.id)!.oversized).map((s) => s.id);
  return { regions, overflow, binBounds };
}

/** 按布局渲染各页 canvas */
export function renderPages(
  sources: FrameSource[],
  layout: PackLayout,
  settings: PackSettings,
  sourceCanvasMap: Map<string, HTMLCanvasElement>,
): HTMLCanvasElement[] {
  const { extrude, pot } = settings;
  const pages: HTMLCanvasElement[] = layout.binBounds.map((b) => {
    const c = document.createElement('canvas');
    c.width = pot ? nextPow2(b.width) : b.width;
    c.height = pot ? nextPow2(b.height) : b.height;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    return c;
  });

  const sourceMap = new Map(sources.map((s) => [s.id, s]));

  for (const region of layout.regions) {
    if (region.contentW === 0 && region.contentH === 0) continue;
    const src = sourceMap.get(region.sourceId)!;
    const origCanvas = sourceCanvasMap.get(region.sourceId)!;
    const tile = buildTile(origCanvas, src.trim, extrude);
    if (!tile) continue;
    const ctx = pages[region.page].getContext('2d')!;
    const pad = settings.padding;

    if (!region.rotated) {
      ctx.drawImage(tile, region.x + pad, region.y + pad);
    } else {
      // 逆时针 90° 烘焙（与 Pixi groupD8.N / rotate=6 的 UV 采样方向一致）。
      // tile 局部 (u,v) 映射：atlasX = region.x + pad + v，
      //                      atlasY = region.y + pad + tileW - u
      // 原右方向映射为图集上方向，原顶边 TL→TR 落在槽左侧 BL→TL。
      ctx.save();
      ctx.translate(region.x + pad, region.y + pad);
      ctx.rotate(-Math.PI / 2);
      ctx.translate(-tile.width, 0);
      ctx.drawImage(tile, 0, 0);
      ctx.restore();
    }
  }

  return pages;
}

function nextPow2(v: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(1, v)));
}

/** 完整打包：布局 + 渲染 + dataURL */
export function packProject(
  sourceList: FrameSource[],
  settings: PackSettings,
  sourceCanvasMap: Map<string, HTMLCanvasElement>,
): PackResult {
  const layout = computeLayout(sourceList, settings);
  const canvases = renderPages(sourceList, layout, settings, sourceCanvasMap);

  const pages: PackedPage[] = canvases.map((canvas, index) => ({
    index,
    width: canvas.width,
    height: canvas.height,
    dataUrl: canvas.toDataURL('image/png'),
    regions: layout.regions
      .filter((r) => r.binIndex === index)
      .map(({ binIndex: _omit, ...rest }) => {
        void _omit;
        return rest;
      }),
  }));

  return { pages, overflow: layout.overflow, at: Date.now() };
}
