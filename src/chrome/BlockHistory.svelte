<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { invoke } from "@tauri-apps/api/core";
  import { aiPane, sendInputToFocusedPane } from "../store/appStore";
  import { logError } from "../core/log";
  import {
    readBlockEvents,
    searchBlockEvents,
    localDay,
    type BlockEvent,
    type SearchHit,
  } from "../core/blocks-log";
  import { formatBlockForAi, formatFailureDigest, frameBracketedPaste, type BlockAiContext } from "../core/ai-payload";

  // #31 受け入れ条件の実証: 耐久ログ（JSONL）のみからブロック列を再構築・再描画する。
  // 稼働中の xterm 装飾には一切依存せず、read_block_events の結果だけで一覧を組む。
  // #49: 検索語を入れた瞬間だけ「全期間横断モード」（search_block_events）へ切り替わる。
  let { onClose }: { onClose: () => void } = $props();

  const today = localDay();
  let day = $state(today);
  let events = $state<BlockEvent[]>([]);
  let loading = $state(true);
  let query = $state("");
  let input = $state<HTMLInputElement | undefined>(undefined);

  // ---- #49 横断検索状態。query が空 = 従来の単日モード。
  let crossMode = $derived(query.trim().length > 0);
  let hits = $state<SearchHit[]>([]);
  let searching = $state(false);
  let searchMeta = $state<{ scanned: number; limitHit: boolean } | null>(null);
  let searchSeq = 0;

  $effect(() => {
    const q = query.trim();
    if (!q) {
      searchSeq++; // 進行中の応答を無効化
      hits = [];
      searchMeta = null;
      searching = false;
      return;
    }
    const seq = ++searchSeq;
    searching = true;
    const t = setTimeout(async () => {
      const res = await searchBlockEvents(q);
      if (seq !== searchSeq) return; // 古い応答は捨てる（後勝ち）
      hits = res.hits;
      searchMeta = { scanned: res.scanned_days, limitHit: res.limit_hit };
      searching = false;
    }, 180); // debounce: タイプ中の全期間走査を抑える
    return () => clearTimeout(t);
  });

  /** ヒットを日付ごとに束ねる（hits は日付降順で連続しているので単純な走査でよい）。 */
  type DayGroup = { day: string; list: BlockEvent[] };
  let groups = $derived.by(() => {
    const gs: DayGroup[] = [];
    for (const h of hits) {
      const last = gs[gs.length - 1];
      if (last && last.day === h.day) last.list.push(h.event);
      else gs.push({ day: h.day, list: [h.event] });
    }
    return gs;
  });

  /** いま画面に出ているブロック（単日 or 横断ヒット）。失敗→AI とフッタ件数の共通母集団。 */
  let visible = $derived(crossMode ? hits.map((h) => h.event) : events);

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

  /** プレビュー行。#33 で確定した command があればそれ、無ければ全文の最初の非空行。 */
  function preview(e: BlockEvent): string {
    if (e.command) return e.command;
    const line = e.text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return line ?? "(空)";
  }

  /** #33: 確定コマンドをフォーカス中のペインへ再入力（Enter は送らない＝実行は人が確認）。
   *  bracketed paste で包み（改行入りでも文字通り挿入）、strict＝フォーカスペイン不在時は
   *  任意ペインへフォールバックしない（AI ペイン等への誤配送防止）。 */
  function rerun(e: BlockEvent) {
    if (!e.command) return;
    const enc = new TextEncoder();
    if (sendInputToFocusedPane(enc.encode(frameBracketedPaste(e.command)), true)) onClose();
  }

  /** #49: 過去日のヒットは実行時 cwd が今と違いがち。cd 込みで挿入する明示ボタン
   *  （何が走るかプロンプト上で全部見える形＝黙った魔法をしない。実行は Enter で人が）。 */
  function rerunWithCd(e: BlockEvent) {
    if (!e.command || !e.cwd) return;
    const cd = `cd '${e.cwd.replace(/'/g, "''")}'; ${e.command}`; // pwsh の単引用エスケープ
    const enc = new TextEncoder();
    if (sendInputToFocusedPane(enc.encode(frameBracketedPaste(cd)), true)) onClose();
  }

  function copy(e: BlockEvent) {
    if (e.text) void navigator.clipboard.writeText(e.text);
  }

  /** BlockEvent（耐久ログのレコード）→ AI 整形用コンテキストへ。 */
  function toCtx(e: BlockEvent): BlockAiContext {
    return { cwd: e.cwd, exitCode: e.exit_code, command: e.command, outputBody: e.output_body, text: e.text };
  }

  function sendToAi(payload: string) {
    const target = get(aiPane);
    if (target == null) return;
    const enc = new TextEncoder();
    void invoke("write_pty", {
      paneId: target,
      data: Array.from(enc.encode(frameBracketedPaste(payload))),
    }).catch((err) => logError(`block-history →AI write failed: ${String(err)}`));
  }

  function toAi(e: BlockEvent) {
    if (!e.text && e.command == null) return;
    sendToAi(formatBlockForAi(toCtx(e)));
  }

  /** #34: 表示中の失敗ブロックをまとめて AI ペインへ。直近優先で最大10件（横断ヒットも対象）。 */
  let failedVisible = $derived(visible.filter((e) => e.exit_code > 0));
  function failuresToAi() {
    const picks = failedVisible.slice(0, 10).map(toCtx); // events は新しい順に並んでいる
    if (!picks.length) return;
    sendToAi(formatFailureDigest(picks));
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
      {#if crossMode}
        <span class="day">全期間</span>
      {:else}
        <span class="daynav">
          <button onclick={() => shiftDay(-1)} title="前日" aria-label="前日">◀</button>
          <span class="day">{day}{day === today ? " (今日)" : ""}</span>
          <button onclick={() => shiftDay(1)} disabled={day >= today} title="翌日" aria-label="翌日">▶</button>
        </span>
      {/if}
      <input
        bind:this={input}
        bind:value={query}
        onkeydown={onKey}
        placeholder="検索で全期間横断… 例: cargo exit:fail cwd:orb  (Esc)"
      />
      {#if failedVisible.length}
        <button
          class="failbtn"
          onclick={failuresToAi}
          disabled={$aiPane == null}
          title={$aiPane == null
            ? "AI ペインがありません（パレット「このペインを AI ペインに設定」）"
            : "表示中の失敗ブロック（直近最大10件）をまとめて AI ペインへ"}
        >失敗→AI ({failedVisible.length > 10 ? `10/${failedVisible.length}` : failedVisible.length})</button>
      {/if}
      <button class="x" onclick={onClose} aria-label="閉じる">✕</button>
    </div>
    {#snippet row(e: BlockEvent, cross: boolean)}
      {@const b = badge(e.exit_code)}
      <div class="row">
        <span class="badge {b.cls}">{b.sym}</span>
        <span class="time">{hhmm(e.started_at)}</span>
        <span class="cmd" title={e.text}>{preview(e)}</span>
        <span class="meta">{base(e.cwd)} · {secs(e.duration_ms)}</span>
        <span class="tools">
          <button onclick={() => copy(e)} title="全文をコピー">copy</button>
          <button onclick={() => toAi(e)} title="AI ペインへ送る">→AI</button>
          {#if e.command}
            <button onclick={() => rerun(e)} title="フォーカス中のペインに再入力（実行は Enter で）">↻</button>
            {#if cross && e.cwd}
              <button onclick={() => rerunWithCd(e)} title={"cd '" + e.cwd + "'; を前置して再入力（実行は Enter で）"}>cd↻</button>
            {/if}
          {/if}
        </span>
      </div>
    {/snippet}
    <div class="list">
      {#if crossMode}
        {#if searching && !hits.length}
          <div class="empty">全期間を検索中…</div>
        {:else if !hits.length}
          <div class="empty">全期間で該当なし</div>
        {:else}
          {#each groups as g (g.day)}
            <div class="dayhead">{g.day}{g.day === today ? " (今日)" : ""}</div>
            {#each g.list as e (e.block_id)}
              {@render row(e, true)}
            {/each}
          {/each}
        {/if}
      {:else if loading}
        <div class="empty">読み込み中…</div>
      {:else if !events.length}
        <div class="empty">{day === today ? "今日" : day} のブロック記録はまだありません</div>
      {:else}
        {#each events as e (e.block_id)}
          {@render row(e, false)}
        {/each}
      {/if}
    </div>
    <div class="foot">
      {#if crossMode}
        {hits.length}件ヒット{searchMeta ? ` · ${searchMeta.scanned}日分を走査` : ""}{searchMeta?.limitHit
          ? " · 上限で打ち切り（絞り込んで）"
          : ""} · フィルタ: exit:fail / cwd: / in:command / from: to: day:
      {:else}
        {events.length} ブロック · ~/.config/orb/blocks/{day}.jsonl
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
  .failbtn {
    flex: 0 0 auto;
    border: 1px solid rgba(255, 92, 138, 0.4);
    border-radius: 6px;
    background: transparent;
    color: #ff5c8a;
    font-family: inherit;
    font-size: 0.7rem;
    padding: 4px 9px;
    white-space: nowrap;
    cursor: pointer;
  }
  .failbtn:hover:not(:disabled) {
    background: rgba(255, 92, 138, 0.14);
  }
  .failbtn:disabled {
    opacity: 0.35;
    cursor: default;
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
  .dayhead {
    position: sticky;
    top: -6px; /* .list の padding ぶん食い込ませて隙間なく貼り付ける */
    background: #05100e;
    color: var(--teal);
    font-size: 0.7rem;
    font-variant-numeric: tabular-nums;
    padding: 6px 10px 3px;
    border-bottom: 1px solid rgba(45, 212, 191, 0.12);
    z-index: 1;
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
