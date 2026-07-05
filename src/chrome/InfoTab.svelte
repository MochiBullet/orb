<script lang="ts">
  // #47: info タブ（取扱説明書）。PTY を持たない特殊タブの中身で、Workspace が
  // アクティブタブ kind === "info" のときだけ描画する。内容は README / 実装
  // （Workspace.onKey・Terminal のハンドラ・各 Issue）に実在する機能のみ書く。
  // ショートカットは src/data/reference.ts（パレットと共有の単一ソース）から描画。
  import { KEY_REFERENCE } from "../data/reference";
  import { MCP_CATALOG } from "../data/mcp-catalog";
  import { STATUS_ICON, STATUS_LABEL, STATUS_PRIORITY } from "../core/agent-status";
  import orbHero from "../assets/orb-hero.png";

  interface Guide {
    title: string;
    items: string[];
  }

  // 最近のアップデート（実装済み機能のみ）。README/実装と齟齬が出ないよう事実だけを列挙する。
  const updates: string[] = [
    "案件ランチャー（Ctrl+P）で複数案件をまとめて選択→model/effort を事前承認→一括起動（候補にカーソルを合わせて Ctrl+Space、Enter で承認画面へ）。auto mode で長時間放置する時、起動後に個別確認で割り込まれずに済む",
    "チェックポイント復元の安全性強化：AI ペインが実行中の間は復元ボタンを既定で無効化（明示チェックで解除可）。確認画面に「手で編集した内容もこの時点まで戻る」旨を明記。加えて、復元がブランチの参照ごと動かしてしまい大事なコミットが迷子になる不具合を修正済み",
    "「🕐 前例」：失敗したコマンドのツールバーから、同じコマンド・同じディレクトリの過去の失敗と、その後の解決履歴を検索して AI ペインへ渡すワンキー",
    "ブロックログ（JSONL）は90日を超えた古いものを自動整理、無限に肥大化しない",
    "背景画像は GIF・動画（mp4/webm）に対応。トリミング（覆う/全体）・位置・ズームを設定パネルから調整可能",
  ];

  const guides: Guide[] = [
    {
      title: "コマンドブロック",
      items: [
        "OSC 133/633 を解釈して、コマンド単位のブロック境界と終了コードバッジ（成功 teal / 失敗 red）を表示",
        "Ctrl+↑ / Ctrl+↓ でブロック（プロンプト）間をジャンプ",
        "ブロックに hover するとツールバー: copy / →AI（失敗ブロックは 🔧 fix）",
        "vim / lazygit 等のフルスクリーン TUI 中はブロック処理を自動停止",
      ],
    },
    {
      title: "ペイン分割 / ズーム / ブロードキャスト",
      items: [
        "Ctrl+Shift+D / E で横 / 縦分割（フォーカス中ペインの cwd を継承）",
        "Ctrl+Shift+Z でフォーカスペインをズーム（全面）切替",
        "スプリッタをドラッグでリサイズ、Ctrl+Tab でフォーカス巡回",
        "ブロードキャスト入力（パレットから切替）で全ペインへ同時入力",
      ],
    },
    {
      title: "タブ",
      items: [
        "Ctrl+T 新規 / Ctrl+W 閉じる。切り替えても全タブの PTY とスクロールバックは生存",
        "タブ名はダブルクリックでリネーム",
        "起動時は常に新規構成（AI + shell、設定 ON なら + info）。前回の画面内容はパレット「前回のセッションを復元」で書き戻せる",
      ],
    },
    {
      title: "案件ランチャー (Ctrl+P)",
      items: [
        "~/.config/orb/projects.toml の案件を、案件名の新タブで開く（既存タブは潰さない）",
        "左 AI / 右上 dev / 右下 lazygit の3ペインを正しい cwd で起動",
        "AI 起動プリセット（継続 --continue / 新規 / 危険モード）は Tab キーで巡回",
      ],
    },
    {
      title: "AI（Claude）ペイン",
      items: [
        "サイドバーの claude / continue ボタンで起動（continue = 会話を再開）",
        "Ctrl+L: 別ペインの選択テキストを cwd/exit 付きの構造化コンテキストで AI 入力欄へ（送信は人が Enter）",
        "Ctrl+Shift+L: AI の提案テキストを選択してシェルのプロンプトへ再入力（実行は Enter）",
        "model / effort はサイドバーのプルダウンから切替",
      ],
    },
    {
      title: "ブロック履歴と全期間検索 (Ctrl+Shift+H)",
      items: [
        "耐久ログ（~/.config/orb/blocks/YYYY-MM-DD.jsonl）からブロック列を再構築",
        "検索 DSL: cargo exit:fail cwd:orb in:command from:2026-06-01 to:2026-06-30 day:2026-07-02",
        "exit: は ok / fail / 終了コード数値、cwd: は部分一致、in: は command / output / all",
        "失敗ブロックの一括 →AI（直近最大10件のダイジェスト）も可能",
      ],
    },
    {
      title: "画像・ファイル添付",
      items: [
        "Win+Shift+S でスクショ → 端末で Ctrl+V: 画像を保存して @パス を挿入（AI にそのまま渡せる）",
        "ファイル / フォルダはウィンドウへドラッグ&ドロップで cwd 相対パスを挿入",
        "挿入するだけで実行はしない＝内容は人が確認してから Enter",
      ],
    },
    {
      title: "セッション要約（引き継ぎ）",
      items: [
        "パレットから3出力: クリップボードへ / AI ペインへ（整理を依頼）/ HANDOFF-YYYY-MM-DD.md 保存",
        "今日×現在の cwd のブロックログから引き継ぎ用 Markdown を組む",
      ],
    },
    {
      title: "設定 (Ctrl+,)",
      items: [
        "フォント / スクロールバック / アクセント色 / 背景（画像・GIF・動画＋暗幕・位置・ズーム）/ 起動時の info タブ",
        "保存先は ~/.config/orb/config.toml（直接編集も可）",
      ],
    },
    {
      title: "その他",
      items: [
        "Ctrl+F: ターミナル内検索 / Ctrl+Shift+K: 画面クリア",
        "Ctrl+Shift+N: フォーカスモード(DND) — 成功通知を抑制し失敗だけ通知",
        "Shift+Enter: 改行（Claude Code 等の複数行入力。Enter で送信しない）",
        "Ctrl+ホイール / Ctrl+= / Ctrl+- / Ctrl+0: フォントズーム",
      ],
    },
  ];
