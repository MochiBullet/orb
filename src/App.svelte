<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import TitleBar from "./chrome/TitleBar.svelte";
  import TabBar from "./chrome/TabBar.svelte";
  import Sidebar from "./chrome/Sidebar.svelte";
  import Workspace from "./layout/Workspace.svelte";
  import Splash from "./chrome/Splash.svelte";
  import { sidebarSide, showSplash } from "./store/appStore";
  import { config } from "./core/config";

  // 起動時オープニング（設定 show_opening が false なら出さない）。
  onMount(() => {
    if (get(config).show_opening !== false) showSplash.set(true);
  });
</script>

<div class="app">
  <TitleBar />
  <TabBar />
  <div class="body" class:reverse={$sidebarSide === "left"}>
    <div class="ws">
      <Workspace />
    </div>
    <Sidebar />
  </div>
</div>

{#if $showSplash}
  <Splash />
{/if}

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .body {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: row;
  }
  .body.reverse {
    flex-direction: row-reverse;
  }
  .ws {
    flex: 1 1 auto;
    min-width: 0;
    position: relative;
  }
</style>
