import type { Terminal, IMarker, IDecoration, IDisposable } from "@xterm/xterm";
import { aiPane, setPaneCwd, focusedPane, dnd } from "../../store/appStore";
import { get } from "svelte/store";
import { invoke } from "@tauri-apps/api/core";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { logError } from "../../core/log";

/**
 * OSC 133/633 の D マーカー payload（rest）から終了コードを解釈する純関数。
 *
 * - 空文字（D 欠落・Ctrl-C 等）や壊れた payload は -1（不明/中断＝⊘）に写す。
 * - 実際の成功（exit 0）は必ず 0 のまま保つ。`|| -1` / `|| 0` は 0 を falsy として
 *   潰すため使わない（#41: 偽の成功／偽の失敗どちらも防ぐ）。Number.isNaN で判定する。
 */
export function parseExitCode(rest: string): number {
  if (rest === "") return -1;
  const n = parseInt(rest.split(";")[0], 10);
  return Number.isNaN(n) ? -1 : n;
}

/**
 * OSC 133/633 マーカーを解釈して Warp 風のコマンドブロック装飾を出すコントローラ。
 *
 * - 単一 xterm グリッドは維持し、ブロック境界は decoration（DOM オーバーレイ）で乗せる。
 * - 代替画面（vim/lazygit/fzf 等）中は処理を完全停止（偽ブロック防止）。
 * - D（終了コード）欠落（Ctrl-C 等）は次の A で中断クローズする。
 * - 各ブロックに hover ツールバー（コピー / AI へ送る）。
 */
export class CommandBlocks {
  private disposables: IDisposable[] = [];
  private decorations: IDecoration[] = [];
  private startMarker: IMarker | null = null;
  private promptMarkers: IMarker[] = [];
  private finished = true;
  private encoder = new TextEncoder();
  cwd = "";
  promptType = "";
  private cmdStart = 0;
  /** この時間(ms)以上かかったコマンドだけ完了通知の対象にする。 */
  private static NOTIFY_MS = 6000;

  constructor(
    private term: Terminal,
    private paneId: number,
  ) {
    this.disposables.push(term.parser.registerOscHandler(633, (d) => this.handle(d)));
    this.disposables.push(term.parser.registerOscHandler(133, (d) => this.handle(d)));
  }

  private handle(data: string): boolean {
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
    }
    return true;
  }

  private onPromptStart() {
    if (this.startMarker && !this.finished) {
      this.decorate(this.startMarker, -1, null);
    }
    this.startMarker = this.term.registerMarker(0) ?? null;
    if (this.startMarker) this.promptMarkers.push(this.startMarker);
    this.finished = false;
    this.cmdStart = Date.now();
  }

  private onFinished(rest: string) {
    if (!this.startMarker) return;
    const code = parseExitCode(rest);
    const endMarker = this.term.registerMarker(0);
    this.decorate(this.startMarker, code, endMarker ?? null);
    this.finished = true;
    this.notifyIfBackground(code);
  }

  /** 非フォーカスのペインで長時間コマンドが終わったら OS 通知（バイブコーディングの待ち時間用）。 */
  private notifyIfBackground(code: number) {
    const elapsed = Date.now() - this.cmdStart;
    if (this.cmdStart === 0 || elapsed < CommandBlocks.NOTIFY_MS) return;
    if (get(focusedPane) === this.paneId) return; // 今見ているペインは通知しない
    if (get(dnd) && code === 0) return; // フォーカスモード(#20): 成功通知は出さない（失敗は昇格）
    const secs = Math.round(elapsed / 1000);
    void sendNotification({
      title: code === 0 ? "orb ✓ コマンド完了" : `orb ✗ 失敗 (exit ${code})`,
      body: `${secs}秒 — ${this.cwd || "(orb)"}`,
    });
  }

  private onProperty(rest: string) {
    const eq = rest.indexOf("=");
    if (eq === -1) return;
    const key = rest.slice(0, eq);
    const value = decodeOsc(rest.slice(eq + 1));
    if (key === "Cwd") {
      this.cwd = value;
      setPaneCwd(this.paneId, value);
    } else if (key === "PromptType") this.promptType = value;
  }

  /** start〜end 行のブロックテキストを取り出す。 */
  private blockText(start: IMarker, end: IMarker | null): string {
    const buf = this.term.buffer.active;
    const s = start.line;
    const e = end && end.line >= 0 ? end.line : s;
    if (s < 0) return "";
    const out: string[] = [];
    for (let i = s; i <= e; i++) {
      const line = buf.getLine(i);
      if (line) out.push(line.translateToString(true));
    }
    return out.join("\n").replace(/\n+$/, "");
  }

  private copyBlock(start: IMarker, end: IMarker | null) {
    const t = this.blockText(start, end);
    if (t) void navigator.clipboard.writeText(t);
  }

  private sendBlockToAi(start: IMarker, end: IMarker | null) {
    const target = get(aiPane);
    if (target == null || target === this.paneId) return;
    const t = this.blockText(start, end);
    if (t)
      void invoke("write_pty", { paneId: target, data: Array.from(this.encoder.encode(t)) }).catch(
        (e) => logError(`pane ${target}: send-block-to-AI write failed: ${String(e)}`),
      );
  }

  /** 失敗ブロック（exit≠0）を「これ直して」依頼として AI ペインへ送る（VIBE_IDEAS #2）。
   *  コマンド＋出力＋exit＋cwd を枠付きで現役エージェントの stdin へ。自動送信はせず確認は人に委ねる。 */
  private fixWithAi(start: IMarker, end: IMarker | null, code: number) {
    const target = get(aiPane);
    if (target == null || target === this.paneId) return;
    const block = this.blockText(start, end);
    if (!block) return;
    const ctx = this.cwd ? ` (cwd: ${this.cwd})` : "";
    const msg = `次のコマンドが exit ${code} で失敗しました${ctx}。原因を説明して、修正案（必要なら修正後のコマンド）を出して:\n\n${block}\n`;
    void invoke("write_pty", { paneId: target, data: Array.from(this.encoder.encode(msg)) }).catch(
      (e) => logError(`pane ${target}: fix-with-AI write failed: ${String(e)}`),
    );
  }

  private decorate(marker: IMarker, code: number, endMarker: IMarker | null) {
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

      const tools = document.createElement("span");
      tools.className = "orb-block-tools";
      const copyBtn = document.createElement("button");
      copyBtn.textContent = "copy";
      copyBtn.title = "ブロックをコピー";
      copyBtn.onpointerdown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.copyBlock(marker, endMarker);
      };
      const aiBtn = document.createElement("button");
      aiBtn.textContent = "→AI";
      aiBtn.title = "ブロックを AI ペインへ送る";
      aiBtn.onpointerdown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.sendBlockToAi(marker, endMarker);
      };
      tools.appendChild(copyBtn);
      tools.appendChild(aiBtn);
      // 失敗ブロックだけ「🔧 fix」（VIBE_IDEAS #2）。中断(⊘ code<0)・成功には出さない。
      if (!ok && code > 0) {
        const fixBtn = document.createElement("button");
        fixBtn.textContent = "🔧 fix";
        fixBtn.title = "失敗の原因と修正を AI ペインに頼む";
        fixBtn.onpointerdown = (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.fixWithAi(marker, endMarker, code);
        };
        tools.appendChild(fixBtn);
      }
      el.appendChild(tools);
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
