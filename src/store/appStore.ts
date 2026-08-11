import { writable, get } from "svelte/store";
import type { PaneNode } from "../layout/tree";
import type { PaneStatus } from "../core/agent-status";

/** OSC 633;P;Cwd マーカーで更新される現在の作業ディレクトリ（フォーカスペインのもの）。 */
export const cwd = writable<string>("");

/** ペインのレイアウトツリー（フロント権威）。null = 未初期化。 */
export const layout = writable<PaneNode | null>(null);

/** フォーカス中のペイン ID（分割・クローズ・枠ハイライトの対象）。 */
export const focusedPane = writable<number>(0);

/** AI(claude)ペインの ID。Ctrl+L で選択テキストの送信先になる。null=AIペイン無し。 */
export const aiPane = writable<number | null>(null);

/** AI ペインで Enter が押された時刻（ms）。/model・/effort 等のスラッシュコマンドは
 *  Claude CLI 内部の処理で pwsh の OSC マーカー（#33）を経由しないため、シェル側の
 *  ブロック境界からは検知できない。代わりに「AI ペインで何か実行された」を合図に
 *  サイドバーの CLAUDE ステータス（model/effort/MCP）を再チェックさせる（#33 の続き）。 */
export const aiPaneActivity = writable(0);

/** フォーカス中のペインを AI ペインに指定する。今は案件ランチャー（tabs.ts）経由でしか
 *  aiPane が決まらず、手動 split/新規タブでは永遠に未設定＝サイドバーの model/effort
 *  プルダウンが常に disabled になる。パレット/ショートカットからの明示指定用。 */
export function setFocusedAsAiPane() {
  // #47: info タブ表示中の focusedPane はダミー(-1)＝AI ペインにしない（ID は 1 始まり）。
  const f = get(focusedPane);
  if (f > 0) aiPane.set(f);
}

/** 最後にフォーカスされていた「シェル側」ペイン（role=ai 以外）。#34 の逆方向注入
 *  （AI ペインの提案テキスト → Ctrl+Shift+L → シェルのプロンプトへ）の届け先。
 *  Terminal.svelte がフォーカス変化で更新し、破棄時に自分なら null へ戻す。 */
export const lastShellPane = writable<number | null>(null);

/** #50: ペインごとの活動状態バッジ（paneId → 状態）。TabBar/ペイン右上/CREW の単一ソース。
 *  osc.ts（D 確定）と Terminal.svelte（AI ペインのアイドル判定）が書き、フォーカスで
 *  「手が要る」系だけ消える（acknowledgePane）。 */
export const paneStatus = writable<ReadonlyMap<number, PaneStatus>>(new Map());

/** 各ペインが「今の状態」になった時刻(ms)。Crew の経過時間表示の元。
 *  setPaneStatus が値の変化時だけ書く＝同じ状態の再設定で経過がリセットされない。 */
export const paneStatusSince = writable<ReadonlyMap<number, number>>(new Map());

/** 状態を設定/解除する（null = バッジ無しへ）。値が変わらない時は再通知しない。 */
export function setPaneStatus(paneId: number, s: PaneStatus | null) {
  let changed = false;
  paneStatus.update((m) => {
    if ((m.get(paneId) ?? null) === s) return m;
    changed = true;
    const next = new Map(m);
    if (s == null) next.delete(paneId);
    else next.set(paneId, s);
    return next;
  });
  if (!changed) return;
  // 状態が消えた時は時刻も消す。残すと次に状態が付いた時、古い時刻から数えて嘘の経過を出す。
  paneStatusSince.update((m) => {
    const next = new Map(m);
    if (s == null) next.delete(paneId);
    else next.set(paneId, Date.now());
    return next;
  });
}

/** ペインごとの直近コマンド行。Crew のシェルペイン表示だけが読む。
 *  AI ペインでは常に "claude" が入るので、描画側で role を見て出し分けること。 */
export const paneLastCommand = writable<ReadonlyMap<number, string>>(new Map());

