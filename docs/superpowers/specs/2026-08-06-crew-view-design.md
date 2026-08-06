# Crew ビュー — ペインをアイソメトリックのキャラで可視化する

> 設計日: 2026-08-06 / 対象: orb v1.5.x 以降 / 状態: 設計

## 背景と目的

orb は「AI コーディングエージェントを操縦するコックピット」を標榜しており（`docs/VIBE_IDEAS.md` §0）、
既にペイン単位のエージェント状態判定（`src/core/agent-status.ts`）とタブ/ペインのバッジ表示を持つ。
しかしその表現はテキストの絵文字バッジに留まり、**複数の claude を並列で回している時の「現場感」が無い**。

Crew ビューは、既にある状態データに**顔を付ける**機能である。画面上部の帯にアイソメトリックの
小さな仕事場を描き、**ペイン1つ＝キャラ1体**として働かせる。目的は2つ：

1. **楽しさ** — vibe-coding 中の画面に生き物が居る。エージェントが動いている感覚が視覚化される。
2. **実用** — 状態バッジと 1:1 で対応させるので、「誰が自分待ちか」が絵として一目で分かり、
   キャラをクリックすればそのペインにフォーカスできる。

`VIBE_IDEAS.md` の 50 案にキャラ演出系は 1 件も無く、競合ターミナル（Warp / Wave / WezTerm 等）にも
同種の機能は無い。差別化枠として新規。

## スコープ

### やること

- 画面上部に高さ **ウィンドウの 1/4 固定**の帯を追加し、アイソメトリックの仕事場を描画する
- **アクティブタブのペイン**をキャラ1体ずつに割り当てる（最大 8 席）
- `PaneStatus`（running / waiting / attention / done / failed）をキャラの見た目に写す
- ペインの起動でキャラが歩いて入場、終了で歩いて退場する
- キャラのクリックでそのペインにフォーカス
- 帯の表示 ON/OFF トグル（キーバインド＋コマンドパレット、localStorage 永続化）

### やらないこと（YAGNI）

- **Claude Code 内部のサブエージェント（Task）の可視化** — 別の配管（hook もしくは会話ログ解析）が
  必要になり、本機能とは独立した課題。今回はペイン＝キャラに限定する。
- 帯の高さの可変化（3 段階トグル等） — 1/4 固定。
- 背景レイヤ（`bg.ts`）への合成 — 帯のみ。
- 全タブ横断の表示 — アクティブタブのみ。他タブの状態は既存の TabBar バッジが担う。
- キャラのカスタマイズ／着せ替え／キャラ同士の掛け合い演出。

## 前提: 必要なデータは既に全部ある

Rust 側の変更は**一切不要**。新規の IPC もイベントも要らない。

| 要るもの | 既存の出どころ |
| --- | --- |
| ペイン一覧（安定した順序） | `layout` ストア + `leafIds()`（`src/layout/tree.ts:80`） |
| ペインの role / label（案件名） | `leafInfoMap()`（`src/layout/tree.ts:132`） |
| ペインの状態 | `paneStatus: Map<paneId, PaneStatus>`（`src/store/appStore.ts:40`） |
| フォーカス移動 | `focusedPane` ストア |
| 表示 ON/OFF の永続化 | `persistedBool()`（`src/store/appStore.ts`、`dnd` と同じ機構） |

`PaneStatus` は `agent-status.ts` が PTY 出力から判定済みで、通知・バッジ・INBOX と同じ単一の
真実を共有する。Crew はこれに**乗るだけ**であり、独自の判定は一切持たない（判定の二重実装で
表示がズレるのを避ける、`agent-status.ts` 冒頭のコメントと同じ方針）。

## アーキテクチャ

3 ユニット。境界は「純ロジック / 描画 / アセット」で切る。

