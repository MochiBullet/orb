// Crew キャラ（アニメ調ちび）を SVG で組む。
//
// SVG にした理由: サイドバー内 42px 〜 拡大時 96px まで振れるので、解像度に縛られない方が破綻しない。
// 色は「キャラ固有色」を1つ受け取り、髪・服・影へ展開する（状態色では塗らない）。
//
// 【描画順の鉄則】腕は必ず最後に描く。
// 最初の試作では 腕 → 胴 → 頭 の順で描いたせいで、上げた腕が頭の裏に隠れ、
// 6状態すべてのシルエットが同じになった（＝「アクティブかどうかしか分からない」の再発）。
// ちびキャラは頭が大きいので、腕を上げると必ず頭と重なる。腕を前面に置いて初めてポーズが立つ。

import type { CrewPose } from "./model";

const SKIN = "#ffe0c4";
const SKIN_SH = "#f0bd97";
const LINE = "#2b1f2d";
const WHITE = "#ffffff";

const CX = 36; // 体の中心
const VB_W = 72;
const VB_H = 78;

interface Palette {
  hair: string;
  hairLit: string;
  cloth: string;
  clothSh: string;
}

function palette(base: string): Palette {
  return {
    hair: mix(base, "#1a1420", 0.5),
    hairLit: mix(base, "#ffffff", 0.32),
    cloth: base,
    clothSh: mix(base, "#1a1420", 0.34),
  };
}

function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const f = (s: number) => {
    const x = (pa >> s) & 255, y = (pb >> s) & 255;
    return Math.round(x + (y - x) * t);
  };
  return `rgb(${f(16)},${f(8)},${f(0)})`;
}

// ---- 目 ----------------------------------------------------------------
type EyeKind = "normal" | "closed" | "cross" | "focus" | "wide";

function eye(cx: number, cy: number, kind: EyeKind): string {
  const g = (inner: string) => `<g transform="translate(${cx} ${cy})">${inner}</g>`;
  switch (kind) {
    case "closed":
      return g(`<path d="M-4.5 0.5 Q0 -4.5 4.5 0.5" fill="none" stroke="${LINE}" stroke-width="2.2" stroke-linecap="round"/>`);
    case "cross":
      return g(`<path d="M-3.6 -3.6 L3.6 3.6 M3.6 -3.6 L-3.6 3.6" stroke="${LINE}" stroke-width="2.2" stroke-linecap="round"/>`);
    case "focus":
      return g(`
        <ellipse rx="4.4" ry="4" fill="${WHITE}" stroke="${LINE}" stroke-width="1.3"/>
        <ellipse cy="1.5" rx="2.9" ry="2.6" fill="${LINE}"/>
        <path d="M-4.8 -2 Q0 -4.4 4.8 -2 L4.8 -4.4 L-4.8 -4.4 Z" fill="${LINE}"/>`);
    case "wide":
      return g(`
        <ellipse rx="5.2" ry="5.8" fill="${WHITE}" stroke="${LINE}" stroke-width="1.3"/>
        <ellipse cy="0.4" rx="3.5" ry="4" fill="${LINE}"/>
        <circle cx="-1.3" cy="-1.9" r="1.7" fill="${WHITE}"/>
        <circle cx="1.5" cy="1.9" r="0.9" fill="${WHITE}" opacity=".8"/>`);
    default:
      return g(`
        <ellipse rx="4.6" ry="5" fill="${WHITE}" stroke="${LINE}" stroke-width="1.3"/>
        <ellipse cy="0.5" rx="3" ry="3.4" fill="${LINE}"/>
        <circle cx="-1.1" cy="-1.5" r="1.4" fill="${WHITE}"/>`);
  }
}

type BrowsKind = "normal" | "focus" | "wide" | "sad";

