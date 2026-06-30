import { invoke } from "@tauri-apps/api/core";
import { writable } from "svelte/store";

export interface OrbConfig {
  font_size: number;
  font_family: string;
  scrollback: number;
  accent: string;
  bg_image: string;
  bg_dim: number;
}

const DEFAULT: OrbConfig = {
  font_size: 13,
  font_family: '"Cascadia Code", "FiraCode Nerd Font", "Consolas", monospace',
  scrollback: 1000,
  accent: "#2dd4bf",
  bg_image: "",
  bg_dim: 0.6,
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
