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
  import {
    focusedPane,
    aiPane,
    showSettings,
    showSplash,
    layout,
    broadcast,
    registerTermClear,
    unregisterTermClear,
  } from "../store/appStore";
  import { leafIds } from "../layout/tree";
  import { config } from "../core/config";
  import { invoke } from "@tauri-apps/api/core";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { getCurrentWindow } from "@tauri-apps/api/window";
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
  let termReady = $state(false);
  let ligatureJoinerId: number | undefined;
  let scrolledUp = $state(false);
  const encoder = new TextEncoder();

  // スクロールで履歴を遡っているか判定（「↓ 最下部」ボタンの表示制御）。
  // 代替画面（vim/lazygit 等）では出さない。
  function updateScrollState() {
    if (!term) return;
    const buf = term.buffer.active;
    scrolledUp = buf.type !== "alternate" && buf.viewportY < buf.baseY;
  }

  // プログラミング合字。@xterm/addon-ligatures は font-finder(Node FS) 依存で
  // WebView では動かないため、依存なしで character joiner に主要シーケンスを手動登録し、
  // フォント(Cascadia Code 等)側の合字グリフを描画させる。長い順にマッチさせる。
  const LIGATURES = [
    "<==>", "<-->", "<==", "==>", "<--", "-->", "===", "!==", "=/=", "<=>",
    "<=", "=>", ">=", "==", "!=", "->", "<-", "::", ":=", "|>", "<|",
    "&&", "||", "++", "--", "...", "..", "</", "/>", "</>", "=~", "<>", "|=",
  ].sort((a, b) => b.length - a.length);

  // line のテキストから合字シーケンスの [start, end) 範囲（非重複・昇順）を返す。
  function ligatureJoiner(text: string): [number, number][] {
    const ranges: [number, number][] = [];
    let i = 0;
    while (i < text.length) {
      let hit = false;
      for (const lig of LIGATURES) {
        if (text.startsWith(lig, i)) {
          ranges.push([i, i + lig.length]);
          i += lig.length;
          hit = true;
          break;
        }
      }
      if (!hit) i++;
    }
    return ranges;
  }

  // 選択コピー: マウスアップ時に選択があればクリップボードへ（PuTTY/Linux 流儀）。
  function onMouseUp() {
    const sel = term?.getSelection();
    if (sel) void navigator.clipboard.writeText(sel);
  }
  // 右クリックでペースト（クリップボードの内容を PTY へ）。
  function onContextMenu(e: MouseEvent) {
    e.preventDefault();
    void navigator.clipboard.readText().then((t) => {
      if (t) pty?.write(encoder.encode(t));
    });
  }

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
    // スプラッシュ表示中は端末にフォーカスしない＝Enter で閉じた瞬間に確実に戻す。
    if ($focusedPane === paneId && !$showSettings && !$showSplash) term?.focus();
  });

  // ウィンドウ復帰時、フォーカスペインの端末へ確実にフォーカスを戻す。
  // WebView2 では DOM の window "focus" が alt-tab 復帰で発火しないことがあるため、
  // Tauri ネイティブの onFocusChanged を主軸にする。復帰直後はフォーカス受付が
  // 間に合わないことがあるので次フレームで focus する。
  let unlistenWinFocus: (() => void) | undefined;
  // IME 変換中フラグ。変換中の再フォーカスは未確定文字（合成）を壊すため抑止する。
  let composing = false;
  function onCompStart() {
    composing = true;
  }
  function onCompEnd() {
    composing = false;
  }
  function refocusIfMine() {
    if (disposed || composing) return;
    const ok = () =>
      get(focusedPane) === paneId && !get(showSettings) && !get(showSplash);
    if (!ok()) return;
    // 既に自分の端末にフォーカスがあるなら触らない。IME 候補ウィンドウ出現等で
    // 焦点が外れていないのに focus() を呼ぶと日本語変換が中断されるのを防ぐ。
    if (document.activeElement === term?.textarea) return;
    requestAnimationFrame(() => {
      if (disposed || composing || !ok()) return;
      if (document.activeElement === term?.textarea) return;
      term?.focus();
    });
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

  // 合字の ON/OFF（設定の保存で反映）。termReady になってから初回登録も行う。
  $effect(() => {
    const on = $config.ligatures;
    if (!termReady || !term) return;
    if (on && ligatureJoinerId === undefined) {
      ligatureJoinerId = term.registerCharacterJoiner(ligatureJoiner);
      term.refresh(0, term.rows - 1);
    } else if (!on && ligatureJoinerId !== undefined) {
      term.deregisterCharacterJoiner(ligatureJoinerId);
      ligatureJoinerId = undefined;
      term.refresh(0, term.rows - 1);
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
      theme: {
        background: "#000000",
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
    container.addEventListener("mouseup", onMouseUp);
    container.addEventListener("contextmenu", onContextMenu);
    container.addEventListener("compositionstart", onCompStart);
    container.addEventListener("compositionend", onCompEnd);
    // ウィンドウ復帰でフォーカス復活（Tauri ネイティブを主軸 + DOM/可視性は保険）。
    window.addEventListener("focus", refocusIfMine);
    document.addEventListener("visibilitychange", refocusIfMine);
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) refocusIfMine();
      })
      .then((un) => {
        if (disposed) un();
        else unlistenWinFocus = un;
      })
      .catch(() => {});

    // Ctrl+Shift+K / パレットの「画面クリア」からこのペインを消去できるよう登録。
    registerTermClear(paneId, () => term?.clear());

    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch (e) {
      console.warn("[orb] WebGL addon unavailable, using fallback renderer", e);
    }

    fit.fit();

    blocks = new CommandBlocks(term, paneId);

    // 合字 $effect の初回登録を解禁（term.open 済みでないと joiner を張れない）。
    termReady = true;

    // スクロール状態を追従（「↓ 最下部」ボタンの出し入れ。term.dispose で自動解除）。
    term.onScroll(() => updateScrollState());

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

    term.onData((data) => {
      const bytes = encoder.encode(data);
      if (get(broadcast)) {
        // ブロードキャスト中はフォーカスペインの入力を全ペインへ複製。
        for (const id of leafIds(get(layout))) {
          void invoke("write_pty", { paneId: id, data: Array.from(bytes) });
        }
      } else {
        pty?.write(bytes);
      }
    });
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
    unregisterTermClear(paneId);
    container?.removeEventListener("keydown", onCopyPaste, true);
    container?.removeEventListener("wheel", onWheel, { capture: true });
    container?.removeEventListener("mouseup", onMouseUp);
    container?.removeEventListener("contextmenu", onContextMenu);
    container?.removeEventListener("compositionstart", onCompStart);
    container?.removeEventListener("compositionend", onCompEnd);
    window.removeEventListener("focus", refocusIfMine);
    document.removeEventListener("visibilitychange", refocusIfMine);
    unlistenWinFocus?.();
    observer?.disconnect();
    blocks?.dispose();
    pty?.close();
    term?.dispose();
  });
