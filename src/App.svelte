<script lang="ts">
  import { onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import TitleBar from "./chrome/TitleBar.svelte";
  import TabBar from "./chrome/TabBar.svelte";
  import Sidebar from "./chrome/Sidebar.svelte";
  import Workspace from "./layout/Workspace.svelte";
  import { sidebarSide, saveScrollbacks } from "./store/appStore";
  import { bgMedia } from "./core/theme";

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
  <!-- #21/#66: 背景メディア＋暗幕を、全 chrome/端末より背面(z-index:0)の1レイヤに敷く。
       内容は .stack(z-index:1)へ丸ごと持ち上げる＝不透明な chrome はメディア/暗幕を覆い、
       透過した端末だけが背後を透かす（暗幕は端末にだけ効く。子コンポーネントの z-index に非依存）。
       画像も動画も object-fit/object-position/transform:scale の同一経路で縦横比を保って表示する。 -->
  <div class="bg-layer" aria-hidden="true">
    {#if $bgMedia}
      {#if $bgMedia.video}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video class="bg-media" src={$bgMedia.src} autoplay muted loop playsinline></video>
      {:else}
        <img class="bg-media" src={$bgMedia.src} alt="" />
      {/if}
    {/if}
    <div class="bg-dim"></div>
  </div>
  <div class="stack">
    <TitleBar />
    <TabBar />
    <div class="body" class:reverse={$sidebarSide === "left"}>
      <div class="ws">
        <Workspace />
      </div>
      <Sidebar />
    </div>
  </div>
</div>

<style>
  .app {
    position: relative;
    height: 100vh;
    /* ズームで拡大したメディアのはみ出しを窓内にクリップ。 */
    overflow: hidden;
  }
  /* 背面のメディア＋暗幕レイヤ。内容(.stack)を z-index:1 に置くことで、この層は端末の
     透過部分にだけ見える（不透明な chrome が覆う）。子コンポーネントの z-index に依存しない。 */
  .bg-layer {
    position: absolute;
    inset: 0;
    z-index: 0;
    pointer-events: none;
  }
  .bg-media {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    /* object-fit で縦横比を保って cover/contain、transform:scale で歪みなくズーム。 */
    object-fit: var(--bg-fit, cover);
    object-position: var(--bg-position, center);
    transform: var(--bg-transform, none);
    transform-origin: var(--bg-origin, center);
  }
  .bg-dim {
    position: absolute;
    inset: 0;
    background: #000;
    opacity: var(--bg-dim, 0);
  }
  .stack {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    height: 100%;
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
