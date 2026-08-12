import type { Terminal, IMarker, IDecoration, IDisposable } from "@xterm/xterm";
import { aiPane, setPaneCwd, dnd, setPaneStatus, clearLaunchedAgent, setPaneLastCommand } from "../../store/appStore";
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

/** OSC 9/777 通知本文（title/body 共通）の上限文字数。E の COMMAND_MAX とは別物：
 *  通知は表示前提でずっと短くて十分なうえ、巨大 payload が OS 通知や DOM をそのまま
 *  肥大させるのを orb 側で止める（#73 SEC-7）。 */
export const NOTIFY_MAX = 200;

/** 上限（NOTIFY_MAX）超過時は末尾を "…" で切り詰める純関数（#73 SEC-7）。 */
export function capNotifyText(s: string): string {
  return s.length > NOTIFY_MAX ? s.slice(0, NOTIFY_MAX) + "…" : s;
}

/**
 * iTerm2 スタイルの OSC 9 通知（`OSC 9 ; <message> ST/BEL`）を解釈する純関数。
 *
 * data は識別子後の残り（"message"）。通知本文を返す。通知でないもの＝空文字や、
 * ConEmu/Windows Terminal 系の数値サブコマンド（`OSC 9 ; 4 ; …`=進捗バー、`9;1`=cwd 等）は
 * null（無視）に写す。これで PowerShell 等の進捗表示を通知と誤検知しない。
 * 巨大 payload は NOTIFY_MAX で切り詰める（#73 SEC-7）。
 */
export function parseOsc9(data: string): string | null {
  if (/^\d+;/.test(data)) return null; // ConEmu numeric subcommand (progress/cwd/…), not a notification
  const body = data.trim();
  return body === "" ? null : capNotifyText(body);
}

/**
 * `OSC 777 ; notify ; <title> ; <body>`（rxvt/urxvt 系）を解釈する純関数。
 *
 * data は識別子後の残り（"notify;title;body"）。防御的にパースする：
 * - 先頭が "notify" 以外のサブコマンドは null（無視）。
 * - title 欠落は "orb" にフォールバック。body は ";" を含んでも保持（3 個目以降を再結合）。
 * - title も body も空なら情報ゼロとして null（無視）。
 * - title/body とも NOTIFY_MAX で切り詰める（#73 SEC-7）。
 *
 * 注意: ここで返す title は攻撃者（プログラムの出力）が完全に制御できる生値。
 * 実際に OS 通知へ渡す際は buildOsc777Notification が固定ラベルへ差し替える（#73 SEC-4）。
 */
export function parseOsc777(data: string): { title: string; body: string } | null {
  const parts = data.split(";");
  if (parts[0] !== "notify") return null;
  const rawTitle = (parts[1] ?? "").trim();
  const body = parts.slice(2).join(";").trim();
  if (rawTitle === "" && body === "") return null;
  return { title: capNotifyText(rawTitle || "orb"), body: capNotifyText(body) };
}

/** OSC 9/777 転送通知に強制する固定タイトル。OSC 777 の title はプログラムの出力＝攻撃者が
 *  完全に制御できるため（"Microsoft Account" 等になりすまして偽の緊急感を出せる）、ここで
 *  受け取った値は一切表示に使わず常にこのラベルにする。「端末出力からの転送であって orb 自身の
 *  メッセージではない」を一目で分かるようにする（#73 SEC-4）。 */
export const TERMINAL_NOTIFY_TITLE = "orb · 端末";

/** OSC 9 の通知内容を組み立てる純関数。title は常に固定（#73 SEC-4）。 */
export function buildOsc9Notification(data: string): { title: string; body: string } | null {
  const body = parseOsc9(data);
  return body == null ? null : { title: TERMINAL_NOTIFY_TITLE, body };
}

/** OSC 777 の通知内容を組み立てる純関数。攻撃者制御の title（parseOsc777 の戻り値）は
 *  使わず、固定ラベルにすり替える（#73 SEC-4）。 */
export function buildOsc777Notification(data: string): { title: string; body: string } | null {
  const n = parseOsc777(data);
  return n == null ? null : { title: TERMINAL_NOTIFY_TITLE, body: n.body };
}

/** command として受け付ける上限。巨大ワンライナー貼り付けで JSONL/DOM を肥大させない。 */
export const COMMAND_MAX = 4096;