export function setPaneLastCommand(paneId: number, cmd: string | null) {
  const v = cmd?.trim();
  if (!v) return; // 空を入れて「コマンド行だけ空白」にしない
  paneLastCommand.update((m) => {
    if (m.get(paneId) === v) return m;
    const next = new Map(m);
    next.set(paneId, v);
    return next;
  });
}

/** ペイン破棄時のレジストリ掃除（Terminal.svelte の onDestroy から）。
 *  消さないと閉じたペインの直近コマンドが溜まり続ける（ID 再利用で誤表示にもなる）。 */
export function clearPaneLastCommand(paneId: number) {
  paneLastCommand.update((m) => {
    if (!m.has(paneId)) return m;
    const next = new Map(m);
    next.delete(paneId);
    return next;
  });
}

/** フォーカス＝確認済み。「手が要る」系（waiting/attention/done/failed）のバッジを消す。
 *  running は進行中の事実なので残す。 */
export function acknowledgePane(paneId: number) {
  const cur = get(paneStatus).get(paneId);
  if (cur && cur !== "running") setPaneStatus(paneId, null);
}

/** 案件ランチャーの一括起動やサイドバーの手動切替で「このペインは具体的にこの model/effort
 *  で動いている」と分かっている時だけ記録する上書き（paneId → 部分上書き）。
 *  status.rs の fetch_status は settings.json 由来の値を返す＝全ペイン共通の1個しか持てない
 *  ため、案件ごとに違う model/effort で起動すると素の status 表示がズレる。ここに具体値が
 *  あればサイドバーはそちらを優先表示し、無ければ従来どおり config 由来にフォールバックする。
 *  "default"/"auto"（＝具体値不明）を指定した時はそのフィールドのキー自体を持たない。 */
export const paneModelEffort = writable<ReadonlyMap<number, { model?: string; effort?: string }>>(
  new Map(),
);

/** model/effort の一方または両方を更新する。値に null を渡すとそのフィールドの上書きを解除
 *  （config 由来の表示へ戻す）、undefined を渡すとそのフィールドには触れない。 */
export function setPaneModelEffort(
  paneId: number,
  patch: { model?: string | null; effort?: string | null },
) {
  paneModelEffort.update((m) => {
    const next = new Map(m);
    const cur = { ...(next.get(paneId) ?? {}) };
    if (patch.model !== undefined) {
      if (patch.model) cur.model = patch.model;
      else delete cur.model;
    }
    if (patch.effort !== undefined) {
      if (patch.effort) cur.effort = patch.effort;
      else delete cur.effort;
    }
    if (cur.model || cur.effort) next.set(paneId, cur);
    else next.delete(paneId);
    return next;
  });
}

/** ペイン破棄時のレジストリ掃除（Terminal.svelte の onDestroy から）。#78 UX-5: 消さないと
 *  閉じたペインの上書きが残り続け、paneStatus/queue/cwd と違って掃除経路が無かった
 *  （長時間の分割/クローズ運用でエントリが単調に溜まるリーク）。 */
export function clearPaneModelEffort(paneId: number) {
  paneModelEffort.update((m) => {
    if (!m.has(paneId)) return m;
    const next = new Map(m);
    next.delete(paneId);
    return next;
  });
}

/** #76/Theme-A: ランチャー起動中の claude ペイン集合（起動 agent フラグ）。
 *  ランチャーは `pwsh -NoExit -Command "…; claude"` で claude を起動するため、claude 稼働中は
 *  PSReadLine の prompt()（A/D/P/Cwd マーカーの発生源）が再発火せず、OSC 133/633 マーカーが
 *  一切届かない（claude が stdin を握りっぱなし）。結果 blocks.isCommandRunning() は永遠に
 *  false のままで、#50 のアイドル判定ゲートも #51 のキュー自動投入も永久に発火しない
 *  ＝「裏で claude を回して通知」という orb の看板機能がランチャー経路で丸ごと死ぬ。
 *  そこで「起動した claude が今も稼働中」を明示フラグで持ち、C マーカー不在でもアイドル
 *  判定を許可する。claude 終了（＝シェルがプロンプトを取り戻し最初の A が来た）で解除する。 */
