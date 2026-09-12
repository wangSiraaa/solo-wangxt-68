// 导入：无损重导入本工具导出的 JSON。
// 优先使用 studio.origImages 中的【原始图片】，重新计算 trim/hash，
// 保留原始画布尺寸与用户设置的 pivot；缺失时退回从图集页切图（仅可预览，有损）。
import type {
  FrameEntry,
  FrameSource,
  PackSettings,
  ProjectMeta,
  ProjectState,
} from './types';
import { analyzeImage, imageToCanvas, loadImageFromDataUrl, uid } from './imageUtils';
import type { AtlasJson } from './exporter';
import { DEFAULT_SETTINGS } from './types';

export interface ImportedProject {
  state: ProjectState;
  /** sourceId -> 原始图片 Blob（调用方负责写入 IDB 与缓存） */
  origBlobs: Map<string, Blob>;
  warnings: string[];
}

function dataUrlToBlob(url: string): Blob {
  const [head, body] = url.split(',');
  const mime = /data:(.*?);/.exec(head)?.[1] ?? 'image/png';
  const bin = atob(body);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

export async function importAtlasJson(
  json: AtlasJson,
  sidecarPages?: { name: string; dataUrl: string }[],
): Promise<ImportedProject> {
  const warnings: string[] = [];
  const studio = json.studio;
  if (!studio) {
    warnings.push('该 JSON 不是本工具导出的工程文件，缺少 studio 块，无法无损重导入。');
    throw new ImportError(warnings);
  }

  const settings: PackSettings = { ...DEFAULT_SETTINGS, ...studio.project.settings };
  const meta: ProjectMeta = { ...studio.project.meta, updatedAt: Date.now() };

  const origBlobs = new Map<string, string>();
  for (const [id, url] of Object.entries(studio.origImages ?? {})) {
    origBlobs.set(id, url);
  }

  // 重新分析原始图像：计算 trim/hash，但沿用导出 JSON 中的 pivot 与名称
  const sources: Record<string, FrameSource> = {};
  const blobs = new Map<string, Blob>();

  for (const [id, info] of Object.entries(json.sources ?? {})) {
    const url = origBlobs.get(id);
    if (!url) {
      warnings.push(`源 ${id} 缺少内嵌原始图片，已跳过。`);
      continue;
    }
    const img = await loadImageFromDataUrl(url);
    const canvas = imageToCanvas(img);
    const { trim, hash } = analyzeImage(canvas);
    const blob = dataUrlToBlob(url);
    blobs.set(id, blob);
    sources[id] = {
      id,
      hash,
      name: info.name || `${info.frame.split('#')[0] || id}.png`,
      origWidth: info.origWidth,
      origHeight: info.origHeight,
      trim,
      pivotX: info.pivot.x,
      pivotY: info.pivot.y,
      blobKey: `blob_${id}`,
      blobType: blob.type,
    };
  }

  // 恢复时间轴帧（重新生成 frame id，事件 id 保留稳定）
  const frames: FrameEntry[] = (json.timeline ?? [])
    .filter((t) => sources[t.sourceId])
    .map((t) => ({
      id: uid('frame'),
      sourceId: t.sourceId,
      duration: t.duration,
      events: t.events.map((e) => ({ ...e })),
    }));

  if (frames.length === 0) {
    warnings.push('时间轴为空。');
  }
  if (sidecarPages?.length) {
    warnings.push(`收到 ${sidecarPages.length} 张图集页；工程已从内嵌原始图片恢复，图集将重新生成。`);
  }

  return {
    state: { meta, settings, frames, sources, pack: null },
    origBlobs: blobs,
    warnings,
  };
}

export class ImportError extends Error {
  warnings: string[];
  constructor(warnings: string[]) {
    super(warnings.join(' '));
    this.warnings = warnings;
  }
}

export async function readFileAsText(file: File): Promise<string> {
  return file.text();
}

export async function readFileAsDataUrl(file: File | Blob): Promise<string> {
  const ab = await file.arrayBuffer();
  const bytes = new Uint8Array(ab);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const base64 = btoa(binary);
  return `data:${file.type || 'image/png'};base64,${base64}`;
}
