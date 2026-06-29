<script lang="ts">
  import type { PaneNode } from "./tree";
  import PaneView from "./PaneView.svelte";

  let { node }: { node: Extract<PaneNode, { kind: "split" }> } = $props();

  const initialRatio = node.ratio;
  let ratio = $state(initialRatio);
  let el: HTMLDivElement;

  function startDrag(e: PointerEvent) {
    e.preventDefault();
    const onMove = (ev: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const r =
        node.dir === "h"
          ? (ev.clientX - rect.left) / rect.width
          : (ev.clientY - rect.top) / rect.height;
      ratio = Math.min(0.85, Math.max(0.15, r));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }
</script>

<div class="split {node.dir}" bind:this={el}>
  <div class="pane" style="flex-grow: {ratio}">
    <PaneView node={node.a} />
  </div>
  <div
    class="splitter {node.dir}"
    onpointerdown={startDrag}
    role="separator"
    aria-orientation={node.dir === "h" ? "vertical" : "horizontal"}
    tabindex="-1"
  ></div>
  <div class="pane" style="flex-grow: {1 - ratio}">
    <PaneView node={node.b} />
  </div>
</div>

<style>
  .split {
    display: flex;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
  }
  .split.h {
    flex-direction: row;
  }
  .split.v {
    flex-direction: column;
  }
  .pane {
    flex-basis: 0;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  .splitter {
    flex: 0 0 4px;
    background: rgba(45, 212, 191, 0.12);
    transition: background 0.12s;
  }
  .splitter.h {
    cursor: col-resize;
  }
  .splitter.v {
    cursor: row-resize;
  }
  .splitter:hover {
    background: rgba(45, 212, 191, 0.45);
  }
</style>
