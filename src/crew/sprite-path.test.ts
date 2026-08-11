import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

// base はモジュールスコープの状態なので、テストごとに resetModules + 再 import して隔離する。
beforeEach(() => {
  vi.resetModules();
  invokeMock.mockReset();
});

describe("resolveCrewSpritePath", () => {
  it("base 未解決なら null（壊れた URL を作らない）", async () => {
    const { resolveCrewSpritePath } = await import("./sprite-path");
    expect(resolveCrewSpritePath("crew/slot0.png")).toBeNull();
  });

  it("初期化成功後は base とスラッシュ結合した絶対パスを返す", async () => {
    invokeMock.mockResolvedValue("C:/Users/x/.config/orb");
    const { initCrewSpriteBase, resolveCrewSpritePath, crewSpriteBaseReady } = await import(
      "./sprite-path"
    );
    await initCrewSpriteBase();
    expect(resolveCrewSpritePath("crew/slot0.png")).toBe("C:/Users/x/.config/orb/crew/slot0.png");
    let ready = false;
    crewSpriteBaseReady.subscribe((v) => (ready = v))();
    expect(ready).toBe(true);
  });

  it("invoke 失敗時は base が null のままで resolve も null を返し続ける", async () => {
    invokeMock.mockRejectedValue(new Error("boom"));
    const { initCrewSpriteBase, resolveCrewSpritePath, crewSpriteBaseReady } = await import(
      "./sprite-path"
    );
    await initCrewSpriteBase();
    expect(resolveCrewSpritePath("crew/slot0.png")).toBeNull();
    let ready = true;
    crewSpriteBaseReady.subscribe((v) => (ready = v))();
    expect(ready).toBe(false);
  });
});
