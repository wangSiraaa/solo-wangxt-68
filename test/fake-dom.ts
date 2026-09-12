// 内存版 Canvas/Image 模拟（无 node-canvas 依赖）。
// - FakeCanvas 持有 RGBA Uint8ClampedArray
// - FakeContext 支持 save/restore/translate/rotate/scale 仿射栈与
//   drawImage 的 3/5/9 参数（源裁剪 + 目标变换），正向最近邻映射，
//   对 1:1 复制与 90° 整数旋转逐像素精确
// - toDataURL/toBlob 使用自定义二进制容器，FakeImage 可解码，
//   从而完整走通 源图 -> dataURL -> Blob -> Image -> canvas 管线

const MAGIC = 'FAC1'; // fake atlas canvas v1

// ---------- 2D 仿射矩阵 [a c e; b d f] ----------
class M {
  constructor(
    public a = 1,
    public b = 0,
    public c = 0,
    public d = 1,
    public e = 0,
    public f = 0,
  ) {}
  clone(): M {
    return new M(this.a, this.b, this.c, this.d, this.e, this.f);
  }
  multiply(o: M): M {
    const { a, b, c, d, e, f } = this;
    return new M(
      a * o.a + c * o.b,
      b * o.a + d * o.b,
      a * o.c + c * o.d,
      b * o.c + d * o.d,
      a * o.e + c * o.f + e,
      b * o.e + d * o.f + f,
    );
  }
  static translate(x: number, y: number): M {
    return new M(1, 0, 0, 1, x, y);
  }
  static rotate(rad: number): M {
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return new M(cos, sin, -sin, cos, 0, 0);
  }
  static scale(sx: number, sy: number): M {
    return new M(sx, 0, 0, sy, 0, 0);
  }
  apply(x: number, y: number): [number, number] {
    return [this.a * x + this.c * y + this.e, this.b * x + this.d * y + this.f];
  }
}

export class FakeImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  constructor(width: number, height: number, data?: Uint8ClampedArray) {
    this.width = width;
    this.height = height;
    this.data = data ?? new Uint8ClampedArray(width * height * 4);
  }
}

