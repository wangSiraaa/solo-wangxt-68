// 端到端像素级测试：
// 1) trim（含边缘半透明、不同画布尺寸、整帧透明）
// 2) 相同像素共享源（哈希去重），帧时长/事件独立
// 3) buildTile 边缘扩色：extrude 区域像素 == 边缘像素；padding 留白独立
// 4) 装箱布局（分页/超大帧）与旋转区域元数据
// 5) 渲染：从生成的图集页按 frame/rotate 取回像素 == 原始 trim 内容
// 6) 导出 JSON 结构 + 重导入恢复（时长、事件、pivot、orig 尺寸）
import { describe, it, expect } from 'vitest';
import { FakeCanvas } from './fake-dom';
import {
  analyzeImage,
  buildTile,
  computeTrim,
  hashImageData,
  imageToCanvas,
  loadImage,
  uid,
} from '../src/lib/imageUtils';
import { computeLayout, packProject } from '../src/lib/packer';
import { DEFAULT_SETTINGS, type FrameSource } from '../src/lib/types';
import { buildExport } from '../src/lib/exporter';
import { importAtlasJson } from '../src/lib/importer';

// ---------- 构造工具 ----------
function makeCanvas(w: number, h: number, paint?: (x: number, y: number) => [number, number, number, number] | null): FakeCanvas {
  const c = new FakeCanvas(w, h);
  if (paint) {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = paint(x, y);
        if (p) {
          const i = (y * w + x) * 4;
          c.data[i] = p[0];
          c.data[i + 1] = p[1];
          c.data[i + 2] = p[2];
          c.data[i + 3] = p[3];
        }
      }
  }
  return c;
}

function px(c: FakeCanvas, x: number, y: number): [number, number, number, number] {
  const i = (y * c.width + x) * 4;
  return [c.data[i], c.data[i + 1], c.data[i + 2], c.data[i + 3]];
}

function sourceFrom(
  canvas: FakeCanvas,
  opts: Partial<FrameSource> = {},
): FrameSource & { __canvas: FakeCanvas } {
  const { trim, hash } = analyzeImage(canvas as unknown as HTMLCanvasElement);
  return {
    id: opts.id ?? uid('src'),
    hash,
    name: opts.name ?? 'x.png',
    origWidth: canvas.width,
    origHeight: canvas.height,
    trim,
    pivotX: opts.pivotX ?? canvas.width / 2,
    pivotY: opts.pivotY ?? canvas.height / 2,
    blobKey: opts.blobKey ?? 'blob_x',
    blobType: 'image/png',
    __canvas: canvas,
  } as FrameSource & { __canvas: FakeCanvas };
}

describe('透明裁边', () => {
  it('保留半透明边缘（alpha>0 全部纳入 trim）', () => {
    // 10x10，实心区 3..6 全不透明，其外圈一圈 alpha=64
    const c = makeCanvas(10, 10, (x, y) => {
      if (x >= 3 && x <= 6 && y >= 3 && y <= 6) return [255, 0, 0, 255];
      if (x >= 2 && x <= 7 && y >= 2 && y <= 7) return [255, 0, 0, 64];
      return null;
    });
    const data = c.getContext().getImageData(0, 0, 10, 10);
    const t = computeTrim(data);
    expect(t.empty).toBe(false);
    expect({ x: t.x, y: t.y, w: t.w, h: t.h }).toEqual({ x: 2, y: 2, w: 6, h: 6 });
  });

  it('整帧透明返回 empty', () => {
    const c = makeCanvas(12, 8);
    const data = c.getContext().getImageData(0, 0, 12, 8);
    const t = computeTrim(data);
    expect(t.empty).toBe(true);
    expect({ w: t.w, h: t.h }).toEqual({ w: 0, h: 0 });
  });
});

describe('相同像素哈希', () => {
  it('同像素同尺寸哈希相同；不同像素不同', () => {
    const a = makeCanvas(8, 8, (x, y) => [x * 30, y * 30, 0, 255]);
    const b = makeCanvas(8, 8, (x, y) => [x * 30, y * 30, 0, 255]);
    const d = makeCanvas(8, 8, (x, y) => [x * 30, y * 30, 1, 255]);
    const ha = hashImageData(a.getContext().getImageData(0, 0, 8, 8));
    const hb = hashImageData(b.getContext().getImageData(0, 0, 8, 8));
    const hd = hashImageData(d.getContext().getImageData(0, 0, 8, 8));
    expect(ha).toBe(hb);
    expect(ha).not.toBe(hd);
  });
});

