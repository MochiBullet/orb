# orb — vibe-coding 最強機能 & 差別化 50案

> 2026-06-30 リサーチ。競合ターミナル4方面（Warp / Wave・iTerm2・Tabby・Hyper・Windows Terminal / WezTerm・Kitty・Ghostty・Alacritty・Rio / AIコーディングワークフロー需要）の徹底調査＋orb固有戦略を統合。
> 各案タグ: **Impact**(vibeレバレッジ ★1–5) / **Diff**(競合がやってない度 ★1–5) / **Effort**(S/M/L/XL) / **基盤**(既存orb資産に乗るか)。

---

## 0. 差別化テーゼ — orb は何になるか

**「orb = AIコーディングエージェントを操縦するためのコックピット（agent-native terminal）」**

リサーチで固まった勝ち筋：**ターミナルは唯一、全部を“既に見てる”最下層レイヤー**。打ったコマンド・出力・exit code・cwd・git状態・そしてエージェントのプロセス本体——全部ターミナルの中にある。IDEプラグインや各エージェントCLIは「自分のスコープ」しか見えないが、orbは下にいるから **どのエージェント（Claude Code / Codex CLI / Gemini CLI / aider / OpenCode…）にも共通で機能を被せられる**。

- Warp はこれを「Agentic Development Environment」として突っ走ってるが、**クローズド＆ロックイン気味＆チーム機能は有料（$20〜$50/月）**。
- orb の差し方 ＝ **BYO-agent・オープン・ローカル/Git管理・Windows一級市民**。Warpが囲ってる体験を、orbはオープン＆Windowsで獲る。
- orbは既に土台がある：コマンドブロック(OSC133/633)・ペイン/タブ・コマンドパレット・案件ランチャー・`claude --continue`常駐ペイン・MCP/使用量サイドバー・broadcast・セッション復元・通知・合字・クリア・コピペ。

**現場の3大ペイン（調査で裏取り）**
1. **お守り(babysitting)**：エージェント待ちでログ凝視、1時間に10〜20回の文脈切替で集中崩壊。AI生成コードの修正に追加時間（約800人調査で95%）。
2. **承認疲れ(approval fatigue)**：Claude Codeユーザーは許可プロンプトの**93%を無思考で承認**＝実質ノーチェック。かといって全許可(`--dangerously-skip-permissions`)は危険。
3. **文脈ロスト**：compactionがscrollbackを破壊（Claude Code Issue #24705）、resume不能ケース、長セッションの引き継ぎ難。

→ orbの3本柱 ＝ **①コンテキスト捕獲を摩擦ゼロに ②マルチエージェントを見て捌く ③速いのに安全（承認疲れをyoloにせず減らす）**。

---

## 1. コンテキスト捕獲 — 「エージェントに食わせる」摩擦をゼロに
*orbのブロック基盤(OSC133/633)が直接効く最強ゾーン。*

1. **ブロック→エージェント送信** — 選択ブロック（コマンド＋出力＋exit code）を構造化して現役エージェントのstdinへ注入。既存Ctrl+Lの一般化。`Impact★5 Diff★4 Effort S 基盤◎`（Warp #2 / iTerm2 captured-output と同根、orbは境界を既にパース済）
2. **「これ直して」ワンクリック（exit≠0トリガー）** — 失敗ブロックに「Fix with agent」。失敗コマンド＋全出力＋cwd＋直近diffを自動梱包して送信。最頻デバッグループを最速化・デモ映え最強。`Impact★5 Diff★5 Effort S 基盤◎`（Warp Suggested-fix #14 を全エージェントへ）
3. **エラー説明（右クリック→AIに聞く）** — エラー出力を右クリ「説明させる/不足依存を挙げさせる」。`Impact★4 Diff★3 Effort S 基盤◎`（Warp #15）
4. **スクショ/領域キャプチャ→ビジョン送信（Windows堅牢版）** — orb内蔵キャプチャ→PNG→現役エージェントへ画像添付。**Claude CodeのWindows画像貼り付けは未解決の罠（Issue #26679）**＝orbがOS一段下で吸収する明確な勝ち筋。`Impact★5 Diff★4 Effort M 基盤○`
5. **堅牢クリップボード画像貼り付け** — BMP/PNG/HTML/ファイル全形式を正規化して添付。`Win+Shift+S`直後の直貼りも成功。`Impact★4 Diff★4 Effort S–M 基盤○`
6. **ドラッグ&ドロップ添付** — ファイル/画像/フォルダをペインにドロップ→cwd基準で相対パス解決し`@file`/画像/ツリー要約へ自動変換。`Impact★4 Diff★3 Effort S 基盤◎`
7. **スクロールバック/直近N注入** — 「直近K分」「直近Nブロック」「セッション全部」をワンキーで束ねて文脈添付。OSC133境界でクリーンに切る。`Impact★4 Diff★4 Effort M 基盤◎`
8. **構造化コンテキスト・スタンプ** — 送信時に cwd・git branch/status・主要env・OSを不可視メタで自動添付。「動かない理由」の自己申告を削る。`Impact★4 Diff★4 Effort S 基盤◎`

