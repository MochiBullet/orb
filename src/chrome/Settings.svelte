<script lang="ts">
  import { get } from "svelte/store";
  import { config, saveConfig, type OrbConfig } from "../core/config";
  import { open } from "@tauri-apps/plugin-dialog";

  let { onClose }: { onClose: () => void } = $props();

  const original = get(config);
  let draft = $state<OrbConfig>({ ...original });
  let saving = $state(false);

  const PRESETS = ["#2dd4bf", "#a78bfa", "#38bdf8", "#fbbf24", "#fb7185", "#4ade80"];

  // ライブプレビュー: ドラフトを config へ即反映（theme.ts と端末透過が連動して見える）。
  $effect(() => config.set({ ...draft }));

  function blurActive() {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  async function save() {
    blurActive();
    saving = true;
    try {
      await saveConfig(draft); // config は $effect で既に draft
      onClose();
    } finally {
      saving = false;
    }
  }

  function cancel() {
    blurActive();
    config.set(original); // プレビューを保存前へ戻す
    onClose();
  }

  async function pickImage() {
    const f = await open({
      multiple: false,
      filters: [{ name: "画像", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"] }],
    });
    if (typeof f === "string") draft.bg_image = f;
  }
  function fileName(p: string): string {
    return p.replace(/\\/g, "/").split("/").pop() || p;
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
    <label>
      <span>背景画像</span>
      <span class="bg-row">
        <button class="pick" onclick={pickImage}>
          {draft.bg_image ? fileName(draft.bg_image) : "画像を選択…"}
        </button>
        {#if draft.bg_image}
          <button class="clear" onclick={() => (draft.bg_image = "")} aria-label="クリア">&#x2715;</button>
        {/if}
      </span>
    </label>
    {#if draft.bg_image}
      <label>
        <span>暗幕 {Math.round(draft.bg_dim * 100)}%</span>
        <input type="range" min="0" max="0.9" step="0.05" bind:value={draft.bg_dim} />
      </label>
    {/if}
    <div class="note">フォント・アクセント・背景は即反映 / スクロールバックは新しいペインから</div>

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
    width: min(440px, 88vw);
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
    max-width: 250px;
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
  input[type="range"] {
    padding: 0;
  }
  .accent-row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    max-width: 250px;
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
    max-width: 250px;
    justify-content: flex-end;
  }
  .pick {
    border: 1px solid rgba(45, 212, 191, 0.3);
    background: #000;
    color: var(--fg);
    font-family: inherit;
    font-size: 0.74rem;
    padding: 4px 10px;
    border-radius: 5px;
    cursor: pointer;
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pick:hover {
    border-color: var(--teal);
  }
  .clear {
    border: 1px solid rgba(255, 92, 138, 0.3);
    background: transparent;
    color: var(--red);
    font-size: 0.66rem;
    padding: 3px 7px;
    border-radius: 5px;
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
