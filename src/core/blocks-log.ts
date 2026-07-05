import { invoke } from "@tauri-apps/api/core";
import { logError } from "./log";

/**
 * #31 ブロックイベント。Rust の `BlockEvent`（blocks.rs）と 1:1・snake_case で送受する。
 *
 * ログ層はレンダラ非依存（xterm を import しない）。osc.ts が xterm からテキスト・時刻・
 * exit を取り出し、ここへ plain object を渡すだけ＝「ログが source of truth」を担保する。
 */
export interface BlockEvent {
  v: 1;
  session_id: string;
  pane_id: number;
  block_id: string;
  cwd: string;
  shell: string;
  prompt_type: string;
  /** 終了コード。-1 = 不明/中断（D 欠落・Ctrl-C・破損 D）。内訳は aborted で判別する。 */
  exit_code: number;
  /** true = D を受け取らず次プロンプト/破棄で閉じた（中断/クラッシュ）。false = D で正常終了。 */
  aborted: boolean;
  started_at: number;
  ended_at: number;
  duration_ms: number;
  /** ブロック全文（プロンプト＋コマンド＋出力、cap 済み）。 */
  text: string;
  truncated: boolean;
  /** コマンドラインのみ（#33: OSC 633;E＋nonce 検証で確定）。E 不在時は null＝嘘をつかない。 */
  command: string | null;
  /** 出力本文のみ（#33: OSC 633;C の出力開始マーカーで確定、cap 済み）。C 不在時は null。 */
  output_body: string | null;
}

/** ブロック全文の保存上限。長いビルド出力等で JSONL を肥大させないため cap する。 */
const TEXT_MAX = 8000;
/** cap 時に残す先頭（コマンド文脈）。末尾（最終エラー/exit 付近）は残余を残す。 */
const TEXT_HEAD = 2000;

/** 末尾の孤立高サロゲート／先頭の孤立低サロゲートを落とす。UTF-16 単位で slice すると
 *  サロゲートペア（絵文字等）を分断でき、孤立サロゲートは JSON 化で serde を弾いて
 *  「ブロックが丸ごとログから消える」ため、切断境界だけ安全に丸める。純関数。 */
function trimLoneSurrogates(s: string): string {
  const n = s.length;
  if (n > 0) {
    const last = s.charCodeAt(n - 1);
    if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1); // 末尾＝高サロゲート単独
  }
  if (s.length > 0) {
    const first = s.charCodeAt(0);
    if (first >= 0xdc00 && first <= 0xdfff) s = s.slice(1); // 先頭＝低サロゲート単独
  }
  return s;
}

/** 上限超過の text を「先頭＋末尾」で切り詰める（中間を省略マーカーで潰す）。純関数。 */
export function capText(text: string): { text: string; truncated: boolean } {
  if (text.length <= TEXT_MAX) return { text, truncated: false };
  const tail = TEXT_MAX - TEXT_HEAD;
  const omitted = text.length - TEXT_MAX;
  const head = trimLoneSurrogates(text.slice(0, TEXT_HEAD));
  const tailPiece = trimLoneSurrogates(text.slice(text.length - tail));
  const clipped = `${head}\n…(${omitted} 文字省略)…\n${tailPiece}`;
  return { text: clipped, truncated: true };
}

