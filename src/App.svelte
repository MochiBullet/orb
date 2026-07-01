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
    /* #21: 背景画像＋暗幕を .app の「背景ペイント層」に1枚へ合成する（画像なしは透明＝従来通り黒）。
       暗幕を絶対配置オーバーレイ(::before)にすると、Svelte のスタイルスコープで z-index が
       子コンポーネント root(TitleBar/TabBar)に効かず、それらまで暗くなる。背景に焼き込めば
       不透明な chrome は一切影響を受けず、透過した端末だけに暗幕が効く（z-index 非依存）。 */
    background-image: linear-gradient(
        rgba(0, 0, 0, var(--bg-dim, 0)),
        rgba(0, 0, 0, var(--bg-dim, 0))
      ),
      var(--bg-image, none);
    background-size: cover;
    background-position: center;
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
