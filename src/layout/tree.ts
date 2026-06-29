export type PaneRole = "shell" | "ai";

/** ワークスペース内の矩形（%単位）。 */
export type Rect = { x: number; y: number; w: number; h: number };

/** スプリッタ1本の描画＆ドラッグ情報。parent はその split が占める矩形(%)。 */
export type Splitter = { id: number; dir: "h" | "v"; ratio: number; parent: Rect };

/**
 * レイアウトツリー。split は id を持ち（ratio ドラッグの対象特定用）、leaf は paneId。
 * Terminal の生存は paneId で決まり、ツリーの形（geometry）とは独立に扱う
 * （Workspace が leaf を flat keyed で生成し、ツリーは矩形計算だけに使う）。
 */
export type PaneNode =
  | { kind: "leaf"; paneId: number; initialCmd?: string; role?: PaneRole }
  | { kind: "split"; id: number; dir: "h" | "v"; ratio: number; a: PaneNode; b: PaneNode };

export function leaf(paneId: number, initialCmd?: string, role?: PaneRole): PaneNode {
  return { kind: "leaf", paneId, initialCmd, role };
}

/** target leaf を分割し、「既存 + 新 leaf」の split に置き換える。 */
export function splitPane(
  node: PaneNode,
  targetId: number,
  dir: "h" | "v",
  newPaneId: number,
  newSplitId: number,
  newCmd?: string,
): PaneNode {
  if (node.kind === "leaf") {
    if (node.paneId === targetId) {
      return { kind: "split", id: newSplitId, dir, ratio: 0.5, a: node, b: leaf(newPaneId, newCmd) };
    }
    return node;
  }
  return {
    ...node,
    a: splitPane(node.a, targetId, dir, newPaneId, newSplitId, newCmd),
    b: splitPane(node.b, targetId, dir, newPaneId, newSplitId, newCmd),
  };
}

/** leaf を削除し兄弟を昇格。最後の1枚を消すと null。不変サブツリーは参照保持。 */
export function closePane(node: PaneNode, paneId: number): PaneNode | null {
  if (node.kind === "leaf") return node.paneId === paneId ? null : node;
  const a = closePane(node.a, paneId);
  const b = closePane(node.b, paneId);
  if (a === null) return b;
  if (b === null) return a;
  if (a === node.a && b === node.b) return node;
  return { ...node, a, b };
}

/** split の ratio を更新（ドラッグ反映、ツリーが単一の真実源）。 */
export function setRatio(node: PaneNode, splitId: number, ratio: number): PaneNode {
  if (node.kind === "leaf") return node;
  if (node.id === splitId) return { ...node, ratio };
  return { ...node, a: setRatio(node.a, splitId, ratio), b: setRatio(node.b, splitId, ratio) };
}

/** 閉じたペインの兄弟サブツリーの最初の leaf（close 後のフォーカス先）。 */
export function siblingFirstLeaf(node: PaneNode, paneId: number): number | null {
  if (node.kind === "leaf") return null;
  if (node.a.kind === "leaf" && node.a.paneId === paneId) return firstLeaf(node.b);
  if (node.b.kind === "leaf" && node.b.paneId === paneId) return firstLeaf(node.a);
  return siblingFirstLeaf(node.a, paneId) ?? siblingFirstLeaf(node.b, paneId);
}

function firstLeaf(node: PaneNode): number {
  return node.kind === "leaf" ? node.paneId : firstLeaf(node.a);
}

export function leafIds(node: PaneNode | null): number[] {
  if (!node) return [];
  if (node.kind === "leaf") return [node.paneId];
  return [...leafIds(node.a), ...leafIds(node.b)];
}

/** 各 leaf の矩形(%)を算出。 */
export function computeRects(node: PaneNode, rect: Rect, out: Map<number, Rect>): void {
  if (node.kind === "leaf") {
    out.set(node.paneId, rect);
    return;
  }
  const { x, y, w, h } = rect;
  if (node.dir === "h") {
    const wa = w * node.ratio;
    computeRects(node.a, { x, y, w: wa, h }, out);
    computeRects(node.b, { x: x + wa, y, w: w - wa, h }, out);
  } else {
    const ha = h * node.ratio;
    computeRects(node.a, { x, y, w, h: ha }, out);
    computeRects(node.b, { x, y: y + ha, w, h: h - ha }, out);
  }
}

/** 各 split のスプリッタ情報を算出。 */
export function computeSplitters(node: PaneNode, rect: Rect, out: Splitter[]): void {
  if (node.kind === "leaf") return;
  out.push({ id: node.id, dir: node.dir, ratio: node.ratio, parent: rect });
  const { x, y, w, h } = rect;
  if (node.dir === "h") {
    const wa = w * node.ratio;
    computeSplitters(node.a, { x, y, w: wa, h }, out);
    computeSplitters(node.b, { x: x + wa, y, w: w - wa, h }, out);
  } else {
    const ha = h * node.ratio;
    computeSplitters(node.a, { x, y, w, h: ha }, out);
    computeSplitters(node.b, { x, y: y + ha, w, h: h - ha }, out);
  }
}

/** leaf の付帯情報（起動コマンド・role）を paneId で引けるマップに。 */
export function leafInfoMap(
  node: PaneNode,
  out: Map<number, { initialCmd?: string; role?: PaneRole }>,
): void {
  if (node.kind === "leaf") {
    out.set(node.paneId, { initialCmd: node.initialCmd, role: node.role });
    return;
  }
  leafInfoMap(node.a, out);
  leafInfoMap(node.b, out);
}