/**
 * #Theme-D1: ブロックの所要時間の起点(ms)を選ぶ純関数。
 *
 * 出力開始(OSC C マーカー)の時刻があればそれを、無ければプロンプト開始(A マーカー)の時刻へ
 * フォールバックする。A→C の間（プロンプトを表示したまま人が放置していた時間）を所要時間に
 * 混ぜないため：A 起点のままだと「10分アイドル→一瞬で終わるコマンド」が ~600 秒と誤計測され、
 * 偽の「600秒 完了」通知・偽の ✅ バッジ・JSONL の巨大 duration_ms を生む。C 不在（コマンド無しの
 * 素プロンプト等）は A 起点のまま＝従来挙動。0 は「未開始」を意味するので選択対象にしない。
 */
export function selectCmdStart(promptStart: number, outputStart: number): number {
  return outputStart > 0 ? outputStart : promptStart;
}

/**
 * #Theme-D3: 配列を直近 max 件に制限する純関数。溢れた古い要素（dispose 対象）を evict へ、
 * 残す要素を keep へ返す。長寿命ペイン（resize せず数千コマンド）で blockDecos/promptMarkers が
 * 単調増加し、各 BlockDeco が command(≤4096)+outputBody(≤8000) の文字列と decoration DOM を
 * 抱えたまま数百 MB/日 に膨らむのを、追加のたびの cap で抑える（従来 blockDecos は onResize 時
 * しか刈られず、promptMarkers は dispose まで一切刈られなかった）。
 */
export function planCap<T>(list: T[], max: number): { keep: T[]; evict: T[] } {
  if (list.length <= max) return { keep: list, evict: [] };
  const cut = list.length - max;
  return { keep: list.slice(cut), evict: list.slice(0, cut) };
}

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
 * #71: `A`（プロンプト開始）マーカーの nonce 認証。rest 全体が orb 自身の nonce
 * （spawn 時に子シェルへ渡した値）と一致するときだけ true。expectedNonce が空（未配線）
 * なら常に false＝安全側（C/E と同じく「自分の nonce を持たないマーカーは信用しない」）。
 *
 * 認証しないと、コマンド出力に紛れた `\x1b]633;A\x07` が正規ブロックを中断クローズ
 * （onPromptStart の D 欠落処理）させ、偽ブロックを差し込めてしまう（#71 の脅威モデル）。
 */
export function isAuthedPromptStart(rest: string, expectedNonce: string): boolean {
  if (!expectedNonce) return false;
  return rest === expectedNonce;
}

/**
 * #71: `D`（終了コード）/`P`（プロパティ）マーカーの nonce 認証つき分解。どちらも
 * `<nonce>;<payload>` 形で来る。rest を最初の `;` で割り、先頭が orb 自身の nonce に
 * 一致したときだけ payload（D なら終了コード文字列、P なら "Cwd=…" 等）を返す。
 * nonce 不在（未配線）・不一致・区切り無しはすべて null＝処理しない（安全側）。
 *
 * これを怠ると、出力に紛れた `633;D;0` が実失敗を緑✓へ偽造（JSONL に exit_code:0 を永続化）、
 * `633;P;Cwd=<任意>` が cwd を偽装（checkpoint/handoff が任意ディレクトリで動く）できる（#71）。
 */
