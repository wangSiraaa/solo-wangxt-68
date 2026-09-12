<script lang="ts">
  import { project } from '../lib/stores';

  let pageIndex = 0;
  $: pages = $project.pack?.pages ?? [];
  $: page = pages[Math.min(pageIndex, Math.max(0, pages.length - 1))] ?? null;
  $: sources = $project.sources;
</script>

<div class="panel atlas">
  <h3 class="section-title" style="justify-content:space-between;display:flex">
    <span>图集页（拼贴图仅为可视化，元数据见导出 JSON）</span>
    {#if pages.length > 1}
      <span class="pager">
        <button on:click={() => (pageIndex = Math.max(0, pageIndex - 1))}>‹</button>
        {pageIndex + 1}/{pages.length}
        <button on:click={() => (pageIndex = Math.min(pages.length - 1, pageIndex + 1))}>›</button>
      </span>
    {/if}
  </h3>

  {#if !page}
    <div class="muted">尚未打包。调整参数后点击「重新打包」。</div>
  {:else}
    <div class="meta-row">
      <span class="tag">{page.width} × {page.height}px</span>
      <span class="tag">{page.regions.length} 个区域</span>
      {#if page.regions.some((r) => r.rotated)}
        <span class="tag blue">{page.regions.filter((r) => r.rotated).length} 个旋转</span>
      {/if}
    </div>
    <div class="canvas-scroll">
      <div class="canvas-box" style={`aspect-ratio:${page.width}/${page.height}`}>
        <img src={page.dataUrl} alt="atlas page" draggable="false" />
        <svg viewBox={`0 0 ${page.width} ${page.height}`} preserveAspectRatio="none">
          {#each page.regions as r (r.sourceId)}
            {#if r.contentW > 0}
              <g>
                <rect
                  x={r.contentX}
                  y={r.contentY}
                  width={r.contentW}
                  height={r.contentH}
                  class="region {r.rotated ? 'rot' : ''}"
                />
                {#if r.rotated}
                  <line
                    x1={r.contentX}
                    y1={r.contentY}
                    x2={r.contentX + r.contentW}
                    y2={r.contentY + r.contentH}
                    class="diag"
                  />
                {/if}
              </g>
            {/if}
          {/each}
        </svg>
      </div>
    </div>
    <div class="legend">
      <span><i class="box normal"></i> 内容区域（frame）</span>
      <span><i class="box rot-box"></i> 旋转区域（rotate=6 CCW）</span>
    </div>
    <div class="regions">
      {#each page.regions as r (r.sourceId)}
        {@const src = sources[r.sourceId]}
        <div class="region-row">
          <span class="tag {r.rotated ? 'blue' : ''}">{r.rotated ? 'CCW90' : '正立'}</span>
          <span class="rname">{src?.name}</span>
          <span class="rsize"
            >frame {r.contentW}×{r.contentH} · orig {src?.origWidth}×{src?.origHeight}</span
          >
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .atlas {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
  }
  .pager {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .pager button {
    padding: 0 7px;
  }
  .muted {
    color: var(--text-dim);
  }
  .meta-row {
    display: flex;
    gap: 6px;
  }
  .canvas-scroll {
    overflow: auto;
    background: repeating-conic-gradient(#20242e 0% 25%, #181b22 0% 50%) 0 0 / 16px 16px;
    border-radius: 6px;
    padding: 8px;
    max-height: 260px;
  }
  .canvas-box {
    position: relative;
    width: 100%;
    margin: 0 auto;
  }
  .canvas-box img,
  .canvas-box svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .region {
    fill: none;
    stroke: rgba(123, 224, 161, 0.7);
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
  }
  .region.rot {
    stroke: rgba(106, 166, 255, 0.85);
  }
  .diag {
    stroke: rgba(106, 166, 255, 0.85);
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
  }
  .legend {
    display: flex;
    gap: 14px;
    font-size: 10px;
    color: var(--text-dim);
  }
  .box {
    display: inline-block;
    width: 10px;
    height: 10px;
    border: 2px solid var(--accent-2);
    margin-right: 4px;
  }
  .rot-box {
    border-color: var(--accent);
  }
  .regions {
    overflow-y: auto;
    max-height: 130px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .region-row {
    display: grid;
    grid-template-columns: 56px 1fr auto;
    gap: 6px;
    align-items: center;
    font-size: 10px;
  }
  .rname {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rsize {
    color: var(--text-dim);
    text-align: right;
  }
</style>