export class FakeContext {
  imageSmoothingEnabled = false;
  private stack: M[] = [new M()];
  constructor(public canvas: FakeCanvas) {}
  private get m(): M {
    return this.stack[this.stack.length - 1];
  }
  private set m(v: M) {
    this.stack[this.stack.length - 1] = v;
  }
  save(): void {
    this.stack.push(this.m.clone());
  }
  restore(): void {
    if (this.stack.length > 1) this.stack.pop();
  }
  translate(x: number, y: number): void {
    this.m = this.m.multiply(M.translate(x, y));
  }
  rotate(rad: number): void {
    this.m = this.m.multiply(M.rotate(rad));
  }
  scale(sx: number, sy: number): void {
    this.m = this.m.multiply(M.scale(sx, sy));
  }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.m = new M(a, b, c, d, e, f);
  }
  resetTransform(): void {
    this.m = new M();
  }

  drawImage(src: FakeCanvas, ...args: number[]): void {
    let sx = 0;
    let sy = 0;
    let sw = src.width;
    let sh = src.height;
    let dx = 0;
    let dy = 0;
    let dw = src.width;
    let dh = src.height;
    if (args.length === 2) {
      dx = args[0];
      dy = args[1];
    } else if (args.length === 4) {
      dx = args[0];
      dy = args[1];
      dw = args[2];
      dh = args[3];
    } else if (args.length === 8) {
      // drawImage(image, sx,sy,sw,sh, dx,dy,dw,dh)：除 image 外 8 个数字
      [sx, sy, sw, sh, dx, dy, dw, dh] = args;
    }
    const dst = this.canvas.data;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const sdata = src.data;
    const SW = src.width;

    // canvas 2D 列主序矩阵 [a c e; b d f]（y 轴向下），逆矩阵：
    //   [d  -c  cf-de] / det
    //   [-b  a  be-af] / det
    const m = this.m;
    const det = m.a * m.d - m.b * m.c;
    if (Math.abs(det) < 1e-12) return;
    const invA = m.d / det;
    const invB = -m.b / det;
    const invC = -m.c / det;
    const invD = m.a / det;
    const invE = (m.c * m.f - m.d * m.e) / det;
    const invF = (m.b * m.e - m.a * m.f) / det;

    // 目标包围盒（变换后可能旋转）：扫描四个角的 AABB
    const corners = [
      m.apply(dx, dy),
      m.apply(dx + dw, dy),
      m.apply(dx + dw, dy + dh),
      m.apply(dx, dy + dh),
    ];
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    const minX = Math.max(0, Math.floor(Math.min(...xs)));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(...xs)));
    const minY = Math.max(0, Math.floor(Math.min(...ys)));
    const maxY = Math.min(H - 1, Math.ceil(Math.max(...ys)));

    for (let oy = minY; oy <= maxY; oy++) {
      for (let ox = minX; ox <= maxX; ox++) {
        // 目标像素中心 -> 目标局部坐标
        const lx = invA * (ox + 0.5) + invC * (oy + 0.5) + invE;
        const ly = invB * (ox + 0.5) + invD * (oy + 0.5) + invF;
        // 目标局部 -> 源【外沿坐标】（像素 su 覆盖 [su, su+1)）
        const suCont = sx + ((lx - dx) / dw) * sw;
        const svCont = sy + ((ly - dy) / dh) * sh;
        const su = Math.floor(suCont);
        const sv = Math.floor(svCont);
        if (su < sx || sv < sy || su >= sx + sw || sv >= sy + sh) continue;
        if (su < 0 || sv < 0 || su >= sx + sw || sv >= sy + sh) continue;
        const si = (sv * SW + su) * 4;
        const di = (oy * W + ox) * 4;
        const sa = sdata[si + 3] / 255;
        if (sa >= 1) {
          dst[di] = sdata[si];
          dst[di + 1] = sdata[si + 1];
          dst[di + 2] = sdata[si + 2];
          dst[di + 3] = sdata[si + 3];
        } else if (sa > 0) {
          const da = dst[di + 3] / 255;
          const outA = sa + da * (1 - sa);
          if (outA > 0) {
            dst[di] = (sdata[si] * sa + dst[di] * da * (1 - sa)) / outA;
            dst[di + 1] = (sdata[si + 1] * sa + dst[di + 1] * da * (1 - sa)) / outA;
            dst[di + 2] = (sdata[si + 2] * sa + dst[di + 2] * da * (1 - sa)) / outA;
          }
          dst[di + 3] = Math.round(outA * 255);
        }
      }
    }
  }

  getImageData(x: number, y: number, w: number, h: number): FakeImageData {
    const out = new FakeImageData(w, h);
    const src = this.canvas.data;
    const W = this.canvas.width;
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const si = ((y + row) * W + (x + col)) * 4;
        const di = (row * w + col) * 4;
        out.data[di] = src[si];
        out.data[di + 1] = src[si + 1];
        out.data[di + 2] = src[si + 2];
        out.data[di + 3] = src[si + 3];
      }
    }
    return out;
  }

  createImageData(w: number, h: number): FakeImageData {
    return new FakeImageData(w, h);
  }

  putImageData(img: FakeImageData, x: number, y: number): void {
    const dst = this.canvas.data;
    const W = this.canvas.width;
    for (let row = 0; row < img.height; row++) {
      for (let col = 0; col < img.width; col++) {
        const si = (row * img.width + col) * 4;
        const di = ((y + row) * W + (x + col)) * 4;
        dst[di] = img.data[si];
        dst[di + 1] = img.data[si + 1];
        dst[di + 2] = img.data[si + 2];
        dst[di + 3] = img.data[si + 3];
      }
    }
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    for (let row = y; row < y + h; row++)
      for (let col = x; col < x + w; col++) {
        const i = (row * this.canvas.width + col) * 4;
        this.canvas.data[i + 3] = 0;
      }
  }
  fillRect(): void {
    /* 测试不需要 */
  }
}

