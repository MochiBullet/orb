<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebglAddon } from "@xterm/addon-webgl";
  import { Unicode11Addon } from "@xterm/addon-unicode11";
  import { ClipboardAddon } from "@xterm/addon-clipboard";
  import { PtyClient } from "../core/pty";

  // P0 は 1 ペイン固定。ペイン分割は P2 で LayoutTree が採番する。
  const PANE_ID = 0;
  const RESIZE_DEBOUNCE_MS = 150;

  let container: HTMLDivElement;
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let pty: PtyClient | undefined;
  let observer: ResizeObserver | undefined;
  let resizeTimer: number | undefined;
  const encoder = new TextEncoder();

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

    // WebGL は open 後に attach。失敗時は canvas/DOM レンダラへフォールバック。
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch (e) {
      console.warn("[orb] WebGL addon unavailable, using fallback renderer", e);
    }

    fit.fit();

    pty = new PtyClient(PANE_ID);
    term.onData((data) => pty?.write(encoder.encode(data)));
    await pty.spawn(term.cols, term.rows, (bytes) => term?.write(bytes));

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
    if (resizeTimer) clearTimeout(resizeTimer);
    observer?.disconnect();
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
  /* xterm の viewport スクロールバーを teal 寄りに */
  .term :global(.xterm-viewport)::-webkit-scrollbar {
    width: 10px;
  }
  .term :global(.xterm-viewport)::-webkit-scrollbar-thumb {
    background: rgba(45, 212, 191, 0.35);
    border-radius: 6px;
  }
</style>