describe('边缘扩色 vs 透明留白', () => {
  it('extrude 复制边缘像素（含半透明 alpha），无内容处保持透明', () => {
    // 内容 4x3：左边缘 alpha=100，其余不透明
    const c = makeCanvas(4, 3, (x) => [10 + x * 10, 200, 40, x === 0 ? 100 : 255]);
    const tile = buildTile(c as unknown as HTMLCanvasElement, { x: 0, y: 0, w: 4, h: 3, empty: false }, 2)!;
    const t = tile as unknown as FakeCanvas;
    expect(t.width).toBe(8); // 4 + 2*2
    expect(t.height).toBe(7); // 3 + 4
    // 内容左上 (2,2) = 源 (0,0)，半透明
    expect(px(t, 2, 2)).toEqual([10, 200, 40, 100]);
    // 左上角 extrude：复制内容左上角像素，alpha 保留 100
    expect(px(t, 0, 0)).toEqual([10, 200, 40, 100]);
    expect(px(t, 1, 1)).toEqual([10, 200, 40, 100]);
    // 右边缘 extrude（不透明）
    expect(px(t, 7, 3)).toEqual([40, 200, 40, 255]);
    // 底边 extrude：左下内容像素
    expect(px(t, 2, 6)).toEqual([10, 200, 40, 100]);
    // 四角：左列条带拉通全高，角像素 = 内容左列对应边缘（半透明保留）
    expect(px(t, 0, 0)).toEqual([10, 200, 40, 100]);
    expect(px(t, 7, 0)).toEqual([40, 200, 40, 255]);
    expect(px(t, 0, 6)).toEqual([10, 200, 40, 100]);
    expect(px(t, 7, 6)).toEqual([40, 200, 40, 255]);
  });
});

describe('装箱布局', () => {
  const settings = { ...DEFAULT_SETTINGS, extrude: 1, padding: 1, border: 0, allowRotation: true, maxWidth: 64, maxHeight: 64 };

  it('超大帧进入 overflow 且不崩溃', () => {
    const big = sourceFrom(makeCanvas(100, 4, (x) => [x, 0, 0, 255]));
    const layout = computeLayout([big], settings);
    expect(layout.overflow).toContain(big.id);
    expect(layout.regions.filter((r) => r.sourceId === big.id && r.contentW > 0)).toHaveLength(0);
  });

  it('整帧透明源不产生装箱区域，但保留在结果中为 0×0', () => {
    const empty = sourceFrom(makeCanvas(20, 20));
    const layout = computeLayout([empty], settings);
    const region = layout.regions.find((r) => r.sourceId === empty.id)!;
    expect(region).toBeTruthy();
    expect(region.contentW).toBe(0);
    expect(region.contentH).toBe(0);
  });

  it('旋转区域 contentW/contentH 与 trim 互换且 rotate=6', () => {
    // 32×32 页：28×28 大方块占左上，右侧 4×28 条带放 20×4 窄条；
    // 窄条旋转成 4×20 后恰好进条带（不旋转 20 宽放不下）
    const block = sourceFrom(makeCanvas(28, 28, (x, y) => [x, y, 1, 255]), { id: 'block' });
    const strip = sourceFrom(makeCanvas(20, 4, (x, y) => [x, y, 2, 255]), { id: 'strip' });
    const settings = {
      ...DEFAULT_SETTINGS,
      extrude: 0,
      padding: 0,
      border: 0,
      allowRotation: true,
      maxWidth: 32,
      maxHeight: 32,
    };
    const layout = computeLayout([block, strip], settings);
    const stripRegion = layout.regions.find((r) => r.sourceId === strip.id)!;
    expect(stripRegion.rotated).toBe(true);
    expect(stripRegion.rotate).toBe(6);
    expect(stripRegion.contentW).toBe(4); // trim.h
    expect(stripRegion.contentH).toBe(20); // trim.w
    expect(layout.binBounds).toHaveLength(1); // 同页
  });
});

