/**
 * #50 エージェント状態バッジの判定ロジック（純関数・レンダラ非依存＝vitest 対象）。
 *
 * 状態は2系統から決まる:
 * - シェルコマンド: OSC133 D（exit 確定）→ statusForClose。#32/#20 の通知と同じ
 *   「見ていない時だけ」ゲートを共有する（判定の二重実装で通知とバッジがズレるのを防ぐ）。
 * - AI(claude)ペイン: claude は1コマンドとして走り続け D が出ないため、
 *   出力ストリームの静止＋末尾パターンで「入力待ち/要承認」を推定する → classifyIdle。
 */

export type PaneStatus = "running" | "waiting" | "attention" | "done" | "failed";

/**
 * #76/Theme-E: このペインの出力を「エージェント状態(waiting/attention)」として追跡すべきか。
 *
 * 二段ゲート構成の「外側」＝追跡候補かの広めの門。実際に waiting/attention へ化けさせる可否は
 * trackAgentOutput 内の「内側」ゲート（isCommandRunning() || isLaunchedAgentActive）で絞るので、
 * 外側に role==="ai" を含めても過剰追跡にはならない（生きた claude 以外は内側で弾かれる）。
 *
 * - role==="ai": AI(claude)ペイン。#50/#51 の肝＝サイドバー「claude 起動」や手打ちの claude を
 *   背景タブへ回した時（launchedActive=false・前景 aiPane でもない）でも状態追跡を続ける。
 *   v1.5.12 でここから role が抜け、この背景 claude が丸ごと無視される回帰を招いたため戻す
 *   （生きた claude は C マーカーを出す＝内側ゲートの isCommandRunning() が true で正しく判定でき、
 *   claude 終了後は C が止まり launchedActive も落ちるので素シェルを誤判定しない）。
 * - launchedActive: ランチャー起動 claude が稼働中（appStore の isLaunchedAgentActive）。起動
 *   ペインは role="ai" なので role で概ね賄えるが、ランチャー意図を明示するため残す。
 * - paneId===foregroundAiPane: パレット「このペインを AI ペインに設定」で前景指定された
 *   ペイン（前景の手動指定・action-target を退行させない）。
 */
export function shouldTrackAgentStatus(
  role: "shell" | "ai" | undefined,
  launchedActive: boolean,
  paneId: number,
  foregroundAiPane: number | null,
): boolean {
  return role === "ai" || launchedActive || paneId === foregroundAiPane;
}

/** バッジ表示（TabBar/ペイン右上/INBOX で共通）。 */
export const STATUS_ICON: Record<PaneStatus, string> = {
  running: "🟢",
  waiting: "🟡",
  attention: "🔔",
  done: "✅",
  failed: "🔴",
};

export const STATUS_LABEL: Record<PaneStatus, string> = {
  running: "実行中",
  waiting: "入力待ち",
  attention: "要承認",
  done: "完了",
  failed: "失敗",
};

/** タブ集約・INBOX の並びで使う優先度（先勝ち）。「あなたの手が要る」ほど先。 */
export const STATUS_PRIORITY: PaneStatus[] = ["attention", "failed", "waiting", "done", "running"];

/** 複数ペインの状態をタブ1個のバッジへ集約する（最優先の1個。無ければ null）。 */
export function aggregateStatus(list: (PaneStatus | undefined)[]): PaneStatus | null {
  for (const want of STATUS_PRIORITY) {
    if (list.includes(want)) return want;
  }
  return null;
}

/**
 * コマンド確定（OSC133 D / 中断クローズ）時のバッジ判定。
 * - watching（最前面ウィンドウ＆当該ペインにフォーカス）なら null＝見ている人にバッジは不要。
 *   null は「running バッジの解除」も兼ねる。
 * - 失敗は所要時間に関係なくバッジ。成功は longRun（#20 の通知しきい値と同じ）だけ。
 *   一瞬で終わる ls 等の成功までバッジにすると背景ペインが常時 ✅ で埋まるため。
 */
export function statusForClose(code: number, watching: boolean, longRun: boolean): PaneStatus | null {
  if (watching) return null;
  if (code !== 0) return "failed";
  return longRun ? "done" : null;
}

/** ANSI エスケープ（CSI/OSC/2文字 ESC）と制御文字を荒削りで除去する（\n \t は残す）。 */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "") // OSC（終端未着の断片も落とす）
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI
    .replace(/\x1b[()][@-~]/g, "") // charset 指定（ESC ( B 等）
    .replace(/\x1b[@-Z\\-_]/g, "") // 2文字エスケープ
    .replace(/\x1b\[[0-9;?]*[ -/]*$/, "") // 末尾で終端バイト未着の CSI 断片（chunk 境界で分断されたケース）
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/**
 * 出力静止時の末尾テキストから「要承認（明示的な確認プロンプト）」か「入力待ち」かを分類。
 * パターンは Claude Code の許可/確認 UI と一般的な CLI 確認を保守的にカバーする
 * （増やす時はここに足して agent-status.test.ts に実例を追加する）。
 */
export const ATTENTION_PATTERNS: RegExp[] = [
  /do you want to/i, // Claude Code: "Do you want to proceed/allow…?"
  /do you trust/i, // Claude Code: フォルダ信頼プロンプト
  /allow .{0,60}\?/i,
  /\by\/n\b/i, // (y/n) [y/N] など
  /❯\s*\d+\./, // 番号付き選択肢のカーソル（許可ダイアログ/質問 UI）
  /press enter to/i,
  /waiting for (your )?(input|approval|confirmation)/i,
];

export function classifyIdle(tail: string): "attention" | "waiting" {
  const t = stripAnsi(tail);
  return ATTENTION_PATTERNS.some((re) => re.test(t)) ? "attention" : "waiting";
}
