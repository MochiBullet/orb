<script lang="ts">
  import { onMount } from "svelte";
  import {
    currentProjectCwd,
    listCheckpointsForAiPane,
    checkpointDiff,
    checkpointRestore,
    type Checkpoint,
  } from "../core/checkpoints";
  import { logError } from "../core/log";

  // #54: 「直前のターンに巻き戻す」。一覧 → 選択で diff プレビュー → 明示確認 → 復元。
  // 破壊的操作（git reset --hard）はこのパネルの confirm クリックでしか発火しない。
  let { onClose }: { onClose: () => void } = $props();

  const cwd = currentProjectCwd();
  let checkpoints = $state<Checkpoint[]>([]);
  let loading = $state(true);
  let selected = $state<Checkpoint | null>(null);
  let diffText = $state("");
  let diffLoading = $state(false);
  // #54 レビュー指摘: diff 取得失敗を「変更なし」と同じ表示にすると、実際は差分を確認できて
  // いないのに安心して復元してしまう（「嘘をつかない」原則違反）。専用のエラー状態で区別する。
  let diffError = $state("");
  let restoring = $state(false);
  let restoreError = $state("");

  async function load() {
    loading = true;
    checkpoints = await listCheckpointsForAiPane();
    loading = false;
  }

  async function select(cp: Checkpoint) {
    selected = cp;
    diffText = "";
    diffError = "";
    restoreError = "";
    if (!cwd) return;
    diffLoading = true;
    try {
      diffText = await checkpointDiff(cwd, cp.hash);
    } catch (e) {
      diffError = String(e);
      logError(`checkpoint diff failed: ${String(e)}`);
    } finally {
      diffLoading = false;
    }
  }

  async function confirmRestore() {
    if (!cwd || !selected) return;
    restoring = true;
    restoreError = "";
    try {
      await checkpointRestore(cwd, selected.hash);
      onClose(); // 復元成功＝目的達成。パネルを閉じて結果はターミナル/エディタで見てもらう。
    } catch (e) {
      restoreError = String(e);
      logError(`checkpoint restore failed: ${String(e)}`);
    } finally {
      restoring = false;
    }
  }

  function fmtWhen(ms: number): string {
    const diff = Math.max(0, Date.now() - ms);
    const min = Math.floor(diff / 60000);
    if (min < 1) return "たった今";
    if (min < 60) return `${min}分前`;
    const hr = Math.floor(min / 60);
    return `${hr}時間前`;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  onMount(() => void load());
</script>

<svelte:window onkeydown={onKey} />

<div class="overlay" onpointerdown={onClose} role="presentation">
  <div class="panel" onpointerdown={(e) => e.stopPropagation()} role="presentation">
    <div class="bar">
      <span class="ttl">チェックポイント</span>
      <span class="hint">AI ペインのターン開始ごとに自動で控えた作業ツリーのスナップショット（直近{checkpoints.length}件）</span>
      <button class="x" onclick={onClose} aria-label="閉じる">✕</button>
    </div>

    {#if !cwd}
      <div class="empty">AI ペインがありません（パレット「このペインを AI ペインに設定」）</div>
    {:else if loading}
      <div class="empty">読み込み中…</div>
    {:else if !checkpoints.length}
      <div class="empty">この案件にはまだチェックポイントがありません（git リポジトリでない、または変化がまだ無い）</div>
    {:else}
      <div class="body">
        <div class="list">
          {#each checkpoints as cp (cp.hash)}
            <button
              class="row"
              class:active={selected?.hash === cp.hash}
              onclick={() => select(cp)}
            >
              <span class="hash">{cp.hash.slice(0, 7)}</span>
              <span class="when">{fmtWhen(cp.created_at)}</span>
            </button>
          {/each}
        </div>
        <div class="preview">
          {#if !selected}
            <div class="empty">左の一覧からチェックポイントを選んで差分を確認</div>
          {:else if diffLoading}
            <div class="empty">差分を取得中…</div>
          {:else if diffError}
            <!-- 差分が取れていない状態での復元は「確認せずに上書き」になるため、ボタン自体を
                 出さない（診断メッセージだけ見せて、選び直し/再試行を促す）。 -->
            <div class="empty err">差分の取得に失敗しました: {diffError}</div>
          {:else}
            <pre class="diff">{diffText || "(このチェックポイント以降、変更はありません)"}</pre>
            <div class="confirm-row">
              {#if restoreError}
                <span class="err">{restoreError}</span>
              {/if}
              <button class="restore" onclick={confirmRestore} disabled={restoring}>
                {restoring ? "巻き戻し中…" : "この時点に巻き戻す（作業ツリーを上書き）"}
              </button>
            </div>
          {/if}
        </div>
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
  .panel {
    width: min(920px, 96vw);
    max-height: 84vh;
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
    gap: 10px;
    padding: 8px 8px 8px 14px;
    border-bottom: 1px solid rgba(45, 212, 191, 0.2);
  }
  .ttl {
    color: var(--fg);
    font-size: 0.86rem;
    flex: 0 0 auto;
  }
  .hint {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--grey);
    font-size: 0.68rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .x {
    flex: 0 0 auto;
    width: 28px;
    height: 28px;
    border: 1px solid rgba(45, 212, 191, 0.3);
    border-radius: 6px;
    background: transparent;
    color: var(--teal);
    cursor: pointer;
  }
  .x:hover {
    background: rgba(45, 212, 191, 0.14);
    border-color: var(--teal);
  }
  .empty {
    color: var(--grey);
    opacity: 0.65;
    font-size: 0.8rem;
    padding: 30px 16px;
    text-align: center;
  }
  .body {
    display: flex;
    min-height: 340px;
    max-height: 62vh;
  }
  .list {
    flex: 0 0 200px;
    overflow-y: auto;
    border-right: 1px solid rgba(45, 212, 191, 0.15);
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .row {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: var(--fg);
    font-family: inherit;
    padding: 6px 8px;
    cursor: pointer;
    text-align: left;
  }
  .row:hover {
    background: rgba(45, 212, 191, 0.08);
  }
  .row.active {
    border-color: rgba(45, 212, 191, 0.4);
    background: rgba(45, 212, 191, 0.12);
  }
  .hash {
    font-size: 0.78rem;
    color: var(--teal);
  }
  .when {
    font-size: 0.66rem;
    color: var(--grey);
  }
  .preview {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    padding: 10px;
    overflow: hidden;
  }
  .diff {
    flex: 1 1 auto;
    overflow: auto;
    margin: 0;
    font-size: 0.74rem;
    line-height: 1.5;
    color: var(--fg);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .confirm-row {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    padding-top: 8px;
    border-top: 1px solid rgba(45, 212, 191, 0.15);
  }
  .err {
    color: #ff5c8a;
    font-size: 0.72rem;
  }
  .restore {
    border: 1px solid rgba(255, 92, 138, 0.5);
    border-radius: 6px;
    background: transparent;
    color: #ff5c8a;
    font-family: inherit;
    font-size: 0.76rem;
    padding: 6px 12px;
    cursor: pointer;
  }
  .restore:hover:not(:disabled) {
    background: rgba(255, 92, 138, 0.14);
  }
  .restore:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