```
PTY 出力 ─→ agent-status.ts（既存）─→ paneStatus ┐
                                                  ├─→ crew/model.ts（純関数）─→ Crew.svelte
layout（ペイン木）─→ leafIds / leafInfoMap ───────┘        CrewMember[]
```

### 1. `src/crew/model.ts` — 純関数（テスト対象）

DOM も Tauri も Svelte も知らない。入力から表示状態を計算するだけ。
`agent-status.ts` と同じ流儀（純ロジックは vitest 対象、レンダラ非依存）。

```ts
export type CrewAction = "typing" | "calling" | "urgent" | "resting" | "down" | "idle";
export type CrewFacing = "back" | "front" | "left" | "right";

export interface CrewMember {
  paneId: number;
  seat: number;          // 0..7。席番号がそのまま座標に写る
  label: string;         // 案件名 or "pane N"
  action: CrewAction;
  facing: CrewFacing;
  status: PaneStatus | null;
}

/** ペイン一覧＋状態から、描画すべきキャラ配列を作る。8席を超えた分は捨てる。 */
export function buildCrew(
  paneIds: number[],
  info: Map<number, { role?: PaneRole; label?: string }>,
  status: ReadonlyMap<number, PaneStatus>,
): CrewMember[];

/** PaneStatus → キャラの動作。null（バッジ無し）は idle。 */
export function actionForStatus(s: PaneStatus | null): CrewAction;
```

**席割り**は `leafIds()` が返す順（ペイン木の左→右／上→下の安定順）をそのまま席 0..7 に写す。
ペインを閉じると後続が 1 つずつ詰める。この「詰める」動きは描画側の CSS transition で
自然に歩行に見える（後述）ので、特別扱いしない。

**8 席の上限**: 9 個目以降は `buildCrew` が捨てる。claude 9 体並列は実運用の上限を超えており
（`VIBE_IDEAS.md` §2「実用上限 5〜6 体」）、超過分の状態は既存の TabBar バッジ／INBOX が担う。

### 2. `src/crew/Crew.svelte` — 描画

`App.svelte` の `<TabBar />` と `<div class="body">` の間に挿入する。`.stack` は
`flex-direction: column` なので、`flex: 0 0 25%` の帯を 1 枚差し込むだけで端末側（`.body` は
`flex: 1 1 auto`）が自動的に 3/4 に縮む。既存レイアウトへの影響はこの 1 箇所のみ。

構造：

```
.crew            床タイル（静的・敷き詰め）＋ 席 8 個
  .desk[seat]    デスクのスプライト（静的）
  .member        キャラ 1 体（絶対配置・transform で席へ移動）
    .sprite      スプライトシートの 1 コマ（background-position で切り出し）
    .bubble      「?」「!」の吹き出し（waiting / attention のみ）
```

### 3. アセット — `static/crew/`

Kenney **Isometric Prototype Tiles**（CC0 1.0）。CC0 なのでクレジット不要・public リポジトリに
同梱可・商用可。8 方向 × 3 アニメーションのキャラと、床・壁・オブジェのタイルが同梱される。

- https://kenney-assets.itch.io/isometric-prototypes-tiles

`static/crew/LICENSE.md` に出典と CC0 である旨を明記する。

**まず 1 パックで完結させる**（床もキャラも同じパックから取る）。複数パックを混ぜると
絵柄が破綻するため、混ぜない。

## 状態 → キャラの表現

**重要な制約**: Kenney のキャラに含まれるアニメーションは 3 種（idle / walk / run 相当）のみで、
「タイピング」「手を挙げる」といった専用フレームは**存在しない**。したがって下表の表現は
**スプライトの向き＋CSS で書く動き**（bob / hop / tint / 吹き出し）で作る。

これは制約であると同時に利点でもある。表現がコード側にあるため、アセットを差し替えても
動きの定義は生き残る。

