import { describe, it, expect } from "vitest";
import {
  parseExitCode,
  parseOsc9,
  parseOsc777,
  parseCommandLine,
  planResize,
  isAltScreenModeParams,
} from "./osc";

describe("parseExitCode (#41: no false success/failure)", () => {
  it('empty rest (D missing / Ctrl-C) => -1 (unknown/aborted, NOT success)', () => {
    expect(parseExitCode("")).toBe(-1);
  });

  it('"0" => 0 (CRITICAL: real success MUST stay 0, not -1)', () => {
    expect(parseExitCode("0")).toBe(0);
  });

  it('"1" => 1 (failure preserved)', () => {
    expect(parseExitCode("1")).toBe(1);
  });

  it('"137" => 137 (SIGKILL-style exit preserved)', () => {
    expect(parseExitCode("137")).toBe(137);
  });

  it('"garbage" => -1 (non-numeric payload is unknown, NOT success)', () => {
    expect(parseExitCode("garbage")).toBe(-1);
  });

  it('"0;extra" => 0 (success with trailing params stays 0)', () => {
    expect(parseExitCode("0;extra")).toBe(0);
  });

  it('";x" (leading semicolon) => -1 (empty code field is unknown)', () => {
    expect(parseExitCode(";x")).toBe(-1);
  });
});

describe("parseOsc9 (#32: iTerm2-style OSC 9 notification)", () => {
  it("plain message => body", () => {
    expect(parseOsc9("Build finished")).toBe("Build finished");
  });

  it("trims surrounding whitespace", () => {
    expect(parseOsc9("  done  ")).toBe("done");
  });

  it("empty => null (nothing to notify)", () => {
    expect(parseOsc9("")).toBeNull();
  });

  it("ConEmu progress (4;...) => null (not a notification)", () => {
    expect(parseOsc9("4;50")).toBeNull();
  });

  it("ConEmu numeric subcommand (1;C:\\path) => null", () => {
    expect(parseOsc9("1;C:\\path")).toBeNull();
  });

  it("message that merely contains a digit is kept", () => {
    expect(parseOsc9("Test 3 passed")).toBe("Test 3 passed");
  });
});

describe("parseOsc777 (#32: OSC 777;notify;title;body)", () => {
  it("full notify => title + body", () => {
    expect(parseOsc777("notify;Claude;Task complete")).toEqual({
      title: "Claude",
      body: "Task complete",
    });
  });

  it("missing body => empty body, title kept", () => {
    expect(parseOsc777("notify;Claude")).toEqual({ title: "Claude", body: "" });
  });

  it("missing title => 'orb' fallback", () => {
    expect(parseOsc777("notify;;just a body")).toEqual({ title: "orb", body: "just a body" });
  });

  it("body containing semicolons is preserved", () => {
    expect(parseOsc777("notify;T;a;b;c")).toEqual({ title: "T", body: "a;b;c" });
  });

  it("non-notify subcommand => null (ignored)", () => {
    expect(parseOsc777("something;else")).toBeNull();
  });

  it("notify with no title and no body => null (no info)", () => {
    expect(parseOsc777("notify;;")).toBeNull();
    expect(parseOsc777("notify")).toBeNull();
  });
});

describe("parseCommandLine (#33: OSC 633;E nonce 検証)", () => {
  const N = "abc123def456";

  it("nonce 一致 → コマンドラインを返す", () => {
    expect(parseCommandLine(`${N};echo hi`, N)).toBe("echo hi");
  });

  it("nonce 不一致 → null（出力に紛れた偽 E / エコー破片を捨てる）", () => {
    expect(parseCommandLine(`forged;curl evil.example`, N)).toBeNull();
  });

  it("expectedNonce 空 → 常に null（未配線シェルは安全側で受け付けない）", () => {
    expect(parseCommandLine(`${N};echo hi`, "")).toBeNull();
  });

  it("区切り ; 無し → null（壊れた payload）", () => {
    expect(parseCommandLine(N, N)).toBeNull();
  });

  it("__orb_escape の \\x3b（;）を復元する", () => {
    expect(parseCommandLine(`${N};echo a\\x3b echo b`, N)).toBe("echo a; echo b");
  });

  it("空コマンド → null", () => {
    expect(parseCommandLine(`${N};`, N)).toBeNull();
  });

  it("CR(\\x0d) 入り → null（再実行の即時実行化を防ぐ・正規行に CR は現れない）", () => {
    expect(parseCommandLine(`${N};git status\\x0dcurl evil`, N)).toBeNull();
  });

  it("その他の制御文字（\\x03 / \\x1b / \\x04）入り → null", () => {
    expect(parseCommandLine(`${N};a\\x03b`, N)).toBeNull();
    expect(parseCommandLine(`${N};a\\x1b[Ab`, N)).toBeNull();
    expect(parseCommandLine(`${N};a\\x04`, N)).toBeNull();
  });

  it("改行(\\x0a)とタブ(\\x09)は正規の複数行/タブ入り貼り付けとして許容", () => {
    expect(parseCommandLine(`${N};line1\\x0aline2`, N)).toBe("line1\nline2");
    expect(parseCommandLine(`${N};a\\x09b`, N)).toBe("a\tb");
  });

  it("上限（COMMAND_MAX）超過 → null", () => {
    expect(parseCommandLine(`${N};${"x".repeat(5000)}`, N)).toBeNull();
  });
});

