<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { layout, focusedPane, cwd as cwdStore, sidebarSide, showSettings, showPalette, paletteMode, broadcast, clearPane, showSplash, tabWelcome, dnd } from "../store/appStore";
  import { tabs, activeTabId, ensureFirstTab, newTab, closeTab, type Tab } from "./tabs";
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
  import { grid2x2, columns3, columns2, mainStack } from "./presets";
  import { invoke } from "@tauri-apps/api/core";
  import { getCurrentWebview } from "@tauri-apps/api/webview";

  let showLauncher = $state(false);
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
  function handleDrop(paths: string[]) {
    const target = get(focusedPane);
    if (target == null || !paths?.length) return;
    const base = get(cwdStore);
    const text = paths.map((p) => quotePath(relToCwd(p, base))).join(" ") + " ";
    void invoke("write_pty", { paneId: target, data: Array.from(dropEncoder.encode(text)) });
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
    dragUnlisten?.();
  });

  function onKey(e: KeyboardEvent) {
    if (showLauncher || get(showPalette) || get(showSettings)) return;
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
    }
  }

  function zoomFocused() {
    const f = get(focusedPane);
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
    { label: "設定を開く", hint: "Ctrl+,", run: () => showSettings.set(true) },
    { label: "案件ランチャー", hint: "Ctrl+P", run: () => (showLauncher = true) },
    { label: "オープニング: 再生", hint: "WELCOME ORB", run: () => showSplash.set(true) },
  ];

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

  {#if miniWelcome}
    {#key $tabWelcome}
      <div class="mini-welcome" aria-hidden="true"><span>welcome</span></div>
    {/key}
  {/if}

  {#if $dnd}
    <div class="dnd-badge" title="フォーカスモード: 成功通知オフ・失敗のみ通知 (Ctrl+Shift+N)">🔕 focus</div>
  {/if}
</div>

{#if showLauncher}
  <Launcher onClose={() => (showLauncher = false)} />
{/if}

{#if $showSettings}
  <Settings onClose={() => showSettings.set(false)} />
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
