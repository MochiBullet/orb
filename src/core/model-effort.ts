/** サイドバーの model/effort 切替と案件ランチャーの一括起動承認で共有する選択肢。
 *  ultracode は誤操作で強制発火すると影響が大きいため一覧には含めない（要れば手打ちで）。 */
export interface ModelEffortOption {
  value: string;
  label: string;
}

export const MODEL_OPTIONS: ModelEffortOption[] = [
  { value: "opus", label: "Opus 4.8" },
  { value: "sonnet", label: "Sonnet 5" },
  { value: "haiku", label: "Haiku 4.5" },
  { value: "fable", label: "Fable 5" },
  { value: "default", label: "Default" },
];

export const EFFORT_OPTIONS: ModelEffortOption[] = [
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
  { value: "max", label: "max（このセッションのみ）" },
  { value: "auto", label: "auto" },
];
