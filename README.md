# orb

**Rust製・バイブコーディング専用ターミナルエミュレータ。**
軽量 × リッチ（ネオン/サイバー）を狙う、（MochiBullet）専用ターミナル。

> 16GB RAM・4コアの非力めノートでもヌルヌル最強に戦える軽さを第一制約に設計。
> Claude Code との並走（バイブコーディング）を前提にした、AI常駐パネル・Warp風コマンドブロック・案件ランチャーを持つ。

---

## インストール

> Windows 専用。実行には **PowerShell 7 (`pwsh`)** と **WebView2 ランタイム**（Win10/11 は標準）が必要です。

### 1. 手動ダウンロード（おすすめ）

[Releases](https://github.com/MochiBullet/orb/releases) から取得：

- **インストーラ** — `orb_*_x64-setup.exe`（NSIS）または `*.msi`
- **ポータブル版** — `orb-x86_64-pc-windows-msvc.exe`（インストール不要・単体起動）

### 2. cargo-binstall（prebuilt を取得）

```sh
cargo binstall orb
```

Releases のポータブル exe を `~/.cargo/bin` へ展開します（ビルド不要）。
※ GUI（フロント／WebView）を伴うため `cargo install orb` には非対応です。

### 3. winget

```sh
winget install MochiBullet.orb
```

（[winget-pkgs](https://github.com/microsoft/winget-pkgs) への登録後に利用可能）

### 4. ソースからビルド

```sh
git clone https://github.com/MochiBullet/orb
cd orb
pnpm install
pnpm tauri build
# インストーラ → src-tauri/target/release/bundle/
# ポータブル exe → src-tauri/target/release/orb.exe
```

詳しい前提・開発手順は [開発](#開発) を参照。

---

## 技術スタック

| 層 | 採用 |
|---|---|
| アプリ基盤 | **Tauri 2.x**（Rustコア × WebView2 UI、Windows標準WebViewで同梱不要・軽量）|
| PTY | `portable-pty`（Windows は内部 ConPTY）|
| Async | `tokio`（Tauri command 用。PTY reader は専用 std::thread）|
| IPC | Tauri 2 **Channel API**（PTY出力は**生バイトフレーム**で送る）|
| UI描画 | `@xterm/xterm` 6.x + `addon-webgl` / `addon-fit` / `addon-unicode11` / `addon-clipboard` / `addon-search` |
| フロント | **Svelte 5 (runes) + Vite + TypeScript**（SvelteKitは使わない＝単一ウィンドウSPAに最小ランタイム）|
| スタイル | プレーンCSS + CSS変数（Tailwind不使用＝依存ゼロ）|
| 既定シェル | `pwsh.exe` 7+（UTF-8、ユーザーの既存 profile.ps1 をそのまま起動）|
| HTTP | `reqwest`（サイドバーのトークン使用量取得のみ）|
| テスト | `vitest`（レイアウトツリーのユニットテスト）|

リリースビルドは `lto + codegen-units=1 + panic=abort + strip + opt-level="s"` でバイナリ・常駐RAMを最小化。

### 実測（2026-06-30）

| 指標 | 値 |
|---|---|
| バイナリ（release `orb.exe`）| **5.37 MB**（debug 21.5 MB の約 1/4。WebView2 は Windows 標準で同梱不要）|
| 常駐 RAM | 約 34 MB（複数ペイン / タブ操作でも安定）|

> 同梱 Chromium を持つ Electron 系（exe 100MB超・RAM 数百MB）と比べ、exe・常駐とも桁違いに軽い。起動時間・大量出力スループットの実測は今後追加予定。

## 機能

- **コマンドブロックUI** — OSC 133/633 を解釈して Warp 風のブロック境界・終了コードバッジ（成功 teal / 失敗 red）を decoration で乗せる。各ブロックに hover ツールバー（`copy` / `→AI`）。プロンプト間ジャンプ（Ctrl+↑/↓）。**alt-buffer（vim/lazygit/btop/fzf 等）中はブロック処理を完全停止**。
- **ペイン分割** — 横/縦分割、フォーカス枠グロー、スプリッタドラッグでリサイズ、閉じると兄弟が昇格。分割時は**フォーカス中ペインの cwd を継承**。ツリーは flat-geometry で、分割やタブ切替で端末（PTY）を殺さない。
- **タブ** — 複数ワークスペース。タブを切り替えても**全タブの PTY とスクロールバックが生存**（非アクティブは display 非表示）。
- **案件ランチャー** — `~/.config/orb/projects.toml` の案件を Ctrl+P パレットから起動。`dev3` プリセット＝左 AI(`claude --continue`) / 右上 dev / 右下 `lg`（lazygit）の3ペインを正しい cwd で spawn。
- **AI（Claude）ペイン** — `claude --continue` を violet 差し色の専用ペインで常駐。別ペインの選択範囲（Ctrl+L）やコマンドブロック（→AI ボタン）を AI ペインの stdin へ送る。
- **サイドバー** — トークン使用量（5h / 7d、80%超で赤）を 30秒ごとに表示。
- **設定GUI** — Ctrl+, でフォント / scrollback を編集、`config.toml` に保存。フォントサイズは全ペインに即反映。
- **フォントズーム** — Ctrl+ホイール / Ctrl+= / Ctrl+- / Ctrl+0（行列維持の font zoom）。
- **スクロールバック検索** — Ctrl+F。
- **カスタムタイトルバー** — `decorations:false`、翡翠グラデ、ランチャーにオーロラ演出（transform 駆動・reduced-motion 尊重）。

## キーバインド

| キー | 動作 |
|---|---|
| `Ctrl+Shift+D` / `Ctrl+Shift+E` | 横分割 / 縦分割 |
| `Ctrl+Shift+W` | ペインを閉じる |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | ペインのフォーカス巡回 |
| `Ctrl+T` / `Ctrl+W` | 新規タブ / タブを閉じる |
| `Ctrl+P` | 案件ランチャー |
| `Ctrl+,` | 設定 |
| `Ctrl+F` | スクロールバック検索 |
| `Ctrl+ホイール` / `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | フォント拡大 / 縮小 / リセット |
| `Ctrl+↑` / `Ctrl+↓` | 直前 / 直後のプロンプトへジャンプ |
| `Ctrl+L` | 選択範囲を AI ペインへ送る |
| `Ctrl+C` / `Ctrl+V` | コピー（選択時）/ ペースト |

> 注: タッチパッドのピンチは WebView2 がネイティブ処理し JS に届かないため、font zoom は Ctrl+ホイール / Ctrl+± で行う（[#10](https://github.com/MochiBullet/orb/issues/10)）。

## 設定（XDG: `~/.config/orb/`）

| ファイル | 中身 |
|---|---|
| `config.toml` | `font_size` / `font_family` / `scrollback`（無ければ既定を書き出す。Ctrl+, でも編集可）|
| `projects.toml` | 案件ランチャーの `[[project]]` 群（無ければ既定10案件を書き出す）|

`shell-integration.ps1`（OSC 133/633 注入）はバイナリに埋め込み、起動時に `%TEMP%\orb\` へ一度だけ展開される。

## アーキテクチャ（責務分割が背骨）

- **Rust = ステートフルで重い/危険なものだけ**：PTYライフサイクル、生バイトのChannel配線、設定/案件DBロード、usage取得、ウィンドウ制御。`PaneId → PTYハンドル` のフラットな `HashMap` だけ持つ＝激薄。
- **フロント = 見た目と配置の全部**：レイアウトツリー（分割・フォーカス・サイズ）、タブ、xterm描画、コマンドブロックUI、AIパネル、ランチャー、サイドバー、設定、タイトルバー。
- **ペインのレイアウトツリーはフロント権威**（xterm は DOM に生き、分割/リサイズ/タブ切替は純UI事象）。端末の生存は paneId で決まり、ツリーの形とは独立（flat-geometry）。
- **PTY teardown**：kill は (1) taskkill /T でプロセスツリーごと → (2) writer/master drop で ConPTY を ClosePseudoConsole → (3) reader を join。**master drop を join の前に**行うのが要点（さもないと ConPTY が EOF にならずハングする）。

## 開発

前提：Rust stable / Node 20+ / pnpm / pwsh 7+ / WebView2（Win10/11標準）。

```sh
pnpm install
pnpm tauri dev      # 開発（ホットリロード）
pnpm test           # レイアウトツリーのユニットテスト（vitest）
pnpm check          # svelte-check（型）
pnpm tauri build    # リリースビルド
```

## ディレクトリ

```
src/                    フロント（Svelte 5 + Vite）
  App.svelte            ルート（TitleBar / TabBar / Workspace / Sidebar）
  main.ts               mount エントリ（config を先読み）
  core/                 config / pty / usage（invoke 薄ラッパ）
  terminal/             Terminal.svelte + blocks/osc.ts（OSC状態機械＋decoration）
  layout/               tree.ts（分割ツリー）/ Workspace.svelte / tabs.ts / launch.ts / Launcher.svelte
  chrome/               TitleBar / TabBar / Sidebar / Settings
  store/                appStore（cwd / layout / focus / aiPane）
  styles/               テーマトークン / ネオン演出 / ベース
src-tauri/              Rustコア
  src/                  lib.rs / commands.rs / pty.rs / shell.rs / config.rs / usage.rs / state.rs / error.rs
  resources/            shell-integration.ps1（OSC133/633注入）
  tauri.conf.json       decorations:false 等
```

## 進捗 / Issue

MVP（P0〜P3）完成後、拡張を **GitHub Issue** で管理（Termux 等からの引き継ぎ担保）。

実装済み: コマンドブロック＋ツールバー / ペイン分割（cwd継承）/ タブ / 案件ランチャー / AIペイン / サイドバー（トークン）/ 設定GUI / フォントズーム / 検索 / aurora演出 / レイアウトツリーのユニットテスト。

継続: クロスプラットフォーム（[#17](https://github.com/MochiBullet/orb/issues/17)）/ サイドバーのモデル・MCP連携（[#18](https://github.com/MochiBullet/orb/issues/18)）/ 描画スループット実測（[#16](https://github.com/MochiBullet/orb/issues/16)）/ ロゴ（[#11](https://github.com/MochiBullet/orb/issues/11)）。

## 継承している既存資産

- 配色：`~/.config/starship.toml` の `[palettes.mochibullet]`（teal `#2dd4bf` / violet `#a78bfa` / 黒 `#000` …）
- ネオン演出：`corporate-website-template-cloudflare` の `globals.css`（`.dream-glow` 等、transform/opacity駆動で軽量）
- 案件DB・3ペイン思想：`~/.config/claude/tools/gen-warp-launch-configs.ps1`
- 起動シェル：`~/.config/powershell/profile.ps1`（PSReadLine / zoxide / fzf / starship / eza / bat / lazygit）
