<script lang="ts">
  import {
    addFrameEvent,
    getSourceCanvas,
    project,
    removeFrameEvent,
    resetPivot,
    selectedFrameId,
    setPivot,
  } from '../lib/stores';

  let newEventName = '';
  let newEventAt = 0;
  let pivotCanvas: HTMLCanvasElement;

  $: frame = $project.frames.find((f) => f.id === $selectedFrameId) ?? null;
  $: source = frame ? $project.sources[frame.sourceId] : null;
  $: frameIndex = frame ? $project.frames.findIndex((f) => f.id === frame.id) : -1;
  $: sourceCanvasVersion = source ? getSourceCanvas(source.id) ?? 0 : 0;
  $: if (pivotCanvas && source && sourceCanvasVersion) drawPivot();

  function drawPivot() {
    if (!pivotCanvas || !source) return;
    const c = getSourceCanvas(source.id);
    const maxW = 230;
    const scale = Math.min(1, maxW / source.origWidth);
    pivotCanvas.width = Math.round(source.origWidth * scale);
    pivotCanvas.height = Math.round(source.origHeight * scale);
    const ctx = pivotCanvas.getContext('2d')!;
    ctx.clearRect(0, 0, pivotCanvas.width, pivotCanvas.height);
    if (c) ctx.drawImage(c, 0, 0, pivotCanvas.width, pivotCanvas.height);
    ctx.strokeStyle = 'rgba(138,180,255,0.9)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, pivotCanvas.width - 1, pivotCanvas.height - 1);
    if (!source.trim.empty) {
      ctx.strokeStyle = 'rgba(102,255,153,0.8)';
      ctx.strokeRect(
        source.trim.x * scale + 0.5,
        source.trim.y * scale + 0.5,
        source.trim.w * scale - 1,
        source.trim.h * scale - 1,
      );
    }
    const px = source.pivotX * scale;
    const py = source.pivotY * scale;
    ctx.strokeStyle = '#ff5577';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px - 6, py);
    ctx.lineTo(px + 6, py);
    ctx.moveTo(px, py - 6);
    ctx.lineTo(px, py + 6);
    ctx.stroke();
  }

  function pickPivot(e: MouseEvent) {
    if (!source || !pivotCanvas) return;
    const rect = pivotCanvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * source.origWidth;
    const y = ((e.clientY - rect.top) / rect.height) * source.origHeight;
    setPivot(source.id, Math.round(x * 10) / 10, Math.round(y * 10) / 10);
  }
</script>

<div class="panel inspector">
  <h3 class="section-title">帧 / 源属性</h3>
  {#if !frame || !source}
    <div class="muted">在左侧时间轴选择一帧</div>
  {:else}
    <div class="kv">
      <span>时间轴位置</span><b>第 {frameIndex + 1} / {$project.frames.length} 帧</b>
    </div>
    <div class="kv">
      <span>原始画布</span><b>{source.origWidth} × {source.origHeight}</b>
    </div>
    <div class="kv">
      <span>透明裁边</span>
      {#if source.trim.empty}
        <b class="red">整帧透明（0×0，不占图集）</b>
      {:else}
        <b>
          x:{source.trim.x} y:{source.trim.y} {source.trim.w}×{source.trim.h}
        </b>
      {/if}
    </div>
    <div class="kv">
      <span>纹理共享</span>
      <b>{$project.frames.filter((f) => f.sourceId === source.id).length} 帧共用此区域</b>
    </div>

    <h4 class="sub-title">旋转中心（原始画布坐标）</h4>
    <div class="pivot-area">
      <canvas bind:this={pivotCanvas} on:click={pickPivot} role="presentation"></canvas>
    </div>
    <div class="row" style="margin:6px 0;gap:6px">
      <label>x <input type="number" value={source.pivotX} on:change={(e) => setPivot(source.id, Number(e.currentTarget.value), source.pivotY)} /></label>
      <label>y <input type="number" value={source.pivotY} on:change={(e) => setPivot(source.id, source.pivotX, Number(e.currentTarget.value))} /></label>
      <button on:click={() => resetPivot(source.id)}>回中心</button>
    </div>

    <h4 class="sub-title">该帧事件（时长/事件独立于共享纹理）</h4>
    {#each frame.events as ev (ev.id)}
      <div class="event-row">
        <input type="number" value={ev.at} disabled />
        <input type="text" value={ev.name} disabled />
        <button class="danger" on:click={() => removeFrameEvent(frame.id, ev.id)}>✕</button>
      </div>
    {/each}
    <div class="event-row">
      <input type="number" bind:value={newEventAt} placeholder="ms" />
      <input type="text" bind:value={newEventName} placeholder="事件名，如 hit" />
      <button
        class="primary"
        on:click={() => {
          if (newEventName.trim()) {
            addFrameEvent(frame.id, newEventName.trim(), newEventAt);
            newEventName = '';
          }
        }}>添加</button
      >
    </div>
  {/if}
</div>

<style>
  .inspector {
    display: flex;
    flex-direction: column;
    gap: 4px;
    overflow-y: auto;
  }
  .muted {
    color: var(--text-dim);
  }
  .kv {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font-size: 11px;
    padding: 3px 0;
  }
  .kv span {
    color: var(--text-dim);
  }
  .kv b {
    font-weight: 600;
    text-align: right;
  }
  .red {
    color: var(--danger);
  }
  .sub-title {
    margin: 10px 0 4px;
    font-size: 11px;
    color: var(--text-dim);
  }
  .pivot-area {
    background: repeating-conic-gradient(#20242e 0% 25%, #181b22 0% 50%) 0 0 / 12px 12px;
    border-radius: 6px;
    padding: 6px;
    display: flex;
    justify-content: center;
  }
  .pivot-area canvas {
    max-width: 100%;
    image-rendering: pixelated;
    cursor: crosshair;
  }
  .event-row {
    display: grid;
    grid-template-columns: 64px 1fr auto;
    gap: 5px;
    margin: 4px 0;
  }
  .event-row input[type='number'] {
    width: 100%;
  }
  .event-row .danger:hover {
    border-color: var(--danger);
    color: var(--danger);
  }
</style>
