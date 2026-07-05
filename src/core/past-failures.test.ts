import { describe, it, expect } from "vitest";
import { findMostRecentPastFailure } from "./past-failures";
import type { SearchHit, BlockEvent } from "./blocks-log";

function ev(partial: Partial<BlockEvent> & { block_id: string }): BlockEvent {
  return {
    v: 1,
    session_id: "s1",
    pane_id: 1,
    cwd: "C:\\proj",
    shell: "pwsh",
    prompt_type: "starship",
    exit_code: 0,
    aborted: false,
    started_at: 0,
    ended_at: 0,
    duration_ms: 0,
    text: "",
    truncated: false,
    command: "cargo test",
    output_body: null,
    ...partial,
  };
}
function hit(partial: Partial<BlockEvent> & { block_id: string }): SearchHit {
  return { day: "2026-07-01", event: ev(partial) };
}

describe("findMostRecentPastFailure（過去ログの複利: このエラー前も見た？）", () => {
  it("過去の失敗が無ければ null（今回が初めての失敗）", () => {
    const hits = [hit({ block_id: "current", exit_code: 1 })];
    expect(findMostRecentPastFailure(hits, "current")).toBeNull();
  });

  it("現在のブロック自身は除外してから探す", () => {
    // hits[0] が現在のブロック（除外対象）で exit_code=1 のみ→残りに失敗が無ければ null
    const hits = [hit({ block_id: "current", exit_code: 1 })];
    expect(findMostRecentPastFailure(hits, "current")).toBeNull();
  });

  it("過去の失敗が見つかり、その後の成功で解決している", () => {
    // 新しい順: [今回の失敗(除外), 過去の成功(解決), 過去の失敗]
    const hits = [
      hit({ block_id: "current", exit_code: 1 }),
      hit({ block_id: "b2", exit_code: 0 }),
      hit({ block_id: "b1", exit_code: 1 }),
    ];
    const m = findMostRecentPastFailure(hits, "current");
    expect(m).not.toBeNull();
    expect(m!.failure.event.block_id).toBe("b1");
    expect(m!.resolvedBy?.event.block_id).toBe("b2");
  });

  it("過去の失敗はあるが、その後まだ成功していない（未解決）", () => {
    const hits = [
      hit({ block_id: "current", exit_code: 1 }),
      hit({ block_id: "b1", exit_code: 1 }),
    ];
    const m = findMostRecentPastFailure(hits, "current");
    expect(m).not.toBeNull();
    expect(m!.failure.event.block_id).toBe("b1");
    expect(m!.resolvedBy).toBeNull();
  });

  it("解決は「失敗直後の最初の成功」を取る（もっと後の成功に飛ばない）", () => {
    // 新しい順: [今回(除外), 後の成功2, 最初の成功1, 過去の失敗]
    const hits = [
      hit({ block_id: "current", exit_code: 1 }),
      hit({ block_id: "success2", exit_code: 0 }),
      hit({ block_id: "success1", exit_code: 0 }),
      hit({ block_id: "b1", exit_code: 1 }),
    ];
    const m = findMostRecentPastFailure(hits, "current");
    expect(m!.resolvedBy?.event.block_id).toBe("success1");
  });

  it("aborted も失敗・成功の判定に正しく効く", () => {
    const hits = [
      hit({ block_id: "current", exit_code: 1 }),
      hit({ block_id: "b1", exit_code: 0, aborted: true }), // 中断は成功扱いしない
    ];
    const m = findMostRecentPastFailure(hits, "current");
    expect(m!.failure.event.block_id).toBe("b1"); // aborted も失敗扱い
    expect(m!.resolvedBy).toBeNull();
  });

  it("直近1件だけを返す（それより古い失敗は無視）", () => {
    const hits = [
      hit({ block_id: "current", exit_code: 1 }),
      hit({ block_id: "b2", exit_code: 1 }), // より新しい過去の失敗
      hit({ block_id: "b1", exit_code: 1 }), // より古い過去の失敗
    ];
    const m = findMostRecentPastFailure(hits, "current");
    expect(m!.failure.event.block_id).toBe("b2");
  });
});
