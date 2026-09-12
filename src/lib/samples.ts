// 内置示例素材生成器：纯 canvas 绘制，输出 PNG Blob，走和普通导入完全相同的流水线。
//
// 序列 A「发光弹球」128×128：弹球上下运动 + 缩放，边缘带径向渐变半透明光晕
// 序列 B「挥剑角色」不同画布尺寸（96×96 / 112×96 / 96×112 …），非中心 pivot
// 序列 C「闪烁星星」96×96：含两帧整帧透明（消失帧），并在重现时触发事件
import { uid } from './imageUtils';

export interface GeneratedImage {
  blob: Blob;
  name: string;
}

export interface GeneratedSequence {
  name: string;
  images: GeneratedImage[];
  /** 每帧时长 ms */
  durations: number[];
  /** 事件：帧序号 -> 事件名 */
  events: Record<number, string>;
  /** 可选自定义 pivot（原始画布坐标） */
  pivot?: { x: number; y: number };
}

function canvasToBlob(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob 失败'))), 'image/png');
  });
}

/** 径向渐变半透明圆（验证：透明裁边保留半透明边缘 + 扩色不串色） */
function drawGlowBall(frame: number, n: number): HTMLCanvasElement {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const t = frame / (n - 1);
  const cy = 28 + Math.sin(t * Math.PI) * 56;
  const r = 22 + Math.sin(t * Math.PI * 2) * 3;

  const glow = ctx.createRadialGradient(64, cy, r * 0.3, 64, cy, r * 2);
  glow.addColorStop(0, 'rgba(120,220,255,0.95)');
  glow.addColorStop(0.45, 'rgba(80,160,255,0.45)');
  glow.addColorStop(1, 'rgba(40,80,200,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(64, cy, r * 2, 0, Math.PI * 2);
  ctx.fill();

  const core = ctx.createRadialGradient(60, cy - 6, 2, 64, cy, r);
  core.addColorStop(0, 'rgba(255,255,255,1)');
  core.addColorStop(1, 'rgba(90,170,255,1)');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(64, cy, r, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

/** 不同画布尺寸的挥剑角色（验证：trim 后 pivot 仍在原始画布坐标系中正确） */
function drawSword(frame: number, n: number): HTMLCanvasElement {
  // 每帧使用不同的画布尺寸，内容在画布中的位置也不同
  const widths = [96, 104, 112, 112, 104, 96];
  const heights = [96, 96, 104, 112, 112, 104];
  const w = widths[frame % widths.length];
  const h = heights[frame % heights.length];
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const t = frame / (n - 1);
  const cx = w / 2;
  const cy = h - 34; // 角色脚附近
  const angle = -1.2 + t * 2.4;

  // 身体（带抗锯齿半透明边缘）
  ctx.fillStyle = 'rgba(235,120,80,0.95)';
  ctx.beginPath();
  ctx.arc(cx, cy - 14, 13, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(cx - 8, cy - 2, 16, 22);

  // 剑：绕 pivot（角色中心）旋转，抗锯齿
  ctx.save();
  ctx.translate(cx, cy - 6);
  ctx.rotate(angle);
  const blade = ctx.createLinearGradient(0, 0, 34, 0);
  blade.addColorStop(0, 'rgba(220,220,235,1)');
  blade.addColorStop(1, 'rgba(160,180,255,0.85)');
  ctx.fillStyle = blade;
  ctx.fillRect(4, -2.5, 34, 5);
  ctx.fillStyle = 'rgba(90,70,50,1)';
  ctx.fillRect(-4, -4, 8, 8);
  ctx.restore();

  return c;
}

/** 星星闪烁，含整帧透明帧（验证：空帧保留原始画布尺寸、不占图集像素） */
function drawStar(frame: number, n: number): HTMLCanvasElement {
  const size = 96;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  // 第 2、7 帧整帧透明（星星消失）
  const invisible = frame === 2 || frame === 7;
  if (invisible) return c;

  const t = frame / (n - 1);
  const scale = 0.7 + 0.3 * Math.sin(t * Math.PI * 3);
  const alpha = 0.55 + 0.45 * Math.sin(t * Math.PI * 3);
  ctx.translate(size / 2, size / 2);
  ctx.scale(scale, scale);
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 30 : 12;
    const a = (i * Math.PI) / 5 - Math.PI / 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = `rgba(255,220,90,${Math.max(0.15, alpha)})`;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,160,40,0.5)';
  ctx.lineWidth = 2;
  ctx.stroke();
  return c;
}

async function sequenceFromDraw(
  name: string,
  n: number,
  draw: (frame: number, n: number) => HTMLCanvasElement,
  durations: number[],
  events: Record<number, string>,
  pivot?: { x: number; y: number },
): Promise<GeneratedSequence> {
  const images: GeneratedImage[] = [];
  for (let i = 0; i < n; i++) {
    const c = draw(i, n);
    images.push({ blob: await canvasToBlob(c), name: `${name}_${String(i + 1).padStart(2, '0')}.png` });
  }
  return { name, images, durations, events, pivot };
}

export async function generateSamples(): Promise<GeneratedSequence[]> {
  const a = await sequenceFromDraw(
    'glow_ball',
    10,
    drawGlowBall,
    Array(10).fill(110),
    { 0: 'spawn', 9: 'despawn' },
  );
  const b = await sequenceFromDraw(
    'sword',
    8,
    drawSword,
    Array(8).fill(90),
    { 0: 'windup', 4: 'strike' },
  );
  const c = await sequenceFromDraw(
    'star',
    10,
    drawStar,
    Array(10).fill(130),
    { 3: 'reappear', 8: 'reappear' },
  );
  return [a, b, c];
}

export { uid };
