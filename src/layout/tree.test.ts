import { describe, it, expect } from "vitest";
import {
  leaf,
  splitPane,
  closePane,
  setRatio,
  siblingFirstLeaf,
  leafIds,
  computeRects,
  leafInfoMap,
  type PaneNode,
  type PaneRole,
  type Rect,
} from "./tree";

const FULL: Rect = { x: 0, y: 0, w: 100, h: 100 };
type Split = Extract<PaneNode, { kind: "split" }>;

describe("tree", () => {
  it("leaf() builds a leaf node", () => {
    expect(leaf(1, "claude", "ai")).toEqual({
      kind: "leaf",
      paneId: 1,
      initialCmd: "claude",
      role: "ai",
    });
  });

  it("splitPane() wraps the target leaf in a 0.5 split (existing=a, new=b)", () => {
    const next = splitPane(leaf(1), 1, "h", 2, 100) as Split;
    expect(next.kind).toBe("split");
    expect(next.id).toBe(100);
    expect(next.dir).toBe("h");
    expect(next.ratio).toBe(0.5);
    expect((next.a as Extract<PaneNode, { kind: "leaf" }>).paneId).toBe(1);
    expect((next.b as Extract<PaneNode, { kind: "leaf" }>).paneId).toBe(2);
  });

  it("splitPane() leaves non-target leaves untouched", () => {
    const root = splitPane(leaf(1), 1, "h", 2, 100);
    const next = splitPane(root, 2, "v", 3, 101);
    expect(leafIds(next).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("closePane() removes a leaf and collapses its split", () => {
    const root = splitPane(leaf(1), 1, "h", 2, 100);
    expect(closePane(root, 2)).toEqual(leaf(1));
  });

  it("closePane() returns null when the last leaf is closed", () => {
    expect(closePane(leaf(1), 1)).toBeNull();
  });

  it("closePane() keeps untouched subtrees by reference", () => {
    const root = splitPane(splitPane(leaf(1), 1, "h", 2, 100), 2, "v", 3, 101) as Split;
    const next = closePane(root, 3) as Split;
    expect(next.a).toBe(root.a); // 1 の側は不変＝参照保持
  });

  it("setRatio() updates only the matching split", () => {
    const root = splitPane(leaf(1), 1, "h", 2, 100);
    const next = setRatio(root, 100, 0.3) as Split;
    expect(next.ratio).toBe(0.3);
  });

  it("siblingFirstLeaf() returns the neighbor leaf", () => {
    const root = splitPane(leaf(1), 1, "h", 2, 100);
    expect(siblingFirstLeaf(root, 1)).toBe(2);
    expect(siblingFirstLeaf(root, 2)).toBe(1);
  });

  it("computeRects() splits horizontally by ratio", () => {
    const root = splitPane(leaf(1), 1, "h", 2, 100);
    const m = new Map<number, Rect>();
    computeRects(root, FULL, m);
    expect(m.get(1)).toEqual({ x: 0, y: 0, w: 50, h: 100 });
    expect(m.get(2)).toEqual({ x: 50, y: 0, w: 50, h: 100 });
  });

  it("computeRects() splits vertically by ratio", () => {
    const root = setRatio(splitPane(leaf(1), 1, "v", 2, 100), 100, 0.25);
    const m = new Map<number, Rect>();
    computeRects(root, FULL, m);
    expect(m.get(1)).toEqual({ x: 0, y: 0, w: 100, h: 25 });
    expect(m.get(2)).toEqual({ x: 0, y: 25, w: 100, h: 75 });
  });

  it("leafInfoMap() maps paneId to cmd/role", () => {
    const root = splitPane(leaf(1, "claude", "ai"), 1, "h", 2, 100);
    const m = new Map<number, { initialCmd?: string; role?: PaneRole }>();
    leafInfoMap(root, m);
    expect(m.get(1)).toEqual({ initialCmd: "claude", role: "ai" });
    expect(m.get(2)).toEqual({ initialCmd: undefined, role: undefined });
  });
});
