import { invoke } from "@tauri-apps/api/core";

/** #52: cwd の案件がローカルで直近24h/1hに消費した token 量（org 全体の 5h/7d % とは別軸）。 */
export interface LocalUsage {
  last_24h_tokens: number;
  last_hour_tokens: number;
}

/** cwd 未指定・取得失敗は全0（サイドバーは黙って項目を出さないだけ）。 */
export async function getLocalUsage(cwd: string): Promise<LocalUsage> {
  try {
    return await invoke<LocalUsage>("get_local_usage", { cwd: cwd || null });
  } catch {
    return { last_24h_tokens: 0, last_hour_tokens: 0 };
  }
}

/** 1000刻みで k 表記に丸める（例: 12345 → "12.3k"、420 → "420"）。 */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}

/** #52: 5h 使用率のサンプル点（ETA 推定用）。 */
export interface PctSample {
  t: number; // epoch ms
  pct: number; // 0-100
}

/** ETA 推定に使う直近サンプルの最大保持数・最小許容間隔。古すぎる/多すぎるサンプルは捨てる。 */
const MAX_SAMPLES = 6;
/** サンプル同士が近すぎると誤差でrateが暴れるので、これ未満の間隔なら追加しない。 */
const MIN_SAMPLE_GAP_MS = 20_000;

/** サンプルを履歴に追加する純関数（直近 MAX_SAMPLES 件・単調増加時刻のみ保持）。 */
export function pushPctSample(history: PctSample[], sample: PctSample): PctSample[] {
  const last = history[history.length - 1];
  if (last && sample.t - last.t < MIN_SAMPLE_GAP_MS) return history; // 近すぎるサンプルは捨てる
  const next = [...history, sample];
  return next.length > MAX_SAMPLES ? next.slice(next.length - MAX_SAMPLES) : next;
}

/**
 * 直近サンプルの傾き（%/分）から「あと何分で100%に達するか」を推定する純関数。
 * リセット直後（%が下がった＝古いサンプルが無効）はレートを計算せず null（嘘の推定を出さない）。
 * サンプル不足・傾きゼロ以下（減っている/横ばい）も null。
 */
export function estimateEtaMinutes(history: PctSample[]): number | null {
  if (history.length < 2) return null;
  const first = history[0];
  const last = history[history.length - 1];
  if (last.pct < first.pct) return null; // reset を跨いだ＝この履歴では推定不能
  const elapsedMin = (last.t - first.t) / 60_000;
  if (elapsedMin <= 0) return null;
  const ratePerMin = (last.pct - first.pct) / elapsedMin;
  if (ratePerMin <= 0) return null;
  const remaining = 100 - last.pct;
  if (remaining <= 0) return 0;
  return Math.round(remaining / ratePerMin);
}
