<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { layout, focusedPane, cwd as cwdStore, sidebarSide, showSettings, showPalette, paletteMode, broadcast, clearPane, consumeScrollback, writeToPane, tabWelcome, dnd, setFocusedAsAiPane, aiPane, paneStatus, acknowledgePane } from "../store/appStore";
  import { formatImagePath, isImagePath } from "../core/insert-path";
  import { STATUS_ICON, STATUS_LABEL } from "../core/agent-status";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { tabs, activeTabId, ensureFirstTab, newTab, closeTab, openInfoTab, type Tab } from "./tabs";
  import {
    splitPane,
    closePane,
    leafIds,
    setRatio,
    siblingFirstLeaf,
    computeRects,
    computeSplitters,
    leafInfoMap,
    type Rect,
    type Splitter,
    type PaneRole,
  } from "./tree";
  import { nextPaneId } from "../store/appStore";
  import Terminal from "../terminal/Terminal.svelte";
  import Launcher from "./Launcher.svelte";
  import Settings from "../chrome/Settings.svelte";
  import CommandPalette, { type PaletteAction } from "../chrome/CommandPalette.svelte";
  import BlockHistory from "../chrome/BlockHistory.svelte";
  import McpCatalog from "../chrome/McpCatalog.svelte";
  import PromptQueue from "../chrome/PromptQueue.svelte";
  import { queues, armedPanes, cancelArmed } from "../store/promptQueue";
  import InfoTab from "../chrome/InfoTab.svelte";
  import { grid2x2, columns3, columns2, mainStack } from "./presets";
  import { invoke } from "@tauri-apps/api/core";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { logError } from "../core/log";
  import { localDay, type SearchResult } from "../core/blocks-log";
  import { buildSessionSummary } from "../core/session-summary";
  import { frameBracketedPaste } from "../core/ai-payload";

  let showLauncher = $state(false);
  let showHistory = $state(false); // #31: ブロック履歴オーバーレイ（耐久ログからの再描画）
  let showMcpCatalog = $state(false); // #46: おすすめ MCP カタログオーバーレイ
  let showPromptQueue = $state(false); // #51: プロンプトキューオーバーレイ
  let zoomedPane = $state<number | null>(null);
  let wsEl: HTMLDivElement;
  const FULL: Rect = { x: 0, y: 0, w: 100, h: 100 };

  // 新規タブで一瞬出る小さな welcome。
  let miniWelcome = $state(false);
  let miniTimer: number | undefined;
  let welcomeUnsub: (() => void) | undefined;

  // ファイル/フォルダのドラッグ&ドロップ添付（VIBE_IDEAS #6）。起動時の操作は不要＝
  // ドロップ時だけ動く。ペイン単位だと全ペインで多重発火するので Workspace で1回だけ受ける。
  let dragUnlisten: (() => void) | undefined;
  let winFocusUnlisten: (() => void) | undefined;
  const dropEncoder = new TextEncoder();
  function quotePath(p: string): string {
    return /\s/.test(p) ? `"${p}"` : p;
  }
  function relToCwd(abs: string, base: string): string {
    if (base && abs.toLowerCase().startsWith(base.toLowerCase())) {
      const r = abs.slice(base.length).replace(/^[\\/]+/, "");
      return r || abs;
    }
    return abs;
  }
  // フォーカス中ペインへ、cwd 相対化したパスを挿入（Enter は送らず人が確認して使う）。
  // #53: AI ペインへの画像ドロップは claude の @添付形（@パス）にする。
  function handleDrop(paths: string[]) {
    const target = get(focusedPane);
    // #47: info タブ表示中の focusedPane はダミー(-1)＝ドロップの届け先なし（ID は 1 始まり）。
    if (target == null || target <= 0 || !paths?.length) return;
    const base = get(cwdStore);
    const forAi = target === get(aiPane);
    const text =
      paths
        .map((p) => {
          const rel = relToCwd(p, base);
          return forAi && isImagePath(p) ? formatImagePath(rel, true) : quotePath(rel);
        })
        .join(" ") + " ";
    void invoke("write_pty", { paneId: target, data: Array.from(dropEncoder.encode(text)) }).catch(
      (e) => logError(`pane ${target}: drag-drop write failed: ${String(e)}`),
    );
  }

  // アクティブタブは最新の $layout、非アクティブは保存済み layout を使う。
  function tabLayout(t: Tab) {
    return t.id === $activeTabId ? $layout : t.layout;
  }

  // 全タブの全 leaf を一度に保持（タブ切替で Terminal を unmount させない＝PTY 生存）。
  let allLeaves = $derived.by(() => {
    const out: { tabId: number; id: number; initialCmd?: string; role?: PaneRole }[] = [];
    for (const t of $tabs) {
      const lay = tabLayout(t);
      if (!lay) continue;
      const infoMap = new Map<number, { initialCmd?: string; role?: PaneRole }>();
      leafInfoMap(lay, infoMap);
      for (const id of leafIds(lay)) {
        const info = infoMap.get(id);
        out.push({ tabId: t.id, id, initialCmd: info?.initialCmd, role: info?.role });
      }
    }
    return out;
  });

  // 可視（アクティブ）タブの geometry。
  let rects = $derived.by(() => {
    const m = new Map<number, Rect>();
    if (zoomedPane != null) {
      m.set(zoomedPane, FULL); // ズーム中はそのペインだけ全面
      return m;
    }
    if ($layout) computeRects($layout, FULL, m);
    return m;
  });
  let splitters = $derived.by(() => {
    if (zoomedPane != null) return []; // ズーム中はスプリッタ非表示
    const a: Splitter[] = [];
    if ($layout) computeSplitters($layout, FULL, a);
    return a;
  });
  let paneCount = $derived($layout ? leafIds($layout).length : 0);

  // #47: アクティブタブが info（取扱説明書）か。info タブは layout: null＝leaf を
  // 持たないので allLeaves には元々乗らず、他タブの Terminal は unmount されない。
  let isInfoActive = $derived($tabs.find((t) => t.id === $activeTabId)?.kind === "info");

  onMount(() => {
    ensureFirstTab();
    window.addEventListener("keydown", onKey, true);
    // ファイル D&D（#6）。Tauri が OS ドロップのフルパスを届ける（HTML drag は不可）。
    void getCurrentWebview()
      .onDragDropEvent((e) => {
        if (e.payload.type === "drop") handleDrop(e.payload.paths);
      })
      .then((un) => (dragUnlisten = un))
      .catch(() => {});
    // #50: ウィンドウ復帰＝フォーカス中ペインは「見た」扱いでバッジを消す
    // （focusedPane の値が変わらない alt-tab 復帰は store 購読では拾えないため）。
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) acknowledgePane(get(focusedPane));
      })
      .then((un) => (winFocusUnlisten = un))
      .catch(() => {});
    // 新規タブ作成のたびに小 welcome（初回 subscribe の即時発火はスキップ）。
    let first = true;
    welcomeUnsub = tabWelcome.subscribe(() => {
      if (first) {
        first = false;
        return;
      }
      if (miniTimer) clearTimeout(miniTimer);
      miniWelcome = true;
      miniTimer = window.setTimeout(() => (miniWelcome = false), 1400);
    });
  });

  onDestroy(() => {
    window.removeEventListener("keydown", onKey, true);
    if (miniTimer) clearTimeout(miniTimer);
    welcomeUnsub?.();
    winFocusUnlisten?.();
    dragUnlisten?.();
  });

  function onKey(e: KeyboardEvent) {
    if (showLauncher || showHistory || showMcpCatalog || showPromptQueue || get(showPalette) || get(showSettings)) return;
    // Ctrl+, : 設定
    if (e.ctrlKey && !e.shiftKey && e.key === ",") {
      e.preventDefault();
      showSettings.set(true);
      return;
    }
    if (e.ctrlKey && !e.shiftKey && (e.key === "t" || e.key === "T")) {
      e.preventDefault();
      newTab();
      return;
    }
    if (e.ctrlKey && !e.shiftKey && (e.key === "w" || e.key === "W")) {
      e.preventDefault();
      closeTab(get(activeTabId));
      return;
    }
    if (e.ctrlKey && !e.shiftKey && (e.key === "p" || e.key === "P")) {
      e.preventDefault();
      showLauncher = true;
      return;
    }
    if (e.ctrlKey && e.key === "Tab") {
      e.preventDefault();
      cycleFocus(e.shiftKey ? -1 : 1);
      return;
    }
    if (!e.ctrlKey || !e.shiftKey) return;
    const k = e.key.toLowerCase();
    if (k === "d") {
      e.preventDefault();
      doSplit("h");
    } else if (k === "e") {
      e.preventDefault();
      doSplit("v");
    } else if (k === "w") {
      e.preventDefault();
      doClose();
    } else if (k === "z") {
      e.preventDefault();
      zoomFocused();
    } else if (k === "k") {
      e.preventDefault();
      clearPane(get(focusedPane)); // フォーカスペインの画面クリア（Ctrl+K は PSReadLine 温存のため Shift 付き）
    } else if (k === "b") {
      e.preventDefault();
      sidebarSide.update((s) => (s === "right" ? "left" : "right")); // サイドバー左右トグル
    } else if (k === "p") {
      e.preventDefault();
      paletteMode.set("search");
      showPalette.set(true); // コマンドパレット (Ctrl+Shift+P)
    } else if (k === "n") {
      e.preventDefault();
      dnd.update((d) => !d); // フォーカスモード(DND)切替 (Ctrl+Shift+N)
    } else if (k === "h") {
      e.preventDefault();
      showHistory = true; // ブロック履歴 (Ctrl+Shift+H, #31)
    } else if (k === "q") {
      e.preventDefault();
      showPromptQueue = true; // プロンプトキュー (Ctrl+Shift+Q, #51)
    }
  }

  // #51: 送信予約トーストのカウントダウン用現在時刻（予約が無い間はタイマーを回さない）。
  let nowTick = $state(Date.now());
  $effect(() => {
    if ($armedPanes.size === 0) return;
    const t = setInterval(() => (nowTick = Date.now()), 200);
    return () => clearInterval(t);
  });
  let armedList = $derived(
    [...$armedPanes.entries()].map(([paneId, a]) => ({
      paneId,
      secs: Math.max(0, Math.ceil((a.sendAt - nowTick) / 1000)),
    })),
  );

  function zoomFocused() {
    const f = get(focusedPane);
    if (f <= 0) return; // #47: info タブ表示中（ダミー -1）はズーム対象なし
    zoomedPane = zoomedPane === f ? null : f; // フォーカスペインの全面化トグル
  }

  const paletteActions: PaletteAction[] = [
    { label: "レイアウト: 2x2 グリッド", hint: "新タブ", run: () => newTab(grid2x2()) },
    { label: "レイアウト: 3カラム", hint: "新タブ", run: () => newTab(columns3()) },
    { label: "レイアウト: 2カラム", hint: "新タブ", run: () => newTab(columns2()) },
    { label: "レイアウト: 主＋副スタック", hint: "新タブ", run: () => newTab(mainStack()) },
    { label: "ペイン: 横分割", hint: "Ctrl+Shift+D", run: () => doSplit("h") },
    { label: "ペイン: 縦分割", hint: "Ctrl+Shift+E", run: () => doSplit("v") },
    { label: "ペイン: 閉じる", hint: "Ctrl+Shift+W", run: () => doClose() },
    { label: "ペイン: ズーム切替", hint: "Ctrl+Shift+Z", run: () => zoomFocused() },
    { label: "ターミナル: 画面クリア", hint: "Ctrl+Shift+K", run: () => clearPane(get(focusedPane)) },
    { label: "タブ: 新規", hint: "Ctrl+T", run: () => newTab() },
    { label: "タブ: 閉じる", hint: "Ctrl+W", run: () => closeTab(get(activeTabId)) },
    {
      label: "ブロードキャスト入力: 切替",
      hint: "全ペイン同時入力",
      run: () => broadcast.update((b) => !b),
    },
    {
      label: "通知: フォーカスモード(DND) 切替",
      hint: "Ctrl+Shift+N",
      run: () => dnd.update((d) => !d),
    },
    {
      label: "サイドバー: 左右入替",
      hint: "Ctrl+Shift+B",
      run: () => sidebarSide.update((s) => (s === "right" ? "left" : "right")),
    },
    { label: "ブロック履歴 / Block history", hint: "Ctrl+Shift+H", run: () => (showHistory = true) },
    {
      label: "プロンプトキュー / Prompt queue",
      hint: "Ctrl+Shift+Q · 次の指示を積む→アイドルで自動投入",
      run: () => (showPromptQueue = true),
    },
    {
      label: "おすすめ MCP / MCP catalog",
      hint: "クリックでインストールコマンド挿入",
      run: () => (showMcpCatalog = true),
    },
    {
      label: "info / 説明書を開く",
      hint: "機能ガイド・ショートカット・導入ガイド",
      run: () => openInfoTab(),
    },
    {
      label: "このペインを AI ペインに設定",
      hint: "サイドバーの model/effort 切替の送信先",
      run: () => setFocusedAsAiPane(),
    },
    { label: "設定を開く", hint: "Ctrl+,", run: () => showSettings.set(true) },
    { label: "案件ランチャー", hint: "Ctrl+P", run: () => (showLauncher = true) },
    {
      label: "前回のセッションを復元 / Restore previous session",
      hint: "保存済みスクロールバック",
      run: () => restorePreviousSession(),
    },
    {
      label: "セッション要約 → クリップボード",
      hint: "今日×この cwd の作業ログを MD で",
      run: () => void summaryToClipboard(),
    },
    {
      label: "セッション要約 → AI ペインへ",
      hint: "引き継ぎ整理を依頼（Enter は人が押す）",
      run: () => void summaryToAiPane(),
    },
    {
      label: "セッション要約 → HANDOFF ファイル",
      hint: "cwd に HANDOFF-YYYY-MM-DD.md を保存",
      run: () => void summaryToHandoffFile(),
    },
  ];

  // ---- #55 セッション要約（引き継ぎワンキー）------------------------------------------------
  // 今日×フォーカスペイン cwd のブロックログを #49 検索 API で取り、引き継ぎ MD を組む。
  // ヒットは新しい順で返るので古い順に並べ直す（buildSessionSummary 内でも時系列ソートする）。
  async function buildTodaysSummary(): Promise<{ md: string; day: string; cwd: string }> {
    const targetCwd = get(cwdStore);
    const day = localDay();
    const res = await invoke<SearchResult>("search_block_events", {
      filters: { terms: [], exit: null, cwd: targetCwd, field: "all", from: day, to: day, limit: 1000 },
    });
    const events = res.hits.map((h) => h.event).reverse();
    return { md: buildSessionSummary(events, { day, cwd: targetCwd }), day, cwd: targetCwd };
  }

  async function summaryToClipboard() {
    try {
      const { md } = await buildTodaysSummary();
      await navigator.clipboard.writeText(md);
    } catch (e) {
      logError(`session summary → clipboard failed: ${String(e)}`);
    }
  }

  // AI ペインの入力欄へ「要約・整理して」依頼込みで挿入（Enter は送らない＝送信は人が）。
  async function summaryToAiPane() {
    const target = get(aiPane);
    if (target == null) return;
    try {
      const { md } = await buildTodaysSummary();
      const payload = frameBracketedPaste("以下の作業ログを引き継ぎ用に要約・整理して:\n\n" + md);
      await invoke("write_pty", { paneId: target, data: Array.from(new TextEncoder().encode(payload)) });
    } catch (e) {
      logError(`session summary → AI pane failed: ${String(e)}`);
    }
  }

  async function summaryToHandoffFile() {
    try {
      const { md, day, cwd } = await buildTodaysSummary();
      await invoke("save_handoff_file", { cwd, day, content: md });
    } catch (e) {
      logError(`session summary → HANDOFF file failed: ${String(e)}`);
    }
  }

  // フォーカス中ペインへ、退避しておいた前回セッションの画面内容を書き戻す（#43: オンデマンド復元）。
  // 起動時の自動書き戻しは廃止したので、必要な時だけこのコマンドで戻す。
  function restorePreviousSession() {
    const pid = get(focusedPane);
    const prior = consumeScrollback(pid);
    if (!prior) return;
    writeToPane(
      pid,
      "\r\n\x1b[38;5;108m──────── orb · 前回のセッション（復元）────────\x1b[0m\r\n" + prior + "\r\n",
    );
  }

  function doSplit(dir: "h" | "v") {
    zoomedPane = null;
    const root = get(layout);
    if (!root) return;
    // フォーカス中ペインの cwd を新ペインへ継承（同じディレクトリで開く）。
    const cwd = get(cwdStore);
    const newCmd = cwd ? `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'` : undefined;
    const newPaneId = nextPaneId();
    const newSplitId = nextPaneId();
    layout.set(splitPane(root, get(focusedPane), dir, newPaneId, newSplitId, newCmd));
    focusedPane.set(newPaneId);
  }

  function doClose() {
    closePaneById(get(focusedPane));
  }

  function closePaneById(paneId: number) {
    zoomedPane = null;
    const root = get(layout);
    if (!root || leafIds(root).length <= 1) return;
    const sib = siblingFirstLeaf(root, paneId);
    const next = closePane(root, paneId);
    layout.set(next); // Terminal が unmount され onDestroy で PTY を kill
    if (sib != null) {
      focusedPane.set(sib);
    } else {
      const remaining = leafIds(next);
      if (remaining.length) focusedPane.set(remaining[0]);
    }
  }

  function cycleFocus(delta: number) {
    const list = leafIds(get(layout));
    if (list.length <= 1) return;
    const cur = list.indexOf(get(focusedPane));
    const idx = ((cur < 0 ? 0 : cur + delta) + list.length) % list.length;
    focusedPane.set(list[idx]);
  }

  function startDrag(e: PointerEvent, s: Splitter) {
    e.preventDefault();
    const onMove = (ev: PointerEvent) => {
      const r = wsEl.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * 100;
      const py = ((ev.clientY - r.top) / r.height) * 100;
      const ratio =
        s.dir === "h" ? (px - s.parent.x) / s.parent.w : (py - s.parent.y) / s.parent.h;
      const clamped = Math.min(0.85, Math.max(0.15, ratio));
      const root = get(layout);
      if (root) layout.set(setRatio(root, s.id, clamped));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }
</script>

<div class="workspace" bind:this={wsEl}>
  {#each allLeaves as lf (lf.id)}
    {@const rect = lf.tabId === $activeTabId ? rects.get(lf.id) : undefined}
    <div
      class="slot"
      class:hidden={lf.tabId !== $activeTabId}
      style={rect
        ? `left:${rect.x}%;top:${rect.y}%;width:${rect.w}%;height:${rect.h}%`
        : ""}
    >
      <Terminal paneId={lf.id} initialCmd={lf.initialCmd} role={lf.role} />
      {#if lf.tabId === $activeTabId && lf.id !== $focusedPane}
        {@const st = $paneStatus.get(lf.id)}
        {#if st}
          <span class="pane-badge" title={STATUS_LABEL[st]} aria-label={STATUS_LABEL[st]}>{STATUS_ICON[st]}</span>
        {/if}
      {/if}
      {#if lf.tabId === $activeTabId}
        {@const pq = $queues.get(lf.id)}
        {#if pq?.items.length}
          <!-- #51: キュー残数（.pane-badge と同じ流儀・空なら出さない・⏸=一時停止中）。 -->
          <span
            class="queue-badge"
            title={`プロンプトキュー ${pq.items.length} 件${pq.paused ? " · 一時停止中" : ""} (Ctrl+Shift+Q)`}
            aria-label={`プロンプトキュー ${pq.items.length} 件`}
          >{pq.paused ? "⏸" : "⧗"}{pq.items.length}</span>
        {/if}
      {/if}
      {#if paneCount > 1 && lf.tabId === $activeTabId}
        <button
          class="pane-x"
          onpointerdown={(e) => {
            e.stopPropagation();
            closePaneById(lf.id);
          }}
          aria-label="close pane">&#x2715;</button
        >
      {/if}
    </div>
  {/each}
  {#each splitters as s (s.id)}
    {@const sx = s.parent.x + s.parent.w * s.ratio}
    {@const sy = s.parent.y + s.parent.h * s.ratio}
    <div
      class="splitter {s.dir}"
      style={s.dir === "h"
        ? `left:${sx}%;top:${s.parent.y}%;height:${s.parent.h}%`
        : `top:${sy}%;left:${s.parent.x}%;width:${s.parent.w}%`}
      onpointerdown={(e) => startDrag(e, s)}
      role="separator"
      aria-orientation={s.dir === "h" ? "vertical" : "horizontal"}
      tabindex="-1"
    ></div>
  {/each}

  {#if isInfoActive}
    <!-- #47: info タブ。ターミナルスロット群は hidden のまま生存し、この上に説明書を敷く。 -->
    <InfoTab />
  {/if}

  {#if miniWelcome}
    {#key $tabWelcome}
      <div class="mini-welcome" aria-hidden="true"><span>welcome</span></div>
    {/key}
  {/if}

  {#if $dnd}
    <div class="dnd-badge" title="フォーカスモード: 成功通知オフ・失敗のみ通知 (Ctrl+Shift+N)">🔕 focus</div>
  {/if}

  {#if armedList.length}
    <!-- #51: 送信予約の可視キャンセル猶予（どの画面でも見える・キャンセルでキューに残す）。 -->
    <div class="queue-arm-stack">
      {#each armedList as a (a.paneId)}
        <div class="queue-arm">
          <span>⧗ ペイン {a.paneId} へ {a.secs}秒後に送信…</span>
          <button onclick={() => cancelArmed(a.paneId)}>キャンセル</button>
        </div>
      {/each}
    </div>
  {/if}
</div>

{#if showLauncher}
  <Launcher onClose={() => (showLauncher = false)} />
{/if}

{#if $showSettings}
  <Settings onClose={() => showSettings.set(false)} />
{/if}

{#if showHistory}
  <BlockHistory onClose={() => (showHistory = false)} />
{/if}

{#if showMcpCatalog}
  <McpCatalog onClose={() => (showMcpCatalog = false)} />
{/if}

{#if showPromptQueue}
  <PromptQueue onClose={() => (showPromptQueue = false)} />
{/if}

{#if $showPalette}
  <CommandPalette actions={paletteActions} initialMode={$paletteMode} onClose={() => showPalette.set(false)} />
{/if}

<style>
  .workspace {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }
  .slot {
    position: absolute;
    overflow: hidden;
  }
  .slot.hidden {
    display: none;
  }
  .slot:hover .pane-x {
    opacity: 0.65;
  }
  /* #50: ペイン右上の状態バッジ（×ボタンの左隣・クリック透過・compositor-only）。 */
  .pane-badge {
    position: absolute;
    top: 4px;
    right: 28px;
    z-index: 6;
    font-size: 0.62rem;
    line-height: 18px;
    pointer-events: none;
    filter: drop-shadow(0 0 4px rgba(0, 0, 0, 0.8));
  }
  /* #51: キュー残数バッジ（.pane-badge の左隣・クリック透過）。 */
  .queue-badge {
    position: absolute;
    top: 4px;
    right: 50px;
    z-index: 6;
    font-size: 0.62rem;
    line-height: 18px;
    color: var(--teal, #2dd4bf);
    pointer-events: none;
    filter: drop-shadow(0 0 4px rgba(0, 0, 0, 0.8));
  }
  .pane-x {
    position: absolute;
    top: 4px;
    right: 6px;
    z-index: 6;
    width: 18px;
    height: 18px;
    border: 0;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.5);
    color: var(--grey);
    font-size: 0.6rem;
    line-height: 1;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s, color 0.12s, background 0.12s;
  }
  .pane-x:hover {
    opacity: 1 !important;
    color: var(--red);
    background: rgba(255, 92, 138, 0.2);
  }
  .splitter {
    position: absolute;
    z-index: 5;
    background: rgba(45, 212, 191, 0.12);
    transition: background 0.12s;
  }
  .splitter.h {
    width: 4px;
    transform: translateX(-2px);
    cursor: col-resize;
  }
  .splitter.v {
    height: 4px;
    transform: translateY(-2px);
    cursor: row-resize;
  }
  .splitter:hover {
    background: rgba(45, 212, 191, 0.45);
  }

  /* フォーカスモード(DND)中の常時バッジ（左下・操作は透過）。状態を見失わないための目印。 */
  .dnd-badge {
    position: absolute;
    left: 12px;
    bottom: 10px;
    z-index: 8;
    padding: 3px 9px;
    border-radius: 999px;
    background: #05100e;
    border: 1px solid rgba(167, 139, 250, 0.5);
    color: var(--violet, #a78bfa);
    font-size: 0.68rem;
    letter-spacing: 0.04em;
    pointer-events: none;
    box-shadow: 0 2px 12px -6px rgba(167, 139, 250, 0.5);
  }

  /* #51: 送信予約中のカウントダウントースト（下中央・キャンセルだけ操作可）。 */
  .queue-arm-stack {
    position: absolute;
    left: 50%;
    bottom: 10px;
    transform: translateX(-50%);
    z-index: 8;
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: center;
  }
  .queue-arm {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 6px 4px 12px;
    border-radius: 999px;
    background: #05100e;
    border: 1px solid rgba(45, 212, 191, 0.5);
    color: var(--teal, #2dd4bf);
    font-size: 0.72rem;
    letter-spacing: 0.02em;
    box-shadow: 0 4px 18px -6px rgba(45, 212, 191, 0.5);
    white-space: nowrap;
  }
  .queue-arm span {
    font-variant-numeric: tabular-nums;
  }
  .queue-arm button {
    border: 1px solid rgba(255, 92, 138, 0.45);
    border-radius: 999px;
    background: transparent;
    color: #ff5c8a;
    font-family: inherit;
    font-size: 0.68rem;
    padding: 2px 10px;
    cursor: pointer;
  }
  .queue-arm button:hover {
    background: rgba(255, 92, 138, 0.14);
  }

  /* 新規タブで一瞬出る小さな welcome（中央・自動フェード・操作は透過）。 */
  .mini-welcome {
    position: absolute;
    inset: 0;
    z-index: 7;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
  }
  .mini-welcome span {
    font-size: 1.2rem;
    letter-spacing: 0.42em;
    text-transform: lowercase;
    color: var(--teal, #2dd4bf);
    text-shadow:
      0 0 10px rgba(45, 212, 191, 0.6),
      0 0 24px rgba(45, 212, 191, 0.3);
    will-change: transform, opacity;
    animation: mini-welcome 1.4s ease both;
  }
  @keyframes mini-welcome {
    0% {
      opacity: 0;
      transform: translateY(6px) scale(0.96);
    }
    18% {
      opacity: 1;
      transform: none;
    }
    76% {
      opacity: 1;
      transform: none;
    }
    100% {
      opacity: 0;
      transform: scale(1.02);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .mini-welcome span {
      animation-duration: 1.4s;
      animation-name: mini-welcome-fade;
    }
  }
  @keyframes mini-welcome-fade {
    0%,
    100% {
      opacity: 0;
    }
    20%,
    76% {
      opacity: 1;
    }
  }
</style>
