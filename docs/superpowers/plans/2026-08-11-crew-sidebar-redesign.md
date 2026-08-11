# Crew サイドバー再設計 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 画面上部 1/4 を占めていた Crew の帯を撤去し、サイドバー内の 2 席として作り直す。状態は吹き出しの文字で言い、キャラクターは差し替えできるようにする。

**Architecture:** 判定ロジックは既存の `core/agent-status.ts`（`PaneStatus` / `STATUS_PRIORITY`）に完全に乗り、Crew 側では一切判定しない。席の選択・経過時間の整形・名前解決・スプライトシートの検証はすべて `src/crew/` の純関数へ隔離して vitest で見る。描画は Svelte、既定のキャラは SVG 生成関数、上書きは PNG スプライトシート。Rust 側の責務は「選ばれた PNG を設定ディレクトリへコピーする」だけ。

**Tech Stack:** Svelte 5 (runes) / TypeScript / vitest / Rust (Tauri 2) / serde+toml / tauri-plugin-dialog

## Global Constraints

- サイドバーの幅は **168px 固定**（`.sidebar { flex: 0 0 168px }` を変更しない）
- 席は **2 席固定**
- 状態は **文字で伝える。色で状態を表さない**
- キャラ本体の色は **キャラ枠固有の色**。状態によって塗り替えない
- 設定物の置き場所は **`config_dir()` = `$XDG_CONFIG_HOME/orb`（未設定なら `~/.config/orb`）**。`%APPDATA%` は使わない
- スプライトシートの検証は **フロント側**（`Image` の `naturalWidth/naturalHeight`）。Rust に PNG デコーダを足さない
- アニメーションは **transform / opacity のみ**（PERFORMANCE.md）
- コード・コメント・UI 文言に**個人的なペルソナ名を入れない**（公開リポジトリのため。`枠1` `枠2` のような汎用名にする）
- 各タスク完了時に `pnpm vitest run` / `pnpm exec svelte-check --threshold error` / `cd src-tauri && cargo test` が緑であること

---

### Task 1: 状態が変わった時刻を記録する

**Files:**
- Modify: `src/store/appStore.ts`（`paneStatus` / `setPaneStatus` / `disposePane` 周辺）
- Test: `src/store/appStore.test.ts`（無ければ新規作成）

**Interfaces:**
- Consumes: なし
- Produces: `paneStatusSince: Readable<ReadonlyMap<number, number>>`、`setPaneStatus(paneId, s)` の副作用

- [ ] **Step 1: 失敗するテストを書く**

`src/store/appStore.test.ts` に追記（ファイルが無ければ新規作成し、先頭に `import { describe, it, expect } from "vitest";` を置く）:

```ts
import { get } from "svelte/store";
import { paneStatus, paneStatusSince, setPaneStatus } from "./appStore";

describe("paneStatusSince", () => {
  it("状態が変わった時だけ時刻を更新する", () => {
    setPaneStatus(1, null);
    setPaneStatus(1, "running");
    const first = get(paneStatusSince).get(1);
    expect(first).toBeTypeOf("number");

    setPaneStatus(1, "running"); // 同じ値の再設定
    expect(get(paneStatusSince).get(1)).toBe(first);

    setPaneStatus(1, "failed");
    expect(get(paneStatusSince).get(1)).not.toBe(first);
  });

  it("状態が消えたら時刻も消す", () => {
    setPaneStatus(2, "attention");
    expect(get(paneStatusSince).has(2)).toBe(true);
    setPaneStatus(2, null);
    expect(get(paneStatusSince).has(2)).toBe(false);
    expect(get(paneStatus).has(2)).toBe(false);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm vitest run src/store/appStore.test.ts`
Expected: FAIL — `paneStatusSince` が export されていない

- [ ] **Step 3: 実装**

`src/store/appStore.ts` の `paneStatus` 宣言の直後に追加:

```ts
/** 各ペインが「今の状態」になった時刻(ms)。Crew の経過時間表示の元。
 *  setPaneStatus が値の変化時だけ書く＝同じ状態の再設定で経過がリセットされない。 */
export const paneStatusSince = writable<ReadonlyMap<number, number>>(new Map());
```

`setPaneStatus` を差し替える:

```ts
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
```

`disposePane`（ペイン破棄の掃除関数。`paneStatus` を消している箇所）に 1 行足す:

```ts
  paneStatusSince.update((m) => {
    if (!m.has(paneId)) return m;
    const next = new Map(m);
    next.delete(paneId);
    return next;
  });
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run src/store/appStore.test.ts`
Expected: PASS（2 件）

- [ ] **Step 5: コミット**

```bash
git add src/store/appStore.ts src/store/appStore.test.ts
git commit -m "feat(crew): record when each pane entered its current status"
```

---

### Task 2: 上部の帯と旧 Crew 実装を撤去する

**Files:**
- Modify: `src/App.svelte`
- Delete: `src/crew/Crew.svelte`
- Delete: `src/crew/model.ts`
- Delete: `src/crew/model.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: なし（削除のみ）

**なぜ最初に消すのか:** 旧 `model.ts` の export（`seatToIso` / `SEAT_COLS` など）を旧 `Crew.svelte` が
参照しているため、モジュールだけ先に書き換えると**新しい描画が出来上がるまでビルドが赤いまま**になる。
先に消しておけば、以降のどのコミットでも `svelte-check` が緑を保てる。
この間 Crew 機能は一時的に無くなるが、帯の撤去自体が今回の目的なので問題ない。

- [ ] **Step 1: App.svelte から帯を外す**

`src/App.svelte` から次を削除する:

```svelte
  import Crew from "./crew/Crew.svelte";
