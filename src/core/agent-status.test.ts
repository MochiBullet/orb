import { describe, it, expect } from "vitest";
import {
  aggregateStatus,
  statusForClose,
  stripAnsi,
  classifyIdle,
} from "./agent-status";

describe("statusForClose (#50: D 確定時のバッジ判定・#32/#20 とゲート共有)", () => {
  it("見ている時は何も出さない（running 解除を兼ねる null）", () => {
    expect(statusForClose(0, true, true)).toBeNull();
    expect(statusForClose(1, true, true)).toBeNull();
    expect(statusForClose(-1, true, false)).toBeNull();
  });

  it("見ていない時: 失敗は所要時間に関係なく failed、成功は長時間だけ done", () => {
    expect(statusForClose(1, false, false)).toBe("failed");
    expect(statusForClose(-1, false, false)).toBe("failed"); // 中断クローズ(-1)も失敗扱い
    expect(statusForClose(0, false, true)).toBe("done");
    expect(statusForClose(0, false, false)).toBeNull(); // 一瞬で終わる成功はバッジにしない
  });
});

describe("aggregateStatus (#50: タブ集約は手が要る順に先勝ち)", () => {
  it("attention > failed > waiting > done > running", () => {
    expect(aggregateStatus(["running", "failed", "attention"])).toBe("attention");
    expect(aggregateStatus(["done", "failed"])).toBe("failed");
    expect(aggregateStatus(["running", "waiting"])).toBe("waiting");
    expect(aggregateStatus(["running", "done"])).toBe("done");
    expect(aggregateStatus(["running", undefined])).toBe("running");
    expect(aggregateStatus([undefined, undefined])).toBeNull();
    expect(aggregateStatus([])).toBeNull();
  });
});

describe("stripAnsi (#50)", () => {
  it("CSI/OSC/2文字エスケープ・制御文字を除去し \\n \\t は残す", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
    expect(stripAnsi("\x1b]0;title\x07body")).toBe("body");
    expect(stripAnsi("a\x1b(Bb")).toBe("ab"); // ESC ( は2文字エスケープ＋残りの ( はそのまま…ではなく charset 指定
    expect(stripAnsi("line1\nline2\tend")).toBe("line1\nline2\tend");
    expect(stripAnsi("\x1b]633;A\x1b\\prompt")).toBe("prompt");
  });

  it("chunk境界で分断された不完全な CSI 断片も末尾なら除去する", () => {
    expect(stripAnsi("hello\x1b[1;2")).toBe("hello"); // 終端バイト未着のまま切れた CSI
    expect(stripAnsi("hello\x1b[")).toBe("hello"); // CSI 導入直後で切れた
    expect(stripAnsi("hello\x1b")).toBe("hello"); // ESC 単体で切れた
  });
});

describe("classifyIdle (#50: 静止時の末尾分類)", () => {
  it("Claude Code の許可/確認プロンプトは attention", () => {
    expect(classifyIdle("Do you want to proceed?\n❯ 1. Yes\n  2. No")).toBe("attention");
    expect(classifyIdle("\x1b[1mDo you want to allow this tool?\x1b[0m")).toBe("attention");
    expect(classifyIdle("Do you trust the files in this folder?")).toBe("attention");
    expect(classifyIdle("Overwrite? (y/n)")).toBe("attention");
    expect(classifyIdle("Press Enter to continue")).toBe("attention");
  });

  it("ただ出力が止まっただけなら waiting", () => {
    expect(classifyIdle("done.\n$ ")).toBe("waiting");
    expect(classifyIdle("Compiling foo v0.1.0")).toBe("waiting");
    expect(classifyIdle("")).toBe("waiting");
    // "esc to interrupt"（実行中スピナー行）は要承認パターンに入れない
    expect(classifyIdle("Musing… (esc to interrupt)")).toBe("waiting");
  });
});
