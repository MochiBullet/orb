import type { Terminal, IMarker, IDecoration, IDisposable } from "@xterm/xterm";
import { aiPane, setPaneCwd, dnd } from "../../store/appStore";
import { get } from "svelte/store";
import { invoke } from "@tauri-apps/api/core";
import { shouldNotifyForPane, notifyThrottled } from "./notify";
import { logError } from "../../core/log";
import { logBlockEvent, genId } from "../../core/blocks-log";

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
 * iTerm2 スタイルの OSC 9 通知（`OSC 9 ; <message> ST/BEL`）を解釈する純関数。
 *
 * data は識別子後の残り（"message"）。通知本文を返す。通知でないもの＝空文字や、
 * ConEmu/Windows Terminal 系の数値サブコマンド（`OSC 9 ; 4 ; …`=進捗バー、`9;1`=cwd 等）は
 * null（無視）に写す。これで PowerShell 等の進捗表示を通知と誤検知しない。
 */
export function parseOsc9(data: string): string | null {
  if (/^\d+;/.test(data)) return null; // ConEmu numeric subcommand (progress/cwd/…), not a notification
  const body = data.trim();
  return body === "" ? null : body;
}

/**
 * `OSC 777 ; notify ; <title> ; <body>`（rxvt/urxvt 系）を解釈する純関数。
 *
 * data は識別子後の残り（"notify;title;body"）。防御的にパースする：
 * - 先頭が "notify" 以外のサブコマンドは null（無視）。
 * - title 欠落は "orb" にフォールバック。body は ";" を含んでも保持（3 個目以降を再結合）。
 * - title も body も空なら情報ゼロとして null（無視）。
 */
export function parseOsc777(data: string): { title: string; body: string } | null {
  const parts = data.split(";");
  if (parts[0] !== "notify") return null;
  const rawTitle = (parts[1] ?? "").trim();
  const body = parts.slice(2).join(";").trim();
  if (rawTitle === "" && body === "") return null;
  return { title: rawTitle || "orb", body };
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
  /** #31: 現在のブロックの ID（プロンプト開始で採番、耐久ログの block_id に使う）。 */
  private currentBlockId = "";
  /** この時間(ms)以上かかったコマンドだけ完了通知の対象にする。 */
  private static NOTIFY_MS = 6000;

  constructor(
    private term: Terminal,
    private paneId: number,
  ) {
    this.disposables.push(term.parser.registerOscHandler(633, (d) => this.handle(d)));
    this.disposables.push(term.parser.registerOscHandler(133, (d) => this.handle(d)));
    // #32: TUI（Claude Code 等）が完了/確認待ちで撃つ通知エスケープを OS 通知へ転送。
    this.disposables.push(term.parser.registerOscHandler(9, (d) => this.onOsc9(d)));
    this.disposables.push(term.parser.registerOscHandler(777, (d) => this.onOsc777(d)));
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
      // D 欠落のまま次プロンプトが来た＝前ブロックを中断クローズ。現在位置を終端マーカーとして
      // 捕捉し、装飾もログも中断(-1・aborted)で確定する。end=null だと本文が1行に潰れて失われる。
      const endMarker = this.term.registerMarker(0);
      this.decorate(this.startMarker, -1, endMarker ?? null);
      this.logBlock(this.startMarker, endMarker ?? null, -1, true);
    }
    this.startMarker = this.term.registerMarker(0) ?? null;
    if (this.startMarker) this.promptMarkers.push(this.startMarker);
    this.finished = false;
    this.cmdStart = Date.now();
    this.currentBlockId = genId();
  }

  private onFinished(rest: string) {
    if (!this.startMarker) return;
    const code = parseExitCode(rest);
    const endMarker = this.term.registerMarker(0);
    this.decorate(this.startMarker, code, endMarker ?? null);
    this.logBlock(this.startMarker, endMarker ?? null, code, false);
    this.finished = true;
    this.notifyIfBackground(code);
  }

  /** #31: 確定/中断した 1 ブロックを耐久ログ（JSONL）へ追記する。
   *  xterm からテキスト・cwd・時刻・exit を取り出し、レンダラ非依存の blocks-log へ渡す。
   *  command / output_body は #33（B/C マーカー）まで null（嘘の分割を書かない）。
   *  aborted=true は「D を受け取らず次プロンプト/破棄で閉じた」＝中断（-1 の内訳を #34 が判別可能に）。
   *  ログ整形は同期実行なので、万一の例外で OSC ハンドラ（true を返す契約）を壊さないよう握り潰す。 */
  private logBlock(start: IMarker, end: IMarker | null, code: number, aborted: boolean) {
    if (!this.currentBlockId || this.cmdStart === 0) return;
    try {
      logBlockEvent({
        paneId: this.paneId,
        blockId: this.currentBlockId,
        cwd: this.cwd,
        shell: "pwsh",
        promptType: this.promptType,
        exitCode: code,
        aborted,
        startedAt: this.cmdStart,
        endedAt: Date.now(),
        text: this.blockText(start, end),
      });
    } catch (e) {
      logError(`pane ${this.paneId}: block log build failed: ${String(e)}`);
    }
  }

  /** 非フォーカスのペインで長時間コマンドが終わったら OS 通知（バイブコーディングの待ち時間用）。 */
  private notifyIfBackground(code: number) {
    const elapsed = Date.now() - this.cmdStart;
    if (this.cmdStart === 0 || elapsed < CommandBlocks.NOTIFY_MS) return;
    if (!shouldNotifyForPane(this.paneId)) return; // 前面（最前面ウィンドウ＆今見ているペイン）は通知しない
    if (get(dnd) && code === 0) return; // フォーカスモード(#20): 成功通知は出さない（失敗は昇格）
    const secs = Math.round(elapsed / 1000);
    notifyThrottled(
      code === 0 ? "orb ✓ コマンド完了" : `orb ✗ 失敗 (exit ${code})`,
      `${secs}秒 — ${this.cwd || "(orb)"}`,
    );
  }

  /** #32: iTerm2 スタイル OSC 9 通知（`OSC 9 ; <message>`）を OS 通知へ転送。 */
  private onOsc9(data: string): boolean {
    const body = parseOsc9(data);
    if (body != null && shouldNotifyForPane(this.paneId)) notifyThrottled("orb", body);
    return true;
  }

  /** #32: `OSC 777 ; notify ; <title> ; <body>` を OS 通知へ転送。 */
  private onOsc777(data: string): boolean {
    const n = parseOsc777(data);
    if (n && shouldNotifyForPane(this.paneId)) notifyThrottled(n.title, n.body);
    return true;
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
    // dispose 時の中断ログはあえて残さない：コマンド開始信号（OSC 133 C）が無い現状では
    // 「実行中コマンドを抱えたまま閉じた」と「アイドルのプロンプトで閉じただけ」を区別できず、
    // ペインを閉じるたびに末尾のアイドルブロックが aborted -1 のゴミ記録になる（#3 の幻ブロックと同質）。
    // 実行中コマンドの取りこぼし捕捉は、C マーカーで開始を検知できる #33 で gate 付きで入れる。
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
