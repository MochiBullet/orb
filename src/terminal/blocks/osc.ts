import type { Terminal, IMarker, IDecoration, IDisposable } from "@xterm/xterm";
import { aiPane, setPaneCwd, dnd, setPaneStatus } from "../../store/appStore";
import { get } from "svelte/store";
import { invoke } from "@tauri-apps/api/core";
import { shouldNotifyForPane, notifyThrottled } from "./notify";
import { logError } from "../../core/log";
import { logBlockEvent, genId, capText, searchSameCommand } from "../../core/blocks-log";
import { statusForClose } from "../../core/agent-status";
import { formatBlockForAi, formatFixRequest, formatPastFailureContext, frameBracketedPaste } from "../../core/ai-payload";
import { findMostRecentPastFailure } from "../../core/past-failures";

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

/** alt-screen 突入/離脱を表す DECSET/DECRST（CSI `?Pm h`/`?Pm l`）の対象コード。 */
const ALT_SCREEN_MODES = new Set([47, 1047, 1049]);

/**
 * CSI `?Pm h` / `?Pm l` の params に alt-screen 系コード（47/1047/1049）が含まれるかを見る純関数。
 *
 * xterm の `buffer.active.type`（および `onBufferChange`）は「実際にバッファが遷移した瞬間」
 * だけ発火するキャッシュ済み内部状態で、TUI が `\e[?1049l` を出さず異常終了すると xterm 内部で
 * alternate に貼り付いたまま二度と遷移イベントを出さなくなる（xterm.js の確認済みの挙動：
 * activateAltBuffer/activateNormalBuffer は「すでにその状態」なら早期 return して素通りする）。
 * これに頼ると、1個目の TUI が異常終了した後は 2個目の TUI が実際に `\e[?1049h` を出しても
 * xterm 内部的には「もう alternate」なので無反応＝以後ずっと検知できなくなる。
 * そこで xterm のキャッシュ状態を経由せず、CSI シーケンスの到着そのもの（本関数の入力）を
 * 都度見る。シェル/TUI 側は毎回このシーケンスを律儀に出すので、xterm 内部がどう記憶しているかに
 * 依存しない。
 */
export function isAltScreenModeParams(params: (number | number[])[]): boolean {
  return params.some((p) => typeof p === "number" && ALT_SCREEN_MODES.has(p));
}

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
 * #56: 1 ブロック分の装飾と、resize 時に同じ装飾を作り直すためのパラメータ一式。
 * xterm の IDecoration は width を後から変えられない（setter 無し）ため、cols が変わったら
 * dispose→同じ marker で再登録する。その再登録に必要な decorate 呼び出し時の値を保持する。
 */