describe('图集渲染像素往返（trim + rotate + extrude/padding）', () => {
  it('正立区域：按 frame 取回的像素 == trim 内容', () => {
    const c = makeCanvas(12, 10, (x, y) => {
      // trim 内容 x 3..8, y 2..6
      if (x >= 3 && x <= 8 && y >= 2 && y <= 6) return [100 + x, 50 + y, 7, 255];
      return null;
    });
    const src = sourceFrom(c);
    const settings = { ...DEFAULT_SETTINGS, extrude: 2, padding: 1, allowRotation: false };
    const result = packProject([src], settings, new Map([[src.id, c as unknown as HTMLCanvasElement]]));
    expect(result.pages.length).toBe(1);
    const page = FakeCanvas.fromDataUrl(result.pages[0].dataUrl);
    const r = result.pages[0].regions[0];
    expect(r.rotated).toBe(false);
    // 逐像素
    for (let y = 0; y < src.trim.h; y++)
      for (let x = 0; x < src.trim.w; x++) {
        const got = px(page, r.contentX + x, r.contentY + y);
        const want = px(c, src.trim.x + x, src.trim.y + y);
        expect(got).toEqual(want);
      }
    // padding 留白：内容外 1 像素是透明的（extrude 之外）
    // 槽起点 = content - extrude - padding；槽左边缘应透明
    expect(px(page, r.x, r.contentY)[3]).toBe(0);
    // extrude 环紧贴内容：content 左侧 1 像素 == 内容左边缘
    expect(px(page, r.contentX - 1, r.contentY)).toEqual(
      px(c, src.trim.x, src.trim.y),
    );
  });

  it('旋转区域：按 rotate=6 映射取回的像素 == trim 内容', () => {
    // 28×28 方块 + 20×4 窄条，窄条旋转进右侧条带
    const blockC = makeCanvas(28, 28, (x, y) => [x, y, 1, 255]);
    const stripC = makeCanvas(20, 4, (x, y) => [(x * 11) & 255, (y * 50) & 255, 9, 255]);
    const block = sourceFrom(blockC, { id: 'block2' });
    const strip = sourceFrom(stripC, { id: 'strip2' });
    const settings = {
      ...DEFAULT_SETTINGS,
      extrude: 0,
      padding: 0,
      border: 0,
      allowRotation: true,
      maxWidth: 32,
      maxHeight: 32,
    };
    const result = packProject(
      [block, strip],
      settings,
      new Map([
        [block.id, blockC as unknown as HTMLCanvasElement],
        [strip.id, stripC as unknown as HTMLCanvasElement],
      ]),
    );
    expect(result.pages).toHaveLength(1);
    const page = FakeCanvas.fromDataUrl(result.pages[0].dataUrl);
    const r = result.pages[0].regions.find((x) => x.sourceId === strip.id)!;
    expect(r.rotated).toBe(true);

    // CCW 烘焙：orig(u,v) -> atlas(contentX + v, contentY + (trim.w-1) - u)
    for (let v = 0; v < strip.trim.h; v++)
      for (let u = 0; u < strip.trim.w; u++) {
        const ax = r.contentX + v;
        const ay = r.contentY + (strip.trim.w - 1) - u;
        expect(px(page, ax, ay)).toEqual(px(stripC, u, v));
      }
  });

  it('不同画布尺寸 + 非中心内容：orig 元数据保持各自尺寸', () => {
    const a = sourceFrom(makeCanvas(96, 96, (x, y) => (x > 80 && y > 80 ? [1, 2, 3, 255] : null)), { name: 'a.png' });
    const b = sourceFrom(makeCanvas(112, 104, (x, y) => (x < 10 && y < 10 ? [4, 5, 6, 255] : null)), { name: 'b.png' });
    const settings = { ...DEFAULT_SETTINGS, extrude: 1, padding: 1 };
    const result = packProject(
      [a, b],
      settings,
      new Map([
        [a.id, (a as unknown as { __canvas: FakeCanvas }).__canvas as unknown as HTMLCanvasElement],
        [b.id, (b as unknown as { __canvas: FakeCanvas }).__canvas as unknown as HTMLCanvasElement],
      ]),
    );
    const byId = new Map(result.pages.flatMap((p) => p.regions.map((r) => [r.sourceId, r])));
    expect(byId.get(a.id)).toBeTruthy();
    expect(byId.get(b.id)).toBeTruthy();
    // 原始尺寸只在 source 上（导出 JSON 中校验）
    expect(a.origWidth).toBe(96);
    expect(b.origWidth).toBe(112);
  });
});

describe('多页打包', () => {
  it('超出单页时自动分页，每个源只出现一次', () => {
    const sources: (FrameSource & { __canvas: FakeCanvas })[] = [];
    const map = new Map<string, HTMLCanvasElement>();
    for (let i = 0; i < 6; i++) {
      const c = makeCanvas(30, 30, (x, y) => [(i * 40 + x) & 255, y, 5, 255]);
      const s = sourceFrom(c, { id: `m${i}`, name: `m${i}.png` });
      sources.push(s);
      map.set(s.id, c as unknown as HTMLCanvasElement);
    }
    // 每页最多放 2 个 30x30（slot 32x32，extrude/padding=1）
    const settings = {
      ...DEFAULT_SETTINGS,
      extrude: 1,
      padding: 1,
      border: 0,
      allowRotation: false,
      maxWidth: 64,
      maxHeight: 64,
    };
    const result = packProject(sources, settings, map);
    expect(result.pages.length).toBeGreaterThan(1);
    const allSourceIds = result.pages.flatMap((p) => p.regions.map((r) => r.sourceId));
    expect(new Set(allSourceIds).size).toBe(allSourceIds.length);
    expect(allSourceIds.sort()).toEqual(sources.map((s) => s.id).sort());
  });
});