</script>

<div class="info-tab">
  <div class="inner">
    <header>
      <img class="hero" src={orbHero} alt="orb" />
      <div class="sub">取扱説明書</div>
      <p class="tagline">
        agent-native terminal — Claude Code と並走するための、バイブコーディング専用ターミナル。
      </p>
      <p class="note">
        このタブは閉じても、コマンドパレット（Ctrl+Shift+P）の「info / 説明書を開く」からいつでも戻せます。
      </p>
    </header>

    <section>
      <h2>最近のアップデート</h2>
      <ul class="updates">
        {#each updates as u}
          <li>{u}</li>
        {/each}
      </ul>
    </section>

    <section>
      <h2>機能ガイド</h2>
      <div class="cards">
        {#each guides as g (g.title)}
          <div class="card">
            <h3>{g.title}</h3>
            <ul>
              {#each g.items as item}
                <li>{item}</li>
              {/each}
            </ul>
          </div>
        {/each}
      </div>
      <div class="badges">
        <span class="badges-label">状態バッジ（タブ・ペイン右上・サイドバー INBOX）:</span>
        {#each STATUS_PRIORITY as s (s)}
          <span class="badge">{STATUS_ICON[s]} {STATUS_LABEL[s]}</span>
        {/each}
        <span class="badges-note">— 手が要るペインには INBOX から1クリックでジャンプ。フォーカスすると既読で消える。</span>
      </div>
    </section>

    <section>
      <h2>ショートカット一覧</h2>
      <ul class="ref">
        {#each KEY_REFERENCE as r (r.keys)}
          <li><span class="kbd">{r.keys}</span><span class="desc">{r.desc}</span></li>
        {/each}
      </ul>
    </section>

    <section>
      <h2>Claude Code 導入ガイド</h2>
      <ol class="steps">
        <li>
          前提: <span class="kbd">Node.js 20+</span>
        </li>
        <li>
          インストール:
          <code class="cmd">npm install -g @anthropic-ai/claude-code</code>
        </li>
        <li>
          初回起動: 端末で <code class="cmd">claude</code> を実行するとブラウザでログインが開く
        </li>
      </ol>
      <p class="pitfall">
        Windows の罠: PATH に出るのは <span class="kbd">claude.cmd</span> シムだけで
        <span class="kbd">claude.exe</span> 実体は出ない。exe を直接要求するツールを使う場合は
        <code class="cmd">…\node_modules\@anthropic-ai\claude-code\bin</code> を PATH に追加する。
      </p>
    </section>

    <section>
      <h2>おすすめ MCP</h2>
      <p class="note">
        インストールはコマンドパレット（Ctrl+Shift+P）→「おすすめ MCP」から。クリックで
        インストールコマンドが端末に挿入される（実行は人が Enter）。
      </p>
      <ul class="mcp">
        {#each MCP_CATALOG as m (m.id)}
          <li><span class="mcp-name">{m.name}</span><span class="desc">{m.desc}</span></li>
        {/each}
      </ul>
    </section>
  </div>
</div>

<style>
  .info-tab {
    position: absolute;
    inset: 0;
    overflow-y: auto;
    background:
      radial-gradient(1200px 500px at 70% -10%, rgba(45, 212, 191, 0.07), transparent 60%),
      radial-gradient(900px 400px at 10% 110%, rgba(var(--violet-rgb, 167, 139, 250), 0.06), transparent 60%),
      #030807;
    color: var(--fg);
  }
  .inner {
    max-width: 860px;
    margin: 0 auto;
    padding: 34px 28px 60px;
  }
  header {
    text-align: center;
  }
  /* TitleBar のロゴマークと同系の hero 版。310KB のラスタなので header 相応に縮小表示。 */
  .hero {
    display: block;
    width: auto;
    max-width: min(240px, 70%);
    height: auto;
    margin: 0 auto 8px;
    filter: drop-shadow(0 0 16px rgba(45, 212, 191, 0.35));
  }
  header .sub {
    font-size: 0.8rem;
    letter-spacing: 0.2em;
    color: var(--violet, #a78bfa);
  }
  .tagline {
    margin: 10px 0 2px;
    font-size: 0.84rem;
    color: var(--fg);
  }
  .note {
    margin: 4px 0 0;
    font-size: 0.72rem;
    color: var(--grey);
    opacity: 0.85;
  }
  section {
    margin-top: 30px;
  }
  .updates {
    margin: 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .updates li {
    font-size: 0.76rem;
    line-height: 1.6;
    color: var(--grey);
  }
  h2 {
    margin: 0 0 12px;
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--teal, #2dd4bf);
    border-bottom: 1px solid rgba(45, 212, 191, 0.2);
    padding-bottom: 6px;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: 10px;
  }
  .card {
    background: rgba(45, 212, 191, 0.04);
    border: 1px solid rgba(45, 212, 191, 0.16);
    border-radius: 8px;
    padding: 12px 14px;
  }
  .card h3 {
    margin: 0 0 8px;
    font-size: 0.78rem;
    color: var(--violet, #a78bfa);
    letter-spacing: 0.04em;
  }
  .card ul {
    margin: 0;
    padding-left: 16px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .card li {
    font-size: 0.74rem;
    line-height: 1.55;
    color: var(--grey);
  }
  .badges {
    margin-top: 12px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    font-size: 0.72rem;
    color: var(--grey);
  }
  .badges-label {
    color: var(--fg);
  }
  .badge {
    border: 1px solid rgba(45, 212, 191, 0.2);
    border-radius: 999px;
    padding: 1px 8px;
    background: rgba(45, 212, 191, 0.05);
    white-space: nowrap;
  }
  .badges-note {
    opacity: 0.8;
  }
  .ref {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .ref li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 8px;
    font-size: 0.78rem;
    border-radius: 6px;
  }
  .ref li:nth-child(odd) {
    background: rgba(255, 255, 255, 0.02);
  }
  .ref .kbd {
    order: 2;
  }
  .kbd {
    flex: 0 0 auto;
    font-size: 0.68rem;
    color: var(--teal, #2dd4bf);
    background: rgba(45, 212, 191, 0.1);
    border: 1px solid rgba(45, 212, 191, 0.25);
    border-radius: 4px;
    padding: 1px 6px;
    white-space: nowrap;
  }
  .desc {
    color: var(--grey);
    min-width: 0;
  }
  .steps {
    margin: 0;
    padding-left: 20px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 0.78rem;
    color: var(--grey);
  }
  .cmd {
    display: inline-block;
    margin-left: 6px;
    font-family: inherit;
    font-size: 0.74rem;
    color: var(--fg);
    background: #000;
    border: 1px solid rgba(45, 212, 191, 0.2);
    border-radius: 5px;
    padding: 2px 8px;
    word-break: break-all;
  }
  .pitfall {
    margin: 12px 0 0;
    font-size: 0.74rem;
    line-height: 1.7;
    color: var(--grey);
    border-left: 2px solid var(--violet, #a78bfa);
    padding: 6px 12px;
    background: rgba(var(--violet-rgb, 167, 139, 250), 0.05);
    border-radius: 0 6px 6px 0;
  }
  .mcp {
    list-style: none;
    margin: 10px 0 0;
    padding: 0;
  }
  .mcp li {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 6px 8px;
    font-size: 0.78rem;
    border-radius: 6px;
  }
  .mcp li:nth-child(odd) {
    background: rgba(255, 255, 255, 0.02);
  }
  .mcp-name {
    flex: 0 0 150px;
    color: var(--teal, #2dd4bf);
  }
</style>
