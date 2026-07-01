<script lang="ts">
  import { get } from "svelte/store";
  import { config, saveConfig, type OrbConfig } from "../core/config";
  import { applyBgVars } from "../core/theme";
  import { open } from "@tauri-apps/plugin-dialog";

  let { onClose }: { onClose: () => void } = $props();

  let draft = $state<OrbConfig>({ ...get(config) });
  let saving = $state(false);

  const PRESETS = ["#2dd4bf", "#a78bfa", "#38bdf8", "#fbbf24", "#fb7185", "#4ade80"];

  // ライブプレビュー: ドラフトのアクセント色を即 --teal に反映。
  $effect(() => {
    document.documentElement.style.setProperty("--teal", draft.accent || "#2dd4bf");
  });

  // #21: 背景画像・暗幕のライブプレビュー。config ストアを経由せず CSS 変数を直接書く
  // ＝端末の再描画/フォーカス移動を起こさない（過去 revert のフォーカス奪取回帰を回避）。
  // 余白・暗幕はライブで見える。端末本体（xterm キャンバス）の透過はレンダラ切替を伴うため
  // 保存＋再起動/新ペインで反映される（WebGL→DOM の切替）。
  $effect(() => {
    applyBgVars(draft.bg_image, draft.bg_dim);
  });

  // 背景画像の basename 表示用。
  const bgName = $derived(draft.bg_image ? draft.bg_image.split(/[\\/]/).pop() : "");

  async function pickBg() {
    try {
      const path = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "画像", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }],
      });
      if (typeof path === "string") draft.bg_image = path;
    } catch {
      /* ダイアログのキャンセル/失敗は無視 */
    }
  }

  function clearBg() {
    draft.bg_image = "";
  }

  async function save() {
    saving = true;
    try {
      await saveConfig(draft);
      config.set({ ...draft }); // theme.ts が購読して確定適用
      onClose();
    } finally {
      saving = false;
    }
  }

  function cancel() {
    // プレビューを保存前の値へ戻す（アクセント色＋背景）。
    const saved = get(config);
    document.documentElement.style.setProperty("--teal", saved.accent || "#2dd4bf");
    applyBgVars(saved.bg_image, saved.bg_dim);
    onClose();
  }
</script>

<div class="overlay" onpointerdown={cancel} role="presentation">
  <div class="panel" onpointerdown={(e) => e.stopPropagation()} role="presentation">
    <div class="title">設定</div>

    <label>
      <span>フォントサイズ</span>
      <input type="number" min="8" max="28" bind:value={draft.font_size} />
    </label>
    <label>
      <span>フォント</span>
      <input bind:value={draft.font_family} />
    </label>
    <label>
      <span>スクロールバック</span>
      <input type="number" min="100" max="100000" step="100" bind:value={draft.scrollback} />
    </label>
    <label>
      <span>アクセント色</span>
      <span class="accent-row">
        {#each PRESETS as p}
          <button
            class="swatch"
            class:sel={draft.accent.toLowerCase() === p}
            style="background:{p}"
            onclick={() => (draft.accent = p)}
            aria-label={p}
          ></button>
        {/each}
        <input type="color" bind:value={draft.accent} aria-label="custom accent" />
      </span>
    </label>
    <label class="toggle">
      <span>合字 (=&gt; != -&gt; 等)</span>
      <input type="checkbox" bind:checked={draft.ligatures} />
    </label>
    <label>
      <span>背景画像</span>
      <span class="bg-row">
        {#if bgName}<span class="bg-name" title={draft.bg_image}>{bgName}</span>{/if}
        <button class="bg-btn" onclick={pickBg}>選ぶ…</button>
        {#if draft.bg_image}<button class="bg-btn clear" onclick={clearBg}>クリア</button>{/if}
      </span>
    </label>
    {#if draft.bg_image}
      <label>
        <span>暗幕（{Math.round(draft.bg_dim * 100)}%）</span>
        <input type="range" min="0" max="0.9" step="0.05" bind:value={draft.bg_dim} />
      </label>
    {/if}
    <div class="note">フォント・アクセント色・合字は保存で反映 / 背景画像とスクロールバックは新しいペイン・再起動から反映</div>

    <div class="btns">
      <button onclick={cancel}>キャンセル</button>
      <button class="save" onclick={save} disabled={saving}>保存</button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 14vh;
    z-index: 120;
  }
  .panel {
    width: min(420px, 86vw);
    background: #05100e;
    border: 1px solid rgba(45, 212, 191, 0.4);
    border-radius: 10px;
    box-shadow: 0 0 40px -8px rgba(45, 212, 191, 0.35);
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .title {
    color: var(--teal);
    letter-spacing: 0.2em;
    font-size: 0.78rem;
    font-weight: 700;
  }
  label {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    font-size: 0.78rem;
    color: var(--grey);
  }
  input {
    flex: 1;
    max-width: 230px;
    background: #000;
    border: 1px solid rgba(45, 212, 191, 0.25);
    border-radius: 5px;
    color: var(--fg);
    font-family: inherit;
    font-size: 0.78rem;
    padding: 4px 8px;
    outline: none;
  }
  input:focus {
    border-color: rgba(45, 212, 191, 0.6);
  }
  .accent-row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    max-width: 230px;
    justify-content: flex-end;
  }
  .swatch {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 1px solid rgba(255, 255, 255, 0.2);
    cursor: pointer;
    padding: 0;
  }
  .swatch.sel {
    box-shadow: 0 0 0 2px #fff;
  }
  .accent-row input[type="color"] {
    width: 30px;
    max-width: 30px;
    height: 22px;
    padding: 0;
    border: 1px solid rgba(45, 212, 191, 0.25);
    border-radius: 4px;
    background: none;
    cursor: pointer;
  }
  .bg-row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    max-width: 230px;
    min-width: 0;
    justify-content: flex-end;
  }
  .bg-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg);
    font-size: 0.7rem;
  }
  .bg-btn {
    flex: 0 0 auto;
    border: 1px solid rgba(45, 212, 191, 0.3);
    background: transparent;
    color: var(--teal);
    font-family: inherit;
    font-size: 0.72rem;
    padding: 3px 10px;
    border-radius: 5px;
    cursor: pointer;
  }
  .bg-btn:hover {
    background: rgba(45, 212, 191, 0.12);
  }
  .bg-btn.clear {
    color: var(--grey);
    border-color: rgba(255, 255, 255, 0.15);
  }
  input[type="range"] {
    background: transparent;
    border: 0;
    padding: 0;
    accent-color: var(--teal);
    cursor: pointer;
  }
  .toggle {
    cursor: pointer;
  }
  .toggle input[type="checkbox"] {
    flex: 0 0 auto;
    width: 16px;
    height: 16px;
    max-width: 16px;
    padding: 0;
    accent-color: var(--teal);
    cursor: pointer;
  }
  .note {
    font-size: 0.66rem;
    color: var(--grey);
    opacity: 0.7;
  }
  .btns {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }
  .btns button {
    border: 1px solid rgba(45, 212, 191, 0.3);
    background: transparent;
    color: var(--grey);
    font-family: inherit;
    font-size: 0.76rem;
    padding: 5px 14px;
    border-radius: 6px;
    cursor: pointer;
  }
  .btns .save {
    border-color: var(--teal);
    color: var(--teal);
  }
  .btns button:hover {
    background: rgba(45, 212, 191, 0.12);
  }
</style>
