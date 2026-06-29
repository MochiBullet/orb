<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { layout, focusedPane, nextPaneId } from "../store/appStore";
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
  import Terminal from "../terminal/Terminal.svelte";
  import Launcher from "./Launcher.svelte";
  import { ensureFirstTab, newTab, closeTab, activeTabId } from "./tabs";

  let showLauncher = $state(false);
  let wsEl: HTMLDivElement;

  // ツリーから geometry を導出する。Terminal は paneId キーで一度だけ生成され、
  // 分割/クローズでは矩形(style)が変わるだけで unmount されない（PTY/scrollback が生き残る）。
  const FULL: Rect = { x: 0, y: 0, w: 100, h: 100 };
  let ids = $derived(leafIds($layout));
  let rects = $derived.by(() => {
    const m = new Map<number, Rect>();
    if ($layout) computeRects($layout, FULL, m);
    return m;
  });
  let splitters = $derived.by(() => {
    const a: Splitter[] = [];
    if ($layout) computeSplitters($layout, FULL, a);
    return a;
  });
  let info = $derived.by(() => {
    const m = new Map<number, { initialCmd?: string; role?: PaneRole }>();
    if ($layout) leafInfoMap($layout, m);
    return m;
  });

  onMount(() => {
    ensureFirstTab();
    window.addEventListener("keydown", onKey, true);
  });

  onDestroy(() => window.removeEventListener("keydown", onKey, true));

  function onKey(e: KeyboardEvent) {
    // モーダル表示中はグローバルショートカットを止める（背後のレイアウト破壊防止）。
    if (showLauncher) return;
    // Ctrl+T 新タブ / Ctrl+W タブ閉じ
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
    // Ctrl+P : 案件ランチャー
    if (e.ctrlKey && !e.shiftKey && (e.key === "p" || e.key === "P")) {
      e.preventDefault();
      showLauncher = true;
      return;
    }
    // Ctrl+Tab / Ctrl+Shift+Tab : フォーカス巡回（端末予約の Ctrl+[ /] は使わない）
    if (e.ctrlKey && e.key === "Tab") {
      e.preventDefault();
      cycleFocus(e.shiftKey ? -1 : 1);
      return;
    }
    // Ctrl+Shift+D 横分割 / E 縦分割 / W クローズ
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
    }
  }

  function doSplit(dir: "h" | "v") {
    const root = get(layout);
    if (!root) return;
    const newPaneId = nextPaneId();
    const newSplitId = nextPaneId();
    layout.set(splitPane(root, get(focusedPane), dir, newPaneId, newSplitId));
    focusedPane.set(newPaneId);
  }

  function doClose() {
    const root = get(layout);
    if (!root || leafIds(root).length <= 1) return;
    const f = get(focusedPane);
    const sib = siblingFirstLeaf(root, f);
    const next = closePane(root, f);
    layout.set(next);
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
  {#each ids as id (id)}
    {@const rect = rects.get(id)}
    {#if rect}
      <div class="slot" style="left:{rect.x}%;top:{rect.y}%;width:{rect.w}%;height:{rect.h}%">
        <Terminal paneId={id} initialCmd={info.get(id)?.initialCmd} role={info.get(id)?.role} />
      </div>
    {/if}
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
</div>

{#if showLauncher}
  <Launcher onClose={() => (showLauncher = false)} />
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
</style>