## 2. マルチエージェント・オーケストレーション — N体回して、見て、捌く
*P2ペイン分割と相性最高。実用上限5〜6体（それ以上はレビュー/マージ負荷が利得を食う）。*

9. **エージェント・ステータスバッジ（hook駆動）** ⭐ — 各ペイン/タブに状態バッジ（🟢実行中/🟡入力待ち/✅完了/🔴失敗/🔔要承認）。OSC133のexit＋アイドル検知＋エージェント出力パターンで判定。**Wave Terminalが Claude Code の lifecycle hook(`wsh badge`)でやってる「どのペインが自分待ちか一目」がN体運用の#1課題解決**。フォーカスで自動クリア。`Impact★5 Diff★4 Effort M 基盤◎`
10. **エージェント・インボックス** — 入力待ち/承認待ち/失敗のエージェントだけを集約パネルに昇格。見落としで時間を溶かす問題の本丸。`Impact★5 Diff★4 Effort M 基盤○`
11. **ステータス付きペイングリッド** — P2ペインに#9のバッジ＋直近トークン＋cwd＋ブランチを集約、「今N体動いてる」を俯瞰。`Impact★5 Diff★5 Effort M 基盤◎`
12. **worktree自動立ち上げ** — 「新タスク」入力→`git worktree add`＋ブランチ＋専用ペイン＋エージェント起動を1アクション。テンプレで.env/DB名を自動分離（並列の鉄則）。`Impact★4 Diff★5 Effort L 基盤○`（Claude Code `isolation: worktree`・Claude Squad/Conductor代替）
13. **Fan-out ランチャー** — 1プロンプトを複数エージェントへ同時投下（別worktree/観点別）。案件ランチャーを「エージェント編成」に拡張。`Impact★5 Diff★5 Effort L 基盤○`
14. **クロスエージェント・タスクボード（kanban）** — Todo→In-progress(エージェント割当)→Review→Done。各カードがworktree＋ペイン＋セッションに紐づく。受託の複数案件並行に直刺さり。`Impact★4 Diff★5 Effort L 基盤○`（Vibe Kanban流）
15. **集約diffレビュー** — 全worktreeの差分を1パネルに集約、ブランチ単位タブ、ハンク承認→該当worktreeにstage。`Impact★5 Diff★4 Effort L 基盤○`
16. **エージェント間メッセージ橋渡し** — あるエージェントの出力/成果物を別エージェントのstdinへ（Ctrl+Lを「ペイン→ペイン」「結果→新プロンプト」へ一般化）。`Impact★4 Diff★4 Effort M 基盤◎`

## 3. 待ち問題キラー — 通知・キュー・非同期で「お守り」を殺す

