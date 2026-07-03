import { describe, it, expect } from "vitest";
import { capText, localDay, buildBlockEvent, genId, parseSearchQuery } from "./blocks-log";

describe("capText (#31: JSONL を肥大させない上限)", () => {
  it("上限内はそのまま・truncated=false", () => {
    const r = capText("short");
    expect(r.text).toBe("short");
    expect(r.truncated).toBe(false);
  });

  it("上限超過は先頭＋末尾を残し省略マーカーを挟む・truncated=true", () => {
    const big = "A".repeat(3000) + "B".repeat(7000); // 10000 > 8000
    const r = capText(big);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThan(big.length);
    expect(r.text.startsWith("A".repeat(2000))).toBe(true); // 先頭 2000 は保持
    expect(r.text.endsWith("B".repeat(6000))).toBe(true); // 末尾（8000-2000）は保持
    expect(r.text).toContain("文字省略");
  });

  it("切断境界のサロゲートペアを分断せず孤立サロゲートを残さない（#31: ブロック消失防止）", () => {
    // 🚀 = U+1F680（サロゲートペア）。head 境界(2000)と tail 開始境界の両方に置く。
    const rocket = "🚀";
    // head 境界: index 1999 に 🚀 を跨がせる（0..1999 が 'a'、1999-2000 が 🚀 の2単位）。
    const head = "a".repeat(1999) + rocket; // 長さ 2001（🚀 が index 1999,2000）
    const mid = "m".repeat(7000);
    const tail = rocket + "z".repeat(2000); // tail 側にもペア
    const big = head + mid + tail;
    const r = capText(big);
    expect(r.truncated).toBe(true);
    // 孤立サロゲート（0xD800-0xDFFF 単独）が結果に残っていないこと。
    for (let i = 0; i < r.text.length; i++) {
      const c = r.text.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        // 高サロゲートの直後は必ず低サロゲートでなければならない。
        const next = r.text.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
      }
      if (c >= 0xdc00 && c <= 0xdfff) {
        // 低サロゲートの直前は必ず高サロゲートでなければならない。
        const prev = i > 0 ? r.text.charCodeAt(i - 1) : 0;
        expect(prev >= 0xd800 && prev <= 0xdbff).toBe(true);
      }
    }
    // JSON 化しても壊れない（serde が弾く孤立サロゲートが無いこと）。
    expect(() => JSON.parse(JSON.stringify({ text: r.text }))).not.toThrow();
  });
});

describe("localDay (#31: ログのファイル分割キー)", () => {
  it("ゼロ埋め YYYY-MM-DD を返す", () => {
    expect(localDay(new Date(2026, 0, 3))).toBe("2026-01-03"); // 1月3日
    expect(localDay(new Date(2026, 11, 25))).toBe("2026-12-25");
  });
});

describe("buildBlockEvent (#31: 純粋なイベント整形)", () => {
  const base = {
    paneId: 2,
    blockId: "blk",
    cwd: "C:\\proj",
    shell: "pwsh",
    promptType: "starship",
    exitCode: 0,
    aborted: false,
    startedAt: 1000,
    endedAt: 3500,
    text: "echo hi\nhi",
    command: null as string | null,
    outputBody: null as string | null,
  };

  it("v=1・duration=ended-started・予約フィールドは null・aborted 反映", () => {
    const e = buildBlockEvent(base);
    expect(e.v).toBe(1);
    expect(e.pane_id).toBe(2);
    expect(e.exit_code).toBe(0);
    expect(e.aborted).toBe(false);
    expect(e.duration_ms).toBe(2500);
    expect(e.command).toBeNull();
    expect(e.output_body).toBeNull();
    expect(e.session_id).toBeTruthy();
  });

  it("aborted=true（中断ブロック）が保持される", () => {
    const e = buildBlockEvent({ ...base, exitCode: -1, aborted: true });
    expect(e.exit_code).toBe(-1);
    expect(e.aborted).toBe(true);
  });

  it("#33: command / output_body が透過し、長い output_body は cap される", () => {
    const e = buildBlockEvent({ ...base, command: "echo hi", outputBody: "hi" });
    expect(e.command).toBe("echo hi");
    expect(e.output_body).toBe("hi");
    const big = buildBlockEvent({ ...base, command: "build", outputBody: "A".repeat(20000) });
    expect(big.output_body!.length).toBeLessThan(20000);
    expect(big.output_body).toContain("文字省略");
    // マーカー不在（E/C 無し）は null のまま＝嘘の分割を書かない
    expect(buildBlockEvent(base).command).toBeNull();
    expect(buildBlockEvent(base).output_body).toBeNull();
    // command は切り詰めると再実行が別物になるため、上限超過は null に落とす（保険）
    expect(buildBlockEvent({ ...base, command: "y".repeat(5000) }).command).toBeNull();
  });

  it("startedAt 欠落(0)は duration 0 に丸める（巨大 duration を書かない）", () => {
    const e = buildBlockEvent({ ...base, startedAt: 0, endedAt: 5000 });
    expect(e.started_at).toBe(5000);
    expect(e.duration_ms).toBe(0);
  });

  it("負の経過（時計巻き戻し等）でも duration は 0 以上に丸める", () => {
    const e = buildBlockEvent({ ...base, startedAt: 5000, endedAt: 1000 });
    expect(e.duration_ms).toBe(0);
  });
});

