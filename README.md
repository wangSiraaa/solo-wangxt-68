# 精灵图集工坊 · Sprite Atlas Studio

纯 Web（Svelte + TypeScript + PixiJS + maxrects-packer）的本地序列帧 → 精灵图集工具。
**所有图片与项目数据只存在浏览器内（IndexedDB / 内存），不会上传到任何服务器。**

## 快速开始

```bash
npm install
npm run dev          # 开发
npm run build        # 产物在 dist/，可直接静态托管 / 双击 index.html（base: './'）
npm run preview      # 预览构建产物
npm test             # 16 个像素级 / 集成测试（内存 Canvas 模拟 + fake-indexeddb）
npm run check        # svelte-check 类型检查
```

打开后点 **「生成示例素材」** 可一键得到三类测试序列：

| 序列 | 画布 | 特性 |
| --- | --- | --- |
| `glow_ball` | 统一 128×128 | 径向渐变**边缘半透明**光晕，验证 trim 保留半透明边缘、extrude 不串色 |
| `sword` | **每帧画布尺寸不同**（96×96 / 112×104…） | pivot 设在脚部（非中心），验证 trim 后旋转中心仍在原始画布坐标系 |
| `star` | 96×96 | 含两帧**整帧透明**（消失帧），验证空帧不占图集像素但保留原始尺寸 |

左右两个 PixiJS 舞台共享同一播放时钟，分别渲染**打包前原始帧**与**打包后图集纹理**，
可逐帧对比动画位置（pivot/trim/rotate）与时间（每帧 duration、事件触发点）。

## 核心设计

### 时间轴帧 vs. 纹理源（相同像素共享纹理，时长/事件独立）

- `FrameSource`：去重后的图像（按全部 RGBA 的 FNV 双遍哈希），保存原始尺寸、trim、pivot、Blob key。
- `FrameEntry`：时间轴上的一帧，只引用 `sourceId`，并独立持有 `duration` 与 `events[]`。
- 导入时相同像素自动合并为同一个 `FrameSource`，因此**共享同一块图集区域**；
  复制帧 / 重复图片产生的时间轴帧仍可设置不同时长与事件。
- 「复制帧」按钮即演示：两帧指向同一纹理区域，时长与事件各自独立。

### 透明裁边（trim）保留原始画布与旋转中心

- 裁边阈值 `alpha > 0`——半透明抗锯齿边缘也纳入 trim，不会被切掉。
- 元数据同时保存三套矩形（兼容 TexturePacker 约定）：
  - `frame` / `spriteSourceSize`：trim 后内容在**图集**中的位置（旋转时宽高互换）；
  - `sourceSize`：**原始画布尺寸**（永不改变）；
  - `pivot`：位于**原始画布坐标系**的旋转中心，默认画布中心，可点击/数字修改。
- PixiJS 预览通过 `new Texture({ frame, orig, trim, rotate })` 让引擎自动把
  trim 内容摆回原始画布位置，因此打包前后舞台的顶点位置一致。
- **整帧透明**：`trim.empty = true`，不占任何图集像素（`0×0` 区域），
  只在元数据中保留原始画布尺寸；引擎按空白帧处理。

### 旋转装箱与元数据修正

- maxrects-packer `allowRotation: true`，装箱器可把矩形旋转 90°（宽高互换）。
- 烘焙采用与 PixiJS `groupD8.N (rotate=6)` 一致的方向（内容在图集中**逆时针 90°**），
  引擎按 UV 自动顺时针转回；导出 JSON 标注 `rotated: true` 与
  `meta.rotateConvention: "CCW_90=groupD8.N(6)"`。
- `frame` 始终是图集内真实像素包围盒；`trim / sourceSize / pivot` 保持原始画布坐标，
  消费方不需要在旋转/未旋转之间做任何换算。
- 旋转数学有逐像素往返测试（`scripts/verify-rotation.mjs`）与端到端测试（旋转区域取回像素）。