const launchedAgents = new Set<number>();
/** ランチャーが AI ペイン起動時に立てる（起動 agent 稼働中）。 */
export function markLaunchedAgent(paneId: number) {
  launchedAgents.add(paneId);
}
/** osc.ts の A マーカー（claude 終了＝シェル復帰）／ペイン破棄で解除する。素のシェル
 *  プロンプトを「入力待ち」と誤判定しないための解除が肝。 */
export function clearLaunchedAgent(paneId: number) {
  launchedAgents.delete(paneId);
}
/** このペインが今ランチャー起動の claude を稼働中か（アイドル判定・状態追跡ゲート用）。 */
export function isLaunchedAgentActive(paneId: number): boolean {
  return launchedAgents.has(paneId);
}

// フォーカス移動そのものが「見た」の合図（#50 受け入れ条件のバッジ自動クリア）。
focusedPane.subscribe(acknowledgePane);

/** 設定パネルの表示状態（TitleBar の歯車 / Ctrl+, から開く）。 */
export const showSettings = writable(false);

/** コマンドパレットの表示状態（ヘッダーの検索欄 / Ctrl+Shift+P から開く）。 */
export const showPalette = writable(false);

/** パレットを開く初期モード。ヘッダーの ⓘ から開くと "help"（取扱説明）で開く。 */
export const paletteMode = writable<"search" | "help">("search");

/** #7: いずれかのオーバーレイ（ランチャー/ブロック履歴/MCP カタログ/プロンプトキュー/
 *  チェックポイント/コマンドパレット/設定）が開いているか。Terminal の再フォーカス処理が
 *  これを購読し、どのオーバーレイを閉じても端末へフォーカスを戻す（従来は $showSettings だけ
 *  見ていたため、設定以外の4オーバーレイを閉じると DOM フォーカスが body に落ちて打鍵が
 *  効かなくなっていた）。履歴/MCP/キュー/チェックポイントは Workspace のローカル $state で
 *  Terminal からは購読できないため、Workspace が全状態から $effect でこの集約ストアへ同期する。 */
export const anyOverlayOpen = writable(false);

/** ブロードキャスト入力。ON の間、フォーカスペインへの入力を全ペインへ複製する。 */
export const broadcast = writable(false);

/** localStorage に永続する真偽ストア（トグルは一度設定すれば以後そのまま）。 */
function persistedBool(key: string, fallback: boolean) {
  let init = fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw != null) init = raw === "1";
  } catch {
    /* localStorage 不可でも既定で動作 */
  }
  const store = writable(init);
  store.subscribe((v) => {
    try {
      localStorage.setItem(key, v ? "1" : "0");
    } catch {
      /* 保存失敗は無視 */
    }
  });
  return store;
}

/** フォーカスモード(DND, VIBE_IDEAS #20)。ON の間は成功通知を抑制し、失敗だけ昇格する。
 *  永続なので「起動のたびに有効化」は不要＝一度 ON にすれば以後そのまま。 */
export const dnd = persistedBool("orb.dnd", false);

/** Crew ビュー（サイドバーのキャラ欄）の表示。dnd と同じ localStorage 永続で、
 *  一度切れば以後そのまま＝起動のたびの操作が要らない。 */
export const crewVisible = persistedBool("orb.crew", true);

/** 新規タブ作成のたびに増えるカウンタ。Workspace が購読して小さな welcome を一瞬出す。
 *  初回タブ/セッション復元（ensureFirstTab）では増やさない＝起動直後に余計な演出を出さない。 */
export const tabWelcome = writable(0);

/** ペインごとの画面クリア関数レジストリ（paneId→term.clear）。
 *  Terminal が mount/destroy で登録解除し、Workspace の Ctrl+Shift+K / パレットから呼ぶ。 */