describe("genId (#31)", () => {
  it("毎回異なる非空文字列を返す", () => {
    const a = genId();
    const b = genId();
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });
});

describe("parseSearchQuery (#49: 横断検索 DSL)", () => {
  it("素のトークンは AND 検索語になる", () => {
    const s = parseSearchQuery("  cargo   build ");
    expect(s.terms).toEqual(["cargo", "build"]);
    expect(s.exit).toBeNull();
    expect(s.cwd).toBeNull();
    expect(s.field).toBe("all");
    expect(s.from).toBeNull();
    expect(s.to).toBeNull();
  });

  it("exit: は ok / fail / 数値（負値含む）を受ける・!0 と ≠0 は fail の別名", () => {
    expect(parseSearchQuery("exit:ok").exit).toBe("ok");
    expect(parseSearchQuery("exit:fail").exit).toBe("fail");
    expect(parseSearchQuery("exit:137").exit).toBe("137");
    expect(parseSearchQuery("exit:-1").exit).toBe("-1");
    expect(parseSearchQuery("exit:!0").exit).toBe("fail");
    expect(parseSearchQuery("exit:≠0").exit).toBe("fail");
  });

  it("cwd: / in: を解釈する（cmd・out の短縮も）", () => {
    const s = parseSearchQuery("cwd:orb in:command");
    expect(s.cwd).toBe("orb");
    expect(s.field).toBe("command");
    expect(parseSearchQuery("in:cmd").field).toBe("command");
    expect(parseSearchQuery("in:output").field).toBe("output");
    expect(parseSearchQuery("in:out").field).toBe("output");
    expect(parseSearchQuery("in:all").field).toBe("all");
  });

  it("from:/to:/day: は YYYY-MM-DD のみ・day は両端に展開", () => {
    const s = parseSearchQuery("from:2026-06-01 to:2026-06-30");
    expect(s.from).toBe("2026-06-01");
    expect(s.to).toBe("2026-06-30");
    const d = parseSearchQuery("day:2026-07-01");
    expect(d.from).toBe("2026-07-01");
    expect(d.to).toBe("2026-07-01");
  });

  it("解釈できない key:value はトークンごと検索語へ落とす＝入力を黙って捨てない", () => {
    expect(parseSearchQuery("exit:xyz").terms).toEqual(["exit:xyz"]);
    expect(parseSearchQuery("in:body").terms).toEqual(["in:body"]);
    expect(parseSearchQuery("from:2026-6-1").terms).toEqual(["from:2026-6-1"]);
    expect(parseSearchQuery("day:notdate").terms).toEqual(["day:notdate"]);
    // 値なしの exit: / cwd: も検索語扱い
    expect(parseSearchQuery("exit:").terms).toEqual(["exit:"]);
    expect(parseSearchQuery("cwd:").terms).toEqual(["cwd:"]);
    // URL のようなコロン入りトークンはそのまま検索語
    expect(parseSearchQuery("https://example.com").terms).toEqual(["https://example.com"]);
  });

  it("混在クエリ: 受け入れ条件の形（cargo exit:fail cwd:orb）を分解できる", () => {
    const s = parseSearchQuery("cargo exit:fail cwd:orb in:command from:2026-06-01");
    expect(s.terms).toEqual(["cargo"]);
    expect(s.exit).toBe("fail");
    expect(s.cwd).toBe("orb");
    expect(s.field).toBe("command");
    expect(s.from).toBe("2026-06-01");
  });
});

describe("parseSearchQuery 値の大小無視 (#49 レビュー修正)", () => {
  it("exit:/in: の値は大文字でも解釈される", () => {
    expect(parseSearchQuery("exit:FAIL").exit).toBe("fail");
    expect(parseSearchQuery("exit:OK").exit).toBe("ok");
    expect(parseSearchQuery("in:CMD").field).toBe("command");
    expect(parseSearchQuery("in:Output").field).toBe("output");
    // cwd の値は素のまま保持（比較は Rust 側で大小無視）
    expect(parseSearchQuery("cwd:OrB").cwd).toBe("OrB");
  });
});