function brows(kind: BrowsKind): string {
  const L = CX - 10.5, R = CX + 10.5, li = CX - 3, ri = CX + 3;
  switch (kind) {
    case "focus": return `<path d="M${L} 15.5 L${li} 17 M${R} 15.5 L${ri} 17" stroke="${LINE}" stroke-width="1.8" stroke-linecap="round"/>`;
    case "wide":  return `<path d="M${L} 13 L${li} 14.5 M${R} 13 L${ri} 14.5" stroke="${LINE}" stroke-width="1.8" stroke-linecap="round"/>`;
    case "sad":   return `<path d="M${L} 16.5 L${li} 14 M${R} 16.5 L${ri} 14" stroke="${LINE}" stroke-width="1.8" stroke-linecap="round"/>`;
    default:      return `<path d="M${L} 14.5 L${li} 14.5 M${R} 14.5 L${ri} 14.5" stroke="${LINE}" stroke-width="1.8" stroke-linecap="round"/>`;
  }
}

type MouthKind = "normal" | "open" | "smile" | "wave" | "flat" | "small";

function mouth(kind: MouthKind): string {
  const y = 30;
  switch (kind) {
    case "open":  return `<path d="M${CX - 5} ${y} Q${CX} ${y + 7} ${CX + 5} ${y} Q${CX} ${y + 2} ${CX - 5} ${y} Z" fill="${LINE}"/>`;
    case "smile": return `<path d="M${CX - 4.5} ${y - .5} Q${CX} ${y + 4} ${CX + 4.5} ${y - .5}" fill="none" stroke="${LINE}" stroke-width="2" stroke-linecap="round"/>`;
    case "wave":  return `<path d="M${CX - 4} ${y + .5} q2 -2 4 0 q2 2 4 0" fill="none" stroke="${LINE}" stroke-width="1.8" stroke-linecap="round"/>`;
    case "flat":  return `<path d="M${CX - 2.5} ${y + .5} L${CX + 2.5} ${y + .5}" stroke="${LINE}" stroke-width="1.8" stroke-linecap="round"/>`;
    default:      return `<ellipse cx="${CX}" cy="${y + .5}" rx="2" ry="2.4" fill="${LINE}"/>`;
  }
}

// ---- 腕 ----------------------------------------------------------------
// 肩から手までの太い線＋先端の手。輪郭を1本余分に敷いて、頭に重なっても腕として読めるようにする。
function arm(x0: number, y0: number, x1: number, y1: number, c: string, sh: string, bend: number): string {
  const mx = (x0 + x1) / 2 + bend;
  const my = (y0 + y1) / 2;
  const d = `M${x0} ${y0} Q${mx} ${my} ${x1} ${y1}`;
  return `
    <path d="${d}" fill="none" stroke="${LINE}" stroke-width="8.4" stroke-linecap="round"/>
    <path d="${d}" fill="none" stroke="${sh}" stroke-width="6.6" stroke-linecap="round"/>
    <path d="${d}" fill="none" stroke="${c}" stroke-width="4.6" stroke-linecap="round"/>
    <circle cx="${x1}" cy="${y1}" r="4" fill="${SKIN}" stroke="${LINE}" stroke-width="1.3"/>`;
}

/**
 * 状態ごとの差分。arms は [左手の到達点, 右手の到達点]（画面上の左右）。
 * bend は腕の曲がり方向、drop は体全体の沈み込み。
 */
interface PoseSpec {
  eyes: EyeKind;
  brows: BrowsKind;
  mouth: MouthKind;
  drop: number;
  lean?: number;
  arms: [[number, number, number], [number, number, number]];
  keyboard?: boolean;
  thumb?: boolean;
}

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

