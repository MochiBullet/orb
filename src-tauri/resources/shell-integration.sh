# orb shell integration for bash — OSC 633 command-block markers.
# Windows 版 shell-integration.ps1 と同じマーカー体系（A/B/C/D/E/P）を bash 向けに移植した
# もの。DEBUG trap / PROMPT_COMMAND の連鎖技法は VS Code の shellIntegration-bash.sh
# （MIT License, microsoft/vscode）を参考にした——starship 等が既に DEBUG trap や
# PROMPT_COMMAND を張っているケースを壊さずに割り込む必要があるため（見た目を壊さず OSC を
# 注入する、という PS1 版と同じ設計目標）。
#
# マーカー: A;<nonce>=プロンプト開始 / B=コマンド入力開始 / C;<nonce>=出力開始
#           D;<nonce>;<code>=実行終了 / E;<nonce>;<escaped-cmd>=コマンドライン
#           P;<nonce>;Cwd=<path>=作業ディレクトリ
# SEC(#71): B 以外は全マーカーに nonce を付ける。フロント(osc.ts)は自分の nonce を持つ
#           マーカーだけ信用する＝出力バイトによる偽造（偽 exit/偽 cwd/偽ブロック）を防ぐ。
#
# ⚠️ 実機（Linux/macOS）未検証（#17 クロスプラットフォーム対応）。Windows は PS1 版のみを
# 使うため、この bash 版は現状 CI（ubuntu-latest）でのビルド確認のみで、trap 連鎖・
# BlockOpen ゲートの実挙動は未確認。

if [ -n "${__ORB_SI_LOADED:-}" ]; then
  builtin return 0 2>/dev/null || builtin exit 0
fi
__ORB_SI_LOADED=1

# #33 相当: E マーカー（コマンドライン）偽造防止 nonce。orb が spawn 時に子環境へ渡す。
# 無ければ空＝E も C も出さない（PS1 版と同じ「nonce 不在では出力に紛れた偽 E/C を
# フロントが受け付けない」設計）。
__orb_nonce="${ORB_NONCE:-}"
# SEC-1(#71): nonce を捕捉したら即 unset。さもないとペイン内で走る任意プログラムが $ORB_NONCE
# を読め、nonce 付きマーカー（E/C/A/D/P）を偽造できる（偽 exit/偽 cwd/偽ブロック）。以後の発行は
# 捕捉済み $__orb_nonce からのみ行う（環境変数は二度と読まない）。
unset ORB_NONCE

# 現在ブロックが開いているか（A を出して D 未了）。空 Enter 等でコマンド未実行のときは
# このまま開き続け、A/B を重複させない＝幻ブロックで耐久ログ #31 を汚さない。
__orb_block_open=0
__orb_command_ran=0
__orb_in_command=0
__orb_current_command=""
__orb_status=0
__orb_custom_ps1=""
__orb_original_ps1=""

__orb_esc=$'\033'
__orb_bel=$'\007'

__orb_osc() {
  builtin printf '%s]633;%s%s' "$__orb_esc" "$1" "$__orb_bel"
}