17. **ネイティブ通知（誤検知潰し版）** ⭐ — PTYアイドル＋OSC133のcommand-finished＋エージェント既知プロンプト形を合わせて**確度の高い**「完了/入力待ち」判定→Windowsトースト＋音。**Claude Codeのhook頼み通知は誤爆既知（#12048/#16975）**＝orbの統一判定が上回れる。`Impact★5 Diff★4 Effort M 基盤◎`
18. **プロンプト・キュー** — エージェント実行中でも入力欄に「次のタスク」を積める。アイドル検知で自動送信。複数積み可。実装軽い割に待ち時間を価値化。`Impact★5 Diff★4 Effort S 基盤○`（Warp `/queue`）
19. **バックグラウンド/ヘッドレス実行＋完了ping** — 「投げて裏へ」。orbのバックグラウンドジョブとして回し完了でインボックス＋通知。`Impact★4 Diff★4 Effort M 基盤○`
20. **フォーカスモード（DND）** — 対応が要るときだけ鳴らす。進捗は静かに、入力待ち/失敗/完了だけ昇格。`Impact★3 Diff★3 Effort S 基盤○`
21. **完了→次アクション提案** — アイドル化(OSC133;D)で「次の指示」候補をパレットに出す/通知。`Impact★4 Diff★4 Effort M 基盤◎`

## 4. レビュー・信頼・安全 — 承認疲れを、yoloにせず減らす

22. **統一diffレビュー・パネル（fs-watch）** — プロジェクトFSを監視→エージェントの書き込みをハンク単位で表示、accept/reject/編集をディスク反映前に。**エージェント非依存**でdiff UIの弱いCLIを底上げ。`Impact★5 Diff★4 Effort L 基盤○`（Windsurf Cascade流）
23. **リスク階層コマンド・ゲート** ⭐ — 端末がエージェント発行コマンドを分類（read-only=自動、`rm -rf`/`DROP`/force push=必ず確認）。承認の93%無思考クリック問題を**端末側**で全エージェントに安全網。`Impact★4 Diff★4 Effort M 基盤○`（Anthropic auto-mode を端末で汎用化）
    - ⚠️ **fast-track 厳禁**：ここは orb が**エージェントの実行を握る面**。分類バグで `rm -rf`/force push を誤って自動承認したら破滅的＝quick win ではない。**S枠に降ろさず M のまま、判定は保守的（迷ったら確認）に**。急がないのが正解。
24. **ワンキー承認オーバーレイ** — 許可プロンプト検知→統一オーバーレイ（approve / reject / edit / 別アプローチ指示）を全エージェントへ。`Impact★4 Diff★4 Effort M 基盤○`（#23 と同じ理由で **fast-track 厳禁・M 据え置き**）
25. **即ロールバック/チェックポイント** — ターン開始時に自動 `git stash`/shadow-commit、ワンキーで直前ターンに戻す。「壊されても戻せる」で承認を緩められる→速度UP。`Impact★4 Diff★4 Effort M 基盤○`（Cursor/Windsurf checkpoint）
26. **監査ログ/セッショントレース** — コマンド・exit・差分・承認可否を時系列記録、エクスポート可。受託の説明責任・引き継ぎに直結。`Impact★3 Diff★4 Effort M 基盤◎`
27. **危険コマンド・プレビュー** — AI生成コマンドを実行前にハイライト＆要確認（#23の軽量入口）。`Impact★4 Diff★4 Effort M 基盤○`
28. **シークレット赤字マスク** — APIキー的文字列を画面/共有/AI送信で自動マスク（entropy/regex）。`Impact★3 Diff★4 Effort M 基盤○`（Warp #41）

## 5. 文脈・セッションの継続性

29. **プロジェクト・ワークスペース復元** — プロジェクト＝ペイン構成＋cwd＋env＋起動エージェント＋steeringファイルの束。選ぶだけ丸ごと復元。`Impact★5 Diff★3 Effort M 基盤◎`（orbのP2＝Warp launch config の正統進化）
30. **compaction耐性スクロールバック** — orbがブロック履歴を独立保持。エージェントが画面クリアしてもorbのログは無傷＋compaction前に自動スナップ。`Impact★4 Diff★5 Effort M 基盤◎`（Claude Code #24705 の明確な救済）
31. **セッション要約・引き継ぎエクスポート** — ブロック履歴＋差分＋決定事項から「セッション要約MD」を自動生成。次セッション/別エージェント/Termux引き継ぎへ。`Impact★4 Diff★4 Effort M 基盤◎`
32. **エージェント・プロファイル（案件別）** — 案件別にエージェント種別/モデル/権限モード/steering（CLAUDE.md・AGENTS.md・.cursorrules）をプロファイル化、ランチャーから起動。`Impact★4 Diff★4 Effort M 基盤◎`
33. **rules/context ファイル自動注入** — repo root＋cwdの `CLAUDE.md`/`AGENTS.md`/`WARP.md`/Cursor rules を読み込みエージェントへ。`Impact★4 Diff★2 Effort S 基盤◎`（Warp #21・低工数の即効）

