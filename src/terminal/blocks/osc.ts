import type { Terminal, IMarker, IDecoration, IDisposable } from "@xterm/xterm";
import { cwd as cwdStore } from "../../store/appStore";

/**
 * OSC 133/633 マーカーを解釈して Warp 風のコマンドブロック装飾を出すコントローラ。
 *
 * - 単一 xterm グリッドは維持し、ブロック境界は decoration（DOM オーバーレイ）で乗せる
 *   ＝ TUI / IME / WebGL の堅牢さを保ったまま体験だけ再現する。
 * - 代替画面（vim/lazygit/fzf 等）中は処理を完全停止（偽ブロック防止）。
 * - D（終了コード）欠落（Ctrl-C 等）は次の A で中断クローズする。
 */
export class CommandBlocks {
  private disposables: IDisposable[] = [];
  private decorations: IDecoration[] = [];
  private startMarker: IMarker | null = null;
  private promptMarkers: IMarker[] = [];
  private finished = true;
  cwd = "";
  promptType = "";

  constructor(private term: Terminal) {
    this.disposables.push(term.parser.registerOscHandler(633, (d) => this.handle(d)));
    this.disposables.push(term.parser.registerOscHandler(133, (d) => this.handle(d)));
  }

  private handle(data: string): boolean {
    // 代替画面（vim 等）中はブロック処理しない。OSC は握りつぶす（表示しない）。
    if (this.term.buffer.active.type === "alternate") return true;

    const sep = data.indexOf(";");
    const marker = sep === -1 ? data : data.slice(0, sep);
    const rest = sep === -1 ? "" : data.slice(sep + 1);

    switch (marker) {
      case "A":
        this.onPromptStart();
        break;
      case "D":
        this.onFinished(rest);
        break;
      case "P":
        this.onProperty(rest);
        break;
      // B / C / E は P1 の装飾には未使用（状態は A/D で足りる）。
    }
    return true; // handled — 制御シーケンスなので端末には表示しない。
  }

  private onPromptStart() {
    // 直前ブロックが D 無しで終わった（Ctrl-C 等）→ 中断としてクローズ。
    if (this.startMarker && !this.finished) {
      this.decorate(this.startMarker, -1);
    }
    this.startMarker = this.term.registerMarker(0) ?? null;
    if (this.startMarker) this.promptMarkers.push(this.startMarker);
    this.finished = false;
  }

  private onFinished(rest: string) {
    if (!this.startMarker) return;
    const code = rest === "" ? 0 : parseInt(rest.split(";")[0], 10) || 0;
    this.decorate(this.startMarker, code);
    this.finished = true;
  }

  private onProperty(rest: string) {
    const eq = rest.indexOf("=");
    if (eq === -1) return;
    const key = rest.slice(0, eq);
    const value = decodeOsc(rest.slice(eq + 1));
    if (key === "Cwd") {
      this.cwd = value;
      cwdStore.set(value);
    } else if (key === "PromptType") this.promptType = value;
  }

  private decorate(marker: IMarker, code: number) {
    const ok = code === 0;
    const dec = this.term.registerDecoration({
      marker,
      width: this.term.cols,
      overviewRulerOptions: { color: ok ? "#2dd4bf" : "#ff5c8a", position: "left" },
    });
    if (!dec) return;
    this.decorations.push(dec);
    dec.onRender((el) => {
      el.classList.add("orb-block");
      el.classList.toggle("ok", ok);
      el.classList.toggle("fail", !ok);
      if (el.dataset.orbReady) return;
      el.dataset.orbReady = "1";
      const badge = document.createElement("span");
      badge.className = "orb-block-badge";
      badge.textContent = ok ? "✓" : code < 0 ? "⊘" : `✗ ${code}`;
      el.appendChild(badge);
    });
  }

  /** 直前/直後のプロンプト行へスクロール（Ctrl+↑ / Ctrl+↓）。 */
  jumpPrev() {
    const y = this.term.buffer.active.viewportY;
    const lines = this.promptMarkers.map((m) => m.line).filter((l) => l >= 0).sort((a, b) => a - b);
    const target = [...lines].reverse().find((l) => l < y);
    if (target != null) this.term.scrollToLine(target);
  }

  jumpNext() {
    const y = this.term.buffer.active.viewportY;
    const lines = this.promptMarkers.map((m) => m.line).filter((l) => l >= 0).sort((a, b) => a - b);
    const target = lines.find((l) => l > y);
    if (target != null) this.term.scrollToLine(target);
  }

  dispose() {
    for (const d of this.decorations) d.dispose();
    for (const d of this.disposables) d.dispose();
    this.decorations = [];
    this.disposables = [];
    this.promptMarkers = [];
    this.startMarker = null;
  }
}

/** PowerShell 側 __orb_escape の逆変換（\xNN → 文字）。 */
function decodeOsc(s: string): string {
  return s.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
