<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import type { ILink } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { WebglAddon } from "@xterm/addon-webgl";
  import { Unicode11Addon } from "@xterm/addon-unicode11";
  import { ClipboardAddon } from "@xterm/addon-clipboard";
  import { SearchAddon } from "@xterm/addon-search";
  import { WebLinksAddon } from "@xterm/addon-web-links";
  import { SerializeAddon } from "@xterm/addon-serialize";
  import { PtyClient } from "../core/pty";
  import { CommandBlocks } from "./blocks/osc";
  import {
    focusedPane,
    aiPane,
    showSettings,
    showSplash,
    layout,
    broadcast,
    registerTermClear,
    unregisterTermClear,
    registerTermSerialize,
    unregisterTermSerialize,
    registerPaneInput,
    unregisterPaneInput,
    consumeScrollback,
    saveOneScrollback,
  } from "../store/appStore";
  import { leafIds } from "../layout/tree";
  import { config } from "../core/config";
  import { logInfo, logWarn, logError } from "../core/log";
  import { invoke } from "@tauri-apps/api/core";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { get } from "svelte/store";

  let { paneId, initialCmd, role }: { paneId: number; initialCmd?: string; role?: "shell" | "ai" } =
    $props();
  const RESIZE_DEBOUNCE_MS = 150;
  const cfg = get(config);

  let container: HTMLDivElement;
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let search: SearchAddon | undefined;
  let pty: PtyClient | undefined;
  let observer: ResizeObserver | undefined;
  let io: IntersectionObserver | undefined;
  let resizeTimer: number | undefined;
  let disposed = false;
  let blocks: CommandBlocks | undefined;
  let serializeAddon: SerializeAddon | undefined;
  let scrollbackTimer: number | undefined;
  let linkProvider: { dispose(): void } | undefined;
  let showSearch = $state(false);
  let searchQuery = $state("");
  let searchInput = $state<HTMLInputElement | undefined>(undefined);
  let termReady = $state(false);
  let ligatureJoinerId: number | undefined;
  let scrolledUp = $state(false);
  // #42: 起動時、pwsh の profile ロード（starship/zoxide/fzf/PSReadLine）に 2〜5s かかる間は
  // 無出力でフリーズに見える。マウント〜シェル準備完了まで小さな「shell starting…」チップを出す。
  // 消えるのは先着した方: (a) OSC 633;A プロンプト開始 / (b) 最初の実 PTY 出力。固定タイマーは使わない。
  let shellStarting = $state(true);
  const encoder = new TextEncoder();

  // シェル準備完了でチップを消す（冪等）。onData（最初の実出力）と OSC 633;A の双方から呼ばれる。
  function markShellReady() {
    if (shellStarting) shellStarting = false;
  }

  // 起動直後の入力ロス対策（#39）: 入力ハンドラは spawn より前に張り、PTY が未起動の間の
  // 打鍵（スプラッシュの最初の一打を含む）はここに溜めて spawn 完了時に順番どおり流す。
  let inputBuffer: Array<{ bytes: Uint8Array; binary: boolean }> = [];
  let ptyReady = false;

  // 入力バイトを PTY へ即書き込む。binary 以外かつ broadcast 中は全ペインへ複製（通常タイプと同経路）。
  function writeInputNow(bytes: Uint8Array, binary: boolean) {
    if (!binary && get(broadcast)) {
      // ブロードキャスト中はフォーカスペインの入力を全ペインへ複製。
      for (const id of leafIds(get(layout))) {
        void invoke("write_pty", { paneId: id, data: Array.from(bytes) }).catch((e) =>
          logError(`pane ${id}: broadcast write failed: ${String(e)}`),
        );
      }
    } else {
      pty?.write(bytes)?.catch((e) =>
        logError(`pane ${paneId}: ${binary ? "binary" : "input"} write failed: ${String(e)}`),
      );
    }
  }
  // spawn 前は溜め、spawn 後は即書き込む。スプラッシュ／xterm 双方の入力経路がここに集約される。
  function enqueueInput(bytes: Uint8Array, binary = false) {
    if (!ptyReady) {
      inputBuffer.push({ bytes, binary });
      return;
    }
    writeInputNow(bytes, binary);
  }

  // スクロールで履歴を遡っているか判定（「↓ 最下部」ボタンの表示制御）。
  // 代替画面（vim/lazygit 等）では出さない。
  function updateScrollState() {
    if (!term) return;
    const buf = term.buffer.active;
    scrolledUp = buf.type !== "alternate" && buf.viewportY < buf.baseY;
  }

  // プログラミング合字。@xterm/addon-ligatures は font-finder(Node FS) 依存で
  // WebView では動かないため、依存なしで character joiner に主要シーケンスを手動登録し、
  // フォント(Cascadia Code 等)側の合字グリフを描画させる。長い順にマッチさせる。
  const LIGATURES = [
    "<==>", "<-->", "<==", "==>", "<--", "-->", "===", "!==", "=/=", "<=>",
    "<=", "=>", ">=", "==", "!=", "->", "<-", "::", ":=", "|>", "<|",
    "&&", "||", "++", "--", "...", "..", "</", "/>", "</>", "=~", "<>", "|=",
  ].sort((a, b) => b.length - a.length);

  // line のテキストから合字シーケンスの [start, end) 範囲（非重複・昇順）を返す。
  function ligatureJoiner(text: string): [number, number][] {
    const ranges: [number, number][] = [];
    let i = 0;
    while (i < text.length) {
      let hit = false;
      for (const lig of LIGATURES) {
        if (text.startsWith(lig, i)) {
          ranges.push([i, i + lig.length]);
          i += lig.length;
          hit = true;
          break;
        }
      }
      if (!hit) i++;
    }
    return ranges;
  }

  // 選択コピー: マウスアップ時に選択があればクリップボードへ（PuTTY/Linux 流儀）。
  function onMouseUp() {
    const sel = term?.getSelection();
    if (sel) void navigator.clipboard.writeText(sel);
  }
  // 右クリックでペースト（クリップボードの内容を PTY へ）。
  function onContextMenu(e: MouseEvent) {
    e.preventDefault();
    void navigator.clipboard.readText().then((t) => {
      if (t) pty?.write(encoder.encode(t))?.catch((e) => logError(`pane ${paneId}: paste write failed: ${String(e)}`));
    });
  }

  function focusThis() {
    focusedPane.set(paneId);
    term?.focus();
  }

  // Ctrl+L: このペインの選択テキストを AI(claude)ペインの stdin へ送る（ペースト）。
  function sendSelectionToAi() {
    const target = get(aiPane);
    if (target == null || target === paneId) return;
    const sel = term?.getSelection() ?? "";
    if (!sel) return;
    void invoke("write_pty", { paneId: target, data: Array.from(encoder.encode(sel)) }).catch((e) =>
      logError(`pane ${target}: send-to-AI write failed: ${String(e)}`),
    );
  }

  // semantic history（VIBE_IDEAS #37）: 出力中の `src/foo.ts:42` 形をクリックで開く。
  // 拡張子は英字始まり限定（`1.2.3:4` 等の誤マッチを避ける）。可視行のみ正規表現＝perf 影響ゼロ。
  const FILE_LINE_RE = /(?:[\w.\-]+[/\\])*[\w.\-]+\.[A-Za-z][\w]{0,7}:\d+(?::\d+)?/g;
  // クリックされた `path:line(:col)` をペインの cwd 基準で解決してエディタへ。
  function openFileLine(token: string) {
    const m = /^(.*?):(\d+)(?::\d+)?$/.exec(token);
    if (!m) return;
    void invoke("open_in_editor", { cwd: blocks?.cwd || null, path: m[1], line: parseInt(m[2], 10) }).catch(
      (e) => logError(`open_in_editor failed: ${String(e)}`),
    );
  }

  // フォーカスが自分に移ったら実際のキーボードフォーカスも端末へ。
  // 設定パネルを閉じた瞬間も（$showSettings が false になったら）端末へ戻す
  // ＝設定内の input にフォーカスが残って入力が吸われるのを防ぐ。
  $effect(() => {
    // スプラッシュ表示中は端末にフォーカスしない＝Enter で閉じた瞬間に確実に戻す。
    if ($focusedPane === paneId && !$showSettings && !$showSplash) term?.focus();
  });

  // ウィンドウ復帰時、フォーカスペインの端末へ確実にフォーカスを戻す。
  // WebView2 では DOM の window "focus" が alt-tab 復帰で発火しないことがあるため、
  // Tauri ネイティブの onFocusChanged を主軸にする。復帰直後はフォーカス受付が
  // 間に合わないことがあるので次フレームで focus する。
  let unlistenWinFocus: (() => void) | undefined;
  // IME 変換中フラグ。変換中の再フォーカスは未確定文字（合成）を壊すため抑止する。
  let composing = false;
  function onCompStart() {
    composing = true;
  }
  function onCompEnd() {
    composing = false;
  }
  function refocusIfMine() {
    if (disposed || composing) return;
    const ok = () =>
      get(focusedPane) === paneId && !get(showSettings) && !get(showSplash);
    if (!ok()) return;
    // 既に自分の端末にフォーカスがあるなら触らない。IME 候補ウィンドウ出現等で
    // 焦点が外れていないのに focus() を呼ぶと日本語変換が中断されるのを防ぐ。
    if (document.activeElement === term?.textarea) return;
    requestAnimationFrame(() => {
      if (disposed || composing || !ok()) return;
      if (document.activeElement === term?.textarea) return;
      term?.focus();
    });
  }

  // 表示中（タブがアクティブ）かどうか。display:none のスロット内では fit/resize すると
  // cols が壊れ、再表示時に過去の出力が細く描画されるため、可視判定で抑止する。
  function isVisible(): boolean {
    return !!container && container.offsetParent !== null && container.clientWidth > 1 && container.clientHeight > 1;
  }

  // 設定でフォントサイズが変わったら即反映。非表示ペインは fit せず、再表示時に
  // IntersectionObserver の復帰ハンドラで fit し直す（非表示中の fit は描画を壊すため）。
  $effect(() => {
    const fs = $config.font_size;
    if (term && term.options.fontSize !== fs) {
      term.options.fontSize = fs;
      if (isVisible()) {
        fit?.fit();
        pty?.resize(term.cols, term.rows);
      }
    }
  });

  // 合字の ON/OFF（設定の保存で反映）。termReady になってから初回登録も行う。
  $effect(() => {
    const on = $config.ligatures;
    if (!termReady || !term) return;
    if (on && ligatureJoinerId === undefined) {
      ligatureJoinerId = term.registerCharacterJoiner(ligatureJoiner);
      term.refresh(0, term.rows - 1);
    } else if (!on && ligatureJoinerId !== undefined) {
      term.deregisterCharacterJoiner(ligatureJoinerId);
      ligatureJoinerId = undefined;
      term.refresh(0, term.rows - 1);
    }
  });

  // ピンチズーム / Ctrl+ホイール / Ctrl+0。WebView2 ではタッチパッドのピンチは
  // ctrlKey 付き wheel として届く。
  function zoom(delta: number) {
    if (!term) return;
    const cur = term.options.fontSize ?? cfg.font_size;
    term.options.fontSize = Math.min(28, Math.max(8, cur + delta));
    fit?.fit();
    pty?.resize(term.cols, term.rows);
  }
  function resetZoom() {
    if (!term) return;
    term.options.fontSize = cfg.font_size;
    fit?.fit();
    pty?.resize(term.cols, term.rows);
  }
  function onWheel(e: WheelEvent) {
    if (!e.ctrlKey) return;
    // xterm のスクロールに食われないよう、ズーム時は capture 段で握りつぶす。
    e.preventDefault();
    e.stopPropagation();
    zoom(e.deltaY < 0 ? 1 : -1);
  }

  function openSearch() {
    showSearch = true;
    queueMicrotask(() => searchInput?.focus());
  }
  function onSearchKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      showSearch = false;
      term?.focus();
    } else if (e.key === "Enter") {
      if (e.shiftKey) search?.findPrevious(searchQuery);
      else search?.findNext(searchQuery);
    }
  }

  // コピペ等の capture-phase keydown（attachCustomKeyEventHandler は二重発火するため不使用）。
  function onCopyPaste(e: KeyboardEvent) {
    if (!e.ctrlKey) return;
    if (e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); blocks?.jumpPrev(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); blocks?.jumpNext(); return; }
    const key = e.key.toLowerCase();
    if (key === "f") { e.preventDefault(); e.stopPropagation(); openSearch(); return; }
    if (key === "0") { e.preventDefault(); e.stopPropagation(); resetZoom(); return; }
    if (key === "=" || key === "+") { e.preventDefault(); e.stopPropagation(); zoom(1); return; }
    if (key === "-") { e.preventDefault(); e.stopPropagation(); zoom(-1); return; }
    if (key === "l") { e.preventDefault(); e.stopPropagation(); sendSelectionToAi(); return; }
    if (key === "c" && (e.shiftKey || (term?.hasSelection() ?? false))) {
      const sel = term?.getSelection() ?? "";
      if (sel) {
        void navigator.clipboard.writeText(sel);
        term?.clearSelection();
        e.preventDefault();
        e.stopPropagation();
      }
    }
    // Ctrl+V はここで処理しない。keydown を preventDefault しても WebView2 は paste
    // イベントを別途発火するため、手動で readText→pty.write すると xterm 本体の
    // paste ハンドラと二重書き込みになる（＝ペーストが2回出る）。xterm 本体に任せれば
    // bracketed paste（\x1b[200~…201~）も正しく付与され、broadcast 経路（term.onData）
    // にも一本で乗る。右クリック貼り付け（onContextMenu）は別操作なので従来どおり残す。
  }

  // 出力が落ち着いたら（1.5s debounce）画面内容を自動保存。閉じる処理に保存を
  // ぶら下げる方式（onCloseRequested）は close をブロックしてゾンビ化させるため、
  // 稼働中にバックグラウンドで残す。再起動時はこれを過去ログとして書き戻す。
  function scheduleScrollbackSave() {
    if (scrollbackTimer) clearTimeout(scrollbackTimer);
    scrollbackTimer = window.setTimeout(() => {
      if (disposed || !serializeAddon) return;
      try {
        saveOneScrollback(paneId, serializeAddon.serialize({ scrollback: 1000 }));
      } catch {
        /* 保存失敗は無視 */
      }
    }, 1500);
  }

  let ptyStarted = false;
  // PTY 起動は startPty で一度だけ。0px で fit すると 1x1 に丸まり pwsh が極小起動して
  // 描画されない「空の枠」になるため、tryStart 側でサイズ確定を待ってから呼ぶ。
  async function startPty() {
    if (ptyStarted || disposed || !term || !fit) return;
    ptyStarted = true;
    fit.fit();
    logInfo(`pane ${paneId}: startPty (cols=${term.cols} rows=${term.rows})`);

    // 前回セッションの画面内容を復元（あれば）。読み取り専用の過去ログとして書き戻し、
    // 区切りの下に新しい pwsh を起動する＝continue/resume なしで前回の表示が戻る。
    const prior = consumeScrollback(paneId);
    if (prior) {
      term.write(prior);
      term.write(
        "\r\n\x1b[38;5;108m──────── orb · 前回のセッション（上は記録／ここから新しいシェル）────────\x1b[0m\r\n",
      );
      logInfo(`pane ${paneId}: restored scrollback (${prior.length} bytes)`);
    }

    pty = new PtyClient(paneId);
    try {
      await pty.spawn(
        term.cols,
        term.rows,
        (bytes) => {
          markShellReady(); // #42: 最初の実 PTY 出力でチップを消す（先着トリガの一方）。
          term?.write(bytes);
          scheduleScrollbackSave();
        },
        initialCmd,
      );
      logInfo(`pane ${paneId}: pty spawned`);
    } catch (e) {
      logError(`pane ${paneId}: spawn failed: ${String(e)}`);
      term.writeln("\x1b[31m[orb] PTY の起動に失敗しました: " + String(e) + "\x1b[0m");
      term.writeln(
        "\x1b[90mPowerShell 7 (pwsh.exe) が見つからない場合は、インストールするか PATH を通してください。\x1b[0m",
      );
      return;
    }

    if (disposed) {
      pty.close();
      return;
    }

    // spawn 完了。溜まっていた入力（スプラッシュの最初の一打・spawn 待ちの打鍵）を
    // 登録順に流す＝1打も落とさず順序も保つ。以降 enqueueInput は即時書き込みになる。
    ptyReady = true;
    for (const item of inputBuffer) writeInputNow(item.bytes, item.binary);
    inputBuffer = [];
  }

  onMount(async () => {
    logInfo(`pane ${paneId}: mount`);
    term = new Terminal({
      fontFamily: cfg.font_family,
      fontSize: cfg.font_size,
      scrollback: cfg.scrollback,
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: "#000000",
        foreground: "#e6fffa",
        cursor: "#2dd4bf",
        cursorAccent: "#000000",
        selectionBackground: "rgba(45, 212, 191, 0.3)",
        black: "#0a1a17",
        red: "#ff5c8a",
        green: "#6ee7b7",
        yellow: "#fbbf24",
        blue: "#4fc3f7",
        magenta: "#a78bfa",
        cyan: "#2dd4bf",
        white: "#e6fffa",
        brightBlack: "#8ba8a3",
      },
    });

    fit = new FitAddon();
    term.loadAddon(fit);

    const unicode = new Unicode11Addon();
    term.loadAddon(unicode);
    term.unicode.activeVersion = "11";

    term.loadAddon(new ClipboardAddon());
    search = new SearchAddon();
    term.loadAddon(search);

    serializeAddon = new SerializeAddon();
    term.loadAddon(serializeAddon);

    // クリック可能URL: 出力中の http/https をクリックで既定ブラウザで開く。
    term.loadAddon(new WebLinksAddon((_e, uri) => void openUrl(uri)));

    term.open(container);

    // 入力ハンドラは spawn を待たずにここで張る（#39）。PTY 未起動の間は enqueueInput が
    // バッファへ積み、spawn 完了時にまとめて流す＝起動直後の打鍵を1打も落とさない。
    term.onData((data) => enqueueInput(encoder.encode(data)));
    term.onBinary((data) => {
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
      enqueueInput(bytes, true);
    });
    // スプラッシュ表示中（端末未フォーカス）の打鍵をこのペインの入力経路へ流せるよう登録。
    registerPaneInput(paneId, (bytes) => enqueueInput(bytes));

    // file:line リンク（#37）。WebLinksAddon(URL) とは別パターンなので併存させる。
    linkProvider = term.registerLinkProvider({
      provideLinks(y: number, callback: (links: ILink[] | undefined) => void) {
        const line = term?.buffer.active.getLine(y - 1);
        if (!line) {
          callback(undefined);
          return;
        }
        const text = line.translateToString(true);
        const links: ILink[] = [];
        FILE_LINE_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = FILE_LINE_RE.exec(text)) !== null) {
          const token = m[0];
          const x = m.index + 1;
          links.push({
            text: token,
            range: { start: { x, y }, end: { x: x + token.length - 1, y } },
            activate: () => openFileLine(token),
          });
        }
        callback(links.length ? links : undefined);
      },
    });

    container.addEventListener("keydown", onCopyPaste, true);
    container.addEventListener("wheel", onWheel, { passive: false, capture: true });
    container.addEventListener("mouseup", onMouseUp);
    container.addEventListener("contextmenu", onContextMenu);
    container.addEventListener("compositionstart", onCompStart);
    container.addEventListener("compositionend", onCompEnd);
    // ウィンドウ復帰でフォーカス復活（Tauri ネイティブを主軸 + DOM/可視性は保険）。
    window.addEventListener("focus", refocusIfMine);
    document.addEventListener("visibilitychange", refocusIfMine);
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) refocusIfMine();
      })
      .then((un) => {
        if (disposed) un();
        else unlistenWinFocus = un;
      })
      .catch(() => {});

    // Ctrl+Shift+K / パレットの「画面クリア」からこのペインを消去できるよう登録。
    registerTermClear(paneId, () => term?.clear());

    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch (e) {
      console.warn("[orb] WebGL addon unavailable, using fallback renderer", e);
    }

    // #42: OSC 633;A（プロンプト開始）到達でも「shell starting…」を消す（先着トリガのもう一方）。
    blocks = new CommandBlocks(term, paneId, markShellReady);

    // 合字 $effect の初回登録を解禁（term.open 済みでないと joiner を張れない）。
    termReady = true;

    // スクロール状態を追従（「↓ 最下部」ボタンの出し入れ。term.dispose で自動解除）。
    term.onScroll(() => updateScrollState());

    // PTY 起動トリガー。空枠バグ（0px で fit→1x1→極小 pwsh）を避けつつ、
    // ターミナルが無起動で終わらないよう安全網を張る：
    //  - 実寸があれば即起動。
    //  - 表示中なのにサイズ未確定なら数フレーム待ち、最後（~1.5s）は強制起動。
    //  - display:none の非アクティブタブ（offsetParent===null）は表示まで起動を保留し、
    //    ResizeObserver が表示された瞬間に起動を促す。
    // PTY 起動トリガー。0px で fit すると 1x1 に丸まり「空の枠」になるため可視化後に起動。
    // 非表示ペインを rAF で毎フレーム監視すると clientWidth/offsetParent の読みが強制 reflow を
    // 誘発し、ペインが増えるとレイアウトスラッシングでフリーズする。よって：
    //  - 表示中でサイズ確定待ちのときだけ短期 rAF（最大 ~1.5s で強制起動）。
    //  - 非表示タブは reflow ゼロの IntersectionObserver で「表示された瞬間」に起動。
    let startWaited = 0;
    function pollActive() {
      if (ptyStarted || disposed || !term) return;
      if (container.clientWidth > 1 && container.clientHeight > 1) {
        void startPty();
        return;
      }
      if (container.offsetParent === null) return; // 非表示 → IntersectionObserver に委ねる
      if (startWaited > 90) {
        logWarn(`pane ${paneId}: size unresolved, forcing start`);
        void startPty();
        return;
      }
      startWaited++;
      requestAnimationFrame(pollActive);
    }

    io = new IntersectionObserver((entries) => {
      if (disposed) {
        io?.disconnect();
        return;
      }
      if (!entries.some((e) => e.isIntersecting)) return; // 非表示化（タブ離脱）は無視
      if (!ptyStarted) {
        startWaited = 0;
        pollActive(); // 初回: 表示された＝サイズ確定を待って起動
        return;
      }
      // 再表示（タブに戻った）: 非表示中は fit を抑止しているので、隠れている間の窓リサイズ／
      // フォント変更が未反映なまま。実寸に合わせて fit し直し再描画する。これをしないと
      // WebGL のグリフがズレたまま＝過去の出力が細く描画される。次フレームでサイズ確定後に実行。
      requestAnimationFrame(() => {
        if (disposed || !term || !fit || !isVisible()) return;
        fit.fit();
        pty?.resize(term.cols, term.rows);
        term.refresh(0, term.rows - 1);
      });
    });
    io.observe(container);

    observer = new ResizeObserver(() => {
      if (!term || !fit || disposed) return;
      if (!ptyStarted) {
        // 非アクティブタブが表示された等でサイズが付いたら起動。
        if (container.clientWidth > 1 && container.clientHeight > 1) void startPty();
        return;
      }
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (!term || !fit) return;
        // 非表示中（タブ非アクティブ／display:none）は fit しない。0px で fit すると cols が
        // 壊れ、タブに戻ったとき過去の出力が細く描画される（致命バグ）。再表示時は
        // ResizeObserver が 0→実寸でもう一度発火し、IntersectionObserver の復帰ハンドラも
        // 走るので、そこで正しく fit し直す。
        if (!isVisible()) return;
        fit.fit();
        pty?.resize(term.cols, term.rows);
        term.refresh(0, term.rows - 1);
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(container);

    requestAnimationFrame(pollActive);
  });

  onDestroy(() => {
    disposed = true;
    logInfo(`pane ${paneId}: destroy`);
    if (resizeTimer) clearTimeout(resizeTimer);
    if (scrollbackTimer) clearTimeout(scrollbackTimer);
    unregisterTermClear(paneId);
    unregisterPaneInput(paneId);
    inputBuffer = [];
    container?.removeEventListener("keydown", onCopyPaste, true);
    container?.removeEventListener("wheel", onWheel, { capture: true });
    container?.removeEventListener("mouseup", onMouseUp);
    container?.removeEventListener("contextmenu", onContextMenu);
    container?.removeEventListener("compositionstart", onCompStart);
    container?.removeEventListener("compositionend", onCompEnd);
    window.removeEventListener("focus", refocusIfMine);
    document.removeEventListener("visibilitychange", refocusIfMine);
    unlistenWinFocus?.();
    observer?.disconnect();
    io?.disconnect();
    linkProvider?.dispose();
    blocks?.dispose();
    pty?.close();
    term?.dispose();
  });