| PaneStatus | action | 向き | 表現 |
| --- | --- | --- | --- |
| `running` 🟢 | `typing` | back（デスクへ向く） | `translateY` を 0↔-2px で往復（0.35s・タイピングの体の揺れ） |
| `waiting` 🟡 | `calling` | front（こちらを向く） | 吹き出し「?」＋ゆっくり明滅 |
| `attention` 🔔 | `urgent` | front | `translateY` -8px の跳ね（0.5s）＋ accent 色の glow ＋ 吹き出し「!」 |
| `done` ✅ | `resting` | back | 一度だけ伸び（scaleY 1.06）→ 静止 |
| `failed` 🔴 | `down` | front | `filter: grayscale(1)` ＋ 数 px 沈む |
| なし（null） | `idle` | back | 静止（呼吸程度の微動） |

**8 方向スプライトのうち実際に使うのは 4 方向**（back / front / left / right）。
斜め 4 方向は使わない（席は格子に並ぶので不要）。

### 入場・退場

walk アニメーションの主な使いどころ。ここが「生きている」感覚の大半を担う。

- **入場**（ペイン起動）: 帯の左端外から自分の席へ歩く（約 1.2s、facing は移動方向）
- **退場**（ペイン終了）: 席から左端外へ歩いてフェードアウト
- **席詰め**（前のペインが閉じた）: 新しい席へ CSS transition で移動する。位置補間の間だけ
  facing を移動方向にして walk コマを回せば、ワープではなく歩行に見える

### 操作

- **キャラをクリック** → `focusedPane.set(paneId)`。見て楽しいだけでなく捌ける。
- **ホバー** → label（案件名）・状態ラベル（`STATUS_LABEL` を再利用）をツールチップ表示。

## 設定と表示切替

`config.toml`（Rust の `Config` 構造体）は**触らない**。表示 ON/OFF だけなので、
`dnd` と同じ `persistedBool()`（localStorage）で足りる。

```ts
// src/store/appStore.ts
export const crewVisible = persistedBool("orb.crew", true);
```

- **キーバインド**: `Ctrl+Shift+J`（`Workspace.svelte` の既存 `Ctrl+Shift+*` チェーンに 1 分岐追加。
  d/e/w/z/k/b/p/n/h/q は使用済み）
- **コマンドパレット**: 「Crew: 表示切替」を `paletteActions` 配列に 1 エントリ追加

## パフォーマンス

`PERFORMANCE.md` の方針（大量出力のホットパスに乗せない・compositor-only）に従う。

- キャラの移動は `transform: translate3d()` のみ。`top`/`left` は使わない
- アニメーションは `steps()` の CSS `@keyframes`。**JS の毎フレームループを持たない**
- 非表示時は `{#if $crewVisible}` で **DOM ごと消す**（描画コストが完全にゼロになる）
- ウィンドウ非フォーカス時は `animation-play-state: paused`
- `prefers-reduced-motion: reduce` で全アニメーションを停止し、静止した絵にフォールバックする
- 床タイルは絶対配置の `<div>` を 20 枚程度並べた**静的レイヤ**（1 度描いたら再描画されない）

描画対象は最大 8 体＋床 20 枚＝ 30 要素弱で、いずれも状態変化時にしか再描画されない。
背景メディア ON（DOM レンダラ）が洪水時 +15% だったのに対し、Crew は PTY 出力のホットパスに
一切乗らないため、大量出力時のコストは原理的に発生しない。

## テスト

### ユニット（vitest・`src/crew/model.test.ts`）

`src/core/agent-status.test.ts` と同じ流儀。純関数のみを対象にする。

- `actionForStatus` が 5 状態＋null を正しく写す
- `buildCrew` の席割りが `leafIds` の順に安定する
- ペインを 1 つ閉じたとき、後続の席番号が 1 つずつ詰む
- 9 ペイン以上で 8 体に切り詰められる
- label 未設定のペインがフォールバック名になる

### 実機確認