## 6. コマンドブロック & 出力知能 — orbの強みを伸ばす

34. **exit-status ガター＋プロンプトジャンプ** — 各ブロックの成否を行頭ガターにアイコン表示、prompt間ジャンプ、「このコマンド出力を選択」。`Impact★4 Diff★2 Effort S 基盤◎`（iTorm2 #10・orbはOSC133データを既に保有）
35. **トリガー（regex→アクション）** ⭐ — 出力に対するユーザー定義regexルールがハイライト/通知/captured-output/AIルーティング/markを発火。orbの通知を「内容認識」へ進化。`Impact★4 Diff★4 Effort M 基盤◎`（iTerm2 #11）
36. **Captured Output（エラー・インボックス）** — トリガーで拾った行（コンパイルエラー等）を集約パネルに、クリックでジャンプ。`Impact★4 Diff★4 Effort M 基盤○`（iTerm2 toolbelt）
37. **semantic history（file:line クリック→エディタ）** — 出力中の `src/foo.ts:42` をクリックでZed等が該当行を開く。`Impact★4 Diff★3 Effort S–M 基盤◎`（orbのURLクリック機構の拡張）
38. **ブロック折りたたみ＋AI1行要約** — 長い出力を畳む＋要約（既存#15発展）。`Impact★4 Diff★4 Effort M 基盤◎`
39. **コマンド履歴パレット** — 全ブロックを横断検索（コマンド/出力/exit/cwd/git/時刻）。「動いたコマンド」を再利用/AIへ。`Impact★4 Diff★3 Effort M 基盤◎`
40. **ブロックのピン留め/ノート** — 重要な実行結果を上部固定＋メモ。`Impact★3 Diff★3 Effort S 基盤◎`

## 7. ナビ・入力エルゴノミクス — モダン端末の手癖

41. **Hints / Quick-Select（アクション付き）** ⭐ — 画面内のURL/path/hash/IP/行番号にキーラベルを重畳、タイプで コピー/開く/AI送信/エディタ起動。**マウスレスでAI出力を拾う**。`Impact★4 Diff★3 Effort M 基盤○`（kitty hints / WezTerm quick-select / Alacritty regex-hints）
42. **モダン入力エディタ** — 複数行編集・括弧/クォート自動補完・クリックカーソル・履歴ゴースト補完。**Warp最大の moat（11ヶ月かけた）**。長いAI生成コマンドの編集が別物に。`Impact★4 Diff★4 Effort L 基盤△`（xterm入力線の外にCodeMirror等のオーバーレイ）
43. **オートサジェスト（履歴ゴースト）** — 履歴/補完からインライン灰色ゴースト、→で確定。`Impact★3 Diff★2 Effort M 基盤△`（Warp #6）
44. **コマンド補正（autocorrect）** — 失敗後にタイポ/フラグ修正を提案（thefuck風だが自動・インライン）。`Impact★3 Diff★3 Effort M 基盤○`（Warp #8）
45. **コマンドパレットのAI化（NL→コマンド）** — 自然言語→コマンド生成を実行前確認付きでパレット統合。`Impact★4 Diff★3 Effort M 基盤◎`
46. **Quake/ドロップダウン（グローバルホットキー）** ⭐ — どのアプリ作業中でも一発でスライドインする常駐AI端末→隠す。「常時手元のエージェント」体験。`Impact★4 Diff★4 Effort M 基盤○`（Windows Terminal _quake / Ghostty quick-terminal）

## 8. 知識・自動化（Warp Drive 対抗・オープン/ローカルで差別化）