export function parseNoncedPayload(rest: string, expectedNonce: string): string | null {
  if (!expectedNonce) return null;
  const sep = rest.indexOf(";");
  if (sep === -1) return null;
  if (rest.slice(0, sep) !== expectedNonce) return null;
  return rest.slice(sep + 1);
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
  /** #Theme-D1: プロンプト開始(A)の時刻。所要時間の起点は selectCmdStart で C 時刻を優先する。 */
  private cmdStart = 0;
  /** #Theme-D1: 出力開始(C)の時刻。0=未受信（この場合 cmdStart=A 時刻へフォールバック）。 */
  private outputStartTime = 0;
  /** #Theme-D3: レジストリの上限。超過分は追加時に古い方から dispose して単調増加を止める。 */
  private static MAX_BLOCK_DECOS = 500;
  private static MAX_PROMPT_MARKERS = 500;
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
        // #71: A も nonce 認証。出力に紛れた `633;A` が正規ブロックを中断クローズ
        // （onPromptStart の D 欠落処理）させ、偽ブロックを差し込む偽造を防ぐ。
        if (isAuthedPromptStart(rest, this.nonce)) this.onPromptStart();
        break;
      case "C":
        // #33: 出力開始。E と同じく nonce で認証する（出力に紛れた偽 C が output_body の
        // 境界を動かすのを防ぐ）。開いているブロックにだけ意味がある（迷子の C は無視）。
        if (!this.finished && this.nonce && rest === this.nonce) {
          this.outputStart = this.term.registerMarker(0) ?? null;
          this.outputStartTime = Date.now(); // #Theme-D1: 実所要時間の起点（A→C のアイドルを除外）
          setPaneStatus(this.paneId, "running"); // #50: コマンド実行開始＝🟢
        }
        break;
      case "D": {
        // #71: D も nonce 認証。出力に紛れた `633;D;0` が実失敗コマンドを緑✓へ偽造し、
        // JSONL に exit_code:0 を永続化＋成功通知＋AI へ「成功」供給するのを防ぐ。
        const code = parseNoncedPayload(rest, this.nonce);
        if (code != null) this.onFinished(code);
        break;
      }
      case "E":
        this.onCommandLine(rest);
        break;
      case "P": {
        // #71: P も nonce 認証。偽 `633;P;Cwd=<任意>` による cwd 偽装（setPaneCwd→AI ペイロード／
        // checkpoint_capture／save_handoff_file が任意ディレクトリで動く）を防ぐ。
        const prop = parseNoncedPayload(rest, this.nonce);
        if (prop != null) this.onProperty(prop);
        break;
      }
    }
    return true;
  }

  /** #33: `E;<nonce>;<escaped-cmd>` を検証してコマンドラインを確定する。 */
  private onCommandLine(rest: string) {
    const cmd = parseCommandLine(rest, this.nonce);
    if (cmd != null) {
      this.pendingCommand = cmd;
      setPaneLastCommand(this.paneId, cmd);
    }
  }

  private onPromptStart() {
    // #Theme-A: A（プロンプト開始）＝シェルが制御を取り戻した＝ランチャー起動の claude が終了した。
    //  素のシェルプロンプトを起動 agent の「入力待ち」と誤判定しないよう、起動フラグをここで解除
    //  する（起動 claude 中はそもそも A が来ない＝この A は claude 終了後の最初のプロンプト）。
    clearLaunchedAgent(this.paneId);
    if (this.startMarker && !this.finished) {
      // D 欠落のまま次プロンプトが来た＝前ブロックを中断クローズ。現在位置を終端マーカーとして
      // 捕捉し、装飾もログも中断(-1・aborted)で確定する。end=null だと本文が1行に潰れて失われる。
      const endMarker = this.term.registerMarker(0);
      this.decorate(this.startMarker, -1, endMarker ?? null, this.pendingCommand, this.extractOutputBody(endMarker ?? null));
      this.logBlock(this.startMarker, endMarker ?? null, -1, true);
      this.updateStatusOnClose(-1);
    }
    this.startMarker = this.term.registerMarker(0) ?? null;
    if (this.startMarker) {
      this.promptMarkers.push(this.startMarker);
      // #Theme-D3: 直近 N 件だけ残し、溢れた古い IMarker を dispose（長寿命ペインのリーク防止）。
      const { keep, evict } = planCap(this.promptMarkers, CommandBlocks.MAX_PROMPT_MARKERS);
      if (evict.length) {
        for (const m of evict) m.dispose();
        this.promptMarkers = keep;
      }
    }
    this.finished = false;
    this.cmdStart = Date.now();
    this.currentBlockId = genId();
    // #33: 新しいブロックの開始＝前ブロックのコマンド/出力境界を破棄。
    this.pendingCommand = null;
    this.outputStart = null;
    this.outputStartTime = 0; // #Theme-D1: C 時刻をブロックごとにリセット（前ブロックの持ち越し防止）
  }

  private onFinished(rest: string) {
    // #Theme-D2: 冪等化。次の A 前に authenticated な D が2回来ても、再装飾・再ログ（block_id 重複）・
    //  再通知しない。finished は初期 true・A で false・D で true＝「既に閉じたブロック」を弾く。
    if (this.finished) return;
    if (!this.startMarker) return;
    const code = parseExitCode(rest);
    const endMarker = this.term.registerMarker(0);
    this.decorate(this.startMarker, code, endMarker ?? null, this.pendingCommand, this.extractOutputBody(endMarker ?? null));
    this.logBlock(this.startMarker, endMarker ?? null, code, false);
    this.finished = true;
    this.notifyIfBackground(code);
    this.updateStatusOnClose(code);
  }

  /** #50: コマンド確定時の状態更新。**記録は見ているかどうかに関係なく行う**
   *  （見ている時に出さないのは表示側の責務＝バッジは shouldShowPaneBadge、通知は
   *  shouldNotifyForPane。ここで消すと Crew が見ているペインの失敗を出せない）。
   *  長時間しきい値は #20 の通知と共有する。null は running 解除。 */
  private updateStatusOnClose(code: number) {
    // #Theme-D1: 所要時間は C(出力開始) 起点を優先＝プロンプト放置時間を longRun 判定に混ぜない。
    const start = selectCmdStart(this.cmdStart, this.outputStartTime);
    const longRun = start > 0 && Date.now() - start >= CommandBlocks.NOTIFY_MS;
    setPaneStatus(this.paneId, statusForClose(code, longRun));
  }

  /** #50: いまコマンド実行中か（E/C 受信済み・D 未受信）。AI ペインのアイドル判定のゲート。
   *  プロンプトで静止しているだけの状態（A 直後）は false。 */
  isCommandRunning(): boolean {
    return !this.finished && (this.outputStart != null || this.pendingCommand != null);
  }

  /** #77 FN-4b: 今 alt-screen（vim/lazygit 等フルスクリーン TUI）中か。broadcast 複製が
   *  このペインへ生バイトを流して画面を壊すのを避けるゲートに使う（自分の入力には使わない）。 */
  isAltScreen(): boolean {
    return this.altScreen;
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
        // #Theme-D1: JSONL の duration_ms(=ended-started) も C 起点で正しくする（放置時間を含めない）。
        startedAt: selectCmdStart(this.cmdStart, this.outputStartTime),
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
    // #Theme-D1: C(出力開始) 起点を優先。A→C のアイドルを所要時間へ混ぜない（偽の「600秒 完了」防止）。
    const start = selectCmdStart(this.cmdStart, this.outputStartTime);
    const elapsed = Date.now() - start;
    if (start === 0 || elapsed < CommandBlocks.NOTIFY_MS) return;
    if (!shouldNotifyForPane(this.paneId)) return; // 前面（最前面ウィンドウ＆今見ているペイン）は通知しない
    if (get(dnd) && code === 0) return; // フォーカスモード(#20): 成功通知は出さない（失敗は昇格）
    const secs = Math.round(elapsed / 1000);
    notifyThrottled(
      this.paneId,
      code === 0 ? "orb ✓ コマンド完了" : `orb ✗ 失敗 (exit ${code})`,
      `${secs}秒 — ${this.cwd || "(orb)"}`,
    );
  }

  /** #32/#73: iTerm2 スタイル OSC 9 通知（`OSC 9 ; <message>`）を OS 通知へ転送。
   *  title は buildOsc9Notification が常に固定ラベルにする（SEC-4：なりすまし対策）。 */
  private onOsc9(data: string): boolean {
    const n = buildOsc9Notification(data);
    if (n && shouldNotifyForPane(this.paneId)) notifyThrottled(this.paneId, n.title, n.body);
    return true;
  }

  /** #32/#73: `OSC 777 ; notify ; <title> ; <body>` を OS 通知へ転送。
   *  攻撃者制御の title はここでは使わない（buildOsc777Notification 参照・SEC-4）。 */
  private onOsc777(data: string): boolean {
    const n = buildOsc777Notification(data);
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
    // #Theme-D3: 追加のたびに直近 N 件へ制限し、溢れた古いブロックの装飾/マーカーを dispose する
    //  （従来 onResize 時しか刈られず、resize しない長寿命ペインで数百 MB/日 に膨らんでいた）。
    //  marker は promptMarkers と共有だが xterm の dispose は冪等＝二重 dispose しても安全。
    const { keep, evict } = planCap(this.blockDecos, CommandBlocks.MAX_BLOCK_DECOS);
    if (evict.length) {
      for (const e of evict) {
        e.dec?.dispose();
        e.endMarker?.dispose();
        e.marker.dispose();
      }
      this.blockDecos = keep;
    }
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
