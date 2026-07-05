/**
 * semantic history（VIBE_IDEAS #37）: 出力中の `src/foo.ts:42` 形をクリックで開くための
 * パターン検出（純関数・レンダラ非依存＝vitest 対象）。Terminal.svelte の link provider が使う。
 *
 * #Theme-F: 素の正規表現は URL の権威部 `host.tld:port`（例: http://app.example.com:8080/x）を
 * file:line と誤検知し、エディタを path="app.example.com" line=8080 で開いてしまう。matchFileLine が
 * その URL 由来の候補を除外する。実ファイル（path/file.ts:42 や command.com:12 等スラッシュを
 * 伴わないもの）は残す。
 */

/** `path/file.ext:line(:col)`。拡張子は英字始まり限定（`1.2.3:4` 等の誤マッチを避ける）。 */
export const FILE_LINE_RE = /(?:[\w.\-]+[/\\])*[\w.\-]+\.[A-Za-z][\w]{0,7}:\d+(?::\d+)?/g;

/** URL の権威部（host.<tld>:port）判定に使う、実運用で URL に出る主要 TLD。網羅ではない
 *  ＝「TLD かつ直後が `/`」の合わせ技で URL のポートだけを狙い撃つ（下記 isUrlAuthority 参照）。 */
const URL_TLDS = new Set([
  "com", "org", "net", "io", "dev", "app", "co", "ai", "gov", "edu",
  "me", "sh", "xyz", "cloud", "page", "pages", "info", "biz",
]);

export interface FileLineMatch {
  token: string;
  index: number;
}

/** マッチ token（file.ext:line…）から拡張子部（<ext>）だけを取り出す。 */
function extOf(token: string): string | null {
  const m = /\.([A-Za-z][\w]{0,7}):\d+/.exec(token);
  return m ? m[1] : null;
}

/**
 * この token が URL の権威部（host.tld:port）で、file:line ではないと判断できるか。
 * - 直前が `://`（スキーム付き URL の権威部開始）＝ http://host:port の host。
 * - 拡張子部が既知 TLD かつ token 直後が `/`（host.tld:port/path のポート）。
 * どちらでもなければ file:line として扱う（実ファイルの取りこぼしを避ける保守側）。
 */
function isUrlAuthority(text: string, token: string, index: number): boolean {
  if (index >= 3 && text.slice(index - 3, index) === "://") return true;
  const ext = extOf(token);
  const after = text[index + token.length];
  if (ext && URL_TLDS.has(ext.toLowerCase()) && after === "/") return true;
  return false;
}

/** 可視行テキストから file:line 候補を抽出し、URL 権威部を除外して返す純関数。 */
export function matchFileLine(text: string): FileLineMatch[] {
  const out: FileLineMatch[] = [];
  FILE_LINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_LINE_RE.exec(text)) !== null) {
    if (isUrlAuthority(text, m[0], m.index)) continue;
    out.push({ token: m[0], index: m.index });
  }
  return out;
}