47. **保存ワークフロー＋クロスエージェント・スラッシュパレット** — パラメータ付き定型コマンド/プロンプト(`$ARGUMENTS`)を保存→パレットから現役エージェントへ展開。**Claude Codeの`.claude/commands`はツール毎に分断→orbが共通化**。dotfiles/Git管理＝チーム課金不要が差別化。`Impact★4 Diff★3 Effort M 基盤◎`（Warp Drive #25/#27 のオープン版）
48. **ノートブック/Runbook** — 手順をMarkdownで残し各コマンドをクリック実行＋Mermaid描画。オンボーディング/手順書をAIも人も実行可能に。`Impact★3 Diff★3 Effort M 基盤○`（Warp #26）
49. **env/シークレット・プロファイル** — 案件別env束をワンクリックロード、1Password/Vault連携でAI文脈にキーを漏らさない。`Impact★3 Diff★3 Effort M 基盤○`（Warp #28）

## 9. ビジュアル / グラフィカルブロック / マルチモーダル

50. **`orb` サイドカーCLI → GUI制御バス** ⭐⭐ — shellに注入した`orb`バイナリで `orb view file` `orb diff` `orb web localhost:5173` `orb ai "msg"` `orb badge` … をローカルソケット→Tauriイベントで実行。**エージェント自身が1コマンドでプレビュー/差分/Web/文脈投入を開ける＝最も agent-native な原始機能**。`Impact★5 Diff★5 Effort L（local版はM） 基盤○`（Wave `wsh` / Windows Terminal `wt` の思想）
51. **ポリモーフィック・ブロック** — ペインを型付き（terminal/file/dir/web/markdown/diff/sysinfo）に。Svelteコンポーネントをxtermの代わりに描画。`Impact★4 Diff★5 Effort L 基盤○`（Wave graphical blocks）
52. **Webブロック（埋め込みプレビュー）** — `pnpm dev`のローカルURL/ドキュメント/検索を端末内のwebviewブロックで。Tauriならほぼ無料。`Impact★4 Diff★4 Effort S–M 基盤○`
53. **Markdownレンダ＋インライン画像** — エージェント生成のplan/specをレンダ表示、画像CLI出力を端末内に（sixel/iTerm2は`addon-image`、Kitty graphicsは自作）。`Impact★3 Diff★3 Effort M–L 基盤○`
54. **音声→プロンプト（ローカルWhisper, push-to-talk）** — ホットキー長押しで転写→入力欄。**Windowsで完結（Warpの音声はmac寄り＝ここで差せる）**。Karpathy/Levels系がvibe高速化で愛用。`Impact★3 Diff★4 Effort M 基盤○`
55. **タブ Color-automation** ⭐ — 実行中プロセス名/cwdパスにマッチさせタブの色/名前を自動付与。「このタブはClaude Code/あれはdev server」を色で即識別＝N体並走の混乱を視覚解決。`Impact★3 Diff★4 Effort M 基盤◎`（Rio）
56. **Custom shader 表面演出** — xterm webgl出力にGLSLポストプロセス（CRT/グロー/翡翠パーティクル）。「世界一リッチ」の見せ場、任意ON。`Impact★2 Diff★3 Effort M–L 基盤△`（Ghostty）
57. **Instant Replay（巻き戻し）** — 画面状態を時系列スナップし、スクラバで遡る。「30秒前にエージェントが消した出力」を再実行せず確認。`Impact★3 Diff★5 Effort L 基盤△`（iTerm2・希少）

## 10. コスト・可観測性・相互運用（オープン性 moat）

58. **ライブ・トークン/コストHUD** ⭐ — エージェントのローカルJSONLを読み、ペイン別/案件別の消費とburn rateを常時表示。**もっちゃんの既存「usage float HUD」＋usage API資産をorbに内蔵移植＝ほぼ再利用**。`Impact★4 Diff★5 Effort S 基盤◎`
59. **予算ガードレール** — 5h/週次上限に対し残量予測（burn rate×reset）、閾値で警告・モデル降格提案・並列数の自動抑制。`Impact★4 Diff★5 Effort S–M 基盤◎`
60. **MCP/権限の可視化＆トグル** — 有効MCP・権限をサイドバーで一望＆切替（既存MCP表示の発展）。`Impact★3 Diff★4 Effort M 基盤◎`
61. **モデルピッカー＋BYOK** — Claude/GPT/Gemini＋自前キーを切替。コスト/品質コントロール・ロックイン回避。`Impact★3 Diff★2 Effort S–M 基盤◎`
62. **WSL/SSH 自動プロファイル検出** — WSLディストリ/SSHホストを自動列挙しランチャーへ。「どこで回すか」をゼロ設定に。`Impact★3 Diff★3 Effort S–M 基盤◎`（Windows Terminal）
63. **Adaptive rendering（省電力/ゲームモード）** — 出力アイドルでFPSスロットル、高負荷時のみ滑らか。**ノートPC(i7)の発熱/電池に効く＝もっちゃんの「軽量×リッチ」原則に完全合致**。`Impact★3 Diff★4 Effort M 基盤○`（Rio）
64. **プラグインSDK（JS/Tauri）** — ユーザーが独自のエージェント/MCP/テーマ統合を後付け。`Impact★3 Diff★3 Effort L 基盤△`（Tabby/Hyper・大コミットだがSvelte/Vite基盤と相性）

