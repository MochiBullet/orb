<script lang="ts">
  import { get } from "svelte/store";
  import { config, saveConfig, type OrbConfig } from "../core/config";

  let { onClose }: { onClose: () => void } = $props();

  let draft = $state<OrbConfig>({ ...get(config) });
  let saving = $state(false);

  async function save() {
    saving = true;
    try {
      await saveConfig(draft);
      config.set({ ...draft });
      onClose();
    } finally {
      saving = false;
    }
  }
</script>

<div class="overlay" onpointerdown={onClose} role="presentation">
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
    <div class="note">フォントは即反映 / スクロールバックは新しいペインから反映</div>

    <div class="btns">
      <button onclick={onClose}>キャンセル</button>
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
