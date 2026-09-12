// PixiJS 预览：打包前（原始帧）与打包后（图集纹理 + trim + rotate 元数据）
// 两个舞台共用同一播放时钟，便于逐帧比较位置 / 时间。
//
// 位置约定：所有精灵都按【原始画布】坐标摆放：
//   精灵左上角 = 画布左上角 - orig/2；轴心 pivot（原始画布坐标）恰好落在舞台原点。
// Pixi v8 对传入 trim+rotate 的纹理会自动：
//   - 把 trim 后的内容放回 orig 大小的四边形；
//   - rotate=6（CCW 烘焙）时在 UV 层顺时针转回；
// 因此两个舞台的顶点位置理论上完全一致。
import { Application, Container, Graphics, Rectangle, Sprite, Texture } from 'pixi.js';
import type { FrameEntry, FrameSource, PackResult } from './types';

export interface PreviewOptions {
  showPivot: boolean;
  showCanvas: boolean;
  showTrim: boolean;
  zoom: number;
}

interface CachedSource {
  canvas: HTMLCanvasElement;
  source: FrameSource;
  origTexture: Texture;
}

export class PreviewStage {
  app: Application;
  private root = new Container();
  private sprite: Sprite | null = null;
  private pivotMark = new Graphics();
  private canvasMark = new Graphics();
  private trimMark = new Graphics();
  private cache = new Map<string, CachedSource>();
  private atlasTextures = new Map<string, Texture>();
  private atlasBaseWrappers = new Set<Texture>();
  private loadedPackAt = -1;
  private opts: PreviewOptions = {
    showPivot: true,
    showCanvas: true,
    showTrim: false,
    zoom: 1,
  };
  private destroyed = false;

  private constructor(app: Application) {
    this.app = app;
    this.root.addChild(this.canvasMark, this.trimMark, this.pivotMark);
    this.app.stage.addChild(this.root);
  }

  static async mount(container: HTMLElement): Promise<PreviewStage> {
    const app = new Application();
    await app.init({
      width: container.clientWidth || 320,
      height: container.clientHeight || 320,
      background: 0x1b1e26,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });
    container.appendChild(app.canvas);
    return new PreviewStage(app);
  }

  setOptions(opts: Partial<PreviewOptions>): void {
    this.opts = { ...this.opts, ...opts };
    this.root.scale.set(this.opts.zoom);
  }

  resize(w: number, h: number): void {
    if (this.destroyed) return;
    this.app.renderer.resize(w, h);
  }

  /** 注册源的原始纹理（打包前舞台使用） */
  registerSource(source: FrameSource, canvas: HTMLCanvasElement): void {
    if (this.cache.has(source.id)) return;
    const texture = Texture.from(canvas);
    this.cache.set(source.id, { canvas, source, origTexture: texture });
  }

  /** 载入打包结果：为每个区域建立带 frame/orig/trim/rotate 的图集纹理 */
  loadAtlas(pack: PackResult | null): void {
    if (pack && pack.at === this.loadedPackAt) return;
    this.loadedPackAt = pack?.at ?? -1;
    this.atlasTextures.forEach((t) => t.destroy(false));
    this.atlasBaseWrappers.forEach((t) => t.destroy(true));
    this.atlasTextures.clear();
    this.atlasBaseWrappers.clear();
    if (!pack) return;
    for (const page of pack.pages) {
      // Texture.from(dataURL) 建立一次性壳纹理，真正复用的是其 TextureSource
      const wrapper = Texture.from(page.dataUrl);
      this.atlasBaseWrappers.add(wrapper);
      const base = wrapper.source;
      for (const r of page.regions) {
        if (r.contentW === 0 && r.contentH === 0) continue;
        const src = this.cache.get(r.sourceId);
        if (!src) continue;
        const s = src.source;
        const frame = new Rectangle(r.contentX, r.contentY, r.contentW, r.contentH);
        const orig = new Rectangle(0, 0, s.origWidth, s.origHeight);
        // trim 位于原始画布坐标系
        const trim = new Rectangle(s.trim.x, s.trim.y, s.trim.w, s.trim.h);
        const tex = new Texture({
          source: base,
          frame,
          orig,
          trim,
          rotate: r.rotate,
        });
        this.atlasTextures.set(r.sourceId, tex);
      }
    }
  }

  /** 显示指定帧。fromAtlas=true 时使用图集纹理（含 trim/rotate 修正） */
  showFrame(frame: FrameEntry | null, sources: Record<string, FrameSource>, fromAtlas: boolean): void {
    if (this.sprite) {
      this.root.removeChild(this.sprite);
      this.sprite.destroy();
      this.sprite = null;
    }
    this.clearMarks();
    if (!frame) return;
    const source = sources[frame.sourceId];
    if (!source) return;

    let texture: Texture | null = null;
    if (fromAtlas) {
      if (source.trim.empty) {
        texture = null; // 整帧透明：无像素可显示
      } else {
        texture = this.atlasTextures.get(source.id) ?? null;
      }
    } else {
      texture = this.cache.get(source.id)?.origTexture ?? null;
    }

    if (texture) {
      this.sprite = new Sprite(texture);
      // 锚点位于【原始画布】坐标系中的 pivot；纹理带 trim/rotate 时
      // Pixi 仍以 orig 尺寸布局顶点，故 trim/旋转不影响轴心位置。
      this.sprite.anchor.set(
        source.pivotX / source.origWidth,
        source.pivotY / source.origHeight,
      );
      this.sprite.position.set(0, 0);
      this.root.addChild(this.sprite);
    }
    this.drawMarks(source);
  }

  private clearMarks(): void {
    this.pivotMark.clear();
    this.canvasMark.clear();
    this.trimMark.clear();
  }

  private drawMarks(s: FrameSource): void {
    // pivot 位于舞台原点，画布左上角 = -pivot
    const left = -s.pivotX;
    const top = -s.pivotY;
    if (this.opts.showCanvas) {
      this.canvasMark.rect(left, top, s.origWidth, s.origHeight).fill({ color: 0xffffff, alpha: 0.04 }).stroke({
        color: 0x8ab4ff,
        width: 1 / this.opts.zoom,
        alpha: 0.9,
      });
    }
    if (this.opts.showTrim && !s.trim.empty) {
      this.trimMark
        .rect(left + s.trim.x, top + s.trim.y, s.trim.w, s.trim.h)
        .stroke({ color: 0x66ff99, width: 1 / this.opts.zoom, alpha: 0.9 });
    }
    if (this.opts.showPivot) {
      const r = 3 / this.opts.zoom;
      this.pivotMark
        .moveTo(-r, 0)
        .lineTo(r, 0)
        .moveTo(0, -r)
        .lineTo(0, r)
        .stroke({ color: 0xff5577, width: 1.5 / this.opts.zoom });
    }
  }

  /** 叠加一个图集页的缩略纹理（调试用） */
  centerView(): void {
    this.root.position.set(this.app.screen.width / 2, this.app.screen.height / 2);
  }

  destroy(): void {
    this.destroyed = true;
    this.cache.forEach((c) => c.origTexture.destroy());
    this.atlasTextures.forEach((t) => t.destroy(false));
    // 壳纹理随 source 一起销毁（派生纹理上方已 destroy(false)，不会重复销毁 source）
    this.atlasBaseWrappers.forEach((t) => t.destroy(true));
    this.app.destroy({ removeView: true });
  }
}
