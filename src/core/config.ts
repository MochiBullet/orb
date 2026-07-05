import { invoke } from "@tauri-apps/api/core";
import { writable } from "svelte/store";

export interface OrbConfig {
  font_size: number;
  font_family: string;
  scrollback: number;
  accent: string;
  ligatures: boolean;
  bg_image: string;
  bg_dim: number;
  /** 背景画像の表示サイズ（CSS background-size）。"cover" / "contain"。 */
  bg_size: string;
  /** 背景画像の表示位置 0..100%（cover 時のクロップ位置調整）。x=水平, y=垂直。 */
  bg_pos_x: number;
  bg_pos_y: number;
  /** #47: 起動時に info（取扱説明書）タブを開く（復元セッションに無ければ末尾へ補充）。 */
  show_info_on_startup: boolean;
}

const DEFAULT: OrbConfig = {
  font_size: 13,
  font_family: '"Cascadia Code", "FiraCode Nerd Font", "Consolas", monospace',
  scrollback: 1000,
  accent: "#2dd4bf",
  ligatures: true,
  bg_image: "",
  bg_dim: 0.6,
  bg_size: "cover",
  bg_pos_x: 50,
  bg_pos_y: 50,
  show_info_on_startup: true,
};

/** ~/.config/orb/config.toml の内容。起動時に loadConfig() で埋める。 */
export const config = writable<OrbConfig>(DEFAULT);

export function saveConfig(c: OrbConfig): Promise<void> {
  return invoke("save_config", { config: c });
}

export async function loadConfig(): Promise<void> {
  try {
    const c = await invoke<OrbConfig>("get_config");
    config.set(c);
  } catch (e) {
    console.warn("[orb] config load failed, using defaults", e);
  }
}
