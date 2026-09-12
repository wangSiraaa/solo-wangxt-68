<script lang="ts">
  import { onMount } from 'svelte';
  import {
    busy,
    getSourceCanvas,
    isPlaying,
    previewFrameIndex,
    project,
    repack,
  } from '../lib/stores';
  import { PreviewStage } from '../lib/preview';

  let beforeEl: HTMLDivElement;
  let afterEl: HTMLDivElement;
  let before: PreviewStage | null = null;
  let after: PreviewStage | null = null;

  let showPivot = true;
  let showCanvas = true;
  let showTrim = false;
  let zoom = 1;

  let playElapsed = 0; // ms（共享时钟）
  let raf = 0;
  let lastTs = 0;
  let activeEvents: string[] = [];

  // 注册所有源的原始纹理（源增加时补注册）
  function syncSources(sig: string) {
    if (!before || !after || sig === registeredSig) return;
    registeredSig = sig;
    for (const s of Object.values($project.sources)) {
      const c = getSourceCanvas(s.id);
      if (c) {
        before.registerSource(s, c);
        after.registerSource(s, c);
      }
    }
    after.loadAtlas($project.pack);
    renderFrame($previewFrameIndex);
  }
  let registeredSig = '';

  function currentFrameIndex(): number {
    const frames = $project.frames;
    if (!frames.length) return -1;
    const total = frames.reduce((a, f) => a + f.duration, 0);
    if (total <= 0) return 0;
    let t = playElapsed % total;
    for (let i = 0; i < frames.length; i++) {
      t -= frames[i].duration;
      if (t < 0) return i;
    }
    return frames.length - 1;
  }

  function frameStartAt(idx: number): number {
    let t = 0;
    for (let i = 0; i < idx && i < $project.frames.length; i++) t += $project.frames[i].duration;
    return t;
  }

  function renderFrame(idx: number) {
    const frame = $project.frames[idx] ?? null;
    before?.showFrame(frame, $project.sources, false);
    after?.showFrame(frame, $project.sources, true);
    previewFrameIndex.set(idx);
    if (frame) {
      // 帧内时间（考虑总时长取模后的回绕）
      const total = $project.frames.reduce((a, f) => a + f.duration, 0);
      const within = playElapsed - frameStartAt(idx) - Math.floor(playElapsed / Math.max(1, total)) * total;
      activeEvents = frame.events.filter((e) => within >= e.at).map((e) => e.name);
    } else {
      activeEvents = [];
    }
  }

  function tick(ts: number) {
    if (!lastTs) lastTs = ts;
    const dt = ts - lastTs;
    lastTs = ts;
    if ($isPlaying && $project.frames.length) {
      playElapsed += dt;
      const idx = currentFrameIndex();
      if (idx !== $previewFrameIndex) renderFrame(idx);
    }
    raf = requestAnimationFrame(tick);
  }

  let previewError = '';

  onMount(() => {
    let resize = () => {};
    let disposed = false;
    (async () => {
      try {
        before = await PreviewStage.mount(beforeEl);
        after = await PreviewStage.mount(afterEl);
      } catch (e) {
        previewError = `PixiJS 初始化失败（通常是浏览器禁用了 WebGL）：${(e as Error).message}`;
        return;
      }
      if (disposed) {
        before?.destroy();
        after?.destroy();
        return;
      }
      before.setOptions({ showPivot, showCanvas, showTrim, zoom });
      after.setOptions({ showPivot, showCanvas, showTrim, zoom });
      resize = () => {
        before?.resize(beforeEl.clientWidth, beforeEl.clientHeight);
        after?.resize(afterEl.clientWidth, afterEl.clientHeight);
        before?.centerView();
        after?.centerView();
      };
      resize();
      window.addEventListener('resize', resize);
      raf = requestAnimationFrame(tick);
    })();

    return () => {
      disposed = true;
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(raf);
      before?.destroy();
      after?.destroy();
    };
  });

  // store 变化时刷新（按签名精确触发，避免每帧重建 GPU 资源）
  $: sourceSig = Object.values($project.sources)
    .map((s) => `${s.id}:${s.trim.w}x${s.trim.h}:${s.pivotX},${s.pivotY}`)
    .join('|');

  $: if (before && after) syncSources(sourceSig);
  // 仅在打包结果变化时重建图集纹理
  $: if (after) {
    after.loadAtlas($project.pack);
    renderFrame($previewFrameIndex);
  }
  // 显示选项 / 当前帧变化只更新画面
  $: if (before && after) {
    before.setOptions({ showPivot, showCanvas, showTrim, zoom });
    after.setOptions({ showPivot, showCanvas, showTrim, zoom });
    renderFrame($previewFrameIndex);
  }
  $: if (before && after) {
    before.centerView();
    after.centerView();
  }

  function seekTo(idx: number) {
    playElapsed = frameStartAt(Math.max(0, Math.min(idx, $project.frames.length - 1)));
    renderFrame(idx);
  }

  function scrub(e: MouseEvent) {
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const total = $project.frames.reduce((a, f) => a + f.duration, 0);
    let t = ratio * total;
    let idx = 0;
    for (let i = 0; i < $project.frames.length; i++) {
      if (t < $project.frames[i].duration) {
        idx = i;
        break;
      }
      t -= $project.frames[i].duration;
      idx = i;
    }
    playElapsed = frameStartAt(idx);
    renderFrame(idx);
  }

  $: totalMs = $project.frames.reduce((a, f) => a + f.duration, 0);
  $: progress = totalMs ? (playElapsed % totalMs) / totalMs : 0;

  function sourceInfo(): string {
    const n = Object.keys($project.sources).length;
    return `${n} 源`;
  }
  function atlasInfo(): string {
    const p = $project.pack;
    if (!p) return '';
    const px = p.pages.reduce((a, pg) => a + pg.width * pg.height, 0);
    return `${p.pages.length} 页 · ${Math.round(px / 1024 / 1024 * 100) / 100}MP${p.overflow.length ? ` · 溢出 ${p.overflow.length}` : ''}`;
  }
