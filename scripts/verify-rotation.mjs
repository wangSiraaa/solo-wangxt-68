// 旋转数学验证（纯 Node，无 DOM）：
// 对比「renderPages 的 CCW 烘焙」与「Pixi v8 Texture rotate=6 的 UV 映射」，
// 证明：orig 任一像素中心经 Pixi UV 采样后，恰好取到烘焙前的同一像素。
//
// 运行：node scripts/verify-rotation.mjs

// ---- groupD8（取自 pixi.js 源码）----
const ux = [1, 1, 0, -1, -1, -1, 0, 1, 1, 1, 0, -1, -1, -1, 0, 1];
const uy = [0, 1, 1, 1, 0, -1, -1, -1, 0, 1, 1, 1, 0, -1, -1, -1];
const vx = [0, -1, -1, -1, 0, 1, 1, 1, 0, 1, 1, 1, 0, -1, -1, 1];
const vy = [1, 1, 0, -1, -1, -1, 0, 1, -1, -1, 0, 1, 1, 1, 0, -1];
const add = (a, b) => {
  const [aUx, aUy, aVx, aVy] = [ux[a], uy[a], vx[a], vy[a]];
  const [bUx, bUy, bVx, bVy] = [ux[b], uy[b], vx[b], vy[b]];
  const nUx = Math.sign(aUx * bUx + aVx * bUy);
  const nUy = Math.sign(aUy * bUx + aVy * bUy);
  const nVx = Math.sign(aUx * bVx + aVx * bVy);
  const nVy = Math.sign(aUy * bVx + aVy * bVy);
  for (let i = 0; i < 16; i++)
    if (ux[i] === nUx && uy[i] === nUy && vx[i] === nVx && vy[i] === nVy) return i;
  throw new Error('no group');
};
const NW = 5;

// 与 Texture.updateUvs rotate 分支相同的角点 UV 计算，直接返回像素坐标
function pixiCorners(frame, pageW, pageH, rotate) {
  const w2 = frame.width / 2;
  const h2 = frame.height / 2;
  const cX = frame.x + w2;
  const cY = frame.y + h2;
  // 归一化后再乘回页尺寸，等价于像素中心 ± 半宽
  let r = add(rotate, NW);
  const out = [];
  for (let k = 0; k < 4; k++) {
    out.push([cX + w2 * ux[r], cY + h2 * uy[r]]);
    r = add(r, 2);
  }
  return out; // TL,TR,BR,BL（相对 orig 内容）
}

function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) < eps;
}

function run() {
  const cw = 40; // trim 后内容宽
  const ch = 30; // trim 后内容高
  const sx = 13; // 槽原点（含 padding/extrude 后内容起点即 frame.x/y）
  const sy = 7;
  const pageW = 200;
  const pageH = 200;

  // rotate=6 时 frame 包围盒是旋转后的：宽=ch, 高=cw
  const frame = { x: sx, y: sy, width: ch, height: cw };
  const [TL, TR, BR, BL] = pixiCorners(frame, pageW, pageH, 6);

  console.log('UV 角点（连续像素坐标）：');
  console.log('  TL ->', TL);
  console.log('  TR ->', TR);
  console.log('  BR ->', BR);
  console.log('  BL ->', BL);

  // Pixi 顶点 UV 落在像素【外沿】（半 texel 约定）：
  //   像素 (u,v) 中心对应归一化 (u+0.5)/cw、(v+0.5)/ch
  function samplePos(u, v) {
    const fu = (u + 0.5) / cw;
    const fv = (v + 0.5) / ch;
    const top = [TL[0] + (TR[0] - TL[0]) * fu, TL[1] + (TR[1] - TL[1]) * fu];
    const bot = [BL[0] + (BR[0] - BL[0]) * fu, BL[1] + (BR[1] - BL[1]) * fu];
    return [top[0] + (bot[0] - top[0]) * fv, top[1] + (bot[1] - top[1]) * fv];
  }

  let bad = 0;
  const samples = [
    [0, 0], [cw - 1, 0], [cw - 1, ch - 1], [0, ch - 1],
    [10, 5], [20, 15], [3, 27], [37, 2],
  ];
  for (const [u, v] of samples) {
    const [ax, ay] = samplePos(u, v);
    const ex = sx + v;
    const ey = sy + (cw - 1) - u;
    // 采样点应落在期望像素的中心（整数 + 0.5）
    const ok = approx(ax, ex + 0.5) && approx(ay, ey + 0.5);
    console.log(`  orig(${String(u).padStart(2)},${String(v).padStart(2)}) -> 采样中心(${ax.toFixed(2)},${ay.toFixed(2)}) 烘焙像素(${ex},${ey}) ${ok ? '✓' : '✗'}`);
    if (!ok) bad++;
  }

  // 全像素扫描
  for (let u = 0; u < cw; u++) {
    for (let v = 0; v < ch; v++) {
      const [ax, ay] = samplePos(u, v);
      const ex = sx + v + 0.5;
      const ey = sy + (cw - 1) - u + 0.5;
      if (!approx(ax, ex) || !approx(ay, ey)) bad++;
    }
  }
  if (bad) {
    console.error(`\n❌ ${bad} 处不一致：烘焙方向与 rotate=6 不匹配`);
    process.exit(1);
  }
  console.log('\n✅ 烘焙公式 atlas(sx+v, sy+(cw-1)-u) 与 Pixi rotate=6 UV 完全一致');
  console.log('✅ trim 偏移只影响四边形在 orig 画布中的位置（updateQuadBounds），不参与 UV，二者正交');
}

run();
