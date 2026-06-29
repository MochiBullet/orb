<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { layout, focusedPane, nextPaneId } from "../store/appStore";
  import { leaf, splitPane, closePane, leafIds } from "./tree";
  import PaneView from "./PaneView.svelte";
  import Launcher from "./Launcher.svelte";

  let showLauncher = $state(false);

  onMount(() => {
    if (!get(layout)) {
      const id = nextPaneId();
      layout.set(leaf(id));
      focusedPane.set(id);
    }
    window.addEventListener("keydown", onKey, true);
  });

  onDestroy(() => window.removeEventListener("keydown", onKey, true));

  function onKey(e: KeyboardEvent) {
    // Ctrl+P : 案件ランチャーを開く
    if (e.ctrlKey && !e.shiftKey && (e.key === "p" || e.key === "P")) {
      e.preventDefault();
      showLauncher = true;
      return;
    }
    // Ctrl+] / Ctrl+[ : フォーカスを次/前のペインへ巡回
    if (e.ctrlKey && !e.shiftKey && (e.key === "]" || e.key === "[")) {
      e.preventDefault();
      cycleFocus(e.key === "]" ? 1 : -1);
      return;
    }
    // Ctrl+Shift+D : 横分割 / E : 縦分割 / W : フォーカスペインを閉じる
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
    const newId = nextPaneId();
    layout.set(splitPane(root, get(focusedPane), dir, newId));
    focusedPane.set(newId);
  }

  function doClose() {
    const root = get(layout);
    if (!root || leafIds(root).length <= 1) return; // 最後の1枚は閉じない
    const next = closePane(root, get(focusedPane));
    layout.set(next);
    const remaining = leafIds(next);
    if (remaining.length) focusedPane.set(remaining[0]);
  }

  function cycleFocus(delta: number) {
    const ids = leafIds(get(layout));
    if (ids.length <= 1) return;
    const cur = ids.indexOf(get(focusedPane));
    const idx = ((cur < 0 ? 0 : cur + delta) + ids.length) % ids.length;
    focusedPane.set(ids[idx]);
  }
</script>

{#if $layout}
  <div class="workspace">
    <PaneView node={$layout} />
  </div>
{/if}

{#if showLauncher}
  <Launcher onClose={() => (showLauncher = false)} />
{/if}

<style>
  .workspace {
    width: 100%;
    height: 100%;
  }
</style>
