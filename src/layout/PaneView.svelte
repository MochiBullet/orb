<script lang="ts">
  import type { PaneNode } from "./tree";
  import Terminal from "../terminal/Terminal.svelte";
  import SplitPane from "./SplitPane.svelte";

  let { node }: { node: PaneNode } = $props();
</script>

{#if node.kind === "leaf"}
  <Terminal paneId={node.paneId} />
{:else}
  <SplitPane {node} />
{/if}
