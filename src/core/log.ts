// orb の軽量ロガー。ペインのライフサイクル（mount / spawn / resize / destroy 等）の
// 診断ログを [orb] 接頭辞付きで console へ出すだけのもの。端末描画や PTY とは独立で、
// 本番ビルドでも WebView2 の devtools から拾える。将来ファイル/Rust 転送が要るならここを差し替える。
const PREFIX = "[orb]";

export function logInfo(msg: string): void {
  console.info(`${PREFIX} ${msg}`);
}

export function logWarn(msg: string): void {
  console.warn(`${PREFIX} ${msg}`);
}

export function logError(msg: string): void {
  console.error(`${PREFIX} ${msg}`);
}
