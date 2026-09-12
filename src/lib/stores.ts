// 中央状态：Svelte store + 源图像的内存缓存（canvas / dataURL / Pixi texture）
import { writable, derived, get } from 'svelte/store';
import type {
  FrameEntry,
  FrameSource,
  PackResult,
  PackSettings,
  ProjectState,
  TimelineEvent,
} from './types';
import { DEFAULT_SETTINGS } from './types';
import { analyzeImage, imageToCanvas, loadImage, uid } from './imageUtils';
import { packProject } from './packer';
import { gcBlobs, getBlob, saveProject, setBlob } from './storage';

function createMeta() {
  return { id: uid('proj'), name: '未命名动画', updatedAt: Date.now() };
}

const initial: ProjectState = {
  meta: createMeta(),
  settings: { ...DEFAULT_SETTINGS },
  frames: [],
  sources: {},
  pack: null,
};

export const project = writable<ProjectState>(initial);
export const selectedFrameId = writable<string | null>(null);
export const previewFrameIndex = writable(0);
export const isPlaying = writable(true);
export const busy = writable(false);
export const toast = writable<{ text: string; kind: 'info' | 'error' } | null>(null);

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function showToast(text: string, kind: 'info' | 'error' = 'info'): void {
  toast.set({ text, kind });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.set(null), 3200);
}

// ---------- 非响应式缓存 ----------

const canvasCache = new Map<string, HTMLCanvasElement>(); // sourceId -> 原始画布
const dataUrlCache = new Map<string, string>(); // sourceId -> 原始 PNG dataURL

export function getSourceCanvas(id: string): HTMLCanvasElement | undefined {
  return canvasCache.get(id);
}
export function getSourceDataUrl(id: string): string | undefined {
  return dataUrlCache.get(id);
}
export function putSourceCanvas(id: string, c: HTMLCanvasElement): void {
  canvasCache.set(id, c);
}

export function usedSourceList(state: ProjectState): FrameSource[] {
  const used = new Set(state.frames.map((f) => f.sourceId));
  return Object.values(state.sources).filter((s) => used.has(s.id));
}

// ---------- 导入图片 ----------

export interface ImportedAsset {
  blob: Blob;
  name: string;
  duration?: number;
  events?: Record<number, string>;
  index?: number;
}

/**
 * 导入一批图片：按像素哈希去重，相同像素共享同一个 FrameSource（共享纹理区域），
 * 每个文件仍生成独立的时间轴帧（时长 / 事件独立）。
 */
export async function importAssets(assets: ImportedAsset[]): Promise<void> {
  busy.set(true);
  try {
    const state = get(project);
    const sources = { ...state.sources };
    const hashToSourceId = new Map<string, string>();
    for (const s of Object.values(sources)) hashToSourceId.set(s.hash, s.id);

    const newFrames: FrameEntry[] = [];
    for (let i = 0; i < assets.length; i++) {
      const a = assets[i];
      const img = await loadImage(a.blob);
      const canvas = imageToCanvas(img);
      const { trim, hash } = analyzeImage(canvas);

      let sourceId = hashToSourceId.get(hash);
      if (!sourceId) {
        sourceId = uid('src');
        const dataUrl = canvas.toDataURL('image/png');
        const source: FrameSource = {
          id: sourceId,
          hash,
          name: a.name,
          origWidth: canvas.width,
          origHeight: canvas.height,
          trim,
          pivotX: canvas.width / 2,
          pivotY: canvas.height / 2,
          blobKey: `blob_${sourceId}`,
          blobType: a.blob.type || 'image/png',
        };
        sources[sourceId] = source;
        hashToSourceId.set(hash, sourceId);
        canvasCache.set(sourceId, canvas);
        dataUrlCache.set(sourceId, dataUrl);
        await setBlob(source.blobKey, a.blob);
      }

      const evs: TimelineEvent[] = Object.entries(a.events ?? {}).map(([at, name]) => ({
        id: uid('evt'),
        at: Number(at),
        name,
      }));
      newFrames.push({
        id: uid('frame'),
        sourceId,
        duration: a.duration ?? 100,
        events: evs,
      });
    }

    project.update((s) => {
      const frames =
        newFrames[0] && assets[0].index !== undefined
          ? insertFramesAt(s.frames, newFrames, assets[0].index!)
          : [...s.frames, ...newFrames];
      return { ...s, sources, frames, meta: touch(s.meta) };
    });
    await persist();
    showToast(`导入 ${assets.length} 张，新增源 ${new Set(newFrames.map((f) => f.sourceId)).size} 个（相同像素自动共享）`);
  } catch (e) {
    showToast(`导入失败：${(e as Error).message}`, 'error');
  } finally {
    busy.set(false);
  }
}

function insertFramesAt(frames: FrameEntry[], add: FrameEntry[], at: number): FrameEntry[] {
  const out = [...frames];
  out.splice(Math.max(0, Math.min(at, out.length)), 0, ...add);
  return out;
}

function touch(meta: ProjectState['meta']): ProjectState['meta'] {
  return { ...meta, updatedAt: Date.now() };
}

// ---------- 帧编辑 ----------

export async function removeFrame(frameId: string): Promise<void> {
  project.update((s) => {
    const frames = s.frames.filter((f) => f.id !== frameId);
    const sources = gcSources(s.sources, frames);
    return { ...s, frames, sources, meta: touch(s.meta) };
  });
  selectedFrameId.update((id) => (id === frameId ? null : id));
  await persist();
}

