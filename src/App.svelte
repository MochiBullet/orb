<script lang="ts">
  import { onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import TitleBar from "./chrome/TitleBar.svelte";
  import TabBar from "./chrome/TabBar.svelte";
  import Sidebar from "./chrome/Sidebar.svelte";
  import Workspace from "./layout/Workspace.svelte";
  import { sidebarSide, saveScrollbacks } from "./store/appStore";

  onMount(() => {
    // アプリ終了/リロード時に各ペインの画面内容を保存（再起動で過去ログとして復元）。
    window.addEventListener("beforeunload", saveScrollbacks);
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested(() => saveScrollbacks())
      .then((un) => (unlisten = un))
      .catch(() => {});
    return () => {
      window.removeEventListener("beforeunload", saveScrollbacks);
      unlisten?.();
    };
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
