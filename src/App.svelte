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