*（番号は分類整理の結果 50→64件に膨張。コアは50案、+14は競合由来の補強候補。実装は下のショートリストの順で。）*

---

## ⭐ Top 10「まず作る」ショートリスト（Impact×Diff×低工数×既存基盤）

> **選定基準（2026-07-01 再アンカー）**：**「自分が1日に何度もやってる手数が消えるか」** で選ぶ。*「Warpに勝つか」ではない* — ソロ・非収益化の個人ツールなので、競合マトリクスは参考、基準はあくまで自分の手数。

| # | 案 | 工数 | なぜ今これ |
|---|-----|:---:|------|
| 1 | **#2 「これ直して」ワンクリック** | S | exit code既に捕捉済。最頻ループ最速化・デモ映え最強 |
| 2 | **#1 ブロック→エージェント送信** | S | P1ブロック基盤に直載せ。コンテキスト捕獲の入口 |
| 3 | **#58 トークン/コストHUD** | S | 既存usage HUD＋API資産の移植＝ほぼ再利用。差別化＆実用 |
| 4 | **#17 ネイティブ通知（誤検知潰し）** | M | babysitting体感が一発で変わる。Claude Code #12048系を上回る |
| 5 | **#18 プロンプト・キュー** | S | 実装軽い割に待ち時間を価値化。UI層で完結 |
| 6 | **#9 エージェント・ステータスバッジ** | M | N体運用の#1課題（どれが自分待ち？）を視覚解決。Wave実証済 |
| 7 | **#29/#32 ワークスペース復元＋エージェント・プロファイル** | M | P2そのもの。Warp launch config資産の正統進化・複数案件運用に直効 |
| 8 | **#4/#5 Windows堅牢スクショ＆画像貼り付け** | S–M | Claude Code等が未解決(#26679)の穴。Windows一級の明確な勝ち筋 |
| 9 | **#46 Quake/ドロップダウン** | M | 常時手元の常駐AI端末。companion form-factor が刺さる |
| 10 | **#23 リスク階層コマンド・ゲート** | M | 安全網を端末で汎用化。yoloにせず承認を減らす＝信頼の土台 |

→ **1〜5は「軽い×効く」即効ゾーン**（P1ブロック基盤＋既存usage資産にほぼ乗る）。まずここで「vibe-coding専用ターミナルってこういうことね」を体感させる。6〜8で背骨（マルチエージェント×プロジェクト）、9〜10で「速いのに安全」を確立。各段階が単体で価値を出す順。

### 🏗 基盤枠（Top10と並走で即着手・唯一の複利枠）

| 案 | 工数 | なぜ最優先で並走させるか |
|---|:---:|---|
| **#30 構造化ブロック永続化（append-only JSONL）** | M | Top10 は全部「単発で効く」捕獲/HUD。対して **#30 だけは複利の土台**：ブロックイベント `{command, cwd, exitCode, startTs, endTs, paneId}` を1行ずつ追記保存すると、**★5案 #39（履歴パレット）/#26（監査ログ）/#30-full（compaction耐性ログ）が全部この上に乗る**。`e54d5ce` で保存/復元の**配管（ペイン別ファイル・周期保存・起動復元）は約6割できてる** — ただし今の中身は**平文バッファ復元**で、**データモデル（構造化イベント）は 0%**。まず JSONL でそこを埋める（SQLite はまだ不要＝軽量ethos。#39 が索引/全文検索を要求した時点で SQLite へ昇格）。 |

