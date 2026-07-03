<script lang="ts">
  import { onMount } from "svelte";
  import { sendInputToFocusedPane } from "../store/appStore";
  import { frameBracketedPaste } from "../core/ai-payload";
  import { getClaudeStatus } from "../core/status";
  import { logError } from "../core/log";
  import { MCP_CATALOG, isInstalled } from "../data/mcp-catalog";

  // #46: おすすめ MCP カタログ。行の[インストール]でコマンドをフォーカス中ペインへ
  // 挿入する（Enter は送らない＝実行は人が確認して押す）。導入済み判定は
  // get_claude_status の短縮名配列（get_mcp_health は重いので使わない）。
  let { onClose }: { onClose: () => void } = $props();

  // null = 未取得/取得失敗。判定できないだけなので全ボタン活性のまま（壊さない）。
  let configured = $state<string[] | null>(null);
  let panel = $state<HTMLDivElement | undefined>(undefined);

  onMount(() => {
    // ターミナルの textarea から DOM フォーカスを外す（Esc が PTY へ漏れないように）。
    queueMicrotask(() => panel?.focus());
    getClaudeStatus()
      .then((s) => (configured = s.mcp))
      .catch((e) => logError(`mcp-catalog: get_claude_status failed: ${String(e)}`));
  });

  function installed(id: string): boolean {
    return configured != null && isInstalled(id, configured);
  }

  const enc = new TextEncoder();
  /** インストールコマンドを挿入（末尾スペースのみ・改行なし）。strict=フォーカス
   *  ペイン不在時のフォールバック禁止（意図しないペインへの誤配送防止）。 */
  function insert(cmd: string) {
    if (sendInputToFocusedPane(enc.encode(frameBracketedPaste(cmd + " ")), true)) onClose();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="overlay" onpointerdown={onClose} role="presentation">
  <div
    class="panel"
    bind:this={panel}
    tabindex="-1"
    onpointerdown={(e) => e.stopPropagation()}
    role="presentation"
  >
    <div class="bar">
      <span class="ttl">おすすめ MCP</span>
      <span class="sub">クリックでインストールコマンドを挿入（実行は Enter で）</span>
      <button class="x" onclick={onClose} aria-label="閉じる">✕</button>
    </div>
    <div class="list">
      {#each MCP_CATALOG as e (e.id)}
        <div class="row">
          <span class="name">{e.name}</span>
          <span class="desc" title={e.note ?? e.desc}>
            {e.desc}
            {#if e.needsOauth}<span class="tag oauth">OAuth</span>{/if}
            {#if e.note}<span class="tag note">{e.note}</span>{/if}
          </span>
          {#if installed(e.id)}
            <button class="inst" disabled>済</button>
          {:else}
            <button class="inst" onclick={() => insert(e.install)} title={e.install}
              >インストール</button
            >
          {/if}
        </div>
      {/each}
    </div>
    <div class="foot">追加後は orb 再起動で有効化（MCP はプロセス起動時に解決される）</div>
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
    width: min(760px, 96vw);
    max-height: 84vh;
    background: #05100e;
    border: 1px solid rgba(45, 212, 191, 0.4);
    border-radius: 10px;
    box-shadow: 0 0 40px -8px rgba(45, 212, 191, 0.4);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .panel:focus {
    outline: none; /* プログラム的フォーカス（Esc 受け）用。視覚リングは不要 */
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
  .sub {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--grey);
    opacity: 0.7;
    font-size: 0.7rem;
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
  .list {
    overflow-y: auto;
    padding: 6px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: 6px;
    font-size: 0.8rem;
  }
  .row:hover {
    background: rgba(45, 212, 191, 0.08);
  }
  .name {
    flex: 0 0 150px;
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .desc {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--grey);
    font-size: 0.74rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tag {
    display: inline-block;
    margin-left: 6px;
    border-radius: 4px;
    padding: 0 5px;
    font-size: 0.64rem;
    vertical-align: 1px;
    white-space: nowrap;
  }
  .tag.oauth {
    color: #a78bfa;
    border: 1px solid rgba(167, 139, 250, 0.4);
    background: rgba(167, 139, 250, 0.1);
  }
  .tag.note {
    color: var(--grey);
    border: 1px solid rgba(255, 255, 255, 0.15);
    background: rgba(255, 255, 255, 0.04);
  }
  .inst {
    flex: 0 0 auto;
    border: 1px solid rgba(45, 212, 191, 0.3);
    border-radius: 6px;
    background: transparent;
    color: var(--teal);
    font-family: inherit;
    font-size: 0.7rem;
    padding: 4px 10px;
    white-space: nowrap;
    cursor: pointer;
  }
  .inst:hover:not(:disabled) {
    background: rgba(45, 212, 191, 0.14);
  }
  .inst:disabled {
    opacity: 0.4;
    cursor: default;
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
