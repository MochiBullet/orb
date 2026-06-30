<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebglAddon } from "@xterm/addon-webgl";
  import { Unicode11Addon } from "@xterm/addon-unicode11";
  import { ClipboardAddon } from "@xterm/addon-clipboard";
  import { SearchAddon } from "@xterm/addon-search";
  import { WebLinksAddon } from "@xterm/addon-web-links";
  import { PtyClient } from "../core/pty";
  import { CommandBlocks } from "./blocks/osc";
  import { focusedPane, aiPane, showSettings } from "../store/appStore";
  import { config } from "../core/config";
  import { invoke } from "@tauri-apps/api/core";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { get } from "svelte/store";

  let { paneId, initialCmd, role }: { paneId: number; initialCmd?: string; role?: "shell" | "ai" } =
    $props();
  const RESIZE_DEBOUNCE_MS = 150;
  const cfg = get(config);

  let container: HTMLDivElement;
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let search: SearchAddon | undefined;
  let pty: PtyClient | undefined;
  let observer: ResizeObserver | undefined;
  let resizeTimer: number | undefined;
  let disposed = false;
  let blocks: CommandBlocks | undefined;
  let showSearch = $state(false);
  let searchQuery = $state("");
  let searchInput = $state<HTMLInputElement | undefined>(undefined);
  const encoder = new TextEncoder();

  function focusThis() {
    focusedPane.set(paneId);
    term?.focus();
  }

  // Ctrl+L: このペインの選択テキストを AI(claude)ペインの stdin へ送る（ペースト）。
  function sendSelectionToAi() {
    const target = get(aiPane);
    if (target == null || target === paneId) return;
    const sel = term?.getSelection() ?? "";
    if (!sel) return;
    void invoke("write_pty", { paneId: target, data: Array.from(encoder.encode(sel)) });
  }

  // フォーカスが自分に移ったら実際のキーボードフォーカスも端末へ。
  // 設定パネルを閉じた瞬間も（$showSettings が false になったら）端末へ戻す
  // ＝設定内の input にフォーカスが残って入力が吸われるのを防ぐ。
  $effect(() => {
    if ($focusedPane === paneId && !$showSettings) term?.focus();
  });

  // 別ウィンドウから orb に戻ると xterm の textarea が左上にリセットされて浮くため、
  // ウィンドウ復帰時にフォーカスペインを再フォーカスして位置を戻す。
  function onWinFocus() {
    if (get(focusedPane) === paneId && !get(showSettings)) term?.focus();
  }

  // 設定でフォントサイズが変わったら即反映（全ペイン）。
  $effect(() => {
    const fs = $config.font_size;
    if (term && term.options.fontSize !== fs) {
      term.options.fontSize = fs;
      fit?.fit();
      pty?.resize(term.cols, term.rows);
    }
  });

  // 背景画像の有無で端末背景の透過を切替（画像時は透明にして .app の背景を透かす）。
  $effect(() => {
    const bg = $config.bg_image ? "rgba(0,0,0,0)" : "#000000";
    if (term && term.options.theme?.background !== bg) {
      term.options.theme = { ...term.options.theme, background: bg };
    }
  });

  // ピンチズーム / Ctrl+ホイール / Ctrl+0。WebView2 ではタッチパッドのピンチは
  // ctrlKey 付き wheel として届く。
  function zoom(delta: number) {
    if (!term) return;
    const cur = term.options.fontSize ?? cfg.font_size;
    term.options.fontSize = Math.min(28, Math.max(8, cur + delta));
    fit?.fit();
    pty?.resize(term.cols, term.rows);
  }
  function resetZoom() {
    if (!term) return;
    term.options.fontSize = cfg.font_size;
    fit?.fit();
    pty?.resize(term.cols, term.rows);
  }
  function onWheel(e: WheelEvent) {
    if (!e.ctrlKey) return;
    // xterm のスクロールに食われないよう、ズーム時は capture 段で握りつぶす。
    e.preventDefault();
    e.stopPropagation();
    zoom(e.deltaY < 0 ? 1 : -1);
  }

  function openSearch() {
    showSearch = true;
    queueMicrotask(() => searchInput?.focus());
  }
  function onSearchKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      showSearch = false;
      term?.focus();
    } else if (e.key === "Enter") {
      if (e.shiftKey) search?.findPrevious(searchQuery);
      else search?.findNext(searchQuery);
    }
  }

  // コピペ等の capture-phase keydown（attachCustomKeyEventHandler は二重発火するため不使用）。
  function onCopyPaste(e: KeyboardEvent) {
    if (!e.ctrlKey) return;
    if (e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); blocks?.jumpPrev(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); blocks?.jumpNext(); return; }
    const key = e.key.toLowerCase();
    if (key === "f") { e.preventDefault(); e.stopPropagation(); openSearch(); return; }
    if (key === "0") { e.preventDefault(); e.stopPropagation(); resetZoom(); return; }
    if (key === "=" || key === "+") { e.preventDefault(); e.stopPropagation(); zoom(1); return; }
    if (key === "-") { e.preventDefault(); e.stopPropagation(); zoom(-1); return; }
    if (key === "l") { e.preventDefault(); e.stopPropagation(); sendSelectionToAi(); return; }
    if (key === "c" && (e.shiftKey || (term?.hasSelection() ?? false))) {
      const sel = term?.getSelection() ?? "";
      if (sel) {
        void navigator.clipboard.writeText(sel);
        term?.clearSelection();
        e.preventDefault();
        e.stopPropagation();
      }
    } else if (key === "v") {
      void navigator.clipboard.readText().then((t) => {
        if (t) pty?.write(encoder.encode(t));
      });
      e.preventDefault();
      e.stopPropagation();
    }
  }

  onMount(async () => {
    term = new Terminal({
      fontFamily: cfg.font_family,
      fontSize: cfg.font_size,
      scrollback: cfg.scrollback,
      cursorBlink: true,
      allowProposedApi: true,
      allowTransparency: true,
      theme: {
        background: cfg.bg_image ? "rgba(0,0,0,0)" : "#000000",
        foreground: "#e6fffa",
        cursor: "#2dd4bf",
        cursorAccent: "#000000",
        selectionBackground: "rgba(45, 212, 191, 0.3)",
        black: "#0a1a17",
        red: "#ff5c8a",
        green: "#6ee7b7",
        yellow: "#fbbf24",
        blue: "#4fc3f7",
        magenta: "#a78bfa",
        cyan: "#2dd4bf",
        white: "#e6fffa",
        brightBlack: "#8ba8a3",
      },
    });

    fit = new FitAddon();
    term.loadAddon(fit);

    const unicode = new Unicode11Addon();
    term.loadAddon(unicode);
    term.unicode.activeVersion = "11";

    term.loadAddon(new ClipboardAddon());
    search = new SearchAddon();
    term.loadAddon(search);

    // クリック可能URL: 出力中の http/https をクリックで既定ブラウザで開く。
    term.loadAddon(new WebLinksAddon((_e, uri) => void openUrl(uri)));

    term.open(container);
    container.addEventListener("keydown", onCopyPaste, true);
    container.addEventListener("wheel", onWheel, { passive: false, capture: true });
    window.addEventListener("focus", onWinFocus);

    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch (e) {
      console.warn("[orb] WebGL addon unavailable, using fallback renderer", e);
    }

    fit.fit();

    blocks = new CommandBlocks(term, paneId);

    pty = new PtyClient(paneId);
    try {
      await pty.spawn(term.cols, term.rows, (bytes) => term?.write(bytes), initialCmd);
    } catch (e) {
      term.writeln("\x1b[31m[orb] PTY の起動に失敗しました: " + String(e) + "\x1b[0m");
      term.writeln(
        "\x1b[90mPowerShell 7 (pwsh.exe) が見つからない場合は、インストールするか PATH を通してください。\x1b[0m",
      );
      return;
    }

    if (disposed) {
      pty.close();
      return;
    }

    term.onData((data) => pty?.write(encoder.encode(data)));
    term.onBinary((data) => {
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
      pty?.write(bytes);
    });

    observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (!term || !fit) return;
        fit.fit();
        pty?.resize(term.cols, term.rows);
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(container);
  });

  onDestroy(() => {
    disposed = true;
    if (resizeTimer) clearTimeout(resizeTimer);
    container?.removeEventListener("keydown", onCopyPaste, true);
    container?.removeEventListener("wheel", onWheel, { capture: true });
    window.removeEventListener("focus", onWinFocus);
    observer?.disconnect();
    blocks?.dispose();
    pty?.close();
    term?.dispose();
  });
