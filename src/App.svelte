<script lang="ts">
  import TitleBar from "./chrome/TitleBar.svelte";
  import Workspace from "./layout/Workspace.svelte";
</script>

<div class="app">
  <TitleBar />
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
