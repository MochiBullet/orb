import { mount } from "svelte";
import { invoke } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";
import "./styles/app.css";
import App from "./App.svelte";
import { loadConfig } from "./core/config";
import { initDefaultBg } from "./core/theme";
import { initGlobalErrorHandlers } from "./core/errors";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";

// top-level await はビルド target(es2020)で不可なので即時 async 関数に包む。
async function boot() {
  // #79: 未捕捉 error / unhandledrejection をトースト可視化（最優先で登録＝以後の失敗を拾う）。
  initGlobalErrorHandlers();

  // HMR / WebView リロード時、前マウントが残した PTY を破棄（孤児 reader/pwsh を防ぐ）。
  await invoke("close_all_ptys").catch(() => {});

  // コマンド完了通知の許可を起動時に一度だけ確認。
  try {
    if (!(await isPermissionGranted())) await requestPermission();
  } catch {
    /* 許可不可でも端末は動く */
  }

  // 端末生成前に設定を読み込んでおく（Terminal は get(config) を同期参照する）。
  await loadConfig();

  mount(App, { target: document.getElementById("app")! });

  // #75 ROB-4: 既定背景センチネルの実パス解決（~3MBの埋込動画を読んで比較/初回は書き込み）は
  // 遅い/競合ディスクだと初回描画をブロックしタイムアウトも無い。bgMedia はリアクティブな
  // ストアで App.svelte が購読しているため mount 前に待つ必要が無く、fire-and-forget にして
  // 解決後に背景がポップインする形にする（UI は即座に表示）。
  void initDefaultBg();
}

void boot();