</script>

<div class="term-wrap" class:focused={$focusedPane === paneId} class:ai={role === "ai"}>
  <div class="term" bind:this={container} onpointerdown={focusThis} role="presentation"></div>
  {#if showSearch}
    <div class="search-bar">
      <input
        bind:this={searchInput}
        bind:value={searchQuery}
        onkeydown={onSearchKey}
        oninput={() => search?.findNext(searchQuery)}
        placeholder="検索  (Enter / Shift+Enter / Esc)"
      />
      <button
        class="sx"
        onpointerdown={() => {
          showSearch = false;
          term?.focus();
        }}
        aria-label="close search">&#x2715;</button
      >
    </div>
  {/if}
</div>

<style>
  .term-wrap {
    position: relative;
    width: 100%;
    height: 100%;
    box-shadow: inset 0 0 0 1px transparent;
    transition: box-shadow 0.12s;
  }
  .term-wrap.focused {
    box-shadow: inset 0 0 0 1px rgba(45, 212, 191, 0.45);
  }
  .term-wrap.ai {
    box-shadow: inset 0 0 0 1px rgba(167, 139, 250, 0.5);
  }
  .term-wrap.ai.focused {
    box-shadow: inset 0 0 0 1.5px rgba(167, 139, 250, 0.75);
  }
  .term {
    width: 100%;
    height: 100%;
    padding: 6px 8px 4px;
    background: #000;
  }
  .term :global(.xterm-viewport)::-webkit-scrollbar {
    width: 10px;
  }
  .term :global(.xterm-viewport)::-webkit-scrollbar-thumb {
    background: rgba(45, 212, 191, 0.35);
    border-radius: 6px;
  }

  .search-bar {
    position: absolute;
    top: 6px;
    right: 12px;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 6px;
    background: #05100e;
    border: 1px solid rgba(45, 212, 191, 0.4);
    border-radius: 6px;
    box-shadow: 0 0 20px -6px rgba(45, 212, 191, 0.4);
    z-index: 10;
  }
  .search-bar input {
    width: 220px;
    border: 0;
    background: transparent;
    color: var(--fg);
    font-family: inherit;
    font-size: 0.8rem;
    outline: none;
  }
  .search-bar .sx {
    border: 0;
    background: transparent;
    color: var(--grey);
    cursor: pointer;
    font-size: 0.7rem;
  }
  .search-bar .sx:hover {
    color: var(--red);
  }

  /* コマンドブロック（OSC 133/633 の decoration オーバーレイ） */
  .term :global(.orb-block) {
    pointer-events: none;
    box-sizing: border-box;
    border-left: 3px solid transparent;
    transition: border-color 0.15s;
  }
  .term :global(.orb-block.ok) {
    border-left-color: rgba(45, 212, 191, 0.6);
    box-shadow: inset 3px 0 10px -5px rgba(45, 212, 191, 0.6);
  }
  .term :global(.orb-block.fail) {
    border-left-color: rgba(255, 92, 138, 0.75);
    background: rgba(255, 92, 138, 0.05);
    box-shadow: inset 3px 0 10px -5px rgba(255, 92, 138, 0.6);
  }
  .term :global(.orb-block-badge) {
    position: absolute;
    right: 6px;
    top: 0;
    font-size: 10px;
    line-height: 1.4;
    letter-spacing: 0.02em;
  }
  .term :global(.orb-block.ok .orb-block-badge) {
    color: #2dd4bf;
  }
  .term :global(.orb-block.fail .orb-block-badge) {
    color: #ff5c8a;
  }
  /* ブロックの hover ツールバー（コピー / AI へ送る） */
  .term :global(.orb-block-tools) {
    position: absolute;
    right: 56px;
    top: 0;
    display: flex;
    gap: 4px;
    opacity: 0.32;
    transition: opacity 0.12s;
    pointer-events: auto;
  }
  .term :global(.orb-block-tools:hover) {
    opacity: 1;
  }
  .term :global(.orb-block-tools button) {
    border: 1px solid rgba(45, 212, 191, 0.4);
    background: #05100e;
    color: var(--teal);
    font-size: 9px;
    line-height: 1.3;
    border-radius: 4px;
    cursor: pointer;
    padding: 0 5px;
  }
  .term :global(.orb-block-tools button:hover) {
    background: rgba(45, 212, 191, 0.18);
    color: var(--fg);
  }
</style>