> **なぜ Top10 の外に別枠で置くか**：Top10 は「今日の手数を軽くする」単発ゾーン、基盤枠は「その上に全部が積み上がる」複利ゾーン。性質が違うので分離した。捕獲系（#1/#2）はもう動いてるので、次は **「捨てずに貯める」に一段降りる** タイミング（＝2026-07-01 レビューの戦略異論を採用）。

## ⚡ クイックウィン（S・基盤◎ で即着手可）
#1 #2 #3 #6 #8 #18 #33 #34 #37 #40 #58

## 🚀 ムーンショット（XL/L・Moat大・orbを“定義づける”）
#50 `orb`サイドカーCLI→GUIバス（agent-native の原始機能）/ #12+#13 worktree自動立ち上げ＋fan-out / #51 ポリモーフィック・ブロック / #22 統一diffレビュー / #57 Instant Replay

## 🚫 やらない/後回し（バックエンド/クラウド依存 or 領域外）
- ブロック共有permalink・リアルタイムセッション共有・Team Drive・Cloud Agents(Oz)＝サーバ必須（Warp有料領域。**“ローカル/オープンで無料”自体がorbの差別化**なので深追いしない）
- 内蔵コードエディタ/Project Explorer全部入り＝IDEの領域に越境（Zed連携#37で代替）
- Kitty graphics protocol フル自作・Kitty keyboard protocol＝xterm.js非対応で高コスト（画像はaddon-imageのsixel/iTerm2で十分）
- remote mux/tmux制御モード・ネイティブUI(Ghostty路線)＝Tauri構成と逆 or 大規模

---

## 競合マトリクス（要点）

| 体験 | Warp | Wave | iTerm2 | orbの取り方 |
|---|---|---|---|---|
| コマンドブロック | ◎ | ○ | ◎(元祖) | **済**（OSC133/633）→出力知能で伸ばす |
| 埋め込みAI/エージェント | ◎(Agent Mode) | ○ | △(plugin) | **済**(claudeペイン)→送信/通知/承認で深掘り |
| マルチエージェント並走 | ○(panes/swarm) | ○(badge) | △ | **狙い目**：ペイン×worktree×バッジでネイティブ化 |
| グラフィカルブロック | △ | ◎(wsh) | △ | ムーンショット#50/#51 |
| 文脈捕獲(出力→AI) | ◎ | ◎(wsh ai) | ○ | **最優先#1/#2**、ブロック基盤で綺麗に勝てる |
| トークン/コスト可視化 | △ | △ | ✗ | **#58 既存資産移植で即勝ち** |
| 入力エディタ | ◎(moat) | ○ | △ | #42 長期投資（差は大きいが工数L） |
| Quake/常駐 | ✗ | ✗ | ✗ | **#46 空白地帯** |
| 価格/オープン性 | 有料寄り/クローズド | OSS | 無料(mac専) | **ローカル/オープン/Win一級＝orbの土俵** |

---

## 主要ソース（裏取り）
- Warp: warp.dev（/ai /agents /modern-terminal /drive /pricing）, docs.warp.dev（blocks, editor, warpify/ssh, agent-platform, code, changelog 2026）
- Wave: waveterm.dev（wsh, blocks, Claude Code badge hooks, ai）
- iTerm2: 公式docs（triggers, shell integration, captured output, semantic history, Python API, Instant Replay）
- WezTerm / Kitty / Ghostty / Alacritty / Rio: 各公式（graphics/keyboard protocol, hints/quick-select, lua, shaders, color-automation, adaptive rendering）
- AIワークフロー: code.claude.com/docs（worktrees, agent-teams）, anthropic.com/engineering/claude-code-auto-mode, Claude Code Issues #24705 #22528 #12048 #16975 #26679 #14472 #26317, ccusage.com, termul.dev, agentsroom.dev, claude-squad, news.ycombinator.com（vibe-coding調査）

---

*生成: 2026-06-30 / 4方面リサーチ（Warp42・拡張系31・GPU30・AIワークフロー30）＋orb戦略統合。実装はTop10の順を推奨。*
