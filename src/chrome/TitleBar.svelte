<script lang="ts">
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { getVersion } from "@tauri-apps/api/app";
  import { cwd, showSettings, showPalette, paletteMode } from "../store/appStore";

  const appWindow = getCurrentWindow();

  // tauri.conf.json の version（about/設定ロゴ横に表示）。
  let version = $state("");
  getVersion().then((v) => (version = v)).catch(() => {});

  // フルパスは長いので末尾2セグメントだけ表示（例: projects/orb）。
  function shortCwd(p: string): string {
    if (!p) return "";
    const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts.slice(-2).join("/");
  }
</script>

<div class="titlebar" data-tauri-drag-region>
  <div class="left" data-tauri-drag-region>
    <span class="brand" data-tauri-drag-region>ORB</span>
    {#if $cwd}
      <span class="cwd" data-tauri-drag-region>{shortCwd($cwd)}</span>
    {/if}
  </div>

  <div class="hcenter">
    <button
      class="hsearch"
      onclick={() => { paletteMode.set("search"); showPalette.set(true); }}
      aria-label="コマンド検索"
      title="コマンド検索 (Ctrl+Shift+P)"
    >
      <span class="hs-ico" aria-hidden="true">&#x2315;</span>
      <span class="hs-ph">コマンドを検索…</span>
      <span class="hs-kbd">Ctrl+Shift+P</span>
    </button>
    <button
      class="hinfo"
      onclick={() => { paletteMode.set("help"); showPalette.set(true); }}
      aria-label="取扱説明・ショートカット一覧"
      title="取扱説明・ショートカット一覧"
    >&#9432;</button>
  </div>

  <div class="controls">
    {#if version}<span class="ver" title="orb version">v{version}</span>{/if}
    <button class="ctl gear" onclick={() => showSettings.set(true)} aria-label="settings"
      >&#x2699;</button
    >
    <button class="ctl" onclick={() => appWindow.minimize()} aria-label="minimize"
      >&#x2013;</button
    >
    <button class="ctl" onclick={() => appWindow.toggleMaximize()} aria-label="maximize"
      >&#x25a2;</button
    >
    <button class="ctl close" onclick={() => appWindow.close()} aria-label="close"
      >&#x2715;</button
    >
  </div>
</div>

<style>
  .titlebar {
    height: 34px;
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 0 0 14px;
    background: linear-gradient(90deg, #000 0%, #061712 50%, #000 100%);
    border-bottom: 1px solid rgba(45, 212, 191, 0.25);
    user-select: none;
  }
  .left {
    display: flex;
    align-items: baseline;
    gap: 12px;
    min-width: 0;
  }
  .brand {
    font-weight: 700;
    letter-spacing: 0.35em;
    font-size: 0.82rem;
    color: var(--teal);
    text-shadow: 0 0 12px rgba(45, 212, 191, 0.5);
  }
  .cwd {
    font-size: 0.72rem;
    color: var(--grey);
    letter-spacing: 0.02em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* header center: always-visible command search + 取扱説明(ⓘ) */
  .hcenter {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 1 420px;
    min-width: 90px;
    margin: 0 16px;
  }
  .hsearch {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1 1 auto;
    min-width: 0;
    height: 24px;
    padding: 0 10px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(45, 212, 191, 0.18);
    border-radius: 6px;
    color: var(--grey);
    font-family: inherit;
    font-size: 0.72rem;
    cursor: text;
    transition: background 0.15s, border-color 0.15s;
  }
  .hsearch:hover {
    background: rgba(45, 212, 191, 0.08);
    border-color: rgba(45, 212, 191, 0.4);
  }
  /* 取扱説明(ⓘ) は枠なし＝アイコン単体。ホバーは glow で示す。 */
  .hinfo {
    flex: 0 0 auto;
    width: 24px;
    height: 24px;
    border: none;
    background: none;
    color: var(--teal);
    font-size: 1.05rem;
    line-height: 1;
    cursor: pointer;
    transition: color 0.15s, text-shadow 0.15s;
  }
  .hinfo:hover {
    color: var(--fg);
    text-shadow: 0 0 8px rgba(45, 212, 191, 0.7);
  }
  .hs-ico {
    flex: 0 0 auto;
    color: var(--teal);
    font-size: 0.9rem;
    line-height: 1;
  }
  .hs-ph {
    flex: 1 1 auto;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hs-kbd {
    flex: 0 0 auto;
    font-size: 0.56rem;
    color: var(--grey);
    opacity: 0.6;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 3px;
    padding: 0 4px;
  }
  .controls {
    display: flex;
    align-items: center;
    height: 100%;
  }
  .ver {
    display: flex;
    align-items: center;
    padding: 0 10px;
    font-family: var(--mono, inherit);
    font-size: 0.66rem;
    letter-spacing: 0.04em;
    color: var(--grey);
    opacity: 0.7;
    user-select: none;
  }
  .ctl {
    width: 46px;
    height: 100%;
    border: 0;
    background: transparent;
    color: var(--grey);
    font-size: 0.8rem;
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
  }
  .ctl:hover {
    background: rgba(45, 212, 191, 0.12);
    color: var(--fg);
  }
  .ctl.gear {
    font-size: 0.98rem;
  }
  .ctl.gear:hover {
    color: var(--teal);
  }
  .ctl.close:hover {
    background: rgba(255, 92, 138, 0.2);
    color: var(--red);
  }
</style>
