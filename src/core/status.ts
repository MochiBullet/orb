import { invoke } from "@tauri-apps/api/core";

export interface ClaudeStatus {
  model: string;
  effort: string;
  mcp: string[];
}

export function getClaudeStatus(cwd?: string): Promise<ClaudeStatus> {
  return invoke("get_claude_status", { cwd: cwd ?? null });
}
