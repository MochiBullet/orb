import { describe, it, expect } from "vitest";
import { buildClaudeCmd } from "./launch";

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
});