</script>

<div class="preview">
  <div class="toolbar panel">
    <div class="row">
      <button class="primary" on:click={() => isPlaying.set(!$isPlaying)}>
        {$isPlaying ? '⏸ 暂停' : '▶ 播放'}
      </button>
      <button on:click={() => seekTo(0)}>⏮</button>
      <button on:click={() => seekTo($previewFrameIndex - 1)}>◀帧</button>
      <button on:click={() => seekTo($previewFrameIndex + 1)}>帧▶</button>
      <span class="tag"
        >帧 {$project.frames.length ? $previewFrameIndex + 1 : 0}/{$project.frames.length} ·
        {Math.round(playElapsed % Math.max(1, totalMs))}ms</span
      >
      {#if activeEvents.length}
        {#each activeEvents as name}
          <span class="tag green">事件: {name}</span>
        {/each}
      {/if}
    </div>
    <div class="row">
      <label class="chk"><input type="checkbox" bind:checked={showCanvas} /> 画布框</label>
      <label class="chk"><input type="checkbox" bind:checked={showTrim} /> trim 框</label>
      <label class="chk"><input type="checkbox" bind:checked={showPivot} /> 轴心</label>
      <label class="chk"
        >缩放
        <input type="range" min="0.25" max="3" step="0.25" bind:value={zoom} />
        {zoom}×</label
      >
      {#if !$project.pack}
        <button class="primary" on:click={() => repack()} disabled={$busy || !$project.frames.length}>
          打包后比较
        </button>
      {/if}
    </div>
  </div>

  {#if previewError}
    <div class="preview-error">{previewError}</div>
  {/if}
  <div class="stages">
    <div class="stage-wrap">
      <div class="stage-label">打包前 · 原始序列帧（{sourceInfo()}）</div>
      <div class="stage" bind:this={beforeEl}></div>
    </div>
    <div class="stage-wrap">
      <div class="stage-label">
        打包后 · 图集纹理 + trim/rotate 元数据
        {#if $project.pack}
          <span class="tag green"
            >{atlasInfo()}</span
          >
        {:else}
          <span class="tag">未打包</span>
        {/if}
      </div>
      <div class="stage" bind:this={afterEl}></div>
    </div>
  </div>

  <div class="timeline panel">
    <div class="track" on:click={scrub} role="slider" tabindex="-1">
      <div class="cursor" style="left:{progress * 100}%"></div>
      {#each $project.frames as f, i}
      <!-- svelte-ignore a11y-click-events-have-key-events -->
      <div
        class="seg"
        class:active={i === $previewFrameIndex}
        style="flex-grow:{f.duration}"
        on:click={(e) => {
          e.stopPropagation();
          seekTo(i);
        }}
        title={`${i + 1}. ${$project.sources[f.sourceId]?.name ?? ''} ${f.duration}ms${f.events.length ? ' · ' + f.events.map((x) => x.name).join(',') : ''}`}
      >
        {#each f.events as ev}
          <span class="ev-dot" style="left:{(ev.at / f.duration) * 100}%" title={ev.name}></span>
        {/each}
      </div>
      {/each}
    </div>
  </div>
</div>

<style>
  .preview {
    display: flex;
    flex-direction: column;
    gap: 8px;
    height: 100%;
    min-height: 0;
  }
  .toolbar {
    display: flex;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    padding: 8px 12px;
  }
  .chk {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--text-dim);
  }
  .stages {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .preview-error {
    color: var(--danger);
    background: rgba(255, 107, 107, 0.1);
    border: 1px solid var(--danger);
    border-radius: 6px;
    padding: 8px 12px;
    font-size: 12px;
  }
  .stage-wrap {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-height: 0;
  }
  .stage-label {
    font-size: 11px;
    color: var(--text-dim);
  }
  .stage {
    flex: 1;
    min-height: 0;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .timeline {
    padding: 10px 12px;
  }
  .track {
    position: relative;
    display: flex;
    height: 34px;
    border-radius: 5px;
    overflow: hidden;
    background: var(--bg);
    border: 1px solid var(--border);
    cursor: pointer;
  }
  .seg {
    position: relative;
    min-width: 3px;
    border-right: 1px solid var(--border);
    background: #20242e;
  }
  .seg:hover {
    background: #2a3040;
  }
  .seg.active {
    background: #2c5ea8;
  }
  .cursor {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--warn);
    z-index: 2;
    pointer-events: none;
  }
  .ev-dot {
    position: absolute;
    top: 3px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent-2);
    transform: translateX(-50%);
  }
</style>
