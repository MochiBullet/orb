/**
 * #34: AI ペイン（Claude Code の入力欄）へ渡すブロック文脈の整形と安全な枠付け。
 *
 * - E/C マーカー（#33）で command / output_body が確定しているブロックは構造化して渡す。
 *   無いもの（マーカー欠落・未対応シェル・巨大出力でマーカー失効）は生テキストへ
 *   フォールバック＝嘘の分割を作らない（#31 の原則）。
 * - 複数行ペイロードは必ず bracketed paste で包む。素の \n は Claude Code の入力欄で
 *   Enter（送信）として解釈され、1行ごとに細切れ送信される。枠で「1回の貼り付け」にし、
 *   送信（Enter）は人が押す。
 */

export interface BlockAiContext {
  cwd: string;
  /** ブロックの終了コード。null は「exit を持たない文脈」（選択テキスト等では使わない）。 */
  exitCode: number | null;
  /** #33 E マーカー由来のコマンドライン。無ければ null。 */
  command: string | null;
  /** #33 C マーカー由来の出力本文。無ければ null。 */
  outputBody: string | null;
  /** フォールバック用の生ブロックテキスト（呼び出し側で cap 済みを渡す）。 */
  text: string;
}

/** ブロック1個を Claude が読み取りやすい平文に整形する。 */
export function formatBlockForAi(b: BlockAiContext): string {
  const exit = b.exitCode != null ? ` exit=${b.exitCode}` : "";
  const head = `[orb block] cwd=${b.cwd || "(不明)"}${exit}`;
  if (b.command != null) {
    const out = b.outputBody ? `\n--- output ---\n${b.outputBody}` : "\n--- output ---\n(出力なし)";
    return `${head}\n$ ${b.command}${out}`;
  }
  // マーカー不在: 画面から抽出した生テキスト（プロンプト行込み）をそのまま渡す。
  return `${head}\n${b.text}`;
}

/** 失敗ブロックの「これ直して」依頼文（VIBE_IDEAS #2 の構造化版）。 */
export function formatFixRequest(b: BlockAiContext): string {
  return (
    `次のコマンドが exit ${b.exitCode} で失敗しました。原因を説明して、修正案（必要なら修正後のコマンド）を出して:\n\n` +
    formatBlockForAi(b)
  );
}

/** formatPastFailureContext が受け取る過去イベントの最小形（blocks-log.ts の BlockEvent の
 *  部分集合＝この2ファイルの依存を作らないため構造的型付けで受ける）。 */
export interface PastEventLike {
  ended_at: number;
  exit_code: number;
  command: string | null;
  output_body: string | null;
  text: string;
}

/** past-failures.ts の判定結果の最小形（PastFailureMatch と構造的に一致）。 */
export interface PastMatchLike {
  failure: { event: PastEventLike };
  resolvedBy: { event: PastEventLike } | null;
}

/** 過去ログの複利（Fable5 ロードマップ #3）: 「このエラー、前にも見た？」の整形。
 *  past-failures.ts の判定結果を、現在の失敗ブロックと合わせて AI が読める形にする。 */
export function formatPastFailureContext(current: BlockAiContext, match: PastMatchLike | null): string {
  if (!match) {
    return (
      "このコマンドの過去の失敗記録はブロック履歴に見つかりませんでした（今回が初めてのようです）。\n\n" +
      formatFixRequest(current)
    );
  }
  const f = match.failure.event;
  const lines = [
    `過去にも同じコマンドが同じディレクトリで失敗しています（${fmtWhen(f.ended_at)}、exit=${f.exit_code}）。`,
    "--- 過去の失敗 ---",
    `$ ${f.command ?? "(コマンド不明)"}`,
    f.output_body ?? f.text,
  ];
  if (match.resolvedBy) {
    const r = match.resolvedBy.event;
    lines.push(
      "",
      `その後 ${fmtWhen(r.ended_at)} に成功しています。何がどう変わって直ったか、今回のログと比較して教えて:`,
      "--- 過去の成功 ---",
      `$ ${r.command ?? "(コマンド不明)"}`,
      r.output_body ?? r.text,
    );
  } else {
    lines.push("", "この後の成功記録は見当たりません（まだ解決されていない可能性）。原因を考えて:");
  }
  return `${lines.join("\n")}\n\n${formatBlockForAi(current)}`;
}

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** 複数の失敗ブロックの一括ダイジェスト（BlockHistory の一括→AI 用）。 */
export function formatFailureDigest(blocks: BlockAiContext[]): string {
  const parts = blocks.map((b, i) => `--- 失敗 ${i + 1}/${blocks.length} ---\n${formatBlockForAi(b)}`);
  return `以下の失敗コマンド ${blocks.length} 件をまとめて渡します。共通原因があれば指摘し、それぞれの直し方を出して:\n\n${parts.join("\n\n")}`;
}

/**
 * ペイロードを bracketed paste で包む。包む前に \n・タブ以外の C0/C1 制御文字を除去する:
 * ペイロード内に ESC[201~ が紛れると枠が早期終了し、以降のバイトが生入力
 * （\n=Enter=勝手に送信）として流れる——ブロック由来のテキストは xterm の
 * レンダ済みセルから来るため ESC を含み得ないが、ここは安全の要所なので多重防御。
 * C1（U+0080-U+009F、特に U+009B=1文字CSI）も念のため落とす。
 */
export function frameBracketedPaste(payload: string): string {
  // eslint-disable-next-line no-control-regex
  const safe = payload.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
  return `\x1b[200~${safe}\x1b[201~`;
}
