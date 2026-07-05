/** #69 followup: rgba(var(--x-rgb), alpha) で使うための "R, G, B" 文字列へ変換する。
 *  CSS カスタムプロパティは16進のまま alpha 合成できない（rgba(var(--x), 0.5) は無効）ため、
 *  R/G/B 成分だけを別変数として並行して持つ。パース失敗時は素の白（255, 255, 255）へ落とす。 */
export function hexToRgbTriplet(hex: string): string {
  // 末尾2桁は任意の alpha（CSS 8桁 #RRGGBBAA）。RGB 成分のみ使うため無視する。
  const m = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(hex.trim());
  if (!m) return "255, 255, 255";
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}
