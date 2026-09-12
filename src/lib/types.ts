// 核心数据模型
// 设计要点：
// - Frame（时间轴帧）只存 sourceId / duration / events，源图像与轴心在 FrameSource 上
// - 相同像素（同 hash）的多个时间轴帧共享同一个 FrameSource，即共享纹理区域，
//   但每帧的 duration 与 events 仍然独立
// - trim 只记录透明裁边的结果，orig 永远保留原始画布尺寸，pivot 位于原始画布坐标系

export interface TimelineEvent {
  id: string;
  /** 触发时间（毫秒，相对该动画片段开头） */
  at: number;
  name: string;
}

export interface TrimRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 整帧透明：没有任何不透明像素 */
  empty: boolean;
}

export interface FrameSource {
  id: string;
  /** 原始像素哈希，相同哈希共享纹理区域 */
  hash: string;
  name: string;
  origWidth: number;
  origHeight: number;
  trim: TrimRect;
  /** 旋转中心，坐标位于【原始画布】坐标系，默认画布中心 */
  pivotX: number;
  pivotY: number;
  /** IndexedDB 中原始图片 Blob 的 key（sources store） */
  blobKey: string;
  blobType: string;
}

export interface FrameEntry {
  id: string;
  /** 引用 FrameSource.id；多个帧可引用同一 source 实现纹理共享 */
  sourceId: string;
  /** 帧时长（毫秒），相同纹理的帧各自独立 */
  duration: number;
  /** 该帧触发的事件（独立于纹理共享） */
  events: TimelineEvent[];
}

export interface PackSettings {
  maxWidth: number;
  maxHeight: number;
  /** 允许 90° 旋转装箱 */
  allowRotation: boolean;
  /** 边缘扩色像素：把边缘像素向外复制，防止缩小采样时邻帧颜色渗入 */
  extrude: number;
  /** 透明留白像素：块与块之间额外的纯透明间隙（独立于边缘扩色） */
  padding: number;
  /** 图集页边距 */
  border: number;
  /** Power-of-two 尺寸 */
  pot: boolean;
  /** 方形图集 */
  square: boolean;
  /** 引擎运行时的缩放采样系数（如 0.5 表示缩小显示），写入元数据供扩色参考 */
  scale: number;
}

export const DEFAULT_SETTINGS: PackSettings = {
  maxWidth: 4096,
  maxHeight: 4096,
  allowRotation: true,
  extrude: 2,
  padding: 1,
  border: 0,
  pot: false,
  square: false,
  scale: 1,
};

export interface ProjectMeta {
  id: string;
  name: string;
  updatedAt: number;
}

// ---------- 打包结果 ----------

/** 一个 FrameSource 在某一页图集里的区域（相同哈希只出现一次） */
export interface PackedRegion {
  sourceId: string;
  page: number;
  /** 图集内分配到的矩形（含 extrude + padding 占位） */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 实际绘制内容（trim 后）的矩形；empty 源时为 0×0 */
  contentX: number;
  contentY: number;
  contentW: number;
  contentH: number;
  /** 该矩形是否被旋转 90°（矩形交换宽高后的装箱标记） */
  rotated: boolean;
  /** 纹理旋转方向约定：0=不旋转，6=内容在图集中逆时针 90°（TexturePacker / PixiJS groupD8.N 约定） */
  rotate: 0 | 6;
  oversized: boolean;
}

export interface PackedPage {
  index: number;
  width: number;
  height: number;
  /** canvas.toDataURL('image/png')，供预览 / 嵌入导出 */
  dataUrl: string;
  regions: PackedRegion[];
}

export interface PackResult {
  pages: PackedPage[];
  /** 未能装入的 sourceId（超大或超限） */
  overflow: string[];
  at: number;
}

// ---------- 项目持久化 ----------

export interface ProjectState {
  meta: ProjectMeta;
  settings: PackSettings;
  frames: FrameEntry[];
  sources: Record<string, FrameSource>;
  pack: PackResult | null;
}
