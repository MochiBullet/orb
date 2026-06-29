import { invoke } from "@tauri-apps/api/core";

export interface Usage {
  five_hour: number;
  seven_day: number;
  five_reset: string;
  seven_reset: string;
}

export function getUsage(): Promise<Usage> {
  return invoke("get_usage");
}
