import type { Terminal, IMarker, IDecoration, IDisposable } from "@xterm/xterm";
import { aiPane, setPaneCwd, dnd, setPaneStatus } from "../../store/appStore";
import { get } from "svelte/store";
import { invoke } from "@tauri-apps/api/core";
import { shouldNotifyForPane, notifyThrottled } from "./notify";
import { logError } from "../../core/log";
import { logBlockEvent, genId, capText } from "../../core/blocks-log";
import { statusForClose } from "../../core/agent-status";
import { formatBlockForAi, formatFixRequest, frameBracketedPaste } from "../../core/ai-payload";

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

/** command として受け付ける上限。巨大ワンライナー貼り付けで JSONL/DOM を肥大させない。 */
export const COMMAND_MAX = 4096;

/**
 * #33: `E;<nonce>;<escaped-cmdline>` の rest（"nonce;cmd"）からコマンドラインを取り出す純関数。
 *
 * nonce は orb が spawn 時に子シェルへ渡した値（ORB_NONCE）。一致しない E は
 * 「コマンド出力に紛れた偽マーカー」や「ConPTY のエコー破片」なので黙って捨てる。
 * expectedNonce が空（未配線）の場合も一切受け付けない＝安全側。
 * コマンド部は shell 側 __orb_escape の \xNN を decodeOsc で復元する。
 *
 * さらに \n(0x0a)・タブ(0x09) 以外の制御文字を含む場合は丸ごと拒否する：
 * 正規の PSReadLine 行には現れず（\r は Enter＝再実行が即実行に化ける、\x03/\x04/\x1b も
 * 端末制御を撃てる）、偽造/破損とみなすのが安全かつログとして正直。上限超過も拒否。
 */
