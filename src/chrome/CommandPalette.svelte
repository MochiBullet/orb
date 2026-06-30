<script lang="ts">
  import { untrack } from "svelte";

  export interface PaletteAction {
    label: string;
    hint?: string;
    run: () => void;
  }

  let {
    actions,
    onClose,
    initialMode = "search",
  }: { actions: PaletteAction[]; onClose: () => void; initialMode?: "search" | "help" } = $props();

  let query = $state("");
  let sel = $state(0);
  let input = $state<HTMLInputElement | undefined>(undefined);
  let mode = $state<"search" | "help">(untrack(() => initialMode));

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
  function runAction(a: PaletteAction) {
    onClose();
    a.run();
  }

  // Tab で選択中の候補をクエリ欄へ補完（オートコンプリート、実行はしない）。
  function complete() {
    const a = filtered[sel];
    if (a) {
      query = a.label;
      queueMicrotask(() => input?.focus());
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (mode === "help") { mode = "search"; queueMicrotask(() => input?.focus()); }
      else onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      sel = Math.min(filtered.length - 1, sel + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      sel = Math.max(0, sel - 1);
    } else if (e.key === "Tab") {
      e.preventDefault();
      complete();
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(sel);
    }
  }

  // info（説明書）に載せる、パレットに無い純粋なキー操作リファレンス。
  const reference: { keys: string; desc: string }[] = [
    { keys: "Ctrl+Shift+P", desc: "コマンドパレット" },
    { keys: "Ctrl+P", desc: "案件ランチャー" },
    { keys: "Ctrl+T / Ctrl+W", desc: "タブ 新規 / 閉じる" },
    { keys: "Ctrl+Tab", desc: "フォーカスを次ペインへ循環" },
    { keys: "Ctrl+Shift+D / E", desc: "ペイン 横分割 / 縦分割" },
    { keys: "Ctrl+Shift+W", desc: "ペインを閉じる" },
    { keys: "Ctrl+Shift+Z", desc: "ペインをズーム（全面）切替" },
    { keys: "Ctrl+Shift+K", desc: "ターミナルの画面をクリア" },
    { keys: "Ctrl+Shift+B", desc: "サイドバー左右入替" },
    { keys: "Ctrl+↑ / Ctrl+↓", desc: "コマンドブロックを上下ジャンプ" },
    { keys: "Ctrl+F", desc: "ターミナル内を検索" },
    { keys: "Ctrl+L", desc: "選択テキストを AI ペインへ送る" },
    { keys: "Ctrl+= / Ctrl+- / Ctrl+0", desc: "文字サイズ 拡大 / 縮小 / リセット" },
    { keys: "Ctrl+, ", desc: "設定を開く" },
    { keys: "ダブルクリック（タブ）", desc: "タブ名をリネーム" },
  ];

  $effect(() => { if (mode === "search") input?.focus(); });
  // クエリが変わったら選択を先頭へ。
  $effect(() => {
    query;
    sel = 0;
  });
</script>

<div class="overlay" onpointerdown={onClose} role="presentation">
  <div class="palette" onpointerdown={(e) => e.stopPropagation()} role="presentation">
    <div class="bar">
      <span class="mag" aria-hidden="true">⌕</span>
      <input
        bind:this={input}
        bind:value={query}
        onkeydown={onKey}
        onfocus={() => (mode = "search")}
        placeholder="コマンドを検索…  (↑↓ / Tab 補完 / Enter / Esc)"
      />
      <button
        class="info"
        class:active={mode === "help"}
        title="ショートカット説明書"
        aria-label="ショートカット説明書"
        aria-pressed={mode === "help"}
        onclick={() => (mode = mode === "help" ? "search" : "help")}
      >&#9432;</button>
    </div>

    {#if mode === "search"}
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
    {:else}
      <div class="help">
        <p class="help-head">クリックで実行できるコマンド</p>
        <div class="list">
          {#each actions as a (a.label)}
            <button class="item" onclick={() => runAction(a)}>
              <span class="lbl">{a.label}</span>
              {#if a.hint}<span class="kbd">{a.hint}</span>{/if}
            </button>
          {/each}
        </div>
        <p class="help-head">キー操作リファレンス</p>
        <ul class="ref">
          {#each reference as r}
            <li><span class="kbd">{r.keys}</span><span class="ref-desc">{r.desc}</span></li>
          {/each}
        </ul>
      </div>
    {/if}
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
    padding-top: 10px;
    z-index: 130;
  }
  .palette {
    width: min(720px, 94vw);
    max-height: 82vh;
    background: #05100e;
    border: 1px solid rgba(45, 212, 191, 0.4);
    border-radius: 10px;
    box-shadow: 0 0 40px -8px rgba(45, 212, 191, 0.4);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px 4px 14px;
    border-bottom: 1px solid rgba(45, 212, 191, 0.2);
  }
  .mag {
    color: var(--teal);
    font-size: 1.1rem;
    line-height: 1;
    flex: 0 0 auto;
  }
  input {
    flex: 1 1 auto;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--fg);
    font-family: inherit;
    font-size: 0.92rem;
    padding: 11px 4px;
    outline: none;
  }
  .info {
    flex: 0 0 auto;
    width: 30px;
    height: 30px;
    border: 1px solid rgba(45, 212, 191, 0.3);
    border-radius: 6px;
    background: transparent;
    color: var(--teal);
    font-size: 1.05rem;
    line-height: 1;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .info:hover {
    background: rgba(45, 212, 191, 0.14);
    border-color: var(--teal);
  }
  .info.active {
    background: rgba(45, 212, 191, 0.2);
    color: var(--fg);
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
  .item:hover,
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
  /* help (説明書) */
  .help {
    overflow-y: auto;
    padding: 10px 6px 14px;
  }
  .help-head {
    margin: 8px 14px 4px;
    font-size: 0.62rem;
    letter-spacing: 0.16em;
    color: var(--teal);
    text-transform: uppercase;
  }
  .kbd {
    flex: 0 0 auto;
    margin-left: 12px;
    font-size: 0.66rem;
    color: var(--teal);
    background: rgba(45, 212, 191, 0.1);
    border: 1px solid rgba(45, 212, 191, 0.25);
    border-radius: 4px;
    padding: 1px 6px;
    white-space: nowrap;
  }
  .ref {
    list-style: none;
    margin: 0;
    padding: 0 8px;
  }
  .ref li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 8px;
    font-size: 0.8rem;
    color: var(--fg);
    border-radius: 6px;
  }
  .ref li:nth-child(odd) {
    background: rgba(255, 255, 255, 0.02);
  }
  .ref .kbd {
    margin-left: 0;
    order: 2;
  }
  .ref-desc {
    color: var(--grey);
  }
</style>
