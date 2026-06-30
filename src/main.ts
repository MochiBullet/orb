import { mount } from "svelte";
import { invoke } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";
import "./styles/app.css";
import App from "./App.svelte";
import { loadConfig } from "./core/config";
import "./core/theme";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";

// top-level await はビルド target(es2020)で不可なので即時 async 関数に包む。
async function boot() {
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
}

void boot();