export function parseCommandLine(rest: string, expectedNonce: string): string | null {
  if (!expectedNonce) return null;
  const sep = rest.indexOf(";");
  if (sep === -1) return null;
  if (rest.slice(0, sep) !== expectedNonce) return null;
  const cmd = decodeOsc(rest.slice(sep + 1));
  if (cmd.length === 0 || cmd.length > COMMAND_MAX) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(cmd)) return null;
  return cmd;
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
  /** #33: 現在のブロックのコマンドライン（E マーカー・nonce 検証済）。E 不在なら null。 */
  private pendingCommand: string | null = null;
  /** #33: 出力開始位置（C マーカー）。コマンド行と出力本文の境界。 */
  private outputStart: IMarker | null = null;
  /** この時間(ms)以上かかったコマンドだけ完了通知の対象にする。 */
  private static NOTIFY_MS = 6000;

  constructor(
    private term: Terminal,
    private paneId: number,
    /** #33: OSC 633;E の偽造防止 nonce（spawn 時に子シェルへ渡した値と同一）。 */
    private nonce: string = "",
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
      case "C":
        // #33: 出力開始。E と同じく nonce で認証する（出力に紛れた偽 C が output_body の
        // 境界を動かすのを防ぐ）。開いているブロックにだけ意味がある（迷子の C は無視）。
        if (!this.finished && this.nonce && rest === this.nonce) {
          this.outputStart = this.term.registerMarker(0) ?? null;
          setPaneStatus(this.paneId, "running"); // #50: コマンド実行開始＝🟢
        }
        break;
      case "D":
        this.onFinished(rest);
        break;
      case "E":
        this.onCommandLine(rest);
        break;
      case "P":
        this.onProperty(rest);
        break;
    }
    return true;
  }

  /** #33: `E;<nonce>;<escaped-cmd>` を検証してコマンドラインを確定する。 */
  private onCommandLine(rest: string) {
    const cmd = parseCommandLine(rest, this.nonce);
    if (cmd != null) this.pendingCommand = cmd;
  }

  private onPromptStart() {
    if (this.startMarker && !this.finished) {
      // D 欠落のまま次プロンプトが来た＝前ブロックを中断クローズ。現在位置を終端マーカーとして
      // 捕捉し、装飾もログも中断(-1・aborted)で確定する。end=null だと本文が1行に潰れて失われる。
      const endMarker = this.term.registerMarker(0);
      this.decorate(this.startMarker, -1, endMarker ?? null, this.pendingCommand, this.extractOutputBody(endMarker ?? null));
      this.logBlock(this.startMarker, endMarker ?? null, -1, true);
      this.updateStatusOnClose(-1);
    }
    this.startMarker = this.term.registerMarker(0) ?? null;
    if (this.startMarker) this.promptMarkers.push(this.startMarker);
    this.finished = false;
    this.cmdStart = Date.now();
    this.currentBlockId = genId();
    // #33: 新しいブロックの開始＝前ブロックのコマンド/出力境界を破棄。
    this.pendingCommand = null;
    this.outputStart = null;
  }

  private onFinished(rest: string) {
    if (!this.startMarker) return;
    const code = parseExitCode(rest);
    const endMarker = this.term.registerMarker(0);
    this.decorate(this.startMarker, code, endMarker ?? null, this.pendingCommand, this.extractOutputBody(endMarker ?? null));
    this.logBlock(this.startMarker, endMarker ?? null, code, false);
    this.finished = true;
    this.notifyIfBackground(code);
    this.updateStatusOnClose(code);
  }

  /** #50: コマンド確定時のバッジ更新。#32/#20 と同じ「見ていない時だけ」ゲートと
   *  #20 と同じ長時間しきい値を共有する（通知とバッジがズレない）。null は running 解除。 */
  private updateStatusOnClose(code: number) {
    const watching = !shouldNotifyForPane(this.paneId);
    const longRun = this.cmdStart > 0 && Date.now() - this.cmdStart >= CommandBlocks.NOTIFY_MS;
    setPaneStatus(this.paneId, statusForClose(code, watching, longRun));
  }

  /** #50: いまコマンド実行中か（E/C 受信済み・D 未受信）。AI ペインのアイドル判定のゲート。
   *  プロンプトで静止しているだけの状態（A 直後）は false。 */
  isCommandRunning(): boolean {
    return !this.finished && (this.outputStart != null || this.pendingCommand != null);
  }

  /** #34: 装飾ツールバー（→AI/🔧fix）が使う出力本文を確定時点で cap して取り出す。
   *  クリック時に this.outputStart を読むと「その時の（＝別ブロックの）」境界を読んで
   *  しまうため、ブロック確定のこの瞬間に値としてクロージャへ渡す。 */
  private extractOutputBody(end: IMarker | null): string | null {
    if (!this.outputStart || this.outputStart.line < 0) return null;
    return capText(this.blockText(this.outputStart, end)).text;
  }

  /** #31: 確定/中断した 1 ブロックを耐久ログ（JSONL）へ追記する。
   *  xterm からテキスト・cwd・時刻・exit を取り出し、レンダラ非依存の blocks-log へ渡す。
   *  command / output_body は #33 の E/C マーカー（nonce 検証済）由来。マーカー不在は null。
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
        // #33: E/C マーカー由来の確定分離。マーカー不在なら null（嘘の分割を書かない）。
        command: this.pendingCommand,
        outputBody:
          this.outputStart && this.outputStart.line >= 0
            ? this.blockText(this.outputStart, end)
            : null,
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

  /** AI ペインの入力欄へペイロードを届ける共通経路（#34）。
   *  bracketed paste で包む＝複数行でも「1回の貼り付け」として入り、素の \n が
   *  Enter（細切れ送信）にならない。送信は人が Enter を押す。 */
  private sendToAiPane(payload: string, label: string) {
    const target = get(aiPane);
    if (target == null || target === this.paneId) return;
    void invoke("write_pty", {
      paneId: target,
      data: Array.from(this.encoder.encode(frameBracketedPaste(payload))),
    }).catch((e) => logError(`pane ${target}: ${label} write failed: ${String(e)}`));
  }

  /** ブロックを構造化コンテキスト（cwd/exit/$command/output）として AI ペインへ（#34）。
   *  E/C マーカー不在時は生テキストへフォールバック。 */
  private sendBlockToAi(
    start: IMarker,
    end: IMarker | null,
    code: number,
    command: string | null,
    outputBody: string | null,
  ) {
    const text = capText(this.blockText(start, end)).text;
    if (!text && command == null) return;
    this.sendToAiPane(
      formatBlockForAi({ cwd: this.cwd, exitCode: code, command, outputBody, text }),
      "send-block-to-AI",
    );
  }

  /** 失敗ブロック（exit≠0）を「これ直して」依頼として AI ペインへ送る（VIBE_IDEAS #2 の構造化版）。 */
  private fixWithAi(
    start: IMarker,
    end: IMarker | null,
    code: number,
    command: string | null,
    outputBody: string | null,
  ) {
    const text = capText(this.blockText(start, end)).text;
    if (!text && command == null) return;
    this.sendToAiPane(
      formatFixRequest({ cwd: this.cwd, exitCode: code, command, outputBody, text }),
      "fix-with-AI",
    );
  }

  /** #33: 確定済みコマンドラインをこのペインのプロンプトへ再入力する（Enter は送らない＝実行は人が確認）。
   *  bracketed paste で包む＝改行入りでも PSReadLine が「貼り付け」として文字通り挿入し、実行されない。 */
  private rerun(command: string) {
    void invoke("write_pty", {
      paneId: this.paneId,
      data: Array.from(this.encoder.encode(frameBracketedPaste(command))),
    }).catch((e) => logError(`pane ${this.paneId}: rerun write failed: ${String(e)}`));
  }

  private decorate(
    marker: IMarker,
    code: number,
    endMarker: IMarker | null,
    command: string | null,
    outputBody: string | null,
  ) {
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
      aiBtn.title = "ブロックを構造化コンテキストとして AI ペインへ送る";
      aiBtn.onpointerdown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.sendBlockToAi(marker, endMarker, code, command, outputBody);
      };
      tools.appendChild(copyBtn);
      tools.appendChild(aiBtn);
      // #33: コマンドラインを確定できたブロックだけ「↻」（プロンプトへ再入力・Enterは人が押す）。
      if (command) {
        const rerunBtn = document.createElement("button");
        rerunBtn.textContent = "↻";
        rerunBtn.title = "コマンドをプロンプトに再入力（実行は Enter で）";
        rerunBtn.onpointerdown = (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.rerun(command);
        };
        tools.appendChild(rerunBtn);
      }
      // 失敗ブロックだけ「🔧 fix」（VIBE_IDEAS #2）。中断(⊘ code<0)・成功には出さない。
      if (!ok && code > 0) {
        const fixBtn = document.createElement("button");
        fixBtn.textContent = "🔧 fix";
        fixBtn.title = "失敗の原因と修正を AI ペインに頼む";
        fixBtn.onpointerdown = (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.fixWithAi(marker, endMarker, code, command, outputBody);
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
