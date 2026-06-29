<script lang="ts">
  import TitleBar from "./chrome/TitleBar.svelte";
  import Terminal from "./terminal/Terminal.svelte";
</script>

<div class="app">
  <TitleBar />
  <div class="body">
    <Terminal />
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
