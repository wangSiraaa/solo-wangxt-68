<script lang="ts">
  import {
    duplicateFrame,
    getSourceCanvas,
    importAssets,
    moveFrame,
    project,
    removeFrame,
    selectedFrameId,
    setFrameDuration,
  } from '../lib/stores';
  import type { FrameEntry, FrameSource } from '../lib/types';

  // 拖放动作由 App 统一定义后传入
  type DropParams = { onFiles: (files: File[]) => void };
  export let dropAction: (
    node: HTMLElement,
    params: DropParams,
  ) => { update?: (p: DropParams) => void; destroy?: () => void };

  const thumbCache = new Map<string, string>();

  function thumbUrl(frame: FrameEntry): string | undefined {
    const src = $project.sources[frame.sourceId];
    if (!src) return undefined;
    const cached = thumbCache.get(src.id);
    if (cached) return cached;
    const c = getSourceCanvas(src.id);
    if (!c) return undefined;
    const t = document.createElement('canvas');
    t.width = 48;
    t.height = Math.max(1, Math.round((48 * src.origHeight) / src.origWidth));
    const ctx = t.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(c, 0, 0, t.width, t.height);
    const url = t.toDataURL();
    thumbCache.set(src.id, url);
    return url;
  }

  function handleDropFiles(files: File[]) {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (images.length) importAssets(images.map((blob) => ({ blob, name: blob.name })));
  }

  function srcOf(f: FrameEntry): FrameSource | undefined {
    return $project.sources[f.sourceId];
  }

  function changeDuration(id: string, e: Event) {
    setFrameDuration(id, Number((e.currentTarget as HTMLInputElement).value));
  }
</script>

<div class="frames" use:dropAction={{ onFiles: handleDropFiles }}>
  <h3 class="section-title" style="margin:0">时间轴 · {$project.frames.length} 帧</h3>

  {#if $project.frames.length === 0}
    <div class="empty">
      拖入序列帧图片<br />或使用顶部「生成示例素材」
    </div>
  {/if}

  <div class="list">
    {#each $project.frames as frame, i (frame.id)}
      {@const src = srcOf(frame)}
      {@const selected = $selectedFrameId === frame.id}
      <!-- svelte-ignore a11y-click-events-have-key-events -->
      <div
        class="frame-card"
        class:selected
        role="button"
        tabindex="0"
        on:click={() => selectedFrameId.set(frame.id)}
        on:keydown={(e) => e.key === 'Enter' && selectedFrameId.set(frame.id)}
      >
        <div class="idx">{i + 1}</div>
        <div class="thumb">
          {#if thumbUrl(frame)}
            <img src={thumbUrl(frame)} alt="" />
          {:else}
            <div class="ph">…</div>
          {/if}
          {#if src?.trim.empty}<span class="tag red">空帧</span>{/if}
        </div>
        <div class="meta">
          <div class="name" title={src?.name}>{src?.name ?? '?'}</div>
          <div class="sub">{src?.origWidth}×{src?.origHeight}</div>
          <label class="sub duration">
            <input
              type="number"
              min="1"
              value={frame.duration}
              on:change={(e) => changeDuration(frame.id, e)}
            />
            ms
          </label>
          {#if frame.events.length}
            <div class="events">
              {#each frame.events as ev}
                <span class="tag blue" title={`@${ev.at}ms`}>{ev.name}</span>
              {/each}
            </div>
          {/if}
        </div>
        <div class="ops">
          <button title="上移" on:click={() => moveFrame(frame.id, -1)}>↑</button>
          <button title="下移" on:click={() => moveFrame(frame.id, 1)}>↓</button>
          <button title="复制（独立时长/事件，共享纹理）" on:click={() => duplicateFrame(frame.id)}
            >⧉</button
          >
          <button class="danger" title="删除帧" on:click={() => removeFrame(frame.id)}>✕</button>
        </div>
      </div>
    {/each}
  </div>
</div>

<style>
  .frames {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 0;
    flex: 1;
  }
  .empty {
    border: 1px dashed var(--border);
    border-radius: 8px;
    padding: 24px 12px;
    text-align: center;
    color: var(--text-dim);
    line-height: 1.8;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 5px;
    overflow-y: auto;
    min-height: 0;
    padding-right: 2px;
  }
  .frame-card {
    display: grid;
    grid-template-columns: 20px 52px 1fr auto;
    gap: 8px;
    align-items: center;
    background: var(--bg-3);
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 5px 7px;
    cursor: pointer;
  }
  .frame-card.selected {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent) inset;
  }
  .idx {
    color: var(--text-dim);
    font-size: 10px;
    text-align: center;
  }
  .thumb {
    position: relative;
    width: 52px;
    height: 52px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: repeating-conic-gradient(#20242e 0% 25%, #181b22 0% 50%) 0 0 / 12px 12px;
    border-radius: 4px;
  }
  .thumb img {
    max-width: 100%;
    max-height: 100%;
  }
  .thumb .tag {
    position: absolute;
    bottom: 1px;
    right: 1px;
  }
  .ph {
    color: var(--text-dim);
  }
  .meta {
    min-width: 0;
  }
  .name {
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sub {
    color: var(--text-dim);
    font-size: 10px;
  }
  .duration {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .duration input {
    width: 52px;
    padding: 1px 4px;
  }
  .events {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    margin-top: 2px;
  }
  .ops {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .ops button {
    padding: 0 5px;
    font-size: 10px;
    line-height: 18px;
  }
  .ops .danger:hover {
    border-color: var(--danger);
    color: var(--danger);
  }
</style>
