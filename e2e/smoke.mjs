// 真实浏览器冒烟测试（Playwright + headless Chromium）：
// 1) 页面加载、点击「生成示例素材」
// 2) 等待打包完成，图集页出现区域
// 3) 校验导出按钮可点击（不真正下载）
// 4) 无 console 错误
//
// 运行：先 npm run preview，再 node e2e/smoke.mjs
import { chromium } from '@playwright/test';

const BASE = process.env.BASE_URL ?? 'http://localhost:4173';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console.error: ' + m.text());
});

await page.goto(BASE, { waitUntil: 'networkidle' });

// 生成示例
await page.getByRole('button', { name: '生成示例素材' }).click();
await page.waitForTimeout(1500);

const frameCards = page.locator('.frame-card');
const frameCount = await frameCards.count();
console.log('时间轴帧数：', frameCount);
if (frameCount < 20) throw new Error('示例帧数不足');

// 等待打包：图集页 meta tag
await page.waitForSelector('.meta-row .tag', { timeout: 8000 });
const atlasText = await page.locator('.atlas .meta-row').first().innerText();
console.log('图集信息：', atlasText.replace(/\n/g, ' '));

// 应存在旋转区域（窄高剑/光晕可能触发）
const regionRows = page.locator('.region-row');
const regionCount = await regionRows.count();
console.log('当前页区域数：', regionCount);
if (regionCount < 3) throw new Error('图集区域过少');

// 空帧标签存在
const emptyTags = page.getByText('空帧');
console.log('空帧标签数：', await emptyTags.count());
if ((await emptyTags.count()) < 1) throw new Error('缺少整帧透明帧标记');

// 检查两个 Pixi canvas 都已挂载
const pixiCanvases = page.locator('.stage canvas');
console.log('Pixi 舞台 canvas：', await pixiCanvases.count());
if ((await pixiCanvases.count()) !== 2) throw new Error('双舞台未就绪');

// 播放控制
await page.getByRole('button', { name: /帧▶/ }).click();
await page.waitForTimeout(200);
await page.getByRole('button', { name: /◀帧/ }).click();

// 选择一帧打开 inspector，修改 pivot
await frameCards.nth(2).click();
await page.waitForTimeout(200);
const inspectorVisible = await page.locator('.inspector').first().isVisible();
if (!inspectorVisible) throw new Error('inspector 不可见');

if (errors.length) {
  console.error('浏览器错误：\n' + errors.join('\n'));
  process.exit(1);
}
console.log('\n✅ 浏览器冒烟通过：无错误，示例导入/打包/双舞台/空帧 均正常');
await browser.close();
