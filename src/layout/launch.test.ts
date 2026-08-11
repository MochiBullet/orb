import { describe, it, expect } from "vitest";
import { buildClaudeCmd, cd, resolveQuickLaunchSlugs, widthPxToRatio, type Project } from "./launch";

function project(slug: string): Project {
  return { slug, name: slug, dir: `C:/${slug}`, dev_cmd: "npm run dev", dev_cwd: "" };
}

describe("buildClaudeCmd（案件ランチャーの一括起動承認: model/effort を起動時フラグへ焼き込む）", () => {
  it("opts 無指定は従来どおりのコマンド文字列（回帰防止）", () => {
    expect(buildClaudeCmd("continue")).toBe("claude --continue");
    expect(buildClaudeCmd("fresh")).toBe("claude");
    expect(buildClaudeCmd("yolo")).toBe("claude --continue --dangerously-skip-permissions");
  });

  it("model が具体値なら --model を付ける、\"default\" なら付けない", () => {
    expect(buildClaudeCmd("continue", { model: "opus" })).toBe("claude --continue --model opus");
    expect(buildClaudeCmd("continue", { model: "default" })).toBe("claude --continue");
  });

  it("effort が具体値なら --effort を付ける、\"auto\" なら付けない", () => {
    expect(buildClaudeCmd("continue", { effort: "xhigh" })).toBe("claude --continue --effort xhigh");
    expect(buildClaudeCmd("continue", { effort: "auto" })).toBe("claude --continue");
  });

  it("model と effort を同時指定すると両方付く（yolo との組み合わせも含む）", () => {
    expect(buildClaudeCmd("continue", { model: "sonnet", effort: "high" })).toBe(
      "claude --continue --model sonnet --effort high",
    );
    expect(buildClaudeCmd("yolo", { model: "haiku", effort: "low" })).toBe(
      "claude --continue --dangerously-skip-permissions --model haiku --effort low",
    );
  });

  it("#Theme-F: 既知語彙にない model/effort は焼き込まない（起動コマンド行への注入を塞ぐ）", () => {
    expect(buildClaudeCmd("continue", { model: "opus; rm -rf /" })).toBe("claude --continue");
    expect(buildClaudeCmd("continue", { effort: "high && curl evil" })).toBe("claude --continue");
    expect(buildClaudeCmd("yolo", { model: "unknown", effort: "bogus" })).toBe(
      "claude --continue --dangerously-skip-permissions",
    );
    // 既知値は従来どおり通る（回帰防止）。
    expect(buildClaudeCmd("continue", { model: "fable", effort: "max" })).toBe(
      "claude --continue --model fable --effort max",
    );
  });
});

describe("cd（#Theme-C: cd 失敗で後段を実行させない・シングルクオートエスケープ保全）", () => {
  it("-ErrorAction Stop を付ける（失敗を終端エラーにして `; claude` を走らせない）", () => {
    expect(cd("C:\\proj")).toBe("Set-Location -LiteralPath 'C:\\proj' -ErrorAction Stop");
  });

  it("dir 内のシングルクオートは '' へエスケープしたまま（PS 文字列を壊さない）", () => {
    expect(cd("C:\\a's dir")).toBe("Set-Location -LiteralPath 'C:\\a''s dir' -ErrorAction Stop");
  });
});

describe("resolveQuickLaunchSlugs（クイック起動ボタン: slug → Project の解決）", () => {
  const projects = [project("a"), project("b"), project("c")];

  it("順序を保ったまま解決する", () => {
    const { resolved, dropped } = resolveQuickLaunchSlugs(["c", "a"], projects);
    expect(resolved.map((p) => p.slug)).toEqual(["c", "a"]);
    expect(dropped).toEqual([]);
  });

  it("未知の slug は落とし、dropped で報告する", () => {
    const { resolved, dropped } = resolveQuickLaunchSlugs(["a", "ghost", "b"], projects);
    expect(resolved.map((p) => p.slug)).toEqual(["a", "b"]);
    expect(dropped).toEqual(["ghost"]);
  });

  it("全滅（全 slug が未知）なら resolved は空、dropped に全部入る", () => {
    const { resolved, dropped } = resolveQuickLaunchSlugs(["x", "y"], projects);
    expect(resolved).toEqual([]);
    expect(dropped).toEqual(["x", "y"]);
  });
});

describe("widthPxToRatio（クイック起動ペイン列: width_px → split 比率の換算）", () => {
  it("通常時はワークスペース実寸に対する素直な比率になる（過剰なクランプで既定の狭さを潰さない）", () => {
    expect(widthPxToRatio(168, 1400)).toBeCloseTo(168 / 1400, 5);
  });

  it("width_px がワークスペース幅より大きい場合は上限にクランプする", () => {
    expect(widthPxToRatio(2000, 1000)).toBe(0.9);
  });

  it("width_px が 0 の場合は下限にクランプする（消えたり0除算したりしない）", () => {
    expect(widthPxToRatio(0, 1000)).toBe(0.05);
  });

  it("width_px が負値の場合も下限にクランプする", () => {
    expect(widthPxToRatio(-50, 1000)).toBe(0.05);
  });

  it("ワークスペース実寸が取得できない/0以下の場合は0.2にフォールバックする", () => {
    expect(widthPxToRatio(168, 0)).toBe(0.2);
    expect(widthPxToRatio(168, -100)).toBe(0.2);
  });
});
