import { describe, it, expect } from "vitest";
import { fmtTokens, pushPctSample, estimateEtaMinutes, type PctSample } from "./usage-local";

describe("fmtTokens (#52)", () => {
  it("1000未満はそのまま、以上はk表記に丸める", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(420)).toBe("420");
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(1000)).toBe("1.0k");
    expect(fmtTokens(4200)).toBe("4.2k"); // 1000-9999は小数1桁
    expect(fmtTokens(9999)).toBe("10.0k");
    expect(fmtTokens(12345)).toBe("12k"); // 10000以上は小数無し
    expect(fmtTokens(99999)).toBe("100k");
  });
});

describe("pushPctSample (#52: ETA推定用の履歴管理)", () => {
  it("直近間隔が近すぎるサンプルは捨てる", () => {
    let h: PctSample[] = [];
    h = pushPctSample(h, { t: 0, pct: 10 });
    h = pushPctSample(h, { t: 5_000, pct: 11 }); // MIN_SAMPLE_GAP_MS(20s)未満
    expect(h).toHaveLength(1);
    h = pushPctSample(h, { t: 25_000, pct: 12 });
    expect(h).toHaveLength(2);
  });

  it("上限件数を超えたら古い方から捨てる", () => {
    let h: PctSample[] = [];
    for (let i = 0; i < 10; i++) h = pushPctSample(h, { t: i * 30_000, pct: i });
    expect(h.length).toBeLessThanOrEqual(6);
    expect(h[h.length - 1].pct).toBe(9); // 最新は必ず残る
  });
});

describe("estimateEtaMinutes (#52: 減っている/横ばい/リセット跨ぎは嘘をつかず null)", () => {
  it("サンプル不足はnull", () => {
    expect(estimateEtaMinutes([])).toBeNull();
    expect(estimateEtaMinutes([{ t: 0, pct: 10 }])).toBeNull();
  });

  it("順調に増えていれば残り分数を推定する", () => {
    // 10分で10%→20%、rate=1%/分、残り80% → 80分
    const h: PctSample[] = [
      { t: 0, pct: 10 },
      { t: 10 * 60_000, pct: 20 },
    ];
    expect(estimateEtaMinutes(h)).toBe(80);
  });

  it("横ばい・減少（リセット跨ぎ）はnull（嘘の推定を出さない）", () => {
    expect(
      estimateEtaMinutes([
        { t: 0, pct: 20 },
        { t: 10 * 60_000, pct: 20 },
      ]),
    ).toBeNull();
    expect(
      estimateEtaMinutes([
        { t: 0, pct: 40 },
        { t: 10 * 60_000, pct: 5 }, // 5hリセットで下がった
      ]),
    ).toBeNull();
  });

  it("既に100%以上/到達済みなら0", () => {
    const h: PctSample[] = [
      { t: 0, pct: 50 },
      { t: 60_000, pct: 100 },
    ];
    expect(estimateEtaMinutes(h)).toBe(0);
  });
});
