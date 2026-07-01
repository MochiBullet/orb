import type { IClipboardProvider } from "@xterm/addon-clipboard";

/**
 * orb の OSC 52 クリップボードプロバイダ（#35）。
 *
 * - **write は通す**：TUI/CLI（tmux `set-clipboard on` 等）が `OSC 52;c;<base64>` で
 *   コピーしたら OS クリップボードへ反映する（WebView2 の navigator.clipboard = OS クリップボード）。
 * - **read は既定拒否**：`OSC 52;c;?`（クリップボード読み出し要求）には空文字を返す。
 *   端末に流れてくる任意のプロセス（AI エージェント含む）が OS クリップボードを
 *   吸い出す exfiltration を防ぐ。他の主要端末と同じ default-deny 方針（issue #35 のレビュー）。
 *   ユーザー操作のコピー/ペースト（選択コピー・右クリック貼り付け）はこの経路を通らないため影響なし。
 */
export const orbClipboardProvider: IClipboardProvider = {
  writeText(_selection, text): Promise<void> {
    return navigator.clipboard.writeText(text);
  },
  readText(_selection): string {
    return "";
  },
};