export function charSvg(state: CrewPose, base = "#4fb3a4", size = 64): string {
  const p = POSE[state] ?? POSE.idle;
  const c = palette(base);
  const dy = p.drop;
  const lean = p.lean ?? 0;

  // 胴（肩をしっかり出す。腕の付け根が見えないとポーズが嘘になる）
  const body = `
    <g data-part="body" transform="translate(0 ${dy})">
<path d="M${CX - 4} 33 L${CX + 4} 33 L${CX + 4} 38 L${CX - 4} 38 Z" fill="${SKIN_SH}" stroke="${LINE}" stroke-width="1.4"/>
      <path d="M${CX - 12} 63 L${CX - 5} 63 L${CX - 5} 71 L${CX - 12} 71 Z" fill="${c.clothSh}" stroke="${LINE}" stroke-width="1.5" stroke-linejoin="round"/>
      <path d="M${CX + 5} 63 L${CX + 12} 63 L${CX + 12} 71 L${CX + 5} 71 Z" fill="${c.clothSh}" stroke="${LINE}" stroke-width="1.5" stroke-linejoin="round"/>
      <path d="M${CX - 13} 41 Q${CX} 36 ${CX + 13} 41 L${CX + 14} 64 Q${CX} 67.5 ${CX - 14} 64 Z"
            fill="${c.cloth}" stroke="${LINE}" stroke-width="1.7" stroke-linejoin="round"/>
      <path d="M${CX - 14} 64 Q${CX} 67.5 ${CX + 14} 64 L${CX + 13.4} 58 Q${CX} 61.5 ${CX - 13.4} 58 Z"
            fill="${c.clothSh}"/>
    </g>`;

  // 頭（胴より後、腕より前）
  const head = `
    <g data-part="head" transform="translate(0 ${dy * 0.6 + lean})">
      <ellipse cx="${CX}" cy="21" rx="15" ry="14.5" fill="${SKIN}" stroke="${LINE}" stroke-width="1.7"/>
      <path d="M${CX - 15} 20 C${CX - 15} 8 ${CX - 8} 3 ${CX} 3 C${CX + 8} 3 ${CX + 15} 8 ${CX + 15} 20
               C${CX + 12} 13 ${CX + 8} 11 ${CX + 4} 12 C${CX + 1} 8.5 ${CX - 4} 8.5 ${CX - 7} 12
               C${CX - 11} 12 ${CX - 13} 15 ${CX - 15} 20 Z"
            fill="${c.hair}" stroke="${LINE}" stroke-width="1.7" stroke-linejoin="round"/>
      <path d="M${CX - 8} 7 C${CX - 3} 5 ${CX + 2} 5 ${CX + 7} 8" fill="none"
            stroke="${c.hairLit}" stroke-width="2.4" stroke-linecap="round" opacity=".7"/>
      <ellipse cx="${CX - 10.5}" cy="25.5" rx="2.4" ry="1.6" fill="${SKIN_SH}" opacity=".65"/>
      <ellipse cx="${CX + 10.5}" cy="25.5" rx="2.4" ry="1.6" fill="${SKIN_SH}" opacity=".65"/>
      ${brows(p.brows)}
      ${eye(CX - 6.5, 23, p.eyes)}
      ${eye(CX + 6.5, 23, p.eyes)}
      ${mouth(p.mouth)}
    </g>`;

  // 腕は最後（頭より前）。これがポーズの読みやすさを決める。
  const arms = `
    <g data-part="arms" transform="translate(0 ${dy})">
      ${arm(CX - 12, 45, p.arms[0][0], p.arms[0][1] - dy, c.cloth, c.clothSh, p.arms[0][2])}
      ${arm(CX + 12, 45, p.arms[1][0], p.arms[1][1] - dy, c.cloth, c.clothSh, p.arms[1][2])}
    </g>`;

  const props = [
    p.keyboard
      ? `<rect x="${CX - 16}" y="${64 + dy}" width="32" height="5.5" rx="2.2"
             fill="${c.clothSh}" stroke="${LINE}" stroke-width="1.3"/>`
      : "",
    p.thumb
      ? `<path d="M${p.arms[1][0]} ${p.arms[1][1] - 4} l0 -5" stroke="${LINE}"
             stroke-width="2.8" stroke-linecap="round"/>`
      : "",
  ].join("");

  return `<svg viewBox="0 0 ${VB_W} ${VB_H}" width="${size}" height="${(size * VB_H) / VB_W}"
      xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <ellipse cx="${CX}" cy="74" rx="15" ry="3" fill="#000" opacity=".28"/>
    ${body}${head}${arms}${props}
  </svg>`;
}
