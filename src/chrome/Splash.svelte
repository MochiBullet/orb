<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { showSplash, sendInputToFocusedPane } from "../store/appStore";

  const encoder = new TextEncoder();

  // figlet: WELCOME = font "small"（スリム）。バックスラッシュを保つため String.raw。
  const WELCOME_ART = [
    String.raw`__      _____ _    ___ ___  __  __ ___ `,
    String.raw`\ \    / / __| |  / __/ _ \|  \/  | __|`,
    String.raw` \ \/\/ /| _|| |_| (_| (_) | |\/| | _| `,
    String.raw`  \_/\_/ |___|____\___\___/|_|  |_|___|`,
  ].join("\n");

  // figlet: ORB = font "ansi_shadow"（ブロック）。ヒーロー。
  const ORB_ART = [
    String.raw` ██████╗ ██████╗ ██████╗ `,
    String.raw`██╔═══██╗██╔══██╗██╔══██╗`,
    String.raw`██║   ██║██████╔╝██████╔╝`,
    String.raw`██║   ██║██╔══██╗██╔══██╗`,
    String.raw`╚██████╔╝██║  ██║██████╔╝`,
    String.raw` ╚═════╝ ╚═╝  ╚═╝╚═════╝ `,
  ].join("\n");

  const reduce =
    typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;

  let leaving = $state(false);
  let outTimer: number | undefined;

  function dismiss() {
    if (leaving) return;
    leaving = true;
    // フェードアウト後に実体を消す（reduce 時は即）。keydown リスナは onDestroy まで張り続け、
    // フェード中（端末はまだ未フォーカス）の打鍵も PTY へ流す＝1打も落とさない。
    outTimer = window.setTimeout(() => showSplash.set(false), reduce ? 0 : 420);
  }

  // KeyboardEvent を端末バイト列へ。修飾キー単独／Ctrl 等の併用は入力にしない（消費のみ）。
  function keyToBytes(e: KeyboardEvent): Uint8Array | null {
    if (e.isComposing) return null;
    if (e.ctrlKey || e.metaKey || e.altKey) return null;
    let s: string | null = null;
    if (e.key === "Enter") s = "\r";
    else if (e.key === "Tab") s = "\t";
    else if (e.key === "Backspace") s = "\x7f";
    else if (e.key === "Escape") s = "\x1b";
    else if (e.key === "ArrowUp") s = "\x1b[A";
    else if (e.key === "ArrowDown") s = "\x1b[B";
    else if (e.key === "ArrowRight") s = "\x1b[C";
    else if (e.key === "ArrowLeft") s = "\x1b[D";
    else if (e.key.length === 1) s = e.key;
    return s == null ? null : encoder.encode(s);
  }

  // 任意キーで開始。その打鍵は splash が消費（preventDefault/stopPropagation で xterm には
  // 渡さない）し、代わりにフォーカスペインの入力経路へ一度だけ届ける＝二重入力なし・入力ロスなし。
  // PTY が未起動なら Terminal 側でバッファされ、spawn 完了時に流れる。
  function onKey(e: KeyboardEvent) {
    e.preventDefault();
    e.stopPropagation();
    const bytes = keyToBytes(e);
    if (bytes) sendInputToFocusedPane(bytes);
    dismiss();
  }

  onMount(() => {
    window.addEventListener("keydown", onKey, true);
  });
  onDestroy(() => {
    if (outTimer) clearTimeout(outTimer);
    window.removeEventListener("keydown", onKey, true);
  });
</script>

<div class="splash" class:leaving class:reduce role="presentation" onpointerdown={dismiss}>
  {#if !reduce}<div class="scan" aria-hidden="true"></div>{/if}
  <div class="inner">
    <pre class="aa welcome" aria-hidden="true">{WELCOME_ART}</pre>
    <pre class="aa orb" aria-label="WELCOME ORB">{ORB_ART}</pre>
    <div class="tagline">vibe-coding terminal</div>
    <div class="hint">press any key to start</div>
  </div>
</div>

<style>
  .splash {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: flex;
    align-items: center;
    justify-content: center;
    background:
      radial-gradient(120% 80% at 50% 42%, rgba(45, 212, 191, 0.12), transparent 60%),
      #000;
    animation: splash-in 360ms ease-out both;
  }
  .splash.leaving {
    animation: splash-out 420ms ease-in both;
  }
  .inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    will-change: transform, opacity;
    animation: inner-in 620ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  .aa {
    margin: 0;
    width: fit-content;
    font-family: var(--mono, "Cascadia Code", monospace);
    line-height: 1.04;
    white-space: pre;
    user-select: none;
  }
  .welcome {
    font-size: clamp(7px, 1.4vw, 13px);
    color: rgba(110, 231, 183, 0.62);
    text-shadow: 0 0 8px rgba(45, 212, 191, 0.25);
    letter-spacing: -0.5px;
  }
  .orb {
    font-size: clamp(9px, 2.1vw, 20px);
    color: var(--teal, #2dd4bf);
    text-shadow:
      0 0 10px rgba(45, 212, 191, 0.7),
      0 0 26px rgba(45, 212, 191, 0.45),
      0 0 52px rgba(45, 212, 191, 0.22);
    letter-spacing: -0.5px;
  }
  .tagline {
    margin-top: 4px;
    font-size: 0.74rem;
    letter-spacing: 0.5em;
    text-transform: uppercase;
    color: rgba(167, 139, 250, 0.85);
    text-shadow: 0 0 14px rgba(167, 139, 250, 0.4);
  }
  .hint {
    font-size: 0.6rem;
    letter-spacing: 0.28em;
    text-transform: uppercase;
    color: var(--grey, #8ba8a3);
    opacity: 0.7;
    animation: blink 1.6s ease-in-out infinite;
  }
  /* compositor-only な薄いスキャンライン（1回スイープ）。 */
  .scan {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: 38%;
    background: linear-gradient(
      to bottom,
      transparent,
      rgba(45, 212, 191, 0.07),
      transparent
    );
    will-change: transform;
    transform: translateY(-120%);
    animation: scan 1.5s ease-in-out 0.15s both;
    pointer-events: none;
  }

  @keyframes splash-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  @keyframes splash-out {
    from {
      opacity: 1;
    }
    to {
      opacity: 0;
    }
  }
  @keyframes inner-in {
    from {
      opacity: 0;
      transform: translateY(10px) scale(0.985);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @keyframes scan {
    from {
      transform: translateY(-120%);
    }
    to {
      transform: translateY(360%);
    }
  }
  @keyframes blink {
    0%,
    100% {
      opacity: 0.2;
    }
    50% {
      opacity: 0.7;
    }
  }

  /* 動き軽減: トランスフォーム/スイープ/点滅を止め、フェードのみ。 */
  .splash.reduce .inner {
    animation: none;
  }
  .splash.reduce .hint {
    animation: none;
  }
</style>
