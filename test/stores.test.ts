// stores 集成测试：相同像素去重共享源、独立时长/事件、自动持久化
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { FakeCanvas } from './fake-dom';
import { importAssets, project, repack, setPivot } from '../src/lib/stores';

function canvasBlob(c: FakeCanvas): Blob {
  const bytes = c.toDataURL().split(',')[1];
  const bin = atob(bytes);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: 'application/x-fake-canvas' });
}

describe('stores：导入/去重/共享/打包', () => {
  beforeEach(() => {
    project.set({
      meta: { id: 'test', name: 't', updatedAt: 0 },
      settings: {
        maxWidth: 256, maxHeight: 256, allowRotation: true, extrude: 1,
        padding: 1, border: 0, pot: false, square: false, scale: 1,
      },
      frames: [],
      sources: {},
      pack: null,
    });
  });

  it('相同像素的多张图片共享一个源，但帧时长/事件独立', async () => {
    const mk = () => {
      const c = new FakeCanvas(8, 8);
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          const i = (y * 8 + x) * 4;
          c.data[i] = x * 30;
          c.data[i + 1] = y * 30;
          c.data[i + 3] = 255;
        }
      return c;
    };
    const blob = canvasBlob(mk());
    await importAssets([
      { blob, name: 'a.png', duration: 100, events: { 0: 'hit' } },
      { blob, name: 'b.png', duration: 250 },
      { blob, name: 'c.png', duration: 400, events: { 30: 'end' } },
    ]);
    const s = get(project);
    expect(s.frames).toHaveLength(3);
    expect(Object.keys(s.sources)).toHaveLength(1); // 共享
    const sourceId = s.frames[0].sourceId;
    expect(s.frames.every((f) => f.sourceId === sourceId)).toBe(true);
    expect(s.frames.map((f) => f.duration)).toEqual([100, 250, 400]);
    expect(s.frames[0].events.map((e) => e.name)).toEqual(['hit']);
    expect(s.frames[1].events).toHaveLength(0);
    expect(s.frames[2].events.map((e) => e.name)).toEqual(['end']);

    // pivot 在原始画布坐标系，默认中心
    const src = s.sources[sourceId];
    expect(src.pivotX).toBe(4);
    await setPivot(sourceId, 1, 6);
    expect(get(project).sources[sourceId].pivotX).toBe(1);

    // 打包：一个源只占一个图集区域
    await repack();
    const pack = get(project).pack!;
    expect(pack.pages.length).toBeGreaterThanOrEqual(1);
    const totalRegions = pack.pages.reduce((n, p) => n + p.regions.filter((r) => r.contentW > 0).length, 0);
    expect(totalRegions).toBe(1);
  });

  it('不同像素不共享；整帧透明帧不占区域', async () => {
    const c1 = new FakeCanvas(6, 6);
    c1.data.fill(255);
    c1.data.fill(0);
    for (let i = 0; i < 6 * 6; i++) {
      c1.data[i * 4] = 10;
      c1.data[i * 4 + 3] = 255;
    }
    const c2 = new FakeCanvas(6, 6); // 全透明
    const c3 = new FakeCanvas(6, 6);
    for (let i = 0; i < 6 * 6; i++) {
      c3.data[i * 4 + 1] = 99;
      c3.data[i * 4 + 3] = 255;
    }
    await importAssets([
      { blob: canvasBlob(c1), name: 'a.png' },
      { blob: canvasBlob(c2), name: 'empty.png' },
      { blob: canvasBlob(c3), name: 'b.png' },
    ]);
    const s = get(project);
    expect(Object.keys(s.sources)).toHaveLength(3);
    await repack();
    const pack = get(project).pack!;
    const regions = pack.pages.flatMap((p) => p.regions);
    const nonEmpty = regions.filter((r) => r.contentW > 0);
    expect(nonEmpty).toHaveLength(2);
    const emptySrc = Object.values(s.sources).find((x) => x.trim.empty)!;
    expect(emptySrc).toBeTruthy();
    const emptyRegion = regions.find((r) => r.sourceId === emptySrc.id)!;
    expect(emptyRegion.contentW).toBe(0);
    // 整帧透明仍保留原始画布尺寸
    expect(emptySrc.origWidth).toBe(6);
    expect(emptySrc.origHeight).toBe(6);
  });
});
