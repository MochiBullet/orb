<script lang="ts">
  import TitleBar from "./chrome/TitleBar.svelte";
  import TabBar from "./chrome/TabBar.svelte";
  import Workspace from "./layout/Workspace.svelte";
</script>

<div class="app">
  <TitleBar />
  <TabBar />
  <div class="body">
    <Workspace />
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
  }
</style>
