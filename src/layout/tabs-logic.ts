/**
 * #47: タブ種別まわりの純粋ロジック（副作用なし＝vitest 対象）。
 * tabs.ts はストア購読・localStorage・invoke の副作用を module スコープに持つため、
 * テスト可能な判定だけをここへ切り出す。
 */

/** タブ種別。undefined は "term"（kind 導入前の保存済みセッションとの後方互換）。 */
export type TabKind = "term" | "info";

/** これらの判定に必要な最小のタブ形（tabs.ts の Tab のサブセット）。 */
export interface TabLike {
  id: number;
  kind?: TabKind;
}

/** kind の後方互換解決: undefined = "term"。 */
export function tabKind(t: TabLike): TabKind {
  return t.kind ?? "term";
}

/** タブ列から info タブを探す（重複作成防止・パレットのアクティブ化に使う）。 */
export function findInfoTab<T extends TabLike>(tabs: T[]): T | undefined {
  return tabs.find((t) => tabKind(t) === "info");
}

/** セッション復元起動で info タブを末尾補充すべきか:
 *  show_info_on_startup が ON かつ復元セットに info タブが無い場合のみ。 */
export function shouldAppendInfoTab(restored: TabLike[], showInfoOnStartup: boolean): boolean {
  return showInfoOnStartup && findInfoTab(restored) === undefined;
}
