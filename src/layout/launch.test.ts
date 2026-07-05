import { describe, it, expect } from "vitest";
import { buildClaudeCmd, cd } from "./launch";

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