interface BlockDeco {
  marker: IMarker;
  endMarker: IMarker | null;
  code: number;
  command: string | null;
  outputBody: string | null;
  /** decorate() 時点の currentBlockId。過去ログ検索で「自分自身」を除外するために持つ
   *  （this.currentBlockId は次ブロック開始で先へ進むため、都度クロージャへ固定する）。 */
  blockId: string;
  /** 登録時の term.cols。現在の cols と違えば作り直しが要る（planResize の stale 判定）。 */
  width: number;
  dec: IDecoration | undefined;
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
  /** #56: ブロック装飾レジストリ（resize 時の作り直しに必要なパラメータ込み）。 */
  private blockDecos: BlockDeco[] = [];
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
  /** alt-screen（vim 等）判定の自前の写し。term.buffer.active.type の直読みや onBufferChange
   *  （xterm 内部のキャッシュ済みバッファ状態）には依存せず、CSI ?1049/47/1047 h/l という
   *  生シーケンスの到着そのものを自前で追う（isAltScreenModeParams のドキュメント参照）。 */
  private altScreen = false;

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
    // alt-screen 突入/離脱を、xterm のバッファ切替イベントではなく CSI ?1049/47/1047 h/l の
    // 生シーケンス到着そのもので検知する（altScreen ドキュメント参照）。xterm 内部の
    // InputHandler も同じシグネチャで DECSET/DECRST を処理しており、false を返す限りその本来の
    // 処理（実際のバッファ切替）は素通しになる＝ここでは観測に徹する。
    this.disposables.push(
      term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
        if (isAltScreenModeParams(params)) this.altScreen = true;
        return false;
      }),
    );
    this.disposables.push(
      term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
        if (isAltScreenModeParams(params)) {
          this.altScreen = false;
          this.onResize(); // #56: alt 中に分割/リサイズされていた場合の幅ズレをここで作り直す
        }
        return false;
      }),
    );
  }

  /**
   * #56: 分割/ウィンドウリサイズ/ズームで cols が変わった後、既存ブロック装飾を現在幅で
   * 作り直す（Terminal.svelte の fit 確定点から呼ばれる）。dispose 済み marker はレジストリ
   * から掃除する。幅が合っているエントリには触れない＝cols 不変の resize は比較だけの no-op。
   * alt-screen 中は何もしない（handle() と同じガード。復帰は CSI ?1049/47/1047 l の検知で拾う）。
   */
  onResize() {
    if (this.altScreen) return;
    const { keep, drop, stale } = planResize(this.blockDecos, this.term.cols);
    for (const e of drop) e.dec?.dispose();
    this.blockDecos = keep;
    for (const e of stale) {
      // 旧 decoration を dispose してから同じ marker で再登録＝DOM 要素は新規に作られるので
      // onRender の orbReady ガードと合わせてツールバー二重表示・リスナー多重登録は起きない。
      e.dec?.dispose();
      e.dec = this.registerBlockDecoration(e);
    }
  }

  private handle(data: string): boolean {
    const sep = data.indexOf(";");
    const marker = sep === -1 ? data : data.slice(0, sep);
    const rest = sep === -1 ? "" : data.slice(sep + 1);
    // altScreen は CSI ?1049/47/1047 h/l の生シーケンス検知で追っており、TUI が \e[?1049l を
    // 出さず異常終了しても次の TUI の \e[?1049h を独立に拾えるため、xterm 側のキャッシュ済み
    // バッファ状態のように貼り付いたままにはならない（isAltScreenModeParams ドキュメント参照）。
    // よって特定マーカーだけ通す自己復旧は不要＝alt 中は全マーカーを一律に握り潰す
    // （偽ブロック防止を徹底する。復帰自体は上の CSI ?l ハンドラが検知する）。
    if (this.altScreen) return true;
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
      this.paneId,
      code === 0 ? "orb ✓ コマンド完了" : `orb ✗ 失敗 (exit ${code})`,
      `${secs}秒 — ${this.cwd || "(orb)"}`,
    );
  }

  /** #32: iTerm2 スタイル OSC 9 通知（`OSC 9 ; <message>`）を OS 通知へ転送。 */
  private onOsc9(data: string): boolean {
    const body = parseOsc9(data);
    if (body != null && shouldNotifyForPane(this.paneId)) notifyThrottled(this.paneId, "orb", body);
    return true;
  }

  /** #32: `OSC 777 ; notify ; <title> ; <body>` を OS 通知へ転送。 */
  private onOsc777(data: string): boolean {
    const n = parseOsc777(data);
    if (n && shouldNotifyForPane(this.paneId)) notifyThrottled(this.paneId, n.title, n.body);
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

  /** Fable5 ロードマップ #3（過去ログの複利）: 「このエラー、前にも見た？」。
   *  #49 の横断検索で同cwd・同コマンドの過去ヒットを引き、直近の過去の失敗＋その後の解決
   *  （あれば）を構造化して AI ペインへ渡す。command が無いブロックは検索しようがないため
   *  ボタン自体を出さない（呼び出し元でガード済み）。 */
  private async checkPastFailure(
    start: IMarker,
    end: IMarker | null,
    code: number,
    command: string,
    outputBody: string | null,
    blockId: string,
  ) {
    const text = capText(this.blockText(start, end)).text;
    const result = await searchSameCommand(this.cwd, command);
    const match = findMostRecentPastFailure(result.hits, blockId);
    this.sendToAiPane(
      formatPastFailureContext({ cwd: this.cwd, exitCode: code, command, outputBody, text }, match),
      "past-failure-check",
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
    // #56: 再生成に必要なパラメータごとレジストリへ。装飾の実登録は共通経路に委ねる。
    const entry: BlockDeco = {
      marker,
      endMarker,
      code,
      command,
      outputBody,
      blockId: this.currentBlockId ?? "",
      width: 0,
      dec: undefined,
    };
    entry.dec = this.registerBlockDecoration(entry);
    if (!entry.dec) return;
    this.blockDecos.push(entry);
  }

  /** entry のパラメータで decoration を現在の term.cols 幅で登録し、装飾 DOM を構築する
   *  （初回作成と #56 の resize 再生成の共通経路）。entry.width は登録幅で更新する。
   *  marker が dispose 済みなら xterm が undefined を返す（呼び元/次の掃除で捨てられる）。 */
  private registerBlockDecoration(entry: BlockDeco): IDecoration | undefined {
    const { marker, endMarker, code, command, outputBody, blockId } = entry;
    const ok = code === 0;
    entry.width = this.term.cols;
    const dec = this.term.registerDecoration({
      marker,
      width: this.term.cols,
      overviewRulerOptions: { color: ok ? "#2dd4bf" : "#ff5c8a", position: "left" },
    });
    if (!dec) return undefined;
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
        // 過去ログの複利（Fable5 ロードマップ #3）。command が確定していないと同一コマンドの
        // 検索しようがないため、fix と違い command 必須（テキストへのフォールバックはしない）。
        if (command) {
          const pastBtn = document.createElement("button");
          pastBtn.textContent = "🕐 前例";
          pastBtn.title = "同じコマンドの過去の失敗・解決履歴を AI ペインに渡す";
          pastBtn.onpointerdown = (e) => {
            e.preventDefault();
            e.stopPropagation();
            void this.checkPastFailure(marker, endMarker, code, command, outputBody, blockId);
          };
          tools.appendChild(pastBtn);
        }
      }
      el.appendChild(tools);
    });
    return dec;
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
    for (const d of this.blockDecos) d.dec?.dispose();
    for (const d of this.disposables) d.dispose();
    this.blockDecos = [];
    this.disposables = [];
    this.promptMarkers = [];
    this.startMarker = null;
  }
}