```

```svelte
    <!-- ペイン＝キャラのアイソメ帯。非表示時は DOM ごと消す＝描画コストが完全にゼロになる。 -->
    {#if $crewVisible}<Crew />{/if}
```

`crewVisible` は `Workspace.svelte` のトグル（`Ctrl+Shift+J`）とパレット項目が引き続き使うので
**store 自体は消さない**。`App.svelte` の import からだけ外す。

- [ ] **Step 2: 旧実装を削除**

```bash
git rm src/crew/Crew.svelte src/crew/model.ts src/crew/model.test.ts
```

- [ ] **Step 3: 緑を確認**

Run: `pnpm exec svelte-check --threshold error && pnpm vitest run`
Expected: 0 ERRORS / 全 PASS（旧 model の 13 件が消えるのでテスト総数は減る）

- [ ] **Step 4: コミット**

```bash
git add src/App.svelte
git commit -m "refactor(crew): remove the top band ahead of the sidebar rebuild"
```

---

### Task 3: 席の選択と名前の解決

**Files:**
- Create: `src/crew/model.ts`（Task 2 で削除済み。ゼロから作る）
- Create: `src/crew/model.test.ts`

**Interfaces:**
- Consumes: `PaneStatus` / `STATUS_PRIORITY`（`src/core/agent-status.ts`）、`PaneRole`（`src/layout/tree.ts`）、Task 1 の `paneStatusSince`
- Produces:
  - `export type CrewPose = PaneStatus | "idle"`
  - `export const MAX_SEATS = 2`
  - `export interface CrewCandidate { paneId: number; tabId: number; tabName: string; role: PaneRole; label?: string; status: PaneStatus | null; since: number | null; command?: string | null }`
  - `export function selectSeats(all: CrewCandidate[], max?: number): { seats: CrewCandidate[]; overflow: number }`
  - `export function poseForStatus(s: PaneStatus | null): CrewPose`
  - `export function resolveName(slotName: string | undefined, c: CrewCandidate): string`

- [ ] **Step 1: 失敗するテストを書く**

`src/crew/model.test.ts` を新規作成する:

```ts
import { describe, it, expect } from "vitest";
import { selectSeats, poseForStatus, resolveName, MAX_SEATS, type CrewCandidate } from "./model";

function cand(p: Partial<CrewCandidate> & { paneId: number }): CrewCandidate {
  return {
    tabId: 1, tabName: "tab 1", role: "shell", status: null, since: null, ...p,
  };
}

describe("selectSeats", () => {
  it("手が要る順に2件だけ着席させ、あふれた数を返す", () => {
    const r = selectSeats([
      cand({ paneId: 1, status: "running" }),
      cand({ paneId: 2, status: "failed" }),
      cand({ paneId: 3, status: "attention" }),
      cand({ paneId: 4, status: "waiting" }),
    ]);
    expect(r.seats.map((s) => s.paneId)).toEqual([3, 2]);
    expect(r.overflow).toBe(2);
  });

  it("状態を持たないペインは最下位だが、空いた席には座る", () => {
    const r = selectSeats([
      cand({ paneId: 1, status: null }),
      cand({ paneId: 2, status: "running" }),
    ]);
    expect(r.seats.map((s) => s.paneId)).toEqual([2, 1]);
    expect(r.overflow).toBe(0);
  });

  it("同じ状態ならペインID昇順で安定する", () => {
    const r = selectSeats([
      cand({ paneId: 9, status: "waiting" }),
      cand({ paneId: 3, status: "waiting" }),
      cand({ paneId: 5, status: "waiting" }),
    ]);
    expect(r.seats.map((s) => s.paneId)).toEqual([3, 5]);
    expect(r.overflow).toBe(1);
  });

  it("ペインが1つなら1席だけ埋まる", () => {
    const r = selectSeats([cand({ paneId: 7 })]);
    expect(r.seats).toHaveLength(1);
    expect(r.overflow).toBe(0);
  });

  it("別タブのペインも候補に含まれる（INBOXの全タブ横断を引き継ぐ）", () => {
    const r = selectSeats([
      cand({ paneId: 1, tabId: 1, status: "running" }),
      cand({ paneId: 2, tabId: 2, tabName: "tab 2", status: "attention" }),
    ]);
    expect(r.seats[0].paneId).toBe(2);
    expect(r.seats[0].tabName).toBe("tab 2");
  });

  it("席数は MAX_SEATS を超えない", () => {
    const many = Array.from({ length: 8 }, (_, i) => cand({ paneId: i, status: "running" }));
    expect(selectSeats(many).seats).toHaveLength(MAX_SEATS);
  });
});

describe("poseForStatus", () => {
  it("状態をそのままポーズ名に、状態無しは idle にする", () => {
    expect(poseForStatus("running")).toBe("running");
    expect(poseForStatus("attention")).toBe("attention");
    expect(poseForStatus(null)).toBe("idle");
  });
});

describe("resolveName", () => {
  it("枠名 → ランチャーlabel → タブ名+ペインID の順に落ちる", () => {
    const c = cand({ paneId: 4, label: "PLIMAL", tabName: "tab 2" });
    expect(resolveName("枠1", c)).toBe("枠1");
    expect(resolveName("", c)).toBe("PLIMAL");
    expect(resolveName("", cand({ paneId: 4, tabName: "tab 2" }))).toBe("tab 2 · p4");
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm vitest run src/crew/model.test.ts`
Expected: FAIL — `selectSeats` などが存在しない

- [ ] **Step 3: 実装**

`src/crew/model.ts` を新規作成する:

```ts
/**
 * Crew ビュー（ペイン＝キャラ）の純ロジック。DOM/Svelte/Tauri 非依存＝vitest 対象。
 *
 * 状態判定そのものは一切持たない。agent-status.ts が決めた PaneStatus を「席」と「見た目」へ
 * 写すだけ（判定を二重実装するとバッジ・通知・キャラの表示がズレる）。
 */
import { STATUS_PRIORITY, type PaneStatus } from "../core/agent-status";
import type { PaneRole } from "../layout/tree";

/** キャラのポーズ。状態名そのまま＋バッジ無しの idle。 */
export type CrewPose = PaneStatus | "idle";

/** サイドバー幅 168px に収まる席数。 */
export const MAX_SEATS = 2;

export interface CrewCandidate {
  paneId: number;
  tabId: number;
  tabName: string;
  role: PaneRole;
  /** ランチャー由来のラベル（案件名）。 */
  label?: string;
  status: PaneStatus | null;
  /** status になった時刻(ms)。null = 不明。 */
  since: number | null;
  /** 直近のコマンド行。AI ペインでは常に "claude" なので描画側で出さない。 */
  command?: string | null;
}

function rank(s: PaneStatus | null): number {
  if (s == null) return STATUS_PRIORITY.length; // 状態無し＝最下位
  const i = STATUS_PRIORITY.indexOf(s);
  return i < 0 ? STATUS_PRIORITY.length : i;
}

/**
 * 手が要る順に並べ、上位 max 件を席に着ける。あふれた数も返す。
 * 元の配列は変更しない（$derived から呼ばれるため）。
 */
export function selectSeats(all: CrewCandidate[], max = MAX_SEATS): {
  seats: CrewCandidate[];
  overflow: number;
} {
  const sorted = [...all].sort((a, b) => rank(a.status) - rank(b.status) || a.paneId - b.paneId);
  return { seats: sorted.slice(0, max), overflow: Math.max(0, sorted.length - max) };
}

export function poseForStatus(s: PaneStatus | null | undefined): CrewPose {
  return s ?? "idle";
}

/** 枠に付けた名前を最優先。無ければ案件ラベル、それも無ければタブ名とペインID。 */
export function resolveName(slotName: string | undefined, c: CrewCandidate): string {
  const slot = slotName?.trim();
  if (slot) return slot;
  const label = c.label?.trim();
  if (label) return label;
  return `${c.tabName} · p${c.paneId}`;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run src/crew/model.test.ts`
Expected: PASS（8 件）

- [ ] **Step 5: コミット**

```bash
git add src/crew/model.ts src/crew/model.test.ts
git commit -m "feat(crew): seat selection across tabs, ordered by who needs a hand"
```

---

### Task 4: 吹き出しの文言と経過時間

**Files:**
- Modify: `src/crew/model.ts`
- Modify: `src/crew/model.test.ts`

**Interfaces:**
- Consumes: Task 3 の `CrewPose`
- Produces: `export const CREW_IDLE_LABEL = "待機"`、`export function formatElapsed(ms: number): string`、`export function bubbleText(status: PaneStatus | null, since: number | null, now: number): string`

- [ ] **Step 1: 失敗するテストを書く**

`src/crew/model.test.ts` の末尾に追記する。**import は既存の先頭の import 行へ足す**
（ファイル中間に import を書かない）:

```ts
// 先頭の import を次に差し替える:
// import { selectSeats, poseForStatus, resolveName, MAX_SEATS, formatElapsed,
//          bubbleText, CREW_IDLE_LABEL, type CrewCandidate } from "./model";

describe("formatElapsed", () => {
  it("分と秒で出す", () => {
    expect(formatElapsed(0)).toBe("0分0秒");
    expect(formatElapsed(48_000)).toBe("0分48秒");
    expect(formatElapsed(192_000)).toBe("3分12秒");
  });

  it("1時間を超えたら時間と分にする", () => {
    expect(formatElapsed(3_600_000)).toBe("1時間0分");
    expect(formatElapsed(7_500_000)).toBe("2時間5分");
  });

  it("24時間を超えたら頭打ちにする", () => {
    expect(formatElapsed(90_000_000)).toBe("24時間+");
  });

  it("負の値は0秒として扱う（時計のズレで壊さない）", () => {
    expect(formatElapsed(-5_000)).toBe("0分0秒");
  });
});

describe("bubbleText", () => {
  it("状態名と経過を並べる", () => {
    expect(bubbleText("attention", 1000, 193_000)).toBe("要承認 3分12秒");
  });

  it("状態が無ければ待機と言い、経過は出さない", () => {
    expect(bubbleText(null, null, 1000)).toBe(CREW_IDLE_LABEL);
  });

  it("時刻が不明なら状態名だけ出す（嘘の数字を出さない）", () => {
    expect(bubbleText("running", null, 1000)).toBe("実行中");
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm vitest run src/crew/model.test.ts`
Expected: FAIL — `formatElapsed` が存在しない

- [ ] **Step 3: 実装**

`src/crew/model.ts` の末尾に追加（先頭の import に `STATUS_LABEL` を足す）:

```ts
/** 状態を持たないペインの吹き出し。STATUS_LABEL には足さない
 *  （idle は PaneStatus ではなく「バッジ無し」なので、バッジ/通知の意味論を変えない）。 */
export const CREW_IDLE_LABEL = "待機";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 経過時間の見出し。24時間で頭打ちにするのは、桁が増えて 168px を割るのを防ぐため。 */
export function formatElapsed(ms: number): string {
  const t = Math.max(0, ms);
  if (t >= DAY_MS) return "24時間+";
  const totalSec = Math.floor(t / 1000);
  const hours = Math.floor(totalSec / 3600);
  if (hours >= 1) return `${hours}時間${Math.floor((totalSec % 3600) / 60)}分`;
  return `${Math.floor(totalSec / 60)}分${totalSec % 60}秒`;
}

/** 吹き出しの中身。状態は文字で言う（色では言わない）。 */
export function bubbleText(status: PaneStatus | null, since: number | null, now: number): string {
  if (status == null) return CREW_IDLE_LABEL;
  const label = STATUS_LABEL[status];
  if (since == null) return label; // 時刻が無いのに経過を書くと嘘になる
  return `${label} ${formatElapsed(now - since)}`;
}
```

import 行を次に差し替える:

```ts
import { STATUS_LABEL, STATUS_PRIORITY, type PaneStatus } from "../core/agent-status";
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run src/crew/model.test.ts`
Expected: PASS（15 件）

- [ ] **Step 5: コミット**

```bash
git add src/crew/model.ts src/crew/model.test.ts
git commit -m "feat(crew): speech-bubble text says the status in words, plus elapsed"
```

---

### Task 5: 既定キャラの SVG

**Files:**
- Create: `src/crew/char-svg.ts`
- Create: `src/crew/char-svg.test.ts`

**Interfaces:**
- Consumes: Task 3 の `CrewPose`
- Produces: `export function charSvg(pose: CrewPose, baseColor: string, size?: number): string`

**必読:** ポーズ・色・描画順の根拠は spec の「3. キャラクターの絵」。とくに **腕は頭より後に描く**。試作で腕→胴→頭の順にしたところ、上げた腕が頭の裏に隠れて 6 ポーズのシルエットが全部同じになった（今回の指摘そのものが再発した）。

- [ ] **Step 1: 失敗するテストを書く**

`src/crew/char-svg.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { charSvg } from "./char-svg";
import type { CrewPose } from "./model";

const POSES: CrewPose[] = ["running", "waiting", "attention", "done", "failed", "idle"];

describe("charSvg", () => {
  it("全ポーズが SVG を返す", () => {
    for (const p of POSES) {
      const s = charSvg(p, "#4fb3a4");
      expect(s.startsWith("<svg")).toBe(true);
      expect(s).toContain("</svg>");
    }
  });

  it("ポーズごとに中身が違う（＝シルエットが変わる）", () => {
    const seen = new Set(POSES.map((p) => charSvg(p, "#4fb3a4")));
    expect(seen.size).toBe(POSES.length);
  });

  it("腕は頭より後に描く（上げた腕が頭に隠れないための不変条件）", () => {
    const s = charSvg("attention", "#4fb3a4");
    expect(s.indexOf('data-part="arms"')).toBeGreaterThan(s.indexOf('data-part="head"'));
  });

  it("キャラ固有色を使い、状態色では塗らない", () => {
    expect(charSvg("failed", "#9b7fd4")).toContain("#9b7fd4");
    expect(charSvg("failed", "#9b7fd4")).not.toContain("#ff5c8a");
  });

  it("size を渡すと width/height に反映される", () => {
    expect(charSvg("idle", "#4fb3a4", 42)).toContain('width="42"');
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm vitest run src/crew/char-svg.test.ts`
Expected: FAIL — `./char-svg` が存在しない

- [ ] **Step 3: 実装**

`src/crew/char-svg.ts` を作成。中身は検証済みのモック `scratchpad/crew-mock/chars.js` を TypeScript 化したもので、次の要件を満たすこと:

- `<g data-part="body">` → `<g data-part="head">` → `<g data-part="arms">` の順に出力する（この順序をテストが不変条件として見ている）
- ポーズごとに変えるのは **腕の到達点 / 目 / 口 / 体の沈み込み** の 4 つ
- `baseColor` から髪（暗く混ぜる）・服の影（暗く混ぜる）・髪のハイライト（白と混ぜる）を作る
- viewBox は `0 0 72 78`、既定 `size` は 64

ポーズ表（spec と同じ。`arms` は [左手の到達点, 右手の到達点]、`drop` は体全体の沈み込み）:

```ts
const POSE: Record<CrewPose, PoseSpec> = {
  idle:      { eyes: "normal", brows: "normal", mouth: "flat",  drop: 0,
               arms: [[16, 62, -5], [56, 62, 5]] },
  running:   { eyes: "focus",  brows: "focus",  mouth: "small", drop: 2, lean: 1.5,
               arms: [[27, 62, -4], [45, 62, 4]], keyboard: true },
  waiting:   { eyes: "normal", brows: "sad",    mouth: "wave",  drop: 0,
               arms: [[16, 62, -5], [61, 12, 8]] },
  attention: { eyes: "wide",   brows: "wide",   mouth: "open",  drop: -2.5,
               arms: [[10, 9, -9], [62, 9, 9]] },
  done:      { eyes: "closed", brows: "normal", mouth: "smile", drop: 0,
               arms: [[16, 62, -5], [59, 26, 8]], thumb: true },
  failed:    { eyes: "cross",  brows: "sad",    mouth: "flat",  drop: 5,
               arms: [[14, 66, -6], [58, 66, 6]] },
};
```

移植元は `C:\Users\hiyok\AppData\Local\Temp\claude\C--Users-hiyok\a29feb63-e7f8-4511-90ad-bd742a81db56\scratchpad\crew-mock\chars.js`。関数 `palette` / `mix` / `eye` / `brows` / `mouth` / `arm` / `charSvg` をそのまま移し、`CrewPose` 型を付け、`typing` というキー名を `running` に統一する。`<g data-part="...">` のラッパは移植時に足す。

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run src/crew/char-svg.test.ts`
Expected: PASS（5 件）

- [ ] **Step 5: 見た目を実際に確認する**

Run: `pnpm tauri dev` は使わず、一時 HTML で 6 ポーズを 42px と 32px で並べて目視する。
静的レビューでは「腕が頭に隠れている」を検出できなかった実績があるため、**必ず絵として見る**こと。

- [ ] **Step 6: コミット**

```bash
git add src/crew/char-svg.ts src/crew/char-svg.test.ts
git commit -m "feat(crew): built-in SVG character with one pose per status"
```

---

### Task 6: スプライトシートの検証と切り出し

**Files:**
- Create: `src/crew/sprite.ts`
- Create: `src/crew/sprite.test.ts`

**Interfaces:**
- Consumes: Task 3 の `CrewPose`
- Produces:
  - `export const SPRITE_ORDER: CrewPose[]`（`["running","waiting","attention","done","failed","idle"]`）
  - `export function validateSheet(w: number, h: number): { ok: true; frame: number } | { ok: false; reason: string }`
  - `export function frameRect(pose: CrewPose, frame: number): { x: number; y: number; w: number; h: number }`

- [ ] **Step 1: 失敗するテストを書く**

`src/crew/sprite.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateSheet, frameRect, SPRITE_ORDER } from "./sprite";

describe("validateSheet", () => {
  it("横に6コマ・各コマ正方形なら通す", () => {
    expect(validateSheet(384, 64)).toEqual({ ok: true, frame: 64 });
    expect(validateSheet(768, 128)).toEqual({ ok: true, frame: 128 });
  });

  it("コマが正方形でなければ理由を付けて弾く", () => {
    const r = validateSheet(384, 100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("6");
  });

  it("寸法が0や負なら弾く", () => {
    expect(validateSheet(0, 64).ok).toBe(false);
    expect(validateSheet(384, 0).ok).toBe(false);
  });
});

describe("frameRect", () => {
  it("並び順どおりの位置を返す", () => {
    expect(frameRect("running", 64)).toEqual({ x: 0, y: 0, w: 64, h: 64 });
    expect(frameRect("idle", 64)).toEqual({ x: 320, y: 0, w: 64, h: 64 });
  });

  it("並び順は6ポーズちょうど", () => {
    expect(SPRITE_ORDER).toHaveLength(6);
    expect(new Set(SPRITE_ORDER).size).toBe(6);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm vitest run src/crew/sprite.test.ts`
Expected: FAIL — `./sprite` が存在しない

- [ ] **Step 3: 実装**

`src/crew/sprite.ts`:

```ts
/**
 * 差し替え用スプライトシート（1枚のPNGに6ポーズを横一列）の検証と切り出し。
 *
 * 検証をフロントで行うのは、Image の naturalWidth/naturalHeight だけで足りるため。
 * Rust に PNG デコーダを足す必要がない（png クレートは現在エンコード用途のみ）。
 */
import type { CrewPose } from "./model";

/** シート内の並び。この順序はテンプレートと同梱ドキュメントの唯一の根拠。 */
export const SPRITE_ORDER: CrewPose[] = [
  "running", "waiting", "attention", "done", "failed", "idle",
];

export function validateSheet(w: number, h: number):
  | { ok: true; frame: number }
  | { ok: false; reason: string } {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { ok: false, reason: "画像の寸法を取得できませんでした" };
  }
  const frame = w / SPRITE_ORDER.length;
  if (!Number.isInteger(frame) || frame !== h) {
    return {
      ok: false,
      reason: `${SPRITE_ORDER.length}コマ横一列・各コマ正方形にしてください（今: ${w}×${h}）`,
    };
  }
  return { ok: true, frame };
}

export function frameRect(pose: CrewPose, frame: number) {
  const i = Math.max(0, SPRITE_ORDER.indexOf(pose));
  return { x: i * frame, y: 0, w: frame, h: frame };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run src/crew/sprite.test.ts`
Expected: PASS（5 件）

- [ ] **Step 5: コミット**

```bash
git add src/crew/sprite.ts src/crew/sprite.test.ts
git commit -m "feat(crew): validate and slice uploaded sprite sheets"
```

---

### Task 7: 設定にキャラ枠を足す（Rust + TS）

**Files:**
- Modify: `src-tauri/src/config.rs`
- Modify: `src/core/config.ts`
- Test: `src-tauri/src/config.rs`（`#[cfg(test)]` に追記）

**Interfaces:**
- Consumes: なし
- Produces: `Config.crew: Vec<CrewSlot>`（TOML では `[[crew]]`）、TS の `OrbConfig.crew: CrewSlot[]`

- [ ] **Step 1: 失敗するテストを書く**

`src-tauri/src/config.rs` の `#[cfg(test)] mod tests` に追記:

```rust
#[test]
fn crew_defaults_to_two_slots() {
    let c: Config = toml::from_str("").expect("empty config parses");
    assert_eq!(c.crew.len(), 2);
    assert!(c.crew[0].sprite.is_empty());
    assert!(!c.crew[0].color.is_empty());
}

#[test]
fn crew_slots_round_trip() {
    // 生文字列は r##"…"## にする。中身に "#123456" が入るため r#"…"# だと途中で閉じる。
    let src = r##"
[[crew]]
name = "枠A"
color = "#123456"
sprite = "crew/slot0.png"
"##;
    let c: Config = toml::from_str(src).expect("parses");
    assert_eq!(c.crew.len(), 1);
    assert_eq!(c.crew[0].name, "枠A");
    assert_eq!(c.crew[0].sprite, "crew/slot0.png");
}
```

- [ ] **Step 2: 失敗を確認**

Run: `cd src-tauri && cargo test crew_`
Expected: FAIL — `Config` に `crew` フィールドが無い

- [ ] **Step 3: 実装**

`src-tauri/src/config.rs` に追加:

```rust
/// Crew の1枠。sprite が空なら既定の SVG キャラを描く。
/// Project と同じく全フィールドに serde(default) を付け、1つ欠けても枠ごと落ちないようにする。
#[derive(Serialize, Deserialize, Clone)]
pub struct CrewSlot {
    #[serde(default)]
    pub name: String,
    #[serde(default = "default_crew_color")]
    pub color: String,
    /// config_dir() からの相対パス。空 = 既定 SVG。
    #[serde(default)]
    pub sprite: String,
}

fn default_crew_color() -> String {
    "#4fb3a4".into()
}

fn default_crew_slots() -> Vec<CrewSlot> {
    vec![
        CrewSlot { name: String::new(), color: "#4fb3a4".into(), sprite: String::new() },
        CrewSlot { name: String::new(), color: "#9b7fd4".into(), sprite: String::new() },
    ]
}
```

`pub struct Config` に 1 フィールド追加:

```rust
    #[serde(default = "default_crew_slots")]
    pub crew: Vec<CrewSlot>,
```

**`config_from_value` にも 1 行足す**（#74 のフィールド単位救済パス）。この関数は `Config { … }` を
全フィールド明示で組み立てているので、足さないとコンパイルが通らない。かつ、ここを通る
（壊れた config.toml の救済時）場合にも既定 2 枠が返る保証になる:

```rust
        crew: field_or_default(v, "crew", default_crew_slots()),
```

`src/core/config.ts` に追加:

```ts
export interface CrewSlot {
  name: string;
  color: string;
  /** config_dir() からの相対パス。空 = 既定の SVG キャラ。 */
  sprite: string;
}
```

`OrbConfig` に `crew: CrewSlot[];` を足し、`DEFAULT` に:

```ts
  crew: [
    { name: "", color: "#4fb3a4", sprite: "" },
    { name: "", color: "#9b7fd4", sprite: "" },
  ],
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd src-tauri && cargo test crew_`
Expected: PASS（2 件）

Run: `pnpm exec svelte-check --threshold error`
Expected: 0 ERRORS

- [ ] **Step 5: コミット**

```bash
git add src-tauri/src/config.rs src/core/config.ts
git commit -m "feat(crew): two configurable character slots in config.toml"
```

---

### Task 8: 選ばれた PNG を設定ディレクトリへ取り込む

**Files:**
- Modify: `src-tauri/src/config.rs`（コマンド追加）
- Modify: `src-tauri/src/lib.rs`（`invoke_handler` へ登録）
- Test: `src-tauri/src/config.rs`（`#[cfg(test)]`）

**Interfaces:**
- Consumes: Task 7 の `CrewSlot`
- Produces: `#[tauri::command] pub fn import_crew_sprite(slot: usize, src: String) -> std::result::Result<String, String>` — 成功時は `config_dir()` からの相対パス（`crew/slot0.png`）を返す

- [ ] **Step 1: 失敗するテストを書く**

純関数部分だけを検査する（ファイル I/O は薄く保つ）。`config.rs` のテストに追記:

```rust
#[test]
fn crew_sprite_dest_is_scoped_to_slot() {
    assert_eq!(crew_sprite_rel(0), "crew/slot0.png");
    assert_eq!(crew_sprite_rel(1), "crew/slot1.png");
}

#[test]
fn crew_sprite_rejects_unknown_slot_and_non_png() {
    assert!(validate_crew_import(2, "a.png").is_err());
    assert!(validate_crew_import(0, "a.jpg").is_err());
    assert!(validate_crew_import(0, "a.PNG").is_ok());
}
```

- [ ] **Step 2: 失敗を確認**

Run: `cd src-tauri && cargo test crew_sprite`
Expected: FAIL — `crew_sprite_rel` が存在しない

- [ ] **Step 3: 実装**

`src-tauri/src/config.rs`:

```rust
/// 枠番号 → config_dir() からの相対パス。枠ごとに固定名なので、取り込みは常に上書き＝
/// 古いスプライトが溜まらない。
pub fn crew_sprite_rel(slot: usize) -> String {
    format!("crew/slot{slot}.png")
}

/// 取り込み前の検証。枠は2つだけ、受けるのは PNG だけ。
// config.rs は `use crate::error::Result` で1引数版 Result を持つ。2引数の標準 Result を
// 使う箇所は std::result::Result と完全修飾する（同ファイル内の既存コメント参照）。
fn validate_crew_import(slot: usize, src: &str) -> std::result::Result<(), String> {
    if slot >= 2 {
        return Err(format!("枠 {slot} は存在しません"));
    }
    let is_png = std::path::Path::new(src)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("png"));
    if !is_png {
        return Err("PNG ファイルを選んでください".into());
    }
    Ok(())
}

#[tauri::command]
pub fn import_crew_sprite(slot: usize, src: String) -> std::result::Result<String, String> {
    validate_crew_import(slot, &src)?;
    let dir = config_dir().join("crew");
    std::fs::create_dir_all(&dir).map_err(|e| format!("保存先を作れません: {e}"))?;
    let rel = crew_sprite_rel(slot);
    let dest = config_dir().join(&rel);
    std::fs::copy(&src, &dest).map_err(|e| format!("コピーに失敗しました: {e}"))?;
    Ok(rel)
}
```

`src-tauri/src/lib.rs` の `tauri::generate_handler![...]` に `config::import_crew_sprite` を足す。

- [ ] **Step 4: テストが通ることを確認**

Run: `cd src-tauri && cargo test crew_sprite`
Expected: PASS（2 件）

- [ ] **Step 5: コミット**

```bash
git add src-tauri/src/config.rs src-tauri/src/lib.rs
git commit -m "feat(crew): import a chosen sprite sheet into the config dir"
```

---

### Task 9: ペインごとの直近コマンドをストアへ出す

**Files:**
- Modify: `src/store/appStore.ts`
- Modify: `src/terminal/blocks/osc.ts`
- Test: `src/store/appStore.test.ts`

**Interfaces:**
- Consumes: なし
- Produces: `paneLastCommand: Readable<ReadonlyMap<number, string>>`、`setPaneLastCommand(paneId, cmd)`、`clearPaneLastCommand(paneId)`

**背景:** コマンド行は `osc.ts` の `CommandBlocks` が nonce 検証済みで持っている（`pendingCommand`）が、
private フィールドでストアに出ていない。`osc.ts` は既に `setPaneStatus(this.paneId, …)` /
`setPaneCwd(this.paneId, …)` を同じ形で呼んでいるので、その並びに 1 本足す。
**AI ペインでは常に `claude` としか入らない**ため、描画側（Task 10）はシェルペインでのみ表示する。

- [ ] **Step 1: 失敗するテストを書く**

`src/store/appStore.test.ts` に追記する。**import は既存の先頭の import 行へ足す**
（`paneLastCommand` と `setPaneLastCommand` を既存の import に加える）:

```ts
describe("paneLastCommand", () => {
  it("ペインごとに直近のコマンドを覚える", () => {
    setPaneLastCommand(5, "cargo test");
    expect(get(paneLastCommand).get(5)).toBe("cargo test");
    setPaneLastCommand(5, "cargo build");
    expect(get(paneLastCommand).get(5)).toBe("cargo build");
  });

  it("ペイン破棄で忘れる", () => {
    setPaneLastCommand(7, "ls");
    clearPaneLastCommand(7);
    expect(get(paneLastCommand).has(7)).toBe(false);
  });

  it("空文字と null は覚えない（空の行を出さない）", () => {
    setPaneLastCommand(6, "");
    expect(get(paneLastCommand).has(6)).toBe(false);
    setPaneLastCommand(6, null);
    expect(get(paneLastCommand).has(6)).toBe(false);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `pnpm vitest run src/store/appStore.test.ts`
Expected: FAIL — `paneLastCommand` が export されていない

- [ ] **Step 3: 実装**

`src/store/appStore.ts`（`paneStatusSince` の隣に置く）:

```ts
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
```

**掃除経路を明示的に足す。** `paneStatusSince` は `setPaneStatus(paneId, null)` が破棄時に
呼ばれるので巻き添えで消えるが、`paneLastCommand` にはその経路が無い＝放っておくと
閉じたペインのコマンドが溜まり続ける。`clearPaneCwd` / `clearPaneModelEffort` と同じ形で
専用の関数を作り、`Terminal.svelte` の `onDestroy`（`clearPaneModelEffort(paneId)` の隣）から呼ぶ:

```ts
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
```

`src/terminal/Terminal.svelte` の `onDestroy` に 1 行:

```ts
    clearPaneLastCommand(paneId); // 破棄ペインの直近コマンドを残さない
```

`src/terminal/blocks/osc.ts` の、`parseCommandLine` の結果を `this.pendingCommand` に入れている箇所
（`if (cmd != null) this.pendingCommand = cmd;`）を次にする:

```ts
    if (cmd != null) {
      this.pendingCommand = cmd;
      setPaneLastCommand(this.paneId, cmd);
    }
```

import に `setPaneLastCommand` を足す（既に `setPaneStatus` / `setPaneCwd` を同じ場所から import している）。

- [ ] **Step 4: テストが通ることを確認**

Run: `pnpm vitest run src/store/appStore.test.ts`
Expected: PASS（5 件）

- [ ] **Step 5: コミット**

```bash
git add src/store/appStore.ts src/terminal/blocks/osc.ts src/store/appStore.test.ts
git commit -m "feat(crew): expose each pane's last command line"
```

---

### Task 10: Crew をサイドバーの1セクションとして描き直す

**Files:**
- Create: `src/crew/Crew.svelte`（Task 2 で削除済み。ゼロから作る）

**Interfaces:**
- Consumes: Task 1〜9 のすべて（`paneLastCommand` を含む）、`tabs` / `activeTabId` / `switchTab`（`src/layout/tabs.ts`）、`leafIds` / `leafInfoMap`（`src/layout/tree.ts`）、`focusedPane` / `layout` / `paneStatus` / `paneStatusSince`（`appStore`）、`config`（`src/core/config.ts`）
- Produces: サイドバーへ差し込む単一コンポーネント（props 無し）

- [ ] **Step 1: 実装**

`src/crew/Crew.svelte` を新規作成する。要件:

- 候補の組み立ては **全タブ横断**。`$tabs` を回し、アクティブタブだけ `$layout` を権威として使う（`Sidebar.svelte` の `inbox` 導出と同じ形）
- `selectSeats` に渡し、`seats` を描画、`overflow > 0` なら `他 {overflow} 人` を1行出す
- 1 席 = `<button>`。クリックで **タブ切替 → `focusedPane.set(paneId)`**（`acknowledgePane` は `focusedPane` の購読側が発火するので呼ばない）
- キャラは枠 index に対応する `$config.crew[i]`。`sprite` が空なら `charSvg(pose, slot.color, 42)` を `{@html}` で出す。空でなければ `<img>` を `convertFileSrc` で出し、`frameRect` の位置で切り出す（`object-fit: none` + `object-position`）
- 吹き出しは HTML。中身は `bubbleText(status, since, now)`。`now` は 1 秒間隔の `setInterval` で更新し、**席が 0 のときと window 非フォーカス時は止める**
- コマンド行は `role === "shell"` かつ `command` がある時だけ出す
- スプライトの読み込みに失敗した / `validateSheet` が false のときは既定 SVG に戻し、`pushToast("warn", ...)` で理由を出す（同じ枠で連続して出さないようガードする）
- アニメーションは transform / opacity のみ。`prefers-reduced-motion: reduce` で止める

- [ ] **Step 2: 型検査**

Run: `pnpm exec svelte-check --threshold error`
Expected: 0 ERRORS

- [ ] **Step 3: コミット**

```bash
git add src/crew/Crew.svelte
git commit -m "feat(crew): render the crew as a sidebar section"
```

---

### Task 11: サイドバーへ差し込み、INBOX を撤去する

**Files:**
- Modify: `src/chrome/Sidebar.svelte`（INBOX セクション削除・Crew 差し込み）

（上部の帯は Task 2 で撤去済み。ここでは触らない）

**Interfaces:**
- Consumes: Task 10 の `Crew.svelte`
- Produces: なし（統合のみ）

**注意:** INBOX の廃止は**出荷済み機能の削除**で、もっちゃんが単独の質問に対して「Crew が INBOX を兼ねる」を選んだことに基づく（spec の「合意の経緯」）。ここを勝手に広げないこと。

- [ ] **Step 1: 実装**

`src/chrome/Sidebar.svelte`:
- `import Crew from "../crew/Crew.svelte";` と `crewVisible` を追加
- `{#if inbox.length} … {/if}` の INBOX セクションを丸ごと削除
- 同じ位置に差し込む:

```svelte
  {#if $crewVisible}
    <div class="sec">
      <div class="label">CREW</div>
      <Crew />
    </div>
  {/if}
```

- 未使用になった `InboxItem` / `inbox` / `INBOX_STATUSES` / `jumpToPane` と、`.inbox-row` / `.inbox-ico` / `.inbox-name` / `.inbox-what` の CSS を削除（`jumpToPane` と同等の処理は Crew 側が持つ）
- `STATUS_ICON` など、削除で未使用になった import を外す

- [ ] **Step 2: 型検査**

Run: `pnpm exec svelte-check --threshold error`
Expected: 0 ERRORS（未使用 import が残っていれば警告ではなくエラーになる設定なので、ここで気付ける）

- [ ] **Step 3: 全テスト**

Run: `pnpm vitest run && cd src-tauri && cargo test`
Expected: すべて PASS

- [ ] **Step 4: コミット**

```bash
git add src/chrome/Sidebar.svelte
git commit -m "feat(crew): move the crew into the sidebar and retire the INBOX section"
```

---

### Task 12: 設定画面に CREW タブ

**Files:**
- Modify: `src/chrome/Settings.svelte`

**Interfaces:**
- Consumes: Task 7 の `CrewSlot` / `config`、Task 7 の `import_crew_sprite`
- Produces: なし（UI のみ）

- [ ] **Step 1: 実装**

`Settings.svelte` に `CREW` セクションを追加。枠ごと（2つ）に:

- 名前の text input（空なら案件ラベルに落ちる旨を placeholder で示す）
- 色の color input
- 「画像を選ぶ」ボタン → `open({ filters: [{ name: "PNG", extensions: ["png"] }], multiple: false })` → 選ばれたら `invoke("import_crew_sprite", { slot: i, src })` → 返った相対パスを `config.crew[i].sprite` に入れて `saveConfig`
- 「既定に戻す」ボタン → `sprite` を空にして `saveConfig`
- テンプレートの場所とコマ順（`running, waiting, attention, done, failed, idle`）を 1 行で明記

既存の設定項目と同じ入力パターン・同じ保存経路（`saveConfig`）に合わせること。新しい保存方式を作らない。

- [ ] **Step 2: 型検査**

Run: `pnpm exec svelte-check --threshold error`
Expected: 0 ERRORS

- [ ] **Step 3: コミット**

```bash
git add src/chrome/Settings.svelte
git commit -m "feat(crew): name, colour and sprite pickers in settings"
```

---

### Task 13: テンプレートと書き方ドキュメント

**Files:**
- Create: `docs/crew-sprite-template.md`
- Create: `assets/crew-template.png`

**Interfaces:**
- Consumes: Task 6 の `SPRITE_ORDER`
- Produces: 同梱テンプレート

- [ ] **Step 1: テンプレート画像を作る**

384×64（1コマ 64×64）の PNG を生成する。各コマに枠線とコマ番号、下に状態名を焼く。
生成スクリプトは使い捨てで良いが、**生成した PNG を実際に開いて 6 コマあることを目視確認**すること。

- [ ] **Step 2: 書き方ドキュメント**

`docs/crew-sprite-template.md` に、コマ順・1コマ正方形・推奨サイズ・透過の扱い・
`設定 → CREW → 画像を選ぶ` の手順・検証に落ちたときのトースト文言を書く。

- [ ] **Step 3: コミット**

```bash
git add docs/crew-sprite-template.md assets/crew-template.png
git commit -m "docs(crew): sprite sheet template and how to draw one"
```

---

### Task 14: 実機で見て直す

**Files:**
- Modify: 目視で見つかった箇所

- [ ] **Step 1: dev ビルドで起動**

Run: `pnpm -C C:\Users\hiyok\orb tauri dev`
（常駐するので `Out-String` を付けない。足場の release orb は触らない）

- [ ] **Step 2: 次を実際に確認する**

- 席が 2 つで、要承認のペインが 1 番目に来る
- 吹き出しの文字が 168px を割らない（`要承認 24時間+` が最長）
- クリックで別タブのペインへ飛び、バッジが消える
- スプライトを差し替えると絵が変わり、壊れた PNG ではトーストが出て既定に戻る
- `Ctrl+Shift+J` で消える／出る

- [ ] **Step 3: 見つかった差分を直してコミット**

静的レビューでは腕が頭に隠れる事故を検出できなかった。**必ず絵として見ること。**

---

## 実装後に残ること（このプランの範囲外）

- 既定 SVG のクオリティ向上（髪型 1 種類のみ）。もっちゃんが「この絵で実装に進む」と判断済みで、絵は差し替え可能なので後戻りしない
- v1.6.1 としてのリリース判断