const termClearRegistry = new Map<number, () => void>();
export function registerTermClear(paneId: number, fn: () => void) {
  termClearRegistry.set(paneId, fn);
}
export function unregisterTermClear(paneId: number) {
  termClearRegistry.delete(paneId);
}
/** 指定ペインの画面をクリア（スクロールバックを消去）。 */
export function clearPane(paneId: number) {
  termClearRegistry.get(paneId)?.();
}

/** ペインごとの入力シンク（paneId → 入力バイトを端末の入力経路へ）。Terminal は
 *  spawn 前でも登録し、PTY 未起動の間はバッファへ積む＝起動直後の打鍵を落とさない。
 *  第2引数 isBroadcastRelay: true は「他ペインからのブロードキャスト複製として届いた」印。
 *  受け側の enqueueInput はこれを見て broadcast を再判定しない（#77 FN-2、全ペインが
 *  互いに複製し合う無限ループ防止）。省略時 undefined は「発信元自身の入力」として扱われ、
 *  従来どおり broadcast 判定を通る（sendInputToFocusedPane の既存呼び出しの挙動を変えない）。 */
const paneInputRegistry = new Map<number, (bytes: Uint8Array, isBroadcastRelay?: boolean) => void>();
export function registerPaneInput(
  paneId: number,
  fn: (bytes: Uint8Array, isBroadcastRelay?: boolean) => void,
) {
  paneInputRegistry.set(paneId, fn);
}
export function unregisterPaneInput(paneId: number) {
  paneInputRegistry.delete(paneId);
}
/** フォーカス中ペイン（無ければ任意の1ペイン）の端末入力経路へバイト列を届ける。
 *  端末未フォーカス時の外部入力ソースからフォーカスペインの入力経路（#39 バッファ）へ
 *  打鍵を流すのに使う。戻り値は届け先が在ったか（＝消えずに済んだか）。
 *  strict=true はフォーカスペインが見つからないとき任意ペインへフォールバックしない
 *  （#33 再実行など「意図しないペインに書くと危険」な送信用）。 */
export function sendInputToFocusedPane(bytes: Uint8Array, strict = false): boolean {
  const focused = paneInputRegistry.get(get(focusedPane));
  const fn = focused ?? (strict ? undefined : paneInputRegistry.values().next().value);
  if (!fn) return false;
  fn(bytes);
  return true;
}

/** #77 FN-2: 指定ペイン（フォーカス有無を問わず任意）の入力経路（#39 バッファ込み）へ
 *  バイト列を届ける。ブロードキャスト複製の配送に使う＝isBroadcastRelay=true を伝えるので
 *  受け側は broadcast を再判定しない（sendInputToFocusedPane と違い broadcast 発火はしない）。
 *  戻り値は届け先が登録済みだったか（未登録＝そのペインの Terminal がまだ mount されていない・
 *  呼び出し側はこれを見てログだけ出す＝黙ってロストさせない）。 */
export function sendInputToPane(paneId: number, bytes: Uint8Array): boolean {
  const fn = paneInputRegistry.get(paneId);
  if (!fn) return false;
  fn(bytes, true);
  return true;
}

/** #77 FN-4b: ペインごとの alt-screen（vim/lazygit 等フルスクリーン TUI）判定シンク。
 *  ブロードキャスト複製を届ける前に「相手ペインが今 alt-screen か」を見るためだけに使う。
 *  フォーカス中ペイン自身の入力には一切影響しない（このガードは複製の配送側だけに掛かる）。 */
const paneAltScreenRegistry = new Map<number, () => boolean>();
export function registerPaneAltScreen(paneId: number, fn: () => boolean) {
  paneAltScreenRegistry.set(paneId, fn);
}
export function unregisterPaneAltScreen(paneId: number) {
  paneAltScreenRegistry.delete(paneId);
}
/** 指定ペインが今 alt-screen 中か。未登録（Terminal 未 mount 等）は false 扱い
 *  ＝分からない時は配送を止めない（#39 バッファ保護を alt-screen 判定の欠落で壊さない）。 */
export function isPaneInAltScreen(paneId: number): boolean {
  return paneAltScreenRegistry.get(paneId)?.() ?? false;
}

