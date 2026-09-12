<script lang="ts">
  import { project, repack, updateSettings } from '../lib/stores';

  const s = () => $project.settings;

  async function patch(p: Partial<ReturnType<typeof s>>) {
    await updateSettings(p);
  }
</script>

<div class="panel">
  <h3 class="section-title">打包参数</h3>

  <div class="field">
    <label title="把内容边缘像素向外复制 N 像素，半透明边缘的 alpha 一并拉伸">
      边缘扩色 extrude
      <div class="hint">防止缩小采样时混入透明黑</div>
    </label>
    <input
      type="number"
      min="0"
      max="32"
      value={s().extrude}
      on:change={(e) => patch({ extrude: Number(e.currentTarget.value) })}
    />
  </div>

  <div class="field">
    <label title="图块之间额外的纯透明间隙，与边缘扩色相互独立">
      透明留白 padding
      <div class="hint">块间隔离，防止邻帧颜色渗入</div>
    </label>
    <input
      type="number"
      min="0"
      max="64"
      value={s().padding}
      on:change={(e) => patch({ padding: Number(e.currentTarget.value) })}
    />
  </div>

  <div class="field">
    <label title="图集四周的安全边距">图集页边距 border</label>
    <input
      type="number"
      min="0"
      max="64"
      value={s().border}
      on:change={(e) => patch({ border: Number(e.currentTarget.value) })}
    />
  </div>

  <div class="field">
    <label>最大尺寸</label>
    <div class="row" style="gap:4px">
      <input
        type="number"
        min="64"
        max="8192"
        value={s().maxWidth}
        on:change={(e) => patch({ maxWidth: Number(e.currentTarget.value) })}
      />
      <span style="color:var(--text-dim)">×</span>
      <input
        type="number"
        min="64"
        max="8192"
        value={s().maxHeight}
        on:change={(e) => patch({ maxHeight: Number(e.currentTarget.value) })}
      />
    </div>
  </div>

  <div class="field">
    <label title="允许把帧旋转 90° 装箱；导出的元数据带 rotate=6，引擎自动转回">
      允许旋转装箱
    </label>
    <input
      type="checkbox"
      checked={s().allowRotation}
      on:change={(e) => patch({ allowRotation: e.currentTarget.checked })}
    />
  </div>

  <div class="field">
    <label>2 的幂尺寸 (POT)</label>
    <input
      type="checkbox"
      checked={s().pot}
      on:change={(e) => patch({ pot: e.currentTarget.checked })}
    />
  </div>

  <div class="field">
    <label>方形图集</label>
    <input
      type="checkbox"
      checked={s().square}
      on:change={(e) => patch({ square: e.currentTarget.checked })}
    />
  </div>

  <div class="field">
    <label title="运行时缩放系数，写入元数据；扩色像素数应与此匹配">运行时缩放系数</label>
    <input
      type="number"
      min="0.1"
      max="2"
      step="0.1"
      value={s().scale}
      on:change={(e) => patch({ scale: Number(e.currentTarget.value) })}
    />
  </div>

  <button class="primary" style="width:100%;margin-top:8px" on:click={() => repack()}>
    重新打包
  </button>
</div>

<style>
  .hint {
    color: var(--text-dim);
    font-size: 10px;
    font-weight: normal;
  }
</style>
