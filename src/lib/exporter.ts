// 导出 / 导入
//
// 导出物：
//   <name>.atlas.json   —— 元数据（引擎可用 + studio 自描述，可无损重导入）
//   <name>-0.png …      —— 图集页图片（embedPages=false 时；否则 JSON 内嵌）
// JSON 同时内嵌【原始图片】（studio.origImages），重导入时不需要 PNG 也能完整恢复工程。
//
// 帧数据结构兼容 TexturePacker 常用约定：
//   frame:    图集中的像素包围盒（旋转时宽高互换）
//   rotated:  内容在图集中逆时针烘焙 90°（rotate=6 / groupD8.N）
//   trim:     内容相对原始画布的包围盒（原始画布坐标系）
//   spriteSourceSize = trim
//   sourceSize: {w,h} 原始画布尺寸
import type {
  FrameEntry,
  FrameSource,
  PackResult,
  PackSettings,
  ProjectMeta,
} from './types';

export const FORMAT_VERSION = 1;

export interface ExportOptions {
  /** 把图集页 PNG 内嵌进 JSON（单文件分发），同时仍可单独下载 PNG */
  embedPages: boolean;
}

export interface ExportFile {
  name: string;
  /** dataURL 或文本 */
  content: string;
  mime: string;
  isText: boolean;
}

interface JsonFrame {
  filename: string;
  frame: { x: number; y: number; w: number; h: number };
  rotated: boolean;
  trimmed: boolean;
  spriteSourceSize: { x: number; y: number; w: number; h: number };
  sourceSize: { w: number; h: number };
  pivot: { x: number; y: number };
}

interface JsonTimelineFrame {
  frame: string; // frames[].filename
  sourceId: string;
  duration: number;
  events: { id: string; at: number; name: string }[];
}

interface StudioBlock {
  format: 'sprite-atlas-studio';
  version: number;
  exportedAt: number;
  project: {
    meta: ProjectMeta;
    settings: PackSettings;
  };
  /** sourceId -> 原始图片 dataURL，用于无损重导入 */
  origImages: Record<string, string>;
  /** 内嵌图集页（可选） */
  pages?: { index: number; uri: string; width: number; height: number }[];
}

export interface AtlasJson {
  meta: {
    app: string;
    version: string;
    image: string[];
    scale: number;
    size: { w: number; h: number }[];
    extrude: number;
    padding: number;
    rotateConvention: 'CCW_90=groupD8.N(6)';
  };
  frames: Record<string, JsonFrame>;
  sources: Record<
    string,
    {
      name: string;
      hash: string;
      frame: string;
      origWidth: number;
      origHeight: number;
      trim: { x: number; y: number; w: number; h: number; empty: boolean };
      pivot: { x: number; y: number };
      sharedByFrames: number;
    }
  >;
  timeline: JsonTimelineFrame[];
  studio?: StudioBlock;
}

export function buildExport(
  meta: ProjectMeta,
  settings: PackSettings,
  frames: FrameEntry[],
  sources: Record<string, FrameSource>,
  pack: PackResult,
  origDataUrls: Map<string, string>,
  options: ExportOptions,
): { json: AtlasJson; pngs: { index: number; dataUrl: string }[] } {
  const usedSourceIds = new Set(frames.map((f) => f.sourceId));
  const shareCount = new Map<string, number>();
  for (const f of frames) shareCount.set(f.sourceId, (shareCount.get(f.sourceId) ?? 0) + 1);

  const jsonFrames: Record<string, JsonFrame> = {};
  const jsonSources: AtlasJson['sources'] = {};

  // filename 规则：<sourceId> 唯一；同一 source 的多个时间轴帧指向同一 filename
  const sourceFilename = new Map<string, string>();

  for (const page of pack.pages) {
    for (const region of page.regions) {
      const src = sources[region.sourceId];
      if (!src) continue;
      const filename = `${src.name.replace(/\.png$/i, '')}#${src.id.slice(-6)}`;
      sourceFilename.set(src.id, filename);
      jsonFrames[filename] = {
        filename,
        frame: { x: region.contentX, y: region.contentY, w: region.contentW, h: region.contentH },
        rotated: region.rotated,
        trimmed: !src.trim.empty && (src.trim.w !== src.origWidth || src.trim.h !== src.origHeight),
        spriteSourceSize: src.trim.empty
          ? { x: 0, y: 0, w: 0, h: 0 }
          : { x: src.trim.x, y: src.trim.y, w: src.trim.w, h: src.trim.h },
        sourceSize: { w: src.origWidth, h: src.origHeight },
        pivot: { x: src.pivotX, y: src.pivotY },
      };
    }
  }

  for (const [id, src] of Object.entries(sources)) {
    if (!usedSourceIds.has(id)) continue;
    jsonSources[id] = {
      name: src.name,
      hash: src.hash,
      frame: sourceFilename.get(id) ?? '',
      origWidth: src.origWidth,
      origHeight: src.origHeight,
      trim: src.trim,
      pivot: { x: src.pivotX, y: src.pivotY },
      sharedByFrames: shareCount.get(id) ?? 0,
    };
  }

  // 整帧透明帧也要在 frames 表中有条目（0×0，无图集区域）
  for (const [id, src] of Object.entries(sources)) {
    if (!usedSourceIds.has(id) || !src.trim.empty) continue;
    const filename = `${src.name.replace(/\.png$/i, '')}#${src.id.slice(-6)}`;
    sourceFilename.set(id, filename);
    jsonFrames[filename] = {
      filename,
      frame: { x: 0, y: 0, w: 0, h: 0 },
      rotated: false,
      trimmed: true,
      spriteSourceSize: { x: 0, y: 0, w: 0, h: 0 },
      sourceSize: { w: src.origWidth, h: src.origHeight },
      pivot: { x: src.pivotX, y: src.pivotY },
    };
  }

  const timeline: JsonTimelineFrame[] = frames.map((f) => ({
    frame: sourceFilename.get(f.sourceId) ?? '',
    sourceId: f.sourceId,
    duration: f.duration,
    events: f.events,
  }));

  const imageNames = pack.pages.map((p) => `${meta.name}-${p.index}.png`);

  const origImages: Record<string, string> = {};
  for (const id of usedSourceIds) {
    const url = origDataUrls.get(id);
    if (url) origImages[id] = url;
  }

  const json: AtlasJson = {
    meta: {
      app: 'sprite-atlas-studio',
      version: String(FORMAT_VERSION),
      image: imageNames,
      scale: settings.scale,
      size: pack.pages.map((p) => ({ w: p.width, h: p.height })),
      extrude: settings.extrude,
      padding: settings.padding,
      rotateConvention: 'CCW_90=groupD8.N(6)',
    },
    frames: jsonFrames,
    sources: jsonSources,
    timeline,
    studio: {
      format: 'sprite-atlas-studio',
      version: FORMAT_VERSION,
      exportedAt: Date.now(),
      project: {
        meta: { ...meta, updatedAt: Date.now() },
        settings,
      },
      origImages,
      pages: options.embedPages
        ? pack.pages.map((p) => ({ index: p.index, uri: p.dataUrl, width: p.width, height: p.height }))
        : undefined,
    },
  };

  return { json, pngs: pack.pages.map((p) => ({ index: p.index, dataUrl: p.dataUrl })) };
}

export function downloadFile(file: ExportFile): void {
  const a = document.createElement('a');
  a.href = file.content;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function jsonToText(json: AtlasJson): string {
  return JSON.stringify(json, null, 2);
}
