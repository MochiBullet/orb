import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { get } from "svelte/store";
import {
  toasts,
  pushToast,
  dismissToast,
  __resetToastsForTest,
  AUTO_DISMISS_MS,
  DEDUPE_MS,
} from "./toasts";

describe("トーストストア (#79)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetToastsForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pushToast: 1件積み、id は単調増加、返り値=採番 id", () => {
    const a = pushToast("info", "one");
    const b = pushToast("info", "two");
    expect(a).toBe(1);
    expect(b).toBe(2);
    const list = get(toasts);
    expect(list.map((t) => t.message)).toEqual(["one", "two"]);
    expect(list[0].kind).toBe("info");
  });

  it("連続する同一 (kind+message) は短窓内で抑止（null を返し積まない）", () => {
    expect(pushToast("error", "boom")).toBe(1);
    expect(pushToast("error", "boom")).toBeNull(); // 連投を抑止
    expect(pushToast("error", "boom")).toBeNull();
    expect(get(toasts).length).toBe(1);
  });

  it("メッセージ or kind が違えば別トーストとして積む", () => {
    pushToast("error", "boom");
    pushToast("error", "different");
    pushToast("warn", "boom"); // 同 message でも kind 違いは別物
    expect(get(toasts).length).toBe(3);
  });

  it("抑止窓を過ぎれば同一メッセージを再度積める", () => {
    expect(pushToast("warn", "again")).toBe(1);
    expect(pushToast("warn", "again")).toBeNull();
    vi.advanceTimersByTime(DEDUPE_MS + 1); // 窓を越える（この間に自動消滅もする）
    expect(pushToast("warn", "again")).toBe(2); // 窓外なので再度積める
  });

  it("dismissToast: id 指定で消える・不在 id は無害", () => {
    const id = pushToast("info", "x")!;
    pushToast("info", "y");
    dismissToast(id);
    expect(get(toasts).map((t) => t.message)).toEqual(["y"]);
    dismissToast(9999); // 不在でも例外なく無変化
    expect(get(toasts).length).toBe(1);
  });

  it("自動消滅: kind ごとの TTL 経過で消える（warn/info < error）", () => {
    pushToast("warn", "w");
    vi.advanceTimersByTime(AUTO_DISMISS_MS.warn);
    expect(get(toasts).length).toBe(0);

    pushToast("error", "e");
    vi.advanceTimersByTime(AUTO_DISMISS_MS.warn); // warn の時間ではまだ消えない
    expect(get(toasts).length).toBe(1);
    vi.advanceTimersByTime(AUTO_DISMISS_MS.error - AUTO_DISMISS_MS.warn);
    expect(get(toasts).length).toBe(0);
  });
});