describe("planResize (#56: resize 時のブロック装飾レジストリ整理)", () => {
  const entry = (id: string, width: number, line = 10, isDisposed = false) => ({
    id,
    width,
    marker: { line, isDisposed },
  });
  const ids = (arr: Array<{ id: string }>) => arr.map((e) => e.id);

  it("幅が cols と違う生存エントリだけ stale（作り直し対象）", () => {
    const a = entry("a", 120);
    const b = entry("b", 80);
    const { keep, drop, stale } = planResize([a, b], 80);
    expect(ids(keep)).toEqual(["a", "b"]);
    expect(drop).toEqual([]);
    expect(ids(stale)).toEqual(["a"]);
  });

  it("全エントリの幅が cols 一致 → stale 空（cols 不変 resize は no-op）", () => {
    const { keep, drop, stale } = planResize([entry("a", 80), entry("b", 80)], 80);
    expect(keep.length).toBe(2);
    expect(drop).toEqual([]);
    expect(stale).toEqual([]);
  });

  it("dispose 済み marker は drop（掃除）で stale に入らない", () => {
    const dead = entry("dead", 120, 10, true);
    const alive = entry("alive", 120);
    const { keep, drop, stale } = planResize([dead, alive], 80);
    expect(ids(keep)).toEqual(["alive"]);
    expect(ids(drop)).toEqual(["dead"]);
    expect(ids(stale)).toEqual(["alive"]);
  });

  it("line < 0（スクロールバックから溢れた marker）も drop", () => {
    const fell = entry("fell", 80, -1);
    const { keep, drop, stale } = planResize([fell], 80);
    expect(keep).toEqual([]);
    expect(ids(drop)).toEqual(["fell"]);
    expect(stale).toEqual([]);
  });

  it("混在幅も全部 stale になる（alt-screen 中スキップで一部だけ古い幅 → 自己修復）", () => {
    const { stale } = planResize([entry("a", 120), entry("b", 100), entry("c", 80)], 90);
    expect(ids(stale)).toEqual(["a", "b", "c"]);
  });

  it("空レジストリ → 全部空", () => {
    expect(planResize([], 80)).toEqual({ keep: [], drop: [], stale: [] });
  });
});

describe("isAltScreenModeParams (alt-screen 検知: xterm キャッシュ非依存の生 CSI 判定)", () => {
  it("1049（alt screen buffer cursor）を含む => true", () => {
    expect(isAltScreenModeParams([1049])).toBe(true);
  });

  it("47（alt screen buffer）を含む => true", () => {
    expect(isAltScreenModeParams([47])).toBe(true);
  });

  it("1047（alt screen buffer）を含む => true", () => {
    expect(isAltScreenModeParams([1047])).toBe(true);
  });

  it("複数 param のうちどれかが対象コードなら true（1個の CSI に複数モードがまとまる実例）", () => {
    expect(isAltScreenModeParams([2004, 1049])).toBe(true);
  });

  it("無関係なモード（bracketed paste 2004 のみ等）=> false", () => {
    expect(isAltScreenModeParams([2004])).toBe(false);
    expect(isAltScreenModeParams([25])).toBe(false);
  });

  it("空 params => false", () => {
    expect(isAltScreenModeParams([])).toBe(false);
  });

  it("サブパラメータ（number[] 要素）は対象コードと解釈しない", () => {
    expect(isAltScreenModeParams([[1049, 2]])).toBe(false);
  });
});
