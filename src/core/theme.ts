import { config, type OrbConfig } from "./config";

/** config のアクセント色を CSS 変数 --teal に流し込む（サイドバー枠・ブロックバッジ・
 *  グロー等が一括で追従する）。config が変わるたび自動適用。 */
function apply(c: OrbConfig) {
  const accent = c.accent || "#2dd4bf";
  document.documentElement.style.setProperty("--teal", accent);
}

config.subscribe(apply);
