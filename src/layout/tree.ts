/** ペインのレイアウトツリー（フロント権威）。leaf = 1 ペイン、split = 2 分割。 */
export type PaneNode =
  | { kind: "leaf"; paneId: number; initialCmd?: string }
  | { kind: "split"; dir: "h" | "v"; ratio: number; a: PaneNode; b: PaneNode };

export function leaf(paneId: number, initialCmd?: string): PaneNode {
  return { kind: "leaf", paneId, initialCmd };
}

/** target leaf を分割し、「既存 + 新 leaf」の split に置き換える。 */
export function splitPane(
  node: PaneNode,
  targetId: number,
  dir: "h" | "v",
  newId: number,
): PaneNode {
  if (node.kind === "leaf") {
    if (node.paneId === targetId) {
      return { kind: "split", dir, ratio: 0.5, a: node, b: leaf(newId) };
    }
    return node;
  }
  return {
    ...node,
    a: splitPane(node.a, targetId, dir, newId),
    b: splitPane(node.b, targetId, dir, newId),
  };
}

/** leaf を削除し兄弟を昇格させる。最後の1枚を消すと null。 */
export function closePane(node: PaneNode, paneId: number): PaneNode | null {
  if (node.kind === "leaf") return node.paneId === paneId ? null : node;
  const a = closePane(node.a, paneId);
  const b = closePane(node.b, paneId);
  if (a === null) return b;
  if (b === null) return a;
  return { ...node, a, b };
}

/** 全 leaf の paneId を出現順（左→右 / 上→下）に列挙。 */
export function leafIds(node: PaneNode | null): number[] {
  if (!node) return [];
  if (node.kind === "leaf") return [node.paneId];
  return [...leafIds(node.a), ...leafIds(node.b)];
}
