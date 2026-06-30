import { leaf, type PaneNode } from "./tree";
import { nextPaneId } from "../store/appStore";

/** 分割レイアウトのプリセット。新タブとして開く用の PaneNode を組み立てる。
 *  各 split は一意な id（ratio ドラッグ対象）、各 leaf は一意な paneId を持つ。 */

function hsplit(a: PaneNode, b: PaneNode, ratio = 0.5): PaneNode {
  return { kind: "split", id: nextPaneId(), dir: "h", ratio, a, b };
}
function vsplit(a: PaneNode, b: PaneNode, ratio = 0.5): PaneNode {
  return { kind: "split", id: nextPaneId(), dir: "v", ratio, a, b };
}

/** 2x2 グリッド（4ペイン）。 */
export function grid2x2(): PaneNode {
  return vsplit(
    hsplit(leaf(nextPaneId()), leaf(nextPaneId())),
    hsplit(leaf(nextPaneId()), leaf(nextPaneId())),
  );
}

/** 横3分割（3カラム）。 */
export function columns3(): PaneNode {
  return hsplit(leaf(nextPaneId()), hsplit(leaf(nextPaneId()), leaf(nextPaneId())), 1 / 3);
}

/** 主＋副: 左に大ペイン、右に上下2段。 */
export function mainStack(): PaneNode {
  return hsplit(
    leaf(nextPaneId()),
    vsplit(leaf(nextPaneId()), leaf(nextPaneId())),
    0.6,
  );
}

/** 左右2分割（2カラム）。 */
export function columns2(): PaneNode {
  return hsplit(leaf(nextPaneId()), leaf(nextPaneId()));
}
