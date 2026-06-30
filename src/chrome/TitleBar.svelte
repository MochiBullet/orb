<script lang="ts">
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { cwd, showSettings } from "../store/appStore";

  const appWindow = getCurrentWindow();

  // フルパスは長いので末尾2セグメントだけ表示（例: projects/orb）。
  function shortCwd(p: string): string {
    if (!p) return "";
    const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts.slice(-2).join("/");
  }
</script>

<div class="titlebar" data-tauri-drag-region>
  <div class="left" data-tauri-drag-region>
    <span class="brand" data-tauri-drag-region>orb</span>
    {#if $cwd}
      <span class="cwd" data-tauri-drag-region>{shortCwd($cwd)}</span>
    {/if}
  </div>
  <div class="controls">
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
  .controls {
    display: flex;
    height: 100%;
  }
  .ctl {
    width: 46px;
    height: 100%;
    border: 0;
    background: transparent;
    color: var(--grey);
    font-size: 0.8rem;
    cursor: pointer;
    transition: background 0.12s, color 0.12s, transform 0.25s;
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
    transform: rotate(60deg);
  }
  .ctl.close:hover {
    background: rgba(255, 92, 138, 0.2);
    color: var(--red);
  }
</style>
