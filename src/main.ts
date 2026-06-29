import { mount } from "svelte";
import "@xterm/xterm/css/xterm.css";
import "./styles/app.css";
import App from "./App.svelte";
import { loadConfig } from "./core/config";

// 端末生成前に設定を読み込んでおく（Terminal は get(config) を同期参照する）。
await loadConfig();

const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;
