<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebglAddon } from "@xterm/addon-webgl";
  import { Unicode11Addon } from "@xterm/addon-unicode11";
  import { ClipboardAddon } from "@xterm/addon-clipboard";
  import { PtyClient } from "../core/pty";
  import { CommandBlocks } from "./blocks/osc";

  // P0 は 1 ペイン固定。ペイン分割は P2 で LayoutTree が採番する。
  const PANE_ID = 0;
  const RESIZE_DEBOUNCE_MS = 150;

  let container: HTMLDivElement;
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let pty: PtyClient | undefined;
  let observer: ResizeObserver | undefined;
  let resizeTimer: number | undefined;
  let disposed = false;
  let blocks: CommandBlocks | undefined;
  const encoder = new TextEncoder();

  // コピペは attachCustomKeyEventHandler だと keydown/keypress の二重発火で入力が
  // 二重化するため使わない。container の keydown を capture phase で横取りし、
  // コピペ操作のときだけ既定処理を止める（通常入力・無選択 Ctrl+C は素通し＝SIGINT）。
  function onCopyPaste(e: KeyboardEvent) {
    if (!e.ctrlKey) return;
    const key = e.key.toLowerCase();
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
      fontFamily: '"Cascadia Code", "FiraCode Nerd Font", "Consolas", monospace',
      fontSize: 13,
      scrollback: 1000,
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

    term.open(container);

    // コピペは capture phase の keydown で横取り（attachCustomKeyEventHandler は使わない）。
    container.addEventListener("keydown", onCopyPaste, true);

    // WebGL は open 後に attach。失敗時は canvas/DOM レンダラへフォールバック。
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch (e) {
      console.warn("[orb] WebGL addon unavailable, using fallback renderer", e);
    }

    fit.fit();

    // OSC 133/633 を解釈してコマンドブロック装飾を出す（出力ストリームに乗る）。
    blocks = new CommandBlocks(term);

    pty = new PtyClient(PANE_ID);
    try {
      await pty.spawn(term.cols, term.rows, (bytes) => term?.write(bytes));
    } catch (e) {
      // pwsh 未検出 / spawn 失敗をユーザーに可視化（無言の空白端末を防ぐ）。
      term.writeln("\x1b[31m[orb] PTY の起動に失敗しました: " + String(e) + "\x1b[0m");
      term.writeln(
        "\x1b[90mPowerShell 7 (pwsh.exe) が見つからない場合は、インストールするか PATH を通してください。\x1b[0m",
      );
      return;
    }

    // 破棄済みなら起動した PTY を畳んで終わる（async/onDestroy 競合対策）。
    if (disposed) {
      pty.close();
      return;
    }

    // 入力結線は spawn 完了後に行う（起動 race による初期キー入力ロストを防ぐ）。
    term.onData((data) => pty?.write(encoder.encode(data)));
    // 非 UTF-8 のバイナリ応答（マウスレポート等）は charCode を直マップで送る。
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
    observer?.disconnect();
    blocks?.dispose();
    pty?.close();
    term?.dispose();
  });
</script>

<div class="term" bind:this={container}></div>

<style>
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

  /* コマンドブロック（OSC 133/633 の decoration オーバーレイ） */
  .term :global(.orb-block) {
    pointer-events: none;
    box-sizing: border-box;
    border-left: 3px solid transparent;
  }
  .term :global(.orb-block.ok) {
    border-left-color: rgba(45, 212, 191, 0.55);
  }
  .term :global(.orb-block.fail) {
    border-left-color: rgba(255, 92, 138, 0.7);
    background: rgba(255, 92, 138, 0.05);
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
</style>