/** 一意 ID（session / block 用）。crypto.randomUUID が無い環境向けにフォールバックを持つ。 */
export function genId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** ログのファイル分割キー（ローカル日付 `YYYY-MM-DD`）。純関数。 */
export function localDay(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** orb 起動ごとの session_id（この JS モジュールのロード＝1 起動につき 1 個）。 */
export const sessionId = genId();

/** buildBlockEvent の入力（osc.ts が xterm から集めた素の値）。 */
export interface BlockInput {
  paneId: number;
  blockId: string;
  cwd: string;
  shell: string;
  promptType: string;
  exitCode: number;
  aborted: boolean;
  startedAt: number;
  endedAt: number;
  text: string;
  /** #33: E マーカー由来のコマンドライン（nonce 検証済）。無ければ null。 */
  command: string | null;
  /** #33: C マーカー以降の出力本文。無ければ null。 */
  outputBody: string | null;
}

/** 入力から BlockEvent を組む純関数（xterm 非依存＝単体テスト可能）。 */
export function buildBlockEvent(inp: BlockInput): BlockEvent {
  const { text, truncated } = capText(inp.text);
  // output_body も text と同じ上限で cap（長いビルド出力等の肥大防止）。
  const outputBody = inp.outputBody != null ? capText(inp.outputBody).text : null;
  // command は「切り詰めた半端なコマンド」を残すと再実行が別物になるため、上限超過は null に落とす
  // （一次防衛は osc.ts parseCommandLine の COMMAND_MAX。ここは他経路向けの保険）。
  const command = inp.command != null && inp.command.length <= 4096 ? inp.command : null;
  // startedAt が欠落（0 以下）なら duration を 0 に丸める（巨大な duration を書かない）。
  const started = inp.startedAt > 0 ? inp.startedAt : inp.endedAt;
  return {
    v: 1,
    session_id: sessionId,
    pane_id: inp.paneId,
    block_id: inp.blockId,
    cwd: inp.cwd,
    shell: inp.shell,
    prompt_type: inp.promptType,
    exit_code: inp.exitCode,
    aborted: inp.aborted,
    started_at: started,
    ended_at: inp.endedAt,
    duration_ms: Math.max(0, inp.endedAt - started),
    text,
    truncated,
    command,
    output_body: outputBody,
  };
}

/** 1 ブロックを耐久ログへ追記（#31）。失敗は握り潰す＝端末動作をブロックしない（#40 方式）。 */
export function logBlockEvent(inp: BlockInput): void {
  const event = buildBlockEvent(inp);
  void invoke("append_block_event", { day: localDay(), event }).catch((e) =>
    logError(`block log append failed (pane ${inp.paneId}): ${String(e)}`),
  );
}

/** 指定日のブロックログを読み戻す（履歴オーバーレイの再描画用）。失敗時は空配列。 */
export async function readBlockEvents(day: string = localDay()): Promise<BlockEvent[]> {
  try {
    return await invoke<BlockEvent[]>("read_block_events", { day });
  } catch (e) {
    logError(`block log read failed: ${String(e)}`);
    return [];
  }
}

// ---- #49 全期間横断検索 ------------------------------------------------------------------

/** 検索クエリの構造化結果。Rust の `SearchFilters`（blocks.rs）へそのまま渡す形。 */
export interface SearchSpec {
  /** AND 検索語（`key:value` 以外のトークン）。 */
  terms: string[];
  /** "ok" | "fail" | 終了コードの数値文字列。 */
  exit: string | null;
  cwd: string | null;
  field: "all" | "command" | "output";
  from: string | null;
  to: string | null;
}

export interface SearchHit {
  day: string;
  event: BlockEvent;
}

export interface SearchResult {
  hits: SearchHit[];
  scanned_days: number;
  limit_hit: boolean;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 検索 DSL を構造化する純関数（vitest 対象）。
 *
 * `cargo exit:fail cwd:orb in:command from:2026-06-01` 形式。対応キー:
 * - `exit:` ok / fail（`!0` `≠0` も fail の別名）/ 終了コード数値
 * - `cwd:` 部分一致 / `in:` command・cmd / output・out / all
 * - `from:` `to:` `day:`（YYYY-MM-DD、day は両端に展開）
 * 解釈できない `key:value` はトークンごと検索語に落とす＝入力を黙って捨てない。
 */
export function parseSearchQuery(raw: string): SearchSpec {
  const spec: SearchSpec = { terms: [], exit: null, cwd: null, field: "all", from: null, to: null };
  for (const tok of raw.trim().split(/\s+/).filter(Boolean)) {
    const m = /^([a-zA-Z]+):(.*)$/.exec(tok);
    const key = m?.[1].toLowerCase();
    const val = m?.[2] ?? "";
    const v = val.toLowerCase(); // 値もキー同様に大小無視（cwd と日付は素の val を使う）
    if (key === "exit" && val) {
      if (v === "ok" || v === "fail") {
        spec.exit = v;
        continue;
      }
      if (v === "!0" || v === "≠0") {
        spec.exit = "fail";
        continue;
      }
      if (/^-?\d+$/.test(v)) {
        spec.exit = v;
        continue;
      }
    } else if (key === "cwd" && val) {
      spec.cwd = val;
      continue;
    } else if (key === "in") {
      if (v === "command" || v === "cmd") {
        spec.field = "command";
        continue;
      }
      if (v === "output" || v === "out") {
        spec.field = "output";
        continue;
      }
      if (v === "all") {
        spec.field = "all";
        continue;
      }
    } else if ((key === "from" || key === "to") && DAY_RE.test(val)) {
      spec[key] = val;
      continue;
    } else if (key === "day" && DAY_RE.test(val)) {
      spec.from = val;
      spec.to = val;
      continue;
    }
    spec.terms.push(tok);
  }
  return spec;
}

/** 全期間のブロックログを横断検索する（#49）。失敗時は空結果。 */
export async function searchBlockEvents(raw: string, limit = 200): Promise<SearchResult> {
  const spec = parseSearchQuery(raw);
  try {
    return await invoke<SearchResult>("search_block_events", {
      filters: { ...spec, limit },
    });
  } catch (e) {
    logError(`block log search failed: ${String(e)}`);
    return { hits: [], scanned_days: 0, limit_hit: false };
  }
}

/**
 * 過去ログの複利（「このエラー前も見た？」）専用の検索。DSL 文字列を経由せず、同じ cwd・
 * 同じコマンドのヒットを直接取りに行く（コマンド中の `:` 等が DSL のキー記法と衝突しない
 * ようにするため、parseSearchQuery は通さない）。command は空白で AND 分割し command
 * フィールドに絞って検索する＝完全一致ではなく「同じコマンドらしさ」の緩い一致。
 */
export async function searchSameCommand(
  cwd: string,
  command: string,
  limit = 50,
): Promise<SearchResult> {
  const terms = command.split(/\s+/).filter(Boolean);
  if (!terms.length) return { hits: [], scanned_days: 0, limit_hit: false };
  try {
    return await invoke<SearchResult>("search_block_events", {
      filters: { terms, exit: null, cwd, field: "command", from: null, to: null, limit },
    });
  } catch (e) {
    logError(`past-failure search failed: ${String(e)}`);
    return { hits: [], scanned_days: 0, limit_hit: false };
  }
}