describe('导出与重导入', () => {
  it('JSON 含帧时长/事件/pivot/sourceSize，重导入后保持一致', async () => {
    const c = makeCanvas(10, 10, (x, y) => (x >= 2 && x <= 7 && y >= 2 && y <= 7 ? [10, 20, 30, 255] : null));
    const src = sourceFrom(c, { pivotX: 3, pivotY: 8, name: 'hero_01.png' });
    // 相同像素的第二个“源”模拟共享（导入时哈希去重在 stores 层；这里直接构造共享关系）
    const settings = { ...DEFAULT_SETTINGS, extrude: 2, padding: 1 };
    const result = packProject([src], settings, new Map([[src.id, c as unknown as HTMLCanvasElement]]));

    // 原始 dataURL（模拟 stores 的 dataUrlCache）
    const origDataUrls = new Map([[src.id, (c as unknown as FakeCanvas).toDataURL()]]);

    const frames = [
      { id: 'f1', sourceId: src.id, duration: 120, events: [{ id: 'e1', at: 0, name: 'hit' }] },
      { id: 'f2', sourceId: src.id, duration: 70, events: [] },
      { id: 'f3', sourceId: src.id, duration: 200, events: [{ id: 'e2', at: 50, name: 'end' }] },
    ];

    const meta = { id: 'p1', name: 'demo', updatedAt: 0 };
    const { json } = buildExport(meta, settings, frames, { [src.id]: src }, result, origDataUrls, {
      embedPages: true,
    });

    // 三个时间轴帧共享同一纹理 filename
    const names = new Set(json.timeline.map((t) => t.frame));
    expect(names.size).toBe(1);
    expect(json.timeline.map((t) => t.duration)).toEqual([120, 70, 200]);
    expect(json.timeline[0].events[0].name).toBe('hit');
    expect(json.timeline[2].events[0]).toMatchObject({ at: 50, name: 'end' });
    expect(json.frames[Array.from(names)[0]].sourceSize).toEqual({ w: 10, h: 10 });
    expect(json.frames[Array.from(names)[0]].pivot).toEqual({ x: 3, y: 8 });
    expect(json.sources[src.id].sharedByFrames).toBe(3);

    // 重导入
    const imported = await importAtlasJson(json);
    expect(imported.state.frames).toHaveLength(3);
    const restoredSrc = imported.state.sources[src.id];
    expect(restoredSrc).toBeTruthy();
    expect(restoredSrc.origWidth).toBe(10);
    expect({ x: restoredSrc.pivotX, y: restoredSrc.pivotY }).toEqual({ x: 3, y: 8 });
    expect(restoredSrc.trim).toMatchObject({ x: 2, y: 2, w: 6, h: 6, empty: false });
    expect(imported.state.frames.map((f) => f.duration)).toEqual([120, 70, 200]);
    expect(imported.state.frames[0].events[0].name).toBe('hit');
    expect(imported.state.frames[2].events[0].at).toBe(50);
    // 原始 Blob 也被带回
    expect(imported.origBlobs.has(src.id)).toBe(true);
    expect(imported.origBlobs.get(src.id)!.size).toBeGreaterThan(0);
  });

  it('整帧透明帧导出 0×0 条目且保留 sourceSize', () => {
    const c = makeCanvas(16, 12);
    const src = sourceFrom(c);
    const settings = { ...DEFAULT_SETTINGS };
    const result = packProject([src], settings, new Map([[src.id, c as unknown as HTMLCanvasElement]]));
    const origDataUrls = new Map([[src.id, c.toDataURL()]]);
    const frames = [{ id: 'f1', sourceId: src.id, duration: 90, events: [] }];
    const { json } = buildExport(
      { id: 'p', name: 'empty', updatedAt: 0 },
      settings,
      frames,
      { [src.id]: src },
      result,
      origDataUrls,
      { embedPages: false },
    );
    const frameEntry = Object.values(json.frames)[0];
    expect(frameEntry.frame).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(frameEntry.sourceSize).toEqual({ w: 16, h: 12 });
    expect(frameEntry.trimmed).toBe(true);
  });
});

describe('Blob -> Image -> Canvas 往返（图片不离开本地管线）', () => {
  it('toBlob 后经 loadImage 解码尺寸/像素一致', async () => {
    const c = makeCanvas(6, 5, (x, y) => [x * 40, y * 50, 33, 200]);
    const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve));
    expect(blob).toBeTruthy();
    const img = await loadImage(blob!);
    expect(img.naturalWidth).toBe(6);
    const back = imageToCanvas(img as unknown as HTMLImageElement) as unknown as FakeCanvas;
    expect(back.width).toBe(6);
    expect(px(back, 3, 2)).toEqual(px(c, 3, 2));
  });
});

// FakeCanvas 需能从 dataURL 解码（静态方法定义在 fake-dom 中）