### 边缘扩色（extrude）与透明留白（padding）分别配置

二者是**相互独立**的两个参数，解决两个不同问题：

| 参数 | 作用 | 像素 |
| --- | --- | --- |
| `extrude` 边缘扩色 | 把内容边缘像素（含半透明 alpha）向外复制 N 像素 | 有颜色（边缘拉伸） |
| `padding` 透明留白 | 图块之间额外的纯透明间隙 | 全透明 |
| `border` | 整页四周安全边距 | 全透明 |

缩小时双线性/mip 采样会取到相邻纹素：extrude 保证取到的是**自身边缘颜色**而非透明黑，
padding 则保证相邻图块的颜色不会渗入。两者可单独增减。

## 导出 / 重导入

点击「导出 JSON + PNG」得到：

- `<name>.atlas.json`
  - `frames`：TexturePacker 风格帧表（frame / rotated / trimmed / spriteSourceSize / sourceSize / pivot）；
  - `sources`：去重纹理源（hash、trim、pivot、被多少时间轴帧共享）；
  - `timeline`：帧序列，每项含 `duration` 与帧内事件（名称、毫秒偏移）；
  - `studio`：**自描述块**，内嵌全部原始图片 dataURL（及可选的图集页），用于无损重导入。
- `<name>-0.png …`：图集页（关闭「内嵌图集页」时额外下载；多页自动编号）。

重导入只需把 `.atlas.json` 拖回窗口（PNG 旁车可选，工程恢复只依赖内嵌原始图）：
工具会用内嵌**原始图片**重新计算 trim/hash，并还原 pivot、时长、事件、打包参数，
然后重新打包。也就是说 JSON 不只是给引擎的数据，也是可继续编辑的工程文件。

## 数据与隐私

- 原始图片 Blob 存 IndexedDB（`blobs` store），项目元数据存 `projects` store；
  编辑自动保存（防抖）。「本地项目」菜单可打开 / 删除。
- 打包结果不持久化（体积大且可随时从源图重新生成）。
- 全程无网络请求；构建产物为静态文件，可离线运行。

## 引擎接入示例（PixiJS v8）

```ts
const base = Texture.from('hero-0.png');
for (const [name, f] of Object.entries(json.frames)) {
  const tex = new Texture({
    source: base.source,
    frame: new Rectangle(f.frame.x, f.frame.y, f.frame.w, f.frame.h),
    orig: new Rectangle(0, 0, f.sourceSize.w, f.sourceSize.h),
    trim: new Rectangle(
      f.spriteSourceSize.x, f.spriteSourceSize.y,
      f.spriteSourceSize.w, f.spriteSourceSize.h,
    ),
    rotate: f.rotated ? 6 : 0, // groupD8.N：CCW 烘焙
  });
  const sprite = new Sprite(tex);
  sprite.anchor.set(f.pivot.x / f.sourceSize.w, f.pivot.y / f.sourceSize.h);
}
// 播放：按 json.timeline[i].duration 切换精灵；到 timeline[i].events[].at 触发事件
```

## 目录

```
src/lib/
  types.ts        数据模型 / 默认参数
  imageUtils.ts   trim、哈希、边缘扩色图块
  packer.ts       maxrects 布局（纯逻辑）+ 图集页渲染
  preview.ts      PixiJS 双舞台（orig 纹理 / frame+trim+rotate 图集纹理）
  exporter.ts     引擎 JSON + studio 自描述块
  importer.ts     JSON 无损重导入
  storage.ts      IndexedDB（项目 + 图片 Blob）
  stores.ts       Svelte 中央状态 / 导入去重 / 打包
  samples.ts      三类内置示例素材生成器
test/             vitest：trim/哈希/extrude/布局/旋转像素往返/导出重导入/多页/存储
scripts/          旋转数学独立验证脚本
e2e/smoke.mjs     Playwright 真实浏览器冒烟（需本机有 Chromium 与系统库）
```
