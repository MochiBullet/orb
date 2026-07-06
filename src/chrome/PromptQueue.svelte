<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { layout, aiPane, focusedPane } from "../store/appStore";
  import { leafIds } from "../layout/tree";
  import { pushToast } from "../store/toasts";
  import {
    queues,
    armedPanes,
    enqueuePrompt,
    removePrompt,
    updatePrompt,
    movePrompt,
    cancelArmed,
    resumePane,
    pauseArmForEdit,
    resumeArmAfterEdit,
  } from "../store/promptQueue";

  // #51 プロンプトキュー: 実行中の AI ペインに「次の指示」を積む → waiting で自動投入。
  // オーバーレイの流儀は BlockHistory 踏襲（Esc で閉じる・panel 内クリックは透過しない）。
  let { onClose }: { onClose: () => void } = $props();

  // 対象ペイン候補＝アクティブタブの leaf（info タブ表示中などは空になり得る）。
  let panes = $derived($layout ? leafIds($layout) : []);

  // 既定の対象: AI ペイン、無ければフォーカスペイン（>0）、それも無ければ先頭 leaf。
  function defaultPane(): number | null {
    const ids = get(layout) ? leafIds(get(layout)!) : [];
    const ai = get(aiPane);
    if (ai != null && ids.includes(ai)) return ai;
    const f = get(focusedPane);
    if (f > 0 && ids.includes(f)) return f;
    return ids[0] ?? null;
  }
  let target = $state<number | null>(defaultPane());

  let text = $state("");
  let editingId = $state<string | null>(null);
  // #5: 編集開始時に予約を止めたペイン（編集終了時にここへ再評価をかける。target 切替に引きずられない）。
  let editingPane = $state<number | null>(null);
  let ta = $state<HTMLTextAreaElement | undefined>(undefined);

  let q = $derived(target != null ? $queues.get(target) : undefined);
  let armed = $derived(target != null ? $armedPanes.get(target) : undefined);

  // 予約カウントダウン用の現在時刻（予約が無い間は回さない）。
  let now = $state(Date.now());
  $effect(() => {
    if (!armed) return;
    const t = setInterval(() => (now = Date.now()), 200);
    return () => clearInterval(t);
  });
  let remainSec = $derived(armed ? Math.max(0, Math.ceil((armed.sendAt - now) / 1000)) : 0);

  // #5: 編集中に止めていた予約を再評価する（無ければ何もしない）。
  function resumeEditPause() {
    if (editingPane != null) resumeArmAfterEdit(editingPane);
    editingPane = null;
  }

  function submit() {
    if (target == null || !text.trim()) return;
    if (editingId) {
      // 予約の猶予中に fire() 済みで既に送信されていた場合は false（黙って握り潰さず伝える）。
      if (!updatePrompt(editingId, text)) {
        pushToast("warn", "編集対象は既に送信されました");
      }
      editingId = null;
      resumeEditPause();
    } else {
      enqueuePrompt(target, text);
    }
    text = "";
    ta?.focus();
  }

  function beginEdit(id: string, current: string) {
    editingId = id;
    text = current;
    // 編集中に古いテキストのまま自動発火しないよう、対象ペインの予約を一旦止める。
    if (target != null) {
      editingPane = target;
      pauseArmForEdit(target);
    }
    ta?.focus();
  }

  function cancelEdit() {
    editingId = null;
    text = "";
    resumeEditPause();
  }

  function onTextKey(e: KeyboardEvent) {
    if (e.key === "Enter" && e.ctrlKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // window の Esc（閉じる）と二重処理させない
      if (editingId) cancelEdit();
      else onClose();
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  onMount(() => {
    queueMicrotask(() => ta?.focus());
  });

  // #5: 編集中断のまま（送信/中止を経ずに）オーバーレイを閉じても、止めた予約を放置しない。
  onDestroy(() => resumeEditPause());
</script>

<svelte:window onkeydown={onKey} />

<div class="overlay" onpointerdown={onClose} role="presentation">
  <div class="panel" onpointerdown={(e) => e.stopPropagation()} role="presentation">
    <div class="bar">
      <span class="ttl">プロンプトキュー</span>
      <select bind:value={target} title="対象ペイン" aria-label="対象ペイン">
        {#each panes as id (id)}
          <option value={id}>ペイン {id}{id === $aiPane ? " (AI)" : ""}</option>
        {/each}
      </select>
      <span class="note">入力待ちになったら上から順に自動送信（3秒の猶予つき）</span>
      <button class="x" onclick={onClose} aria-label="閉じる">✕</button>
    </div>

    <div class="compose">
      <textarea
        bind:this={ta}
        bind:value={text}
        onkeydown={onTextKey}
        rows="3"
        placeholder={editingId ? "編集中…  (Ctrl+Enter で更新 / Esc で中止)" : "次の指示を積む…  (Ctrl+Enter で追加)"}
      ></textarea>
      <div class="compose-tools">
        {#if editingId}
          <button class="add" onclick={submit} disabled={!text.trim()}>更新</button>
          <button class="ghost" onclick={cancelEdit}>編集中止</button>
        {:else}
          <button class="add" onclick={submit} disabled={target == null || !text.trim()}>追加</button>
        {/if}
      </div>
    </div>

    {#if q?.paused}
      <div class="banner paused-banner">
        ⏸ 一時停止中（失敗を検知したため自動送信を止めています）
        <button onclick={() => target != null && resumePane(target)}>再開</button>
      </div>
    {/if}
    {#if armed}
      <div class="banner armed-banner">
        ⧗ {remainSec}秒後に先頭のプロンプトを送信…
        <button onclick={() => target != null && cancelArmed(target)}>キャンセル</button>
      </div>
    {/if}

    <div class="list">
      {#if !q || q.items.length === 0}
        <div class="empty">このペインのキューは空です（上の欄から積めます）</div>
      {:else}
        {#each q.items as it, i (it.id)}
          <div class="row" class:armed-row={armed?.itemId === it.id}>
            <span class="idx">{i + 1}</span>
            <span class="txt" title={it.text}>{it.text}</span>
            <span class="tools">
              <button onclick={() => movePrompt(it.paneId, it.id, -1)} disabled={i === 0} title="上へ">↑</button>
              <button
                onclick={() => movePrompt(it.paneId, it.id, 1)}
                disabled={i === q.items.length - 1}
                title="下へ">↓</button
              >
              <button onclick={() => beginEdit(it.id, it.text)} title="編集">✎</button>
              <button onclick={() => removePrompt(it.paneId, it.id)} title="削除">✕</button>
            </span>
          </div>
        {/each}
      {/if}
    </div>
    <div class="foot">
      🔔 要承認（許可プロンプト）中は送信しない · 失敗検知で自動停止 · broadcast 中は保留
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
    padding-top: 10px;
    z-index: 130;
  }
  .panel {
    width: min(680px, 96vw);
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
  select {
    flex: 0 0 auto;
    background: rgba(45, 212, 191, 0.08);
    border: 1px solid rgba(45, 212, 191, 0.3);
    border-radius: 4px;
    color: var(--teal);
    font-family: inherit;
    font-size: 0.72rem;
    padding: 2px 6px;
    outline: none;
  }
  .note {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--grey);
    opacity: 0.6;
    font-size: 0.66rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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
  .compose {
    padding: 10px 14px 8px;
    border-bottom: 1px solid rgba(45, 212, 191, 0.12);
  }
  textarea {
    width: 100%;
    resize: vertical;
    background: rgba(45, 212, 191, 0.05);
    border: 1px solid rgba(45, 212, 191, 0.25);
    border-radius: 6px;
    color: var(--fg);
    font-family: inherit;
    font-size: 0.82rem;
    padding: 8px 10px;
    outline: none;
    box-sizing: border-box;
  }
  textarea:focus {
    border-color: rgba(45, 212, 191, 0.55);
  }
  .compose-tools {
    display: flex;
    gap: 6px;
    justify-content: flex-end;
    margin-top: 6px;
  }
  .add {
    border: 1px solid rgba(45, 212, 191, 0.4);
    border-radius: 6px;
    background: rgba(45, 212, 191, 0.12);
    color: var(--teal);
    font-family: inherit;
    font-size: 0.72rem;
    padding: 4px 14px;
    cursor: pointer;
  }
  .add:hover:not(:disabled) {
    background: rgba(45, 212, 191, 0.22);
  }
  .add:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .ghost {
    border: 1px solid rgba(139, 168, 163, 0.3);
    border-radius: 6px;
    background: transparent;
    color: var(--grey);
    font-family: inherit;
    font-size: 0.72rem;
    padding: 4px 10px;
    cursor: pointer;
  }
  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 14px;
    font-size: 0.74rem;
    border-bottom: 1px solid rgba(45, 212, 191, 0.12);
  }
  .banner button {
    border-radius: 6px;
    font-family: inherit;
    font-size: 0.7rem;
    padding: 2px 10px;
    cursor: pointer;
  }
  .paused-banner {
    color: #fbbf24;
    background: rgba(251, 191, 36, 0.07);
  }
  .paused-banner button {
    border: 1px solid rgba(251, 191, 36, 0.45);
    background: transparent;
    color: #fbbf24;
  }
  .paused-banner button:hover {
    background: rgba(251, 191, 36, 0.14);
  }
  .armed-banner {
    color: var(--teal);
    background: rgba(45, 212, 191, 0.07);
  }
  .armed-banner button {
    border: 1px solid rgba(255, 92, 138, 0.45);
    background: transparent;
    color: #ff5c8a;
  }
  .armed-banner button:hover {
    background: rgba(255, 92, 138, 0.14);
  }
  .list {
    overflow-y: auto;
    padding: 6px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 10px;
    border-radius: 6px;
    font-size: 0.8rem;
  }
  .row:hover {
    background: rgba(45, 212, 191, 0.08);
  }
  .row.armed-row {
    background: rgba(45, 212, 191, 0.1);
    box-shadow: inset 2px 0 0 var(--teal, #2dd4bf);
  }
  .idx {
    flex: 0 0 auto;
    min-width: 20px;
    text-align: center;
    color: var(--grey);
    font-size: 0.7rem;
    font-variant-numeric: tabular-nums;
  }
  .txt {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tools {
    flex: 0 0 auto;
    display: flex;
    gap: 4px;
    opacity: 0;
    transition: opacity 0.12s;
  }
  .row:hover .tools {
    opacity: 1;
  }
  .tools button {
    border: 1px solid rgba(45, 212, 191, 0.25);
    background: transparent;
    color: var(--teal);
    font-family: inherit;
    font-size: 0.68rem;
    border-radius: 4px;
    padding: 2px 7px;
    cursor: pointer;
  }
  .tools button:hover:not(:disabled) {
    background: rgba(45, 212, 191, 0.14);
  }
  .tools button:disabled {
    opacity: 0.3;
    cursor: default;
  }
  .empty {
    color: var(--grey);
    opacity: 0.65;
    font-size: 0.8rem;
    padding: 22px 16px;
    text-align: center;
  }
  .foot {
    flex: 0 0 auto;
    border-top: 1px solid rgba(45, 212, 191, 0.15);
    padding: 5px 14px;
    color: var(--grey);
    opacity: 0.6;
    font-size: 0.66rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
