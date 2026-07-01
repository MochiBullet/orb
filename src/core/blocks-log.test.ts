import { describe, it, expect } from "vitest";
import { capText, localDay, buildBlockEvent, genId } from "./blocks-log";

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
