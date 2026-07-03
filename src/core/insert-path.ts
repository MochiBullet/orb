/**
 * #53 画像添付のパス挿入形。純関数（vitest 対象）・レンダラ非依存。
 *
 * claude（AI ペイン）へは `@パス` の添付形、通常シェルへは素のパス引数。
 * 空白入りは引用符で包む（claude の @ 引用対応は upstream 依存だが、
 * orb-shots の保存先は原則空白無しなので実運用では素通り）。
 */
export function formatImagePath(path: string, forAi: boolean): string {
  const quoted = /\s/.test(path) ? `"${path}"` : path;
  return forAi ? `@${quoted}` : quoted;
}

/** ドロップされたパスが画像か（#6 の D&D を #53 で @添付形へ拡張する判定）。 */
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
export function isImagePath(p: string): boolean {
  return IMAGE_EXT_RE.test(p);
}
