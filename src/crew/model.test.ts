import { describe, it, expect } from "vitest";
import { selectSeats, poseForStatus, resolveName, MAX_SEATS, type CrewCandidate } from "./model";

function cand(p: Partial<CrewCandidate> & { paneId: number }): CrewCandidate {
  return {
    tabId: 1, tabName: "tab 1", role: "shell", status: null, since: null, ...p,
  };
}

describe("selectSeats", () => {
  it("手が要る順に2件だけ着席させ、あふれた数を返す", () => {
    const r = selectSeats([
      cand({ paneId: 1, status: "running" }),
      cand({ paneId: 2, status: "failed" }),
      cand({ paneId: 3, status: "attention" }),
      cand({ paneId: 4, status: "waiting" }),
    ]);
    expect(r.seats.map((s) => s.paneId)).toEqual([3, 2]);
    expect(r.overflow).toBe(2);
  });

  it("状態を持たないペインは最下位だが、空いた席には座る", () => {
    const r = selectSeats([
      cand({ paneId: 1, status: null }),
      cand({ paneId: 2, status: "running" }),
    ]);
    expect(r.seats.map((s) => s.paneId)).toEqual([2, 1]);
    expect(r.overflow).toBe(0);
  });

  it("同じ状態ならペインID昇順で安定する", () => {
    const r = selectSeats([
      cand({ paneId: 9, status: "waiting" }),
      cand({ paneId: 3, status: "waiting" }),
      cand({ paneId: 5, status: "waiting" }),
    ]);
    expect(r.seats.map((s) => s.paneId)).toEqual([3, 5]);
    expect(r.overflow).toBe(1);
  });

  it("ペインが1つなら1席だけ埋まる", () => {
    const r = selectSeats([cand({ paneId: 7 })]);
    expect(r.seats).toHaveLength(1);
    expect(r.overflow).toBe(0);
  });

  it("別タブのペインも候補に含まれる（INBOXの全タブ横断を引き継ぐ）", () => {
    const r = selectSeats([
      cand({ paneId: 1, tabId: 1, status: "running" }),
      cand({ paneId: 2, tabId: 2, tabName: "tab 2", status: "attention" }),
    ]);
    expect(r.seats[0].paneId).toBe(2);
    expect(r.seats[0].tabName).toBe("tab 2");
  });

  it("席数は MAX_SEATS を超えない", () => {
    const many = Array.from({ length: 8 }, (_, i) => cand({ paneId: i, status: "running" }));
    expect(selectSeats(many).seats).toHaveLength(MAX_SEATS);
  });
});

describe("poseForStatus", () => {
  it("状態をそのままポーズ名に、状態無しは idle にする", () => {
    expect(poseForStatus("running")).toBe("running");
    expect(poseForStatus("attention")).toBe("attention");
    expect(poseForStatus(null)).toBe("idle");
  });
});

describe("resolveName", () => {
  it("枠名 → ランチャーlabel → タブ名+ペインID の順に落ちる", () => {
    const c = cand({ paneId: 4, label: "PLIMAL", tabName: "tab 2" });
    expect(resolveName("枠1", c)).toBe("枠1");
    expect(resolveName("", c)).toBe("PLIMAL");
    expect(resolveName("", cand({ paneId: 4, tabName: "tab 2" }))).toBe("tab 2 · p4");
  });
});
