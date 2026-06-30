<script lang="ts">
  import TitleBar from "./chrome/TitleBar.svelte";
  import TabBar from "./chrome/TabBar.svelte";
  import Sidebar from "./chrome/Sidebar.svelte";
  import Workspace from "./layout/Workspace.svelte";
  import { sidebarSide } from "./store/appStore";
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

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background-image: var(--bg-image, none);
    background-size: cover;
    background-position: center;
    position: relative;
  }
  /* 背景画像の上に暗幕（可読性確保）。画像が無ければ --bg-dim:0 で無効。 */
  .app::before {
    content: "";
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, var(--bg-dim, 0));
    pointer-events: none;
    z-index: 0;
  }
  .app > * {
    position: relative;
    z-index: 1;
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
