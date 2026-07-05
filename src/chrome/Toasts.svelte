<script lang="ts">
  // #79 トースト表示。右下に積み、端末の邪魔をしない（トースト本体だけ pointer-events を拾う）。
  // enter/leave は transform+opacity のみ＝compositor-only（PERFORMANCE.md）。fly=translate+opacity,
  // fade=opacity で、いずれも layout/paint を起こさない。
  import { fly, fade } from "svelte/transition";
  import { toasts, dismissToast } from "../store/toasts";
</script>

<div class="toasts" role="region" aria-label="通知">
  {#each $toasts as t (t.id)}
    <!-- クリックでも × でも閉じられる。role=alert で読み上げにも乗せる。
         div クリックは便宜機能で、閉じる操作はキーボード到達可能な × ボタンで担保済み。 -->
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
    <div
      class="toast {t.kind}"
      role="alert"
      in:fly={{ y: 12, duration: 180 }}
      out:fade={{ duration: 140 }}
      onclick={() => dismissToast(t.id)}
    >
      <span class="msg">{t.message}</span>
      <button
        class="x"
        aria-label="閉じる"
        onclick={(e) => {
          e.stopPropagation();
          dismissToast(t.id);
        }}>×</button
      >
    </div>
  {/each}
</div>

<style>
  /* 右下固定。トーストが無い/隙間では pointer-events を通し、端末クリックを塞がない。 */
  .toasts {
    position: fixed;
    right: 14px;
    bottom: 14px;
    z-index: 200; /* Settings オーバーレイ(120)より上＝設定中の失敗も見える。 */
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: flex-end;
    pointer-events: none;
    max-width: min(380px, 80vw);
  }
  .toast {
    pointer-events: auto; /* 本体だけクリック可（コンテナは透過）。 */
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 9px 11px;
    border-radius: 8px;
    background: rgba(5, 16, 14, 0.94);
    border: 1px solid var(--edge, var(--grey));
    border-left-width: 3px;
    box-shadow: 0 6px 22px -8px rgba(0, 0, 0, 0.6);
    color: var(--fg);
    font-size: 0.76rem;
    line-height: 1.4;
    cursor: pointer;
    backdrop-filter: blur(6px);
  }
  /* 種別ごとの色（既存トークンのみ使用）。左枠の色で一目で判別。 */
  .toast.error {
    --edge: var(--red);
  }
  .toast.warn {
    --edge: var(--teal);
  }
  .toast.info {
    --edge: var(--grey);
  }
  .msg {
    flex: 1;
    word-break: break-word;
  }
  .x {
    flex: 0 0 auto;
    background: none;
    border: 0;
    color: var(--grey);
    font-size: 0.95rem;
    line-height: 1;
    padding: 0 2px;
    cursor: pointer;
  }
  .x:hover {
    color: var(--fg);
  }
</style>