export class FakeCanvas {
  private _width: number;
  private _height: number;
  data: Uint8ClampedArray;
  constructor(width = 0, height = 0) {
    this._width = width;
    this._height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }
  get width(): number {
    return this._width;
  }
  set width(v: number) {
    if (v === this._width && this.data.length === v * this._height * 4) return;
    this._width = v;
    this.data = new Uint8ClampedArray(this._width * this._height * 4);
  }
  get height(): number {
    return this._height;
  }
  set height(v: number) {
    if (v === this._height && this.data.length === this._width * v * 4) return;
    this._height = v;
    this.data = new Uint8ClampedArray(this._width * this._height * 4);
  }
  getContext(_kind?: string): FakeContext {
    return new FakeContext(this);
  }
  /** 二进制容器：magic(4) + w(u32LE) + h(u32LE) + RGBA */
  private serialize(): Uint8Array {
    const out = new Uint8Array(12 + this.data.length);
    out.set(new TextEncoder().encode(MAGIC), 0);
    const dv = new DataView(out.buffer);
    dv.setUint32(4, this.width, true);
    dv.setUint32(8, this.height, true);
    out.set(this.data, 12);
    return out;
  }
  static deserialize(bytes: Uint8Array): FakeCanvas {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = new TextDecoder().decode(bytes.subarray(0, 4));
    if (magic !== MAGIC) throw new Error('不是 fake canvas 容器');
    const w = dv.getUint32(4, true);
    const h = dv.getUint32(8, true);
    const c = new FakeCanvas(w, h);
    c.data.set(bytes.subarray(12, 12 + w * h * 4));
    return c;
  }
  static fromBytes(bytes: Uint8Array): FakeCanvas {
    return FakeCanvas.deserialize(bytes);
  }
  static fromDataUrl(url: string): FakeCanvas {
    return FakeCanvas.deserialize(fromBase64(url.split(',')[1]));
  }
  toDataURL(): string {
    return `data:application/x-fake-canvas;base64,${toBase64(this.serialize())}`;
  }
  toBlob(cb: (b: Blob | null) => void): void {
    cb(new Blob([this.serialize()], { type: 'application/x-fake-canvas' }));
  }
}

// ---------- FakeImage：支持 dataURL 与 blob: URL ----------
const blobRegistry = new Map<string, Blob>();

export function installFakeDom(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    createElement(tag: string) {
      if (tag === 'canvas') return new FakeCanvas();
      if (tag === 'img') return new FakeImage();
      if (tag === 'input') return { type: '', value: '', files: null, onchange: null };
      if (tag === 'a') return { click() {}, set href(_v: string) {}, set download(_v: string) {}, remove() {} };
      throw new Error(`未实现 createElement(${tag})`);
    },
    createElementNS() {
      return {};
    },
    body: { appendChild() {}, removeChild() {} },
  };
  g.Image = FakeImage;
  const origURL = g.URL as typeof URL | undefined;
  class FakeURL {
    static createObjectURL(blob: Blob): string {
      const key = `blob:fake/${Math.random().toString(36).slice(2)}`;
      blobRegistry.set(key, blob);
      return key;
    }
    static revokeObjectURL(key: string): void {
      blobRegistry.delete(key);
    }
  }
  // 保留 URL 其它能力
  const Mixed = class extends (origURL ?? Object) {};
  Mixed.createObjectURL = FakeURL.createObjectURL;
  Mixed.revokeObjectURL = FakeURL.revokeObjectURL;
  g.URL = Mixed;
}

export class FakeImage {
  naturalWidth = 0;
  naturalHeight = 0;
  width = 0;
  height = 0;
  onload: (() => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  private _src = '';
  set src(value: string) {
    this._src = value;
    void this.decode();
  }
  get src(): string {
    return this._src;
  }
  private async decode(): Promise<void> {
    try {
      let bytes: Uint8Array;
      if (this._src.startsWith('blob:')) {
        const blob = blobRegistry.get(this._src);
        if (!blob) throw new Error('未知 blob URL');
        bytes = new Uint8Array(await blob.arrayBuffer());
      } else if (this._src.startsWith('data:')) {
        const b64 = this._src.split(',')[1];
        bytes = fromBase64(b64);
      } else {
        throw new Error('不支持的图片源');
      }
      const c = FakeCanvas.deserialize(bytes);
      this.naturalWidth = this.width = c.width;
      this.naturalHeight = this.height = c.height;
      // 把解码后的像素挂在自身，imageToCanvas -> drawImage 时可读
      (this as unknown as { _canvas: FakeCanvas })._canvas = c;
      queueMicrotask(() => this.onload?.());
    } catch (e) {
      queueMicrotask(() => this.onerror?.(e));
    }
  }
}

// 让 drawImage 能直接吃 FakeImage：在 FakeContext.drawImage 内归一化
const originalDraw = FakeContext.prototype.drawImage;
FakeContext.prototype.drawImage = function patchedDraw(
  this: FakeContext,
  src: FakeCanvas | (FakeImage & { _canvas?: FakeCanvas }),
  ...args: number[]
): void {
  const canvas =
    src instanceof FakeCanvas ? src : (src as unknown as { _canvas?: FakeCanvas })._canvas;
  if (!canvas) throw new Error('drawImage: 源未就绪');
  return originalDraw.call(this, canvas, ...args);
};

// ---------- base64 ----------
export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