`reference_orb_screenshot_verify` の PowerShell 手順（`EnumWindows` で最大窓を特定して
`CopyFromScreen`。`PrintWindow` は WebView2 の中身が撮れず黒くなる）でスクリーンショットを撮り、
以下を目視する。

1. 帯がウィンドウ高さの約 1/4 を占め、端末が 3/4 に縮んでいる
2. ペイン 2 つで 2 体が別々の席に立っている
3. 片方に承認プロンプトを出す → そのキャラだけ `urgent`（跳ね＋「!」）になる
4. キャラをクリック → そのペインにフォーカスが移る
5. `Ctrl+Shift+J` で帯が消え、端末が全高に戻る

## リスク

1. **絵柄が期待に合わない可能性** — Kenney の prototype 素材は灰色寄りの素朴な絵柄で、
   「カラフルなオフィス」を想像していた場合ギャップが出る。緩和策：アセットのパスと
   スプライトの切り出し定義を 1 箇所（`src/crew/sprites.ts`）に集約し、パック差し替えを
   ファイル 1 つの変更で済むようにする。まず動くものを見て判断する。
2. **アイソメ床タイルの継ぎ目** — 菱形タイルは単純な `background-repeat` では格子が合わない。
   緩和策：`background-repeat` に頼らず、タイルを絶対配置で明示的に格子状に並べる。
3. **画面の 1/4 が常時奪われる** — 端末が狭くなる。緩和策：ON/OFF トグルを最初から実装し、
   キーバインド 1 発で全高に戻せるようにする（上記の設定節）。

## 実装時に変わったこと（2026-08-06 追記）

実装計画（`docs/superpowers/plans/2026-08-06-crew-view.md`）と実機確認を経て、本仕様から
以下を変更した。理由込みで残す。

1. **Kenney スプライトは未導入。キャラは CSS 図形で描いている。** 「まず動作から見たい」という
   要望に沿って Task 5（スプライト差し替え）を任意タスクに切り出し、Task 1〜4 をアセット無しで
   完成させた。差し替えるかどうかは実物を見てから判断する。アセットを足さなければリポジトリは
   軽いまま保てる。
2. **向きは 4 方向ではなく 2 方向（back / front）。** 向きの意味は「人間の手が要るか否か」
   だけで、席は格子に固定されているため左右を向く必然が無い。使わない状態を型に持たせない。
3. **「奥に浮かぶモニタ」をやめ、人の手前に机＋画面を置いた。** 実機で見たところ、キャラの
   真上のモニタは宙に浮いた黒い箱にしか見えなかった。描画順を「人 → 机 → 画面」にして脚と胴の
   下半分を隠すと、素直に「机に向かって座っている」と読める。
4. **絵全体を帯の高さに合わせて縮小する。** 8 席すべて埋まると、小さめのウィンドウ
   （1116×729 で検証）では 1/4 の帯から前列がはみ出した。`bind:clientHeight` で帯の高さを測り、
   `scale()` で全体を縮めて必ず収める。
5. **名前ラベルは常時表示をやめ、フォーカス中／ホバー中の 1 人だけに出す。** 8 体並ぶと
   ラベル同士が重なって全部読めなくなったため。全員分の名前は `title` 属性から引ける。
6. **キャラを `<div>` ではなく `<button>` にした。** クリックでペインにフォーカスを移す実際の
   コントロールなので、a11y 警告を抑制するより実体を正しくする方を選んだ。キーボードでも
   到達でき、`aria-label` に状態名まで乗る。

## 実装順序（概略）

1. `src/crew/model.ts` ＋ `model.test.ts`（純ロジック・アセット不要でここだけ先に完結できる）
2. アセット取得と `static/crew/`＋`sprites.ts`（スプライト切り出し定義）
3. `Crew.svelte`（床 → 静止キャラ → 状態別アニメーション → 入退場の順に足す）
4. `App.svelte` への 1 行挿入・トグル・パレット・キーバインド
5. 実機スクリーンショット検証
