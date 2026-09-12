<script lang="ts">
  import { onMount, tick } from 'svelte';
  import FrameList from './components/FrameList.svelte';
  import SettingsPanel from './components/SettingsPanel.svelte';
  import SourceInspector from './components/SourceInspector.svelte';
  import PreviewPanel from './components/PreviewPanel.svelte';
  import AtlasView from './components/AtlasView.svelte';
  import {
    busy,
    hydrate,
    importAssets,
    project,
    repack,
    setPivot,
    showToast,
    toast,
    getSourceDataUrl,
  } from './lib/stores';
  import { generateSamples } from './lib/samples';
  import { listProjects, loadProject, deleteProject } from './lib/storage';
  import { buildExport, downloadFile, jsonToText } from './lib/exporter';
  import { importAtlasJson, readFileAsDataUrl } from './lib/importer';

  let embedPages = true;
  let savedProjects: { id: string; name: string; updatedAt: number }[] = [];
  let showProjects = false;
  let dragOver = false;

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.accept = 'image/*';
  fileInput.onchange = () => {
    if (fileInput.files) pickImages(Array.from(fileInput.files));
    fileInput.value = '';
  };

  const jsonInput = document.createElement('input');
  jsonInput.type = 'file';
  jsonInput.multiple = true;
  jsonInput.accept = '.json,application/json,image/png';
  jsonInput.onchange = () => {
    if (jsonInput.files) importFiles(Array.from(jsonInput.files));
    jsonInput.value = '';
  };

  async function pickImages(files: File[]) {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (!images.length) return;
    await importAssets(images.map((blob) => ({ blob, name: blob.name })));
    afterImportMaybePack();
  }

  let autoPack = true;
  async function afterImportMaybePack() {
    await tick();
    if (autoPack) repack();
  }

  // ---------- 示例素材 ----------
  async function loadSamples() {
    busy.set(true);
    try {
      const sequences = await generateSamples();
      for (const seq of sequences) {
        const assets = seq.images.map((im, i) => ({
          blob: im.blob,
          name: im.name,
          duration: seq.durations[i] ?? 100,
          // 事件在对应帧内的偏移（这里放在帧时长的 80% 处）
          events:
            seq.events[i] !== undefined
              ? { [Math.round((seq.durations[i] ?? 100) * 0.8)]: seq.events[i] }
              : undefined,
        }));
        await importAssets(assets);
      }
      // 给剑序列设置非中心 pivot（脚部），演示旋转中心在不同画布尺寸下被保留
      applySwordPivot();
      await repack();
      showToast('已生成三类示例：半透明光晕 / 不同画布尺寸挥剑 / 含整帧透明星星');
    } finally {
      busy.set(false);
    }
  }

  function applySwordPivot() {
    // 找到 sword 前缀的源，将 pivot 放到脚部（原始画布坐标）
    for (const src of Object.values($project.sources)) {
      if (src.name.startsWith('sword')) {
        setPivot(src.id, src.origWidth / 2, src.origHeight - 12);
      }
    }
  }

  // ---------- 导出 ----------
  function doExport() {
    if (!$project.pack) {
      showToast('请先打包再导出', 'error');
      return;
    }
    const origDataUrls = new Map<string, string>();
    for (const id of Object.keys($project.sources)) {
      const url = getSourceDataUrl(id);
      if (url) origDataUrls.set(id, url);
    }
    const { json, pngs } = buildExport(
      $project.meta,
      $project.settings,
      $project.frames,
      $project.sources,
      $project.pack,
      origDataUrls,
      { embedPages },
    );
    const baseName = $project.meta.name.replace(/[^\w一-龥-]+/g, '_');
    const blob = new Blob([jsonToText(json)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    downloadFile({ name: `${baseName}.atlas.json`, content: url, mime: 'application/json', isText: true });
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    if (!embedPages) {
      for (const p of pngs) {
        downloadFile({
          name: `${baseName}-${p.index}.png`,
          content: p.dataUrl,
          mime: 'image/png',
          isText: false,
        });
      }
    }
    showToast(
      embedPages
        ? '已导出单文件 JSON（内嵌原图与图集页，可重导入）'
        : `已导出 JSON + ${pngs.length} 张 PNG（JSON 仍内嵌原始图）`,
    );
  }

  // ---------- 导入工程 ----------
  async function importFiles(files: File[]) {
    const jsonFile = files.find((f) => f.name.endsWith('.json'));
    if (!jsonFile) {
      // 纯图片
      pickImages(files);
      return;
    }
    try {
      const json = JSON.parse(await jsonFile.text());
      const sidecars = await Promise.all(
        files
          .filter((f) => f !== jsonFile && f.type.startsWith('image/'))
          .map(async (f) => ({ name: f.name, dataUrl: await readFileAsDataUrl(f) })),
      );
      const result = await importAtlasJson(json, sidecars);
      await hydrate(result.state);
      for (const [id, blob] of result.origBlobs) {
        const { setBlob } = await import('./lib/storage');
        setBlob(`blob_${id}`, blob);
      }
      if (result.warnings.length) showToast(result.warnings.join('；'), 'error');
      else showToast('工程已从 JSON 无损重导入（原始图片 / pivot / 时间轴均保留）');
      await repack();
    } catch (e) {
      showToast(`导入失败：${(e as Error).message}`, 'error');
    }
  }

  function renameInput(e: Event) {
    const v = (e.currentTarget as HTMLInputElement).value;
    if (v.trim()) {
      project.update((s) => ({ ...s, meta: { ...s.meta, name: v.trim() } }));
    }
  }

  async function refreshProjects() {
    savedProjects = await listProjects();
    showProjects = true;
  }

  async function openProject(id: string) {
    const state = await loadProject(id);
    if (state) {
      await hydrate(state);
      showProjects = false;
      showToast(`已打开项目「${state.meta.name}」`);
      repack();
    }
  }

  async function removeProject(id: string, e: MouseEvent) {
    e.stopPropagation();
    await deleteProject(id);
    savedProjects = await listProjects();
  }

  // ---------- 全局拖放 ----------
  // action 参数：{ onFiles?: (files: File[]) => void }，未提供时走默认导入逻辑
  function dropAction(
    node: HTMLElement,
    params?: { onFiles?: (files: File[]) => void },
  ): { update?: (p?: { onFiles?: (files: File[]) => void }) => void; destroy: () => void } {
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      dragOver = true;
    };
    const onDragLeave = (e: DragEvent) => {
      if ((e.target as HTMLElement) === node) dragOver = false;
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      dragOver = false;
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (params?.onFiles) {
        params.onFiles(files);
        return;
      }
      if (files.some((f) => f.name.endsWith('.json'))) importFiles(files);
      else pickImages(files);
    };
    node.addEventListener('dragover', onDragOver);
    node.addEventListener('dragleave', onDragLeave);
    node.addEventListener('drop', onDrop);
    return {
      update(p?: { onFiles?: (files: File[]) => void }) {
        params = p;
      },
      destroy() {
        node.removeEventListener('dragover', onDragOver);
        node.removeEventListener('dragleave', onDragLeave);
        node.removeEventListener('drop', onDrop);
      },
    };
  }

  onMount(async () => {
    savedProjects = await listProjects();
  });
</script>

<div class="app" use:dropAction>
  <header>
    <div class="brand">🎞️ 精灵图集工坊 <span class="ver">Sprite Atlas Studio</span></div>
    <input class="project-name" value={$project.meta.name} on:change={renameInput} />
    <div class="spacer"></div>
    <label class="chk"><input type="checkbox" bind:checked={autoPack} /> 导入后自动打包</label>
    <button on:click={loadSamples} disabled={$busy}>生成示例素材</button>
    <button on:click={() => fileInput.click()}>导入图片</button>
    <button on:click={() => jsonInput.click()}>导入工程 JSON</button>
    <div class="menu-wrap">
      <button on:click={refreshProjects}>本地项目 ▾</button>
      {#if showProjects}
        <div class="menu" role="menu">
          {#if savedProjects.length === 0}
            <div class="menu-empty">暂无已保存项目（编辑会自动保存到 IndexedDB）</div>
          {:else}
            {#each savedProjects as p (p.id)}
              <div class="menu-item" role="menuitem" on:click={() => openProject(p.id)}>
                <div>
                  <div>{p.name}</div>
                  <div class="menu-date">{new Date(p.updatedAt).toLocaleString()}</div>
                </div>
                <button class="mini danger" on:click={(e) => removeProject(p.id, e)}>删除</button>
              </div>
            {/each}
          {/if}
        </div>
      {/if}
    </div>
    <label class="chk" title="勾选：单文件 JSON（内嵌图集页，便于分发）；不勾选：JSON + 独立 PNG 文件">
      <input type="checkbox" bind:checked={embedPages} /> 图集页内嵌 JSON
    </label>
    <button class="primary" on:click={doExport}>导出 JSON + PNG</button>
  </header>

  <main>
    <aside class="left">
      <FrameList {dropAction} />
    </aside>
    <section class="center">
      <PreviewPanel />
    </section>
    <aside class="right">
      <SettingsPanel />
      <SourceInspector />
      <AtlasView />
    </aside>
  </main>

  {#if $toast}
    <div class="toast {$toast.kind}">{$toast.text}</div>
  {/if}
  {#if $busy}<div class="busy-mask">处理中…</div>{/if}
  {#if dragOver}<div class="drop-hint">松开以导入（图片序列 / 工程 JSON）</div>{/if}
</div>

<style>
  .app {
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    background: var(--bg-2);
    border-bottom: 1px solid var(--border);
  }
  .brand {
    font-weight: 700;
    font-size: 14px;
    white-space: nowrap;
  }
  .ver {
    color: var(--text-dim);
    font-weight: 400;
    font-size: 11px;
    margin-left: 6px;
  }
  .project-name {
    width: 140px;
  }
  .spacer {
    flex: 1;
  }
  .chk {
    font-size: 11px;
    color: var(--text-dim);
    display: flex;
    align-items: center;
    gap: 4px;
  }
  main {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 280px 1fr 310px;
    gap: 8px;
    padding: 8px;
  }
  .left,
  .right {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
    overflow-y: auto;
  }
  .center {
    min-height: 0;
  }
  .menu-wrap {
    position: relative;
  }
  .menu {
    position: absolute;
    top: 34px;
    right: 0;
    width: 280px;
    background: var(--bg-3);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px;
    z-index: 50;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
  }
  .menu-empty {
    padding: 12px;
    color: var(--text-dim);
    font-size: 11px;
  }
  .menu-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 7px 9px;
    border-radius: 5px;
    cursor: pointer;
  }
  .menu-item:hover {
    background: var(--bg-2);
  }
  .menu-date {
    font-size: 10px;
    color: var(--text-dim);
  }
  .mini {
    padding: 2px 8px;
    font-size: 10px;
  }
  .toast {
    position: fixed;
    bottom: 18px;
    left: 50%;
    transform: translateX(-50%);
    background: var(--bg-3);
    border: 1px solid var(--accent);
    color: var(--text);
    padding: 9px 16px;
    border-radius: 8px;
    z-index: 100;
    max-width: 70vw;
  }
  .toast.error {
    border-color: var(--danger);
  }
  .busy-mask,
  .drop-hint {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 90;
    pointer-events: none;
    font-size: 18px;
  }
  .busy-mask {
    background: rgba(10, 12, 16, 0.45);
  }
  .drop-hint {
    background: rgba(44, 94, 168, 0.25);
    border: 3px dashed var(--accent);
    font-weight: 700;
  }
</style>