</script>

<div
  class="term-wrap"
  class:focused={$focusedPane === paneId}
  class:ai={role === "ai"}
  class:broadcast={$broadcast}
>
  <div class="term" bind:this={container} onpointerdown={focusThis} role="presentation"></div>

  {#if shellStarting}
    <!-- #42: 起動レイテンシの体感フリーズ解消。全画面を覆わない小チップ（復元スクロールバックを隠さない）。 -->
    <div class="shell-starting" role="status" aria-live="polite">
      <span class="ss-dot"></span>
      shell starting…
    </div>
  {/if}

  {#if showSearch}
    <div class="search-bar">
      <input
        bind:this={searchInput}
        bind:value={searchQuery}
        onkeydown={onSearchKey}
        oninput={() => search?.findNext(searchQuery)}
        placeholder="検索  (Enter / Shift+Enter / Esc)"
      />
      <button
        class="sx"
        onpointerdown={() => {
          showSearch = false;
          term?.focus();
        }}
        aria-label="close search">&#x2715;</button
      >
    </div>
  {/if}

  {#if scrolledUp}
    <button
      class="scroll-bottom"
      onpointerdown={(e) => {
        e.preventDefault();
        term?.scrollToBottom();
        scrolledUp = false;
        focusThis();
      }}
      title="最下部（入力欄）へ戻る"
    >
      &#x2193; 最下部
    </button>
  {/if}
</div>

<style>
  .term-wrap {
    position: relative;
    width: 100%;
    height: 100%;
    box-shadow: inset 0 0 0 1px transparent;
    transition: box-shadow 0.12s;
  }
  .term-wrap.focused {
    box-shadow: inset 0 0 0 1px rgba(45, 212, 191, 0.45);
  }
  .term-wrap.ai {
    box-shadow: inset 0 0 0 1px rgba(167, 139, 250, 0.5);
  }
  .term-wrap.ai.focused {
    box-shadow: inset 0 0 0 1.5px rgba(167, 139, 250, 0.75);
  }
  /* ブロードキャスト中は全ペインを赤枠で警告（入力が全ペインに飛ぶ）。 */
  .term-wrap.broadcast {
    box-shadow: inset 0 0 0 2px rgba(255, 92, 138, 0.6);
  }
  .term {
    width: 100%;
    height: 100%;
    padding: 6px 8px 4px;
    background: #000;
  }
  .term :global(.xterm-viewport)::-webkit-scrollbar {
    width: 10px;
  }
  .term :global(.xterm-viewport)::-webkit-scrollbar-thumb {
    background: rgba(45, 212, 191, 0.35);
    border-radius: 6px;
  }

  .search-bar {
    position: absolute;
    top: 6px;
    right: 12px;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 6px;
    background: #05100e;
    border: 1px solid rgba(45, 212, 191, 0.4);
    border-radius: 6px;
    box-shadow: 0 0 20px -6px rgba(45, 212, 191, 0.4);
    z-index: 10;
  }
  .search-bar input {
    width: 220px;
    border: 0;
    background: transparent;
    color: var(--fg);
    font-family: inherit;
    font-size: 0.8rem;
    outline: none;
  }
  .search-bar .sx {
    border: 0;
    background: transparent;
    color: var(--grey);
    cursor: pointer;
    font-size: 0.7rem;
  }
  .search-bar .sx:hover {
    color: var(--red);
  }

  /* スクロールで履歴を遡っている間だけ右下に出る「↓ 最下部へ戻る」ボタン。 */
  .scroll-bottom {
    position: absolute;
    right: 14px;
    bottom: 12px;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px 12px;
    background: #05100e;
    border: 1px solid rgba(45, 212, 191, 0.5);
    border-radius: 999px;
    box-shadow: 0 4px 18px -6px rgba(45, 212, 191, 0.5);
    color: var(--teal);
    font-family: inherit;
    font-size: 0.72rem;
    letter-spacing: 0.04em;
    cursor: pointer;
    z-index: 9;
    animation: sb-in 0.14s ease-out;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
  }
  .scroll-bottom:hover {
    background: rgba(45, 212, 191, 0.16);
    border-color: var(--teal);
    color: var(--fg);
  }
  @keyframes sb-in {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  /* #42: 起動中の「shell starting…」チップ。左下に控えめに。全画面を覆わず復元スクロールバックを隠さない。
     アニメは transform/opacity のみ（compositor-only, PERFORMANCE 準拠）。teal/neon on black。 */
  .shell-starting {
    position: absolute;
    left: 14px;
    bottom: 12px;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 4px 11px;
    background: #05100e;
    border: 1px solid rgba(45, 212, 191, 0.4);
    border-radius: 999px;
    box-shadow: 0 4px 18px -6px rgba(45, 212, 191, 0.5);
    color: var(--teal);
    font-family: inherit;
    font-size: 0.72rem;
    letter-spacing: 0.04em;
    pointer-events: none;
    z-index: 9;
    animation: ss-in 0.16s ease-out;
  }
  .ss-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--teal);
    box-shadow: 0 0 8px rgba(45, 212, 191, 0.85);
    animation: ss-pulse 1.15s ease-in-out infinite;
  }
  @keyframes ss-in {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @keyframes ss-pulse {
    0%,
    100% {
      opacity: 0.35;
      transform: scale(0.8);
    }
    50% {
      opacity: 1;
      transform: scale(1.15);
    }
  }
  /* 動き軽減設定では無限パルスを止める（点は残す）。 */
  @media (prefers-reduced-motion: reduce) {
    .shell-starting {
      animation: none;
    }
    .ss-dot {
      animation: none;
      opacity: 0.85;
    }
  }

  /* コマンドブロック（OSC 133/633 の decoration オーバーレイ） */
  .term :global(.orb-block) {
    pointer-events: none;
    box-sizing: border-box;
    border-left: 3px solid transparent;
    transition: border-color 0.15s;
  }
  .term :global(.orb-block.ok) {
    border-left-color: rgba(45, 212, 191, 0.6);
    box-shadow: inset 3px 0 10px -5px rgba(45, 212, 191, 0.6);
  }
  .term :global(.orb-block.fail) {
    border-left-color: rgba(255, 92, 138, 0.75);
    background: rgba(255, 92, 138, 0.05);
    box-shadow: inset 3px 0 10px -5px rgba(255, 92, 138, 0.6);
  }
  .term :global(.orb-block-badge) {
    position: absolute;
    right: 6px;
    top: 0;
    font-size: 10px;
    line-height: 1.4;
    letter-spacing: 0.02em;
  }
  .term :global(.orb-block.ok .orb-block-badge) {
    color: #2dd4bf;
  }
  .term :global(.orb-block.fail .orb-block-badge) {
    color: #ff5c8a;
  }
  /* ブロックの hover ツールバー（コピー / AI へ送る） */
  .term :global(.orb-block-tools) {
    position: absolute;
    right: 56px;
    top: 0;
    display: flex;
    gap: 4px;
    opacity: 0.32;
    transition: opacity 0.12s;
    pointer-events: auto;
  }
  .term :global(.orb-block-tools:hover) {
    opacity: 1;
  }
  .term :global(.orb-block-tools button) {
    border: 1px solid rgba(45, 212, 191, 0.4);
    background: #05100e;
    color: var(--teal);
    font-size: 9px;
    line-height: 1.3;
    border-radius: 4px;
    cursor: pointer;
    padding: 0 5px;
  }
  .term :global(.orb-block-tools button:hover) {
    background: rgba(45, 212, 191, 0.18);
    color: var(--fg);
  }
</style>
