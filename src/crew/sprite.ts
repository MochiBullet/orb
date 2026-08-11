/**
 * 差し替え用スプライトシート（1枚のPNGに6ポーズを横一列）の検証と切り出し。
 *
 * 検証をフロントで行うのは、Image の naturalWidth/naturalHeight だけで足りるため。
 * Rust に PNG デコーダを足す必要がない（png クレートは現在エンコード用途のみ）。
 */
import type { CrewPose } from "./model";

/** シート内の並び。この順序はテンプレートと同梱ドキュメントの唯一の根拠。 */
export const SPRITE_ORDER: CrewPose[] = [
  "running", "waiting", "attention", "done", "failed", "idle",
];

export function validateSheet(w: number, h: number):
  | { ok: true; frame: number }
  | { ok: false; reason: string } {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { ok: false, reason: "画像の寸法を取得できませんでした" };
  }
  const frame = w / SPRITE_ORDER.length;
  if (!Number.isInteger(frame) || frame !== h) {
    return {
      ok: false,
      reason: `${SPRITE_ORDER.length}コマ横一列・各コマ正方形にしてください（今: ${w}×${h}）`,
    };
  }
  return { ok: true, frame };
}

export function frameRect(pose: CrewPose, frame: number) {
  const i = Math.max(0, SPRITE_ORDER.indexOf(pose));
  return { x: i * frame, y: 0, w: frame, h: frame };
}