export async function duplicateFrame(frameId: string): Promise<void> {
  project.update((s) => {
    const idx = s.frames.findIndex((f) => f.id === frameId);
    if (idx < 0) return s;
    const src = s.frames[idx];
    const copy: FrameEntry = {
      ...src,
      id: uid('frame'),
      events: src.events.map((e) => ({ ...e, id: uid('evt') })),
    };
    const frames = [...s.frames];
    frames.splice(idx + 1, 0, copy);
    return { ...s, frames, meta: touch(s.meta) };
  });
  await persist();
}

export async function moveFrame(frameId: string, delta: number): Promise<void> {
  project.update((s) => {
    const idx = s.frames.findIndex((f) => f.id === frameId);
    const j = idx + delta;
    if (idx < 0 || j < 0 || j >= s.frames.length) return s;
    const frames = [...s.frames];
    const [item] = frames.splice(idx, 1);
    frames.splice(j, 0, item);
    return { ...s, frames, meta: touch(s.meta) };
  });
  await persist();
}

export async function setFrameDuration(frameId: string, duration: number): Promise<void> {
  project.update((s) => ({
    ...s,
    frames: s.frames.map((f) => (f.id === frameId ? { ...f, duration: Math.max(1, duration) } : f)),
    meta: touch(s.meta),
  }));
  await persist();
}

export async function addFrameEvent(frameId: string, name: string, at: number): Promise<void> {
  project.update((s) => ({
    ...s,
    frames: s.frames.map((f) =>
      f.id === frameId ? { ...f, events: [...f.events, { id: uid('evt'), name, at }] } : f,
    ),
    meta: touch(s.meta),
  }));
  await persist();
}

export async function removeFrameEvent(frameId: string, eventId: string): Promise<void> {
  project.update((s) => ({
    ...s,
    frames: s.frames.map((f) =>
      f.id === frameId ? { ...f, events: f.events.filter((e) => e.id !== eventId) } : f,
    ),
    meta: touch(s.meta),
  }));
  await persist();
}

// ---------- 源编辑（pivot 在原始画布坐标系） ----------

export async function setPivot(sourceId: string, x: number, y: number): Promise<void> {
  project.update((s) => {
    const src = s.sources[sourceId];
    if (!src) return s;
    return {
      ...s,
      sources: { ...s.sources, [sourceId]: { ...src, pivotX: x, pivotY: y } },
      meta: touch(s.meta),
    };
  });
  await persist();
}

export async function resetPivot(sourceId: string): Promise<void> {
  const s = get(project);
  const src = s.sources[sourceId];
  if (src) await setPivot(sourceId, src.origWidth / 2, src.origHeight / 2);
}

function gcSources(
  sources: Record<string, FrameSource>,
  frames: FrameEntry[],
): Record<string, FrameSource> {
  const used = new Set(frames.map((f) => f.sourceId));
  const out: Record<string, FrameSource> = {};
  for (const [id, src] of Object.entries(sources)) {
    if (used.has(id)) {
      out[id] = src;
    } else {
      canvasCache.delete(id);
      dataUrlCache.delete(id);
    }
  }
  return out;
}

// ---------- 设置 ----------

export async function updateSettings(patch: Partial<PackSettings>): Promise<void> {
  project.update((s) => ({ ...s, settings: { ...s.settings, ...patch }, meta: touch(s.meta) }));
  await persist();
}

// ---------- 打包 ----------

export async function repack(): Promise<void> {
  busy.set(true);
  try {
    const s = get(project);
    const list = usedSourceList(s);
    const map = new Map<string, HTMLCanvasElement>();
    for (const src of list) {
      const c = canvasCache.get(src.id);
      if (c) map.set(src.id, c);
    }
    // 让重排有机会先绘制
    await new Promise((r) => setTimeout(r, 0));
    const result: PackResult = await new Promise((resolve) =>
      setTimeout(() => resolve(packProject(list, s.settings, map)), 0),
    );
    project.update((st) => ({ ...st, pack: result, meta: touch(st.meta) }));
    if (result.overflow.length) {
      showToast(`有 ${result.overflow.length} 个源过大未能装入`, 'error');
    }
  } catch (e) {
    showToast(`打包失败：${(e as Error).message}`, 'error');
  } finally {
    busy.set(false);
  }
}

// ---------- 持久化 ----------

let saveTimer: ReturnType<typeof setTimeout> | undefined;
export async function persist(): Promise<void> {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const s = get(project);
    try {
      await saveProject(s);
      const list = Object.values(s.sources);
      await gcBlobs(list);
    } catch (e) {
      showToast(`自动保存失败：${(e as Error).message}`, 'error');
    }
  }, 400);
}

export async function hydrate(state: ProjectState): Promise<void> {
  project.set(state);
  previewFrameIndex.set(0);
  selectedFrameId.set(state.frames[0]?.id ?? null);
  // 从 IDB 恢复原始图片缓存
  for (const src of Object.values(state.sources)) {
    if (canvasCache.has(src.id)) continue;
    const blob = await getBlob(src.blobKey);
    if (blob) {
      const img = await loadImage(blob);
      const canvas = imageToCanvas(img);
      canvasCache.set(src.id, canvas);
      dataUrlCache.set(src.id, canvas.toDataURL('image/png'));
    }
  }
}

// ---------- 派生 ----------

export const frameList = derived(project, (s) => s.frames);
export const sourceMap = derived(project, (s) => s.sources);
export const totalDuration = derived(project, (s) =>
  s.frames.reduce((sum, f) => sum + f.duration, 0),
);

export function sourceById(sources: Record<string, FrameSource>, id: string): FrameSource | undefined {
  return sources[id];
}