/** #77 FN-2/FN-4b: ブロードキャストの配送先を絞り込む純関数。発信元自身（selfId）は
 *  常に対象に残す（alt-screen 中でも自分の入力を捨てる理由はない）。他ペインは
 *  isAltScreen(id) が true なら除外する（フルスクリーン TUI バッファへの生バイト複製で
 *  画面が壊れるのを避ける）。Terminal.svelte から isPaneInAltScreen を渡して使う。 */
export function broadcastTargets(
  leafIds: number[],
  selfId: number,
  isAltScreen: (id: number) => boolean,
): number[] {
  return leafIds.filter((id) => id === selfId || !isAltScreen(id));
}


/** ペインごとの画面内容シリアライザ（paneId→ANSI 付き文字列を返す）。
 *  アプリ終了/リロード時に全ペイン分を保存し、再起動で過去ログとして復元する
 *  （PTY プロセス自体は復元不可なので「画面の記録」を書き戻して新シェルを起動する）。 */
const termSerializeRegistry = new Map<number, () => string>();
export function registerTermSerialize(paneId: number, fn: () => string) {
  termSerializeRegistry.set(paneId, fn);
}
export function unregisterTermSerialize(paneId: number) {
  termSerializeRegistry.delete(paneId);
}

const SCROLLBACK_KEY = "orb.scrollback";
const PER_PANE_MAX = 200_000; // 1 ペインあたりの保存上限（localStorage 5MB を圧迫しない）

/** アプリ終了/リロード時に全ペインの画面内容を localStorage へ保存。 */
export function saveScrollbacks() {
  try {
    const out: Record<number, string> = {};
    for (const [paneId, fn] of termSerializeRegistry) {
      let text = "";
      try {
        text = fn();
      } catch {
        continue;
      }
      if (!text) continue;
      if (text.length > PER_PANE_MAX) text = text.slice(text.length - PER_PANE_MAX);
      out[paneId] = text;
    }
    localStorage.setItem(SCROLLBACK_KEY, JSON.stringify(out));
  } catch {
    /* 保存失敗は無視（端末動作は継続） */
  }
}

/** 実行中に 1 ペイン分の画面内容を保存マップへ増分マージする（出力が落ち着くたびに呼ばれる）。
 *  saveScrollbacks は終了時の一括版。こちらは他ペインの保存を消さないよう既存マップへ読み書きする。 */
export function saveOneScrollback(paneId: number, text: string) {
  try {
    let map: Record<number, string> = {};
    try {
      const raw = localStorage.getItem(SCROLLBACK_KEY);
      if (raw) map = JSON.parse(raw);
    } catch {
      map = {};
    }
    if (!text) {
      delete map[paneId];
    } else {
      if (text.length > PER_PANE_MAX) text = text.slice(text.length - PER_PANE_MAX);
      map[paneId] = text;
    }
    localStorage.setItem(SCROLLBACK_KEY, JSON.stringify(map));
  } catch {
    /* 保存失敗は無視（端末動作は継続） */
  }
}

// 前回セッションの scrollback を起動時に一度だけメモリ(restoreCache)へ退避しておく。
// #43: 起動時の自動書き戻し（eager restore）は速度のため廃止。退避したスナップショットは
// パレットの「前回のセッションを復元」からオンデマンドでのみ消費する。ensureFirstTab が
// 一度だけ確定させる（セッション中の saveOneScrollback が localStorage を上書きしても、
// 前回分はこの時点でメモリへ写してあるので失われない）。
let restoreCache: Record<number, string> | null = null;
let restorePrimed = false;

/** ensureFirstTab から一度だけ呼ぶ。保存済み scrollback をメモリへ読み込み、オンデマンド
 *  復元で使えるよう退避する。#43 以降は起動時の自動書き戻しをしないため、引数 enabled は
 *  互換のための残置（自動復元の可否を分岐していた名残）で、常にスナップショットのみ退避する。 */
