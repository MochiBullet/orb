import { writable } from "svelte/store";

/** OSC 633;P;Cwd マーカーで更新される現在の作業ディレクトリ（フルパス）。 */
export const cwd = writable<string>("");
