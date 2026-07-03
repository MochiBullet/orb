/**
 * #47: キー操作リファレンスの単一ソース。
 * コマンドパレットの説明書モード（CommandPalette.svelte）と info タブ（InfoTab.svelte）の
 * 両方がここを import する（二重管理禁止）。キーの根拠は Workspace.svelte の onKey と
 * Terminal.svelte の capture ハンドラ＝実装に無いキーを書かない。
 */

export interface KeyReference {
  keys: string;
  desc: string;
}

export const KEY_REFERENCE: KeyReference[] = [
  { keys: "Ctrl+Shift+P", desc: "コマンドパレット" },
  { keys: "Ctrl+P", desc: "案件ランチャー" },
  { keys: "Ctrl+T / Ctrl+W", desc: "タブ 新規 / 閉じる" },
  { keys: "Ctrl+Tab", desc: "フォーカスを次ペインへ循環" },
  { keys: "Ctrl+Shift+D / E", desc: "ペイン 横分割 / 縦分割" },
  { keys: "Ctrl+Shift+W", desc: "ペインを閉じる" },
  { keys: "Ctrl+Shift+Z", desc: "ペインをズーム（全面）切替" },
  { keys: "Ctrl+Shift+K", desc: "ターミナルの画面をクリア" },
  { keys: "Ctrl+Shift+B", desc: "サイドバー左右入替" },
  { keys: "Ctrl+↑ / Ctrl+↓", desc: "コマンドブロックを上下ジャンプ" },
  { keys: "Ctrl+F", desc: "ターミナル内を検索" },
  { keys: "Ctrl+L", desc: "選択テキストを AI ペインへ送る" },
  { keys: "Ctrl+Shift+L", desc: "AI ペインの選択をシェルのプロンプトへ（実行は Enter）" },
  { keys: "Ctrl+Shift+H", desc: "ブロック履歴（耐久ログから検索・再構築）" },
  { keys: "Ctrl+Shift+N", desc: "フォーカスモード(DND) 切替" },
  { keys: "Ctrl+Shift+Q", desc: "プロンプトキュー（次の指示を積む→入力待ちで自動投入）" },
  { keys: "Shift+Enter", desc: "改行を送る（Claude Code 等の複数行入力）" },
  { keys: "Ctrl+= / Ctrl+- / Ctrl+0", desc: "文字サイズ 拡大 / 縮小 / リセット" },
  { keys: "Ctrl+, ", desc: "設定を開く" },
  { keys: "ダブルクリック（タブ）", desc: "タブ名をリネーム" },
];