# OSC データに混ざると壊れる文字（; 改行 制御文字 \）を \xNN にエスケープする。
# PS1 版 __orb_escape と同一規則——バックスラッシュ自体も \x5c にする点に注意（フロントの
# decodeOsc は `\xNN` パターンだけを復元し、VS Code 方式の `\\` ダブルエスケープは
# 復元できないため、その escaper をそのまま持ち込むと非互換になる）。
# LC_ALL=C でバイト単位に処理する＝マルチバイト UTF-8（日本語等）はエスケープ対象の
# バイト値(<0x20, \, ;)に該当しない限りそのまま素通しになり、正しく往復する。
__orb_escape() {
  builtin local LC_ALL=C
  builtin local str="$1"
  builtin local -i len="${#str}"
  builtin local -i i val
  builtin local byte out=""
  for (( i = 0; i < len; i++ )); do
    byte="${str:$i:1}"
    builtin printf -v val '%d' "'$byte"
    if (( val < 32 )) || [ "$byte" = '\' ] || [ "$byte" = ';' ]; then
      builtin printf -v byte '\\x%02x' "$val"
    fi
    out+="$byte"
  done
  builtin printf '%s' "$out"
}

__orb_update_cwd() {
  # #71: P も nonce 付き（parser 側で P は nonce 必須）＝偽 cwd 注入を防ぐ。
  __orb_osc "P;$__orb_nonce;Cwd=$(__orb_escape "$PWD")"
}

# A: 開いているブロックが無ければ新ブロックを開く（初回 or D 直後）。開いたままなら
# （空Enter等）何も出さず待機ブロックを継続＝幻ブロックを作らない（PS1 版と同じ判断）。
__orb_prompt_start() {
  if [ "$__orb_block_open" != "1" ]; then
    # #71: A も nonce 付き＝出力に紛れた偽 A による正規ブロックの中断クローズ偽造を防ぐ。
    __orb_osc "A;$__orb_nonce"
    __orb_update_cwd
  fi
}

# B: コマンド入力開始（新ブロックを開いたときだけ）。
__orb_prompt_end() {
  if [ "$__orb_block_open" != "1" ]; then
    __orb_osc 'B'
    __orb_block_open=1
  fi
}

# PS1 を A/B で挟む。PS1 の `\[...\]` はプロンプト表示のたびに評価される非表示エスケープ
# 領域で、実際に OSC を出すかどうかは prompt_start/prompt_end 内の BlockOpen ゲートに
# 委ねる（PS1 文字列自体は毎回同じ形に保ち、ゲートだけで幻ブロックを防ぐ）。
__orb_update_prompt() {
  if [ "$__orb_custom_ps1" = "" ] || [ "$__orb_custom_ps1" != "$PS1" ]; then
    __orb_original_ps1="$PS1"
    __orb_custom_ps1="\[\$(__orb_prompt_start)\]${__orb_original_ps1}\[\$(__orb_prompt_end)\]"
    PS1="$__orb_custom_ps1"
  fi
}

# DEBUG trap: 実際にコマンドが実行される直前にだけ発火する（空 Enter では発火しない＝
# bash の仕様）。E/C はここで出す（PS1 版の PSConsoleHostReadLine ラップと同じ「実際に
# 送信された瞬間」に相当）。
__orb_preexec() {
  __orb_command_ran=1
  __orb_current_command="$BASH_COMMAND"
  if [ -n "$__orb_nonce" ] && [ -n "$__orb_current_command" ]; then
    __orb_osc "E;$__orb_nonce;$(__orb_escape "$__orb_current_command")"
    __orb_osc "C;$__orb_nonce"
  fi
}

# 複合コマンド（cmd1 && cmd2 等）は DEBUG trap が複数回発火するため、1回目だけ処理する
# （__orb_in_command ガード）。自分自身の PS1 埋め込み呼び出し（__orb_prompt_start 等）が
# BASH_COMMAND に来ても誤発火しないよう名前で除外する（VS Code 版と同じ防御）。
__orb_preexec_guarded() {
  case "$BASH_COMMAND" in
    __orb_*) builtin return ;;
  esac
  if [ "$__orb_in_command" != "1" ]; then
    __orb_in_command=1
    __orb_preexec
  fi
}

# D: コマンドが実際に走ったら、開いているブロックを終了コード付きで閉じる。
# $? は PROMPT_COMMAND チェーンの最初の1行で必ず捕捉する（連鎖先の評価で上書きされる前に）。
__orb_precmd_body() {
  if [ "$__orb_command_ran" = "1" ]; then
    # #71: D も nonce 付き＝出力に紛れた偽 D による偽の成功✓（偽 exit code）を防ぐ。
    __orb_osc "D;$__orb_nonce;$__orb_status"
    __orb_block_open=0
    __orb_command_ran=0
  fi
  __orb_in_command=0
  __orb_update_prompt
}

# 既存の DEBUG trap（starship init 等）を検出し、壊さず連鎖させる。
# 'trap -p DEBUG' の出力をパースする技法は VS Code 版の __vsc_get_trap を踏襲。
__orb_get_trap() {
  builtin local -a terms
  builtin eval "terms=( $(trap -p "${1:-DEBUG}") )"
  builtin printf '%s' "${terms[2]:-}"
}

__orb_existing_debug_trap="$(__orb_get_trap DEBUG)"
if [ -z "$__orb_existing_debug_trap" ]; then
  trap '__orb_preexec_guarded' DEBUG
elif [[ "$__orb_existing_debug_trap" != '__orb_preexec_guarded' && "$__orb_existing_debug_trap" != '__orb_preexec_chain' ]]; then
  __orb_existing_debug_trap_body="$__orb_existing_debug_trap"
  __orb_preexec_chain() {
    __orb_preexec_guarded
    builtin eval "$__orb_existing_debug_trap_body"
  }
  trap '__orb_preexec_chain' DEBUG
fi

# 既存の PROMPT_COMMAND（starship init 等）を検出し、壊さず連鎖させる。$? の捕捉は
# 必ずこのエントリ関数の最初の1行で行う（連鎖先の評価で上書きされる前に確定させる）。
__orb_original_prompt_command="${PROMPT_COMMAND:-}"
if [ -n "$__orb_original_prompt_command" ] && [ "$__orb_original_prompt_command" != "__orb_precmd_entry" ]; then
  __orb_precmd_entry() {
    __orb_status="$?"
    builtin eval "$__orb_original_prompt_command"
    __orb_precmd_body
  }
else
  __orb_precmd_entry() {
    __orb_status="$?"
    __orb_precmd_body
  }
fi
PROMPT_COMMAND=__orb_precmd_entry

__orb_update_prompt

# PromptType 通知（一度だけ）。
if [ -n "${STARSHIP_SESSION_KEY:-}" ]; then
  # #71: P も nonce 付き（parser 側で P は nonce 必須になった）。
  __orb_osc "P;$__orb_nonce;PromptType=starship"
fi