export function primeScrollbackRestore(enabled: boolean) {
  void enabled; // #43: 自動復元は廃止。分岐せず常にオンデマンド用スナップショットを退避。
  if (restorePrimed) return;
  restorePrimed = true;
  try {
    const raw = localStorage.getItem(SCROLLBACK_KEY);
    restoreCache = raw ? JSON.parse(raw) : null;
  } catch {
    restoreCache = null;
  }
}

/** 指定ペインの保存済み画面内容を取り出す（消費。一度取り出したら二度は返さない）。
 *  オンデマンド復元（パレット）から呼ぶ。 */
export function consumeScrollback(paneId: number): string | undefined {
  if (!restoreCache) return undefined;
  const text = restoreCache[paneId];
  if (text === undefined) return undefined;
  delete restoreCache[paneId];
  return text;
}

/** ペインごとの端末書き込みシンク（paneId→term.write）。オンデマンドの前回セッション復元で、
 *  退避しておいた画面内容をそのペインの端末へ書き戻すのに使う（registerTermClear と同じ流儀）。 */
const termWriteRegistry = new Map<number, (text: string) => void>();
export function registerTermWrite(paneId: number, fn: (text: string) => void) {
  termWriteRegistry.set(paneId, fn);
}
export function unregisterTermWrite(paneId: number) {
  termWriteRegistry.delete(paneId);
}
/** 指定ペインの端末へ文字列（ANSI 可）を書き込む。前回セッション復元で使う。 */
export function writeToPane(paneId: number, text: string): boolean {
  const fn = termWriteRegistry.get(paneId);
  if (!fn) return false;
  fn(text);
  return true;
}

/** ペインごとの cwd レジストリ。focus 切替時に旧ペイン値が残置しないよう、
 *  OSC Cwd を全ペイン分ここに溜め、focus 中ペインの値を cwd ストアへ即反映する。 */
const cwdRegistry = new Map<number, string>();

/** OSC 633;P;Cwd 受信時に呼ぶ（フォーカス中なら即 cwd ストアへ）。 */
export function setPaneCwd(paneId: number, dir: string) {
  cwdRegistry.set(paneId, dir);
  if (get(focusedPane) === paneId) cwd.set(dir);
}

// フォーカス変化で即その paneId の cwd へ追従（次の OSC Cwd を待たない＝残置を防ぐ）。
focusedPane.subscribe((pid) => cwd.set(cwdRegistry.get(pid) ?? ""));

/** ペイン破棄時のレジストリ掃除（Terminal.svelte の onDestroy から）。
 *  消さないと閉じたペインの cwd が残り、ID 再利用や誤参照で嘘の cwd を映しうる。 */
export function clearPaneCwd(paneId: number) {
  cwdRegistry.delete(paneId);
}

/** 指定ペイン自身の cwd を読む（フォーカス中ペインとは独立）。#54: チェックポイント捕捉は
 *  「今フォーカスされているペインの cwd」ではなく「AI ペイン自身の cwd」に紐付ける必要がある
 *  （分割ビューで別ペインにフォーカスがある間に AI が作業しても正しい案件を掴むため）。 */
export function getPaneCwd(paneId: number): string | undefined {
  return cwdRegistry.get(paneId);
}

let paneCounter = 0;
/** 単調増加のペイン ID を採番する。#48: 永続はしない＝毎起動 1 から。fresh 構成の
 *  ペイン ID が前回起動と一致することで、paneId キーの scrollback 復元が成立する。 */
export function nextPaneId(): number {
  return ++paneCounter;
}

/** orb 起動時刻（稼働時間表示用）。 */
export const startedAt = Date.now();

/** サイドバーの左右位置（localStorage 永続、既定は右）。 */
const savedSide =
  typeof localStorage !== "undefined"
    ? (localStorage.getItem("orb.sidebarSide") as "left" | "right" | null)
    : null;
export const sidebarSide = writable<"left" | "right">(savedSide ?? "right");
sidebarSide.subscribe((s) => {
  try {
    localStorage.setItem("orb.sidebarSide", s);
  } catch {
    /* localStorage 不可でも動く */
  }
});
