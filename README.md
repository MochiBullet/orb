# orb

**Rust製・バイブコーディング専用ターミナルエミュレータ。**
世界最軽量 × 世界一リッチ（ネオン/サイバー）を狙う、もっちゃん（MochiBullet）専用ターミナル。

> 16GB RAM・4コアの非力めノートでもヌルヌル最強に戦える軽さを第一制約に設計。
> Claude Code との並走（バイブコーディング）を前提にした、AI常駐パネル・Warp風コマンドブロック・案件ランチャーを持つ。

---

## 技術スタック

| 層 | 採用 |
|---|---|
| アプリ基盤 | **Tauri 2.x**（Rustコア × WebView2 UI、Windows標準WebViewで同梱不要・軽量）|
| PTY | `portable-pty`（Windows は内部 ConPTY）|
| Async | `tokio`（Tauri command 用。PTY reader は専用 std::thread）|
| IPC | Tauri 2 **Channel API**（PTY出力は**生バイトフレーム**で送る）|
| UI描画 | `@xterm/xterm` 5.x + `addon-webgl` / `addon-fit` / `addon-unicode11` / `addon-clipboard` |
| フロント | **Svelte 5 (runes) + Vite + TypeScript**（SvelteKitは使わない＝単一ウィンドウSPAに最小ランタイム）|
| スタイル | プレーンCSS + CSS変数（Tailwind不使用＝依存ゼロ）|
| 既定シェル | `pwsh.exe` 7+（UTF-8、ユーザーの既存 profile.ps1 をそのまま起動）|

リリースビルドは `lto + codegen-units=1 + panic=abort + strip + opt-level="s"` でバイナリ・常駐RAMを最小化。

## アーキテクチャ（責務分割が背骨）

- **Rust = ステートフルで重い/危険なものだけ**：PTYライフサイクル、生バイトのChannel配線、設定/案件DBロード、ウィンドウ制御。`PaneId → PTYハンドル` のフラットな `HashMap` だけ持つ＝激薄。
- **フロント = 見た目と配置の全部**：レイアウトツリー（分割・フォーカス・サイズ）、xterm描画、コマンドブロックUI、AIパネル、ランチャー、タイトルバー。
- **ペインのレイアウトツリーはフロント権威**（xterm は DOM に生き、分割/リサイズは純UI事象）。

## 開発

前提：Rust stable / Node 20+ / pnpm / pwsh 7+ / WebView2（Win10/11標準）。

```sh
pnpm install
pnpm tauri dev      # 開発（ホットリロード）
pnpm tauri build    # リリースビルド
```

## ディレクトリ

```
src/                    フロント（Svelte 5 + Vite）
  App.svelte            ルート
  main.ts               Svelte 5 mount エントリ
  styles/               テーマトークン / ネオン演出 / ベース
  （以降 terminal/ layout/ ai/ launcher/ chrome/ core/ を追加していく）
src-tauri/              Rustコア
  src/                  lib.rs / pty / shell / config / launcher / commands（順次追加）
  resources/            shell-integration.ps1（OSC133/633注入・予定）
  tauri.conf.json       decorations:false 等
```

## フェーズ / 進捗

MVP = P0〜P3。詳細・受け入れ条件・検証手順は **GitHub Issue** で管理（Termux等からの引き継ぎ担保）。

- **P0 骨格** — 1ペイン pwsh が動く（カスタムタイトルバー / xterm WebGL / Channel双方向 / UTF-8 / テーマ）
- **P1 ブロックUI** — Warp風（OSC133/633注入＋decorationでブロック境界・終了コードバッジ・alt-buffer停止）
- **P2 ランチャー＋ペイン** — 案件3ペイン起動（warp案件DB移植・dev3プリセット・分割/フォーカス/リサイズ）
- **P3 AIパネル** — `claude --continue` 常駐＋選択/ブロックをAIへ送る導線
- **P4+** — ブロック折りたたみ/共有・複数タブ・設定GUI・テーマエディタ 等

## 継承している既存資産

- 配色：`~/.config/starship.toml` の `[palettes.mochibullet]`（teal `#2dd4bf` / violet `#a78bfa` / 黒 `#000` …）
- ネオン演出：`corporate-website-template-cloudflare` の `globals.css`（`.dream-glow` 等、transform/opacity駆動で軽量）
- 案件DB・3ペイン思想：`~/.config/claude/tools/gen-warp-launch-configs.ps1`（11案件＋vibe3レイアウト）
- 起動シェル：`~/.config/powershell/profile.ps1`（PSReadLine / zoxide / fzf / starship / eza / bat / lazygit）