/**
 * #56: resize 時のブロック装飾レジストリ整理（純関数）。
 *
 * - dispose 済み / スクロールバックから溢れた（line<0）marker のエントリは drop（掃除対象）。
 * - 生存エントリのうち登録時幅 width が現在の cols と違うものだけ stale（作り直し対象）。
 *
 * 幅は「最後の resize 時の cols」ではなくエントリごとに持つ＝alt-screen 中のスキップ等で
 * 一部のエントリだけ古い幅のまま残っても、次の呼び出しで必ず作り直し対象になる（自己修復）。
 * cols 不変の resize（行数だけ変化）では stale が空＝数値比較 O(n) だけで済む。
 */
export function planResize<E extends { marker: { line: number; isDisposed: boolean }; width: number }>(
  entries: E[],
  cols: number,
): { keep: E[]; drop: E[]; stale: E[] } {
  const keep: E[] = [];
  const drop: E[] = [];
  const stale: E[] = [];
  for (const e of entries) {
    if (e.marker.isDisposed || e.marker.line < 0) {
      drop.push(e);
      continue;
    }
    keep.push(e);
    if (e.width !== cols) stale.push(e);
  }
  return { keep, drop, stale };
}

/** PowerShell 側 __orb_escape の逆変換（\xNN → 文字）。 */
function decodeOsc(s: string): string {
  return s.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