</script>

<div
  class="term-wrap"
  class:focused={$focusedPane === paneId}
  class:ai={role === "ai"}
  class:broadcast={$broadcast}
>
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

  {#if scrolledUp}
    <button
      class="scroll-bottom"
      onpointerdown={(e) => {
        e.preventDefault();
        term?.scrollToBottom();
        scrolledUp = false;
        focusThis();
      }}
      title="最下部（入力欄）へ戻る"
    >
      &#x2193; 最下部
    </button>
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
  /* ブロードキャスト中は全ペインを赤枠で警告（入力が全ペインに飛ぶ）。 */
  .term-wrap.broadcast {
    box-shadow: inset 0 0 0 2px rgba(255, 92, 138, 0.6);
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

  /* スクロールで履歴を遡っている間だけ右下に出る「↓ 最下部へ戻る」ボタン。 */
  .scroll-bottom {
    position: absolute;
    right: 14px;
    bottom: 12px;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px 12px;
    background: #05100e;
    border: 1px solid rgba(45, 212, 191, 0.5);
    border-radius: 999px;
    box-shadow: 0 4px 18px -6px rgba(45, 212, 191, 0.5);
    color: var(--teal);
    font-family: inherit;
    font-size: 0.72rem;
    letter-spacing: 0.04em;
    cursor: pointer;
    z-index: 9;
    animation: sb-in 0.14s ease-out;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
  }
  .scroll-bottom:hover {
    background: rgba(45, 212, 191, 0.16);
    border-color: var(--teal);
    color: var(--fg);
  }
  @keyframes sb-in {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: none;
    }
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
