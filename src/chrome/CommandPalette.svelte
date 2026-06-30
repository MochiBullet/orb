<script lang="ts">
  export interface PaletteAction {
    label: string;
    hint?: string;
    run: () => void;
  }

  let { actions, onClose }: { actions: PaletteAction[]; onClose: () => void } = $props();

  let query = $state("");
  let sel = $state(0);
  let input = $state<HTMLInputElement | undefined>(undefined);

  let filtered = $derived(
    query.trim() ? actions.filter((a) => fuzzy(a.label, query)) : actions,
  );

  // ゆるい部分一致（クエリの各文字が順番に現れる）。
  function fuzzy(text: string, q: string): boolean {
    const t = text.toLowerCase();
    const ql = q.toLowerCase().replace(/\s+/g, "");
    let i = 0;
    for (const ch of t) {
      if (ch === ql[i]) i++;
      if (i >= ql.length) return true;
    }
    return ql.length === 0;
  }

  function run(i: number) {
    const a = filtered[i];
    if (!a) return;
    onClose();
    a.run();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      sel = Math.min(filtered.length - 1, sel + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      sel = Math.max(0, sel - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(sel);
    }
  }

  $effect(() => input?.focus());
  // クエリが変わったら選択を先頭へ。
  $effect(() => {
    query;
    sel = 0;
  });
</script>

<div class="overlay" onpointerdown={onClose} role="presentation">
  <div class="palette" onpointerdown={(e) => e.stopPropagation()} role="presentation">
    <input
      bind:this={input}
      bind:value={query}
      onkeydown={onKey}
      placeholder="コマンドを検索…  (↑↓ / Enter / Esc)"
    />
    <div class="list">
      {#each filtered as a, i (a.label)}
        <button
          class="item"
          class:sel={i === sel}
          onclick={() => run(i)}
          onpointerenter={() => (sel = i)}
        >
          <span class="lbl">{a.label}</span>
          {#if a.hint}<span class="hint">{a.hint}</span>{/if}
        </button>
      {/each}
      {#if !filtered.length}
        <div class="empty">該当なし</div>
      {/if}
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
    padding-top: 12vh;
    z-index: 130;
  }
  .palette {
    width: min(520px, 88vw);
    max-height: 60vh;
    background: #05100e;
    border: 1px solid rgba(45, 212, 191, 0.4);
    border-radius: 10px;
    box-shadow: 0 0 40px -8px rgba(45, 212, 191, 0.4);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  input {
    border: 0;
    border-bottom: 1px solid rgba(45, 212, 191, 0.2);
    background: transparent;
    color: var(--fg);
    font-family: inherit;
    font-size: 0.92rem;
    padding: 13px 16px;
    outline: none;
  }
  .list {
    overflow-y: auto;
    padding: 6px;
  }
  .item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    border: 0;
    background: transparent;
    color: var(--grey);
    font-family: inherit;
    font-size: 0.82rem;
    text-align: left;
    padding: 8px 12px;
    border-radius: 6px;
    cursor: pointer;
  }
  .item.sel {
    background: rgba(45, 212, 191, 0.14);
    color: var(--fg);
  }
  .lbl {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hint {
    font-size: 0.68rem;
    color: var(--grey);
    opacity: 0.6;
    margin-left: 12px;
    flex: 0 0 auto;
  }
  .empty {
    color: var(--grey);
    opacity: 0.6;
    font-size: 0.78rem;
    padding: 14px 16px;
    text-align: center;
  }
</style>
