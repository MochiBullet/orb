/**
 * #47: タブ種別まわりの純粋ロジック（副作用なし＝vitest 対象）。
 * tabs.ts はストア購読・localStorage・invoke の副作用を module スコープに持つため、
 * テスト可能な判定だけをここへ切り出す。
 */

/** タブ種別。undefined は "term"（kind を付けない通常生成の既定）。 */
export type TabKind = "term" | "info";

/** これらの判定に必要な最小のタブ形（tabs.ts の Tab のサブセット）。 */
export interface TabLike {
  id: number;
  kind?: TabKind;
}

/** kind の既定解決: undefined = "term"。 */
export function tabKind(t: TabLike): TabKind {
  return t.kind ?? "term";
}

/** タブ列から info タブを探す（重複作成防止・パレットのアクティブ化に使う）。 */
export function findInfoTab<T extends TabLike>(tabs: T[]): T | undefined {
  return tabs.find((t) => tabKind(t) === "info");
}
