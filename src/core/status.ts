import { invoke } from "@tauri-apps/api/core";

export interface ClaudeStatus {
  model: string;
  effort: string;
  mcp: string[];
}

export function getClaudeStatus(cwd?: string): Promise<ClaudeStatus> {
  return invoke("get_claude_status", { cwd: cwd ?? null });
}

export type McpStatus = "connected" | "needs_auth" | "failed" | "unknown";

export interface McpHealth {
  name: string; // 短縮名（ClaudeStatus.mcp と同じ突き合わせキー）
  status: McpStatus;
}

/// `claude mcp list` 実測の生死。重い（数秒）ので長間隔＋手動リロードでのみ呼ぶ。
export function getMcpHealth(): Promise<McpHealth[]> {
  return invoke("get_mcp_health");
}

export function getGitBranch(cwd?: string): Promise<string | null> {
  return invoke("get_git_branch", { cwd: cwd ?? null });
}
