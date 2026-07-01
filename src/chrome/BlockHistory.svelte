<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { invoke } from "@tauri-apps/api/core";
  import { aiPane } from "../store/appStore";
  import { logError } from "../core/log";
  import { readBlockEvents, localDay, type BlockEvent } from "../core/blocks-log";

  // #31 受け入れ条件の実証: 耐久ログ（JSONL）のみからブロック列を再構築・再描画する。
  // 稼働中の xterm 装飾には一切依存せず、read_block_events の結果だけで一覧を組む。
  let { onClose }: { onClose: () => void } = $props();

  const today = localDay();
  let day = $state(today);
  let events = $state<BlockEvent[]>([]);
  let loading = $state(true);
  let query = $state("");
  let input = $state<HTMLInputElement | undefined>(undefined);

  let filtered = $derived(
    query.trim()
      ? events.filter((e) =>
          `${e.text} ${e.cwd}`.toLowerCase().includes(query.trim().toLowerCase()),
        )
      : events,
  );

  async function load(d: string) {
    loading = true;
    const list = await readBlockEvents(d);
    events = list.reverse(); // 新しいものを上に
    loading = false;
  }

  // 別の日へ移動（restart-after-midnight でも前日の .jsonl を辿れるように）。
  function shiftDay(delta: number) {
    const [y, m, dd] = day.split("-").map(Number);
    day = localDay(new Date(y, m - 1, dd + delta));
    query = "";
    void load(day);
  }

  onMount(() => {
    void load(day);
    queueMicrotask(() => input?.focus());
  });

  function badge(code: number): { sym: string; cls: string } {
    if (code === 0) return { sym: "✓", cls: "ok" };
    if (code < 0) return { sym: "⊘", cls: "abort" };
    return { sym: `✗ ${code}`, cls: "fail" };
  }

  function hhmm(ms: number): string {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  function base(p: string): string {
    if (!p) return "";
    const parts = p.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? p;
  }

  function secs(ms: number): string {
    return `${Math.round(ms / 100) / 10}s`;
  }

  /** ブロック全文のうち最初の非空行（≒コマンド行）をプレビューに使う。 */
  function preview(text: string): string {
    const line = text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return line ?? "(空)";
  }

  function copy(e: BlockEvent) {
    if (e.text) void navigator.clipboard.writeText(e.text);
  }

  function toAi(e: BlockEvent) {
    const target = get(aiPane);
    if (target == null || !e.text) return;
    const enc = new TextEncoder();
    void invoke("write_pty", {
      paneId: target,
      data: Array.from(enc.encode(e.text)),
    }).catch((err) => logError(`block-history →AI write failed: ${String(err)}`));
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }
</script>

<div class="overlay" onpointerdown={onClose} role="presentation">
  <div class="panel" onpointerdown={(e) => e.stopPropagation()} role="presentation">
    <div class="bar">
      <span class="ttl">ブロック履歴</span>
      <span class="daynav">
        <button onclick={() => shiftDay(-1)} title="前日" aria-label="前日">◀</button>
        <span class="day">{day}{day === today ? " (今日)" : ""}</span>
        <button onclick={() => shiftDay(1)} disabled={day >= today} title="翌日" aria-label="翌日">▶</button>
      </span>
      <input
        bind:this={input}
        bind:value={query}
        onkeydown={onKey}
        placeholder="コマンド / 出力 / cwd を検索…  (Esc)"
      />
      <button class="x" onclick={onClose} aria-label="閉じる">✕</button>
    </div>
    <div class="list">
      {#if loading}
        <div class="empty">読み込み中…</div>
      {:else if !filtered.length}
        <div class="empty">
          {events.length ? "該当なし" : "今日のブロック記録はまだありません"}
        </div>
      {:else}
        {#each filtered as e (e.block_id)}
          {@const b = badge(e.exit_code)}
          <div class="row">
            <span class="badge {b.cls}">{b.sym}</span>
            <span class="time">{hhmm(e.started_at)}</span>
            <span class="cmd" title={e.text}>{preview(e.text)}</span>
            <span class="meta">{base(e.cwd)} · {secs(e.duration_ms)}</span>
            <span class="tools">
              <button onclick={() => copy(e)} title="全文をコピー">copy</button>
              <button onclick={() => toAi(e)} title="AI ペインへ送る">→AI</button>
            </span>
          </div>
        {/each}
      {/if}
    </div>
    <div class="foot">
      {filtered.length} / {events.length} ブロック · ~/.config/orb/blocks/{day}.jsonl
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
    width: min(860px, 96vw);
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
    padding: 6px 8px 6px 14px;
    border-bottom: 1px solid rgba(45, 212, 191, 0.2);
  }
  .ttl {
    color: var(--fg);
    font-size: 0.86rem;
    flex: 0 0 auto;
  }
  .daynav {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 0 0 auto;
  }
  .daynav button {
    border: 1px solid rgba(45, 212, 191, 0.25);
    background: transparent;
    color: var(--teal);
    border-radius: 4px;
    width: 22px;
    height: 22px;
    line-height: 1;
    font-size: 0.7rem;
    cursor: pointer;
    padding: 0;
  }
  .daynav button:hover:not(:disabled) {
    background: rgba(45, 212, 191, 0.14);
  }
  .daynav button:disabled {
    opacity: 0.3;
    cursor: default;
  }
  .day {
    color: var(--teal);
    font-size: 0.72rem;
    background: rgba(45, 212, 191, 0.1);
    border: 1px solid rgba(45, 212, 191, 0.25);
    border-radius: 4px;
    padding: 1px 6px;
    flex: 0 0 auto;
    white-space: nowrap;
  }
  input {
    flex: 1 1 auto;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--fg);
    font-family: inherit;
    font-size: 0.86rem;
    padding: 8px 4px;
    outline: none;
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
    padding: 7px 10px;
    border-radius: 6px;
    font-size: 0.8rem;
  }
  .row:hover {
    background: rgba(45, 212, 191, 0.08);
  }
  .badge {
    flex: 0 0 auto;
    min-width: 34px;
    text-align: center;
    font-size: 0.72rem;
    font-weight: 600;
    border-radius: 4px;
    padding: 1px 5px;
  }
  .badge.ok {
    color: #6ee7b7;
    background: rgba(45, 212, 191, 0.12);
  }
  .badge.fail {
    color: #ff5c8a;
    background: rgba(255, 92, 138, 0.12);
  }
  .badge.abort {
    color: var(--grey);
    background: rgba(255, 255, 255, 0.05);
  }
  .time {
    flex: 0 0 auto;
    color: var(--grey);
    font-variant-numeric: tabular-nums;
    font-size: 0.72rem;
  }
  .cmd {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: inherit;
  }
  .meta {
    flex: 0 0 auto;
    color: var(--grey);
    opacity: 0.7;
    font-size: 0.7rem;
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
  .tools button:hover {
    background: rgba(45, 212, 191, 0.14);
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
