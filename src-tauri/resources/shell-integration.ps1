# orb shell integration for PowerShell 7+ — OSC 633 command-block markers.
# profile.ps1 が定義した prompt（starship 等）をラップし、見た目を壊さず OSC を
# 前後に挿入する。手本: VS Code shellIntegration.ps1。
#
# マーカー: A;<nonce>=プロンプト開始 / B=コマンド入力開始 / C;<nonce>=実行開始
#           D;<nonce>;<code>=実行終了 / E;<nonce>;<cmd>=コマンドライン
#           P;<nonce>;Cwd=<path>=作業ディレクトリ
# SEC(#71): B 以外は全マーカーに nonce を付ける。フロント(osc.ts)は自分の nonce を持つ
#           マーカーだけ信用する＝コマンド出力バイトによる偽造（偽 exit/偽 cwd/偽ブロック）を防ぐ。

if ($global:__orb_si_loaded) { return }
$global:__orb_si_loaded = $true

# #78 UX-2: 以前はここで $global:WarningPreference = 'SilentlyContinue' を設定し、
# ユーザーのセッション全体（本人の Write-Warning・モジュールの非推奨通知等）を丸ごと
# 握り潰していた。orb が黙らせたいのは自分自身の Set-PSReadLineOption 呼び出し周りの
# ListView 警告だけなので、グローバル設定はやめて各呼び出しに -WarningAction
# SilentlyContinue を個別に付ける（下記2箇所）。

# profile が PSReadLine をロード済みなら、起動直後に InlineView へ固定する
# （orb は分割多用ターミナルのため既定を InlineView にする＝下の理由と同じ）。
# ここは起動時の一度きり＝ユーザーが後で明示的に ListView 等へ変更したらそれを尊重する
# （#78 UX-2: 以前は prompt() 内で毎回 InlineView に戻しており、ユーザーの選択を上書きし続けていた）。
if (Get-Module PSReadLine) {
    try { Set-PSReadLineOption -PredictionViewStyle InlineView -WarningAction SilentlyContinue -ErrorAction SilentlyContinue } catch {}
}

$global:__orb_si = @{
    OriginalPrompt = $function:prompt
    LastHistoryId  = -1
    # 現在ブロックが開いているか（A を出して D 未了）。空Enter等でコマンド未実行のときは
    # このまま開き続け、A/D を重複させない＝幻ブロックで耐久ログ #31 を汚さない。
    BlockOpen      = $false
    HasPSReadLine  = $null -ne (Get-Module -Name PSReadLine)
    # #33: E マーカー（コマンドライン）偽造防止 nonce。orb が spawn 時に子環境へ渡す。
    # 無ければ空＝E は emit しない（出力に紛れた偽 E をフロントが受け付けないための鍵）。
    Nonce          = "$env:ORB_NONCE"
    # #33: PSConsoleHostReadLine をラップ済みか。PSReadLine は対話開始時に遅延ロードされる
    # ため、dot-source 時ではなく prompt() 内で存在を確認してから一度だけラップする。
    ReadLineWrapped = $false
    # #78 UX-2: 上の dot-source 時点で PSReadLine が既にロード済みなら InlineView 適用は
    # 済んでいる＝prompt() 側の一度きり適用は不要（true にして二重適用を避ける）。
    # 遅延ロードで未適用ならここは false のままで、prompt() が最初の1回だけ拾う。
    InlineViewApplied = ($null -ne (Get-Module -Name PSReadLine))
}

# SEC-1(#71): nonce を捕捉したら即座に環境変数から消す。さもないとペイン内で走る任意の
# プログラムが $env:ORB_NONCE を読め、nonce 付きマーカー（E/C/A/D/P）を丸ごと偽造できる
# （偽 exit・偽 cwd・偽ブロック）。以後の発行はすべて捕捉済みの $global:__orb_si.Nonce から
# 行う（環境変数は二度と読まない）。VS Code の shell integration と同じ方式。
Remove-Item Env:\ORB_NONCE -ErrorAction SilentlyContinue

# #33: PSConsoleHostReadLine（PSReadLine の入力フック）をラップし、実際にコマンドが
# 送信された瞬間に E;<nonce>;<escaped-cmdline>（コマンドライン）と C（出力開始）を出す。
# prompt() の A/D と合わせて「プロンプト｜コマンド｜出力」を確定的に区切る（VS Code 方式）。
# 空行（空Enter）は何も出さない＝#31 の幻ブロック防止と整合。
function global:__orb_wrap_readline {
    $cur = $function:PSConsoleHostReadLine
    if ($null -eq $cur) { return } # PSReadLine 未ロード＝従来 A/D のみ
    # 既にラップ済みで、かつ現在のフックが自分のラッパーのまま → 何もしない。
    # Import-Module PSReadLine -Force 等でフックが差し替わっていたら再ラップして自己修復する。
    if ($global:__orb_si.ReadLineWrapped -and [object]::ReferenceEquals($cur, $global:__orb_si.WrapperSb)) { return }
    $global:__orb_si.OriginalReadLine = $cur
    function global:PSConsoleHostReadLine {
        $line = & $global:__orb_si.OriginalReadLine
        # 空白のみの行はコマンドとして実行されない（履歴も進まない）ので何も出さない。
        # nonce 不在なら E も C も出さない（フロントは nonce 無しの C を受け付けない）。
        if ($null -ne $line -and $line.Trim().Length -gt 0 -and $global:__orb_si.Nonce) {
            $n = $global:__orb_si.Nonce
            # C: ここから先が出力（PSReadLine が確定行を描画し終えた直後＝出力の先頭）。
            # C も nonce 付き＝出力に紛れた偽 C が output_body の境界を動かすのを防ぐ。
            [Console]::Write((__orb_osc "E;$n;$(__orb_escape $line)") + (__orb_osc "C;$n"))
        }
        return $line
    }
    $global:__orb_si.WrapperSb = $function:PSConsoleHostReadLine
    $global:__orb_si.ReadLineWrapped = $true
}

# orb は分割多用ターミナルのため PSReadLine 予測を InlineView に固定する。
# ListView は「幅50・高さ5」未満で警告を出し、リサイズに prompt 単位でしか追従できず
# 分割直後の警告を防げない。予測自体は1行インラインで残る。元の好みは orb の外では不変
# （この pwsh プロセス内だけの変更）。
if ($global:__orb_si.HasPSReadLine) {
    try { Set-PSReadLineOption -PredictionViewStyle InlineView -WarningAction SilentlyContinue -ErrorAction SilentlyContinue } catch {}
}

$global:__orb_ESC = [char]0x1b
$global:__orb_BEL = [char]0x07

function global:__orb_osc([string]$body) {
    return "$($global:__orb_ESC)]633;$body$($global:__orb_BEL)"
}

# OSC データに混ざると壊れる文字（; 改行 制御文字 \）を \xNN にエスケープ。
function global:__orb_escape([string]$value) {
    if ([string]::IsNullOrEmpty($value)) { return $value }
    return [regex]::Replace($value, "[\x00-\x1f\\;\n]", {
        param($m)
        -join ([System.Text.Encoding]::UTF8.GetBytes($m.Value) | ForEach-Object { '\x{0:x2}' -f $_ })
    })
}

function global:prompt {
    # 直前コマンドの終了状態を「最初の文」で捕捉する。関数内の素の $? は実環境
    # （PSReadLine＋プロファイルフック）で常に True になり失敗を取りこぼすため、
    # starship init と同じく $global:? を読む（実測: cmd /c exit 3 まで ✓ になっていた）。
    $LastOk = $global:?
    $LastExit = $global:LASTEXITCODE
    $FakeCode = [int](-not $LastOk)

    # 例外系失敗（CommandNotFound / cmdlet エラー等）の判別: $Error の先頭が前プロンプトから
    # 変わっていれば「新しいエラーが積まれた」＝例外系。native 失敗は $Error に積まれない。
    # （ExecutionStatus は CommandNotFound で 'Failed' にならず判別不能だった＝実測）
    # 注: -ErrorAction Ignore で失敗したコマンドは $Error に積まれず判別不能＝native の
    # 残存コードが付く可能性がある（許容し記録）。ベースライン更新は prompt 末尾で行う。
    $errObj = if ($global:Error.Count -gt 0) { $global:Error[0] } else { $null }
    $errNew = ($null -ne $errObj) -and -not [object]::ReferenceEquals($errObj, $global:__orb_si.LastErr)

    # 前回プロンプト以降に「実際にコマンドが実行された」かを履歴 ID の前進で判定する
    # （VS Code shell integration と同流儀）。空Enter・Ctrl+C で入力破棄・シェル内部の
    # プロンプト再描画では履歴 ID が進まない＝コマンド未実行として D/A を出さない。
    $h = Get-History -Count 1
    $curId = if ($h) { [int]$h.Id } else { -1 }
    $ranCommand = $curId -ne $global:__orb_si.LastHistoryId

    $out = ''
    # #71: A/D/P に埋める nonce（捕捉済みローカル。環境変数は SEC-1 で消去済み）。
    $n = $global:__orb_si.Nonce

    # D: コマンドが実際に走ったら、開いているブロックを終了コード付きで閉じる。
    if ($ranCommand -and $global:__orb_si.BlockOpen) {
        # $LASTEXITCODE は native コマンドしか更新しない＝例外系失敗では前回 native の値が
        # 残る（実測: nosuchcmd が直前の exit 3 を引き継いだ）。例外系（$errNew）と
        # Ctrl+C 中断（ExecutionStatus 'Stopped'）は 1 に固定し、native の実コードだけ
        # $LastExit から拾う（連続同一コードの失敗ループでも正しい値を保てる）。
        $code = if ($LastOk) { 0 }
                elseif ($errNew -or ($h -and $h.ExecutionStatus -eq 'Stopped')) { 1 }
                elseif ($LastExit) { $LastExit }
                else { 1 }
        $out += __orb_osc "D;$n;$code"
        $global:__orb_si.BlockOpen = $false
    }

    # A: 開いているブロックが無ければ新ブロックを開く（初回 or D 直後）。
    # 開いたままなら（空Enter等）新 A を出さず待機ブロックを継続＝幻ブロックを作らない。
    $openBlock = -not $global:__orb_si.BlockOpen
    if ($openBlock) {
        $out += __orb_osc "A;$n"
        # P: 作業ディレクトリ（新ブロックにだけ付ける）。#71: nonce 付きで偽 cwd 注入を防ぐ。
        if ($pwd.Provider.Name -eq 'FileSystem') {
            $out += __orb_osc "P;$n;Cwd=$(__orb_escape $pwd.ProviderPath)"
        }
    }

    # 元の prompt（starship 等）は $? / $LASTEXITCODE を見るので状態を復元してから呼ぶ。
    # Write-Error は Ignore（$Error を汚さず $? だけ False に倒す・starship と同じ流儀）。
    $global:LASTEXITCODE = $LastExit
    if ($FakeCode -ne 0) { Write-Error 'orb' -ErrorAction Ignore }

    $out += [string]($global:__orb_si.OriginalPrompt.Invoke())

    # B: コマンド入力開始（新ブロックを開いたときだけ）。
    if ($openBlock) {
        $out += __orb_osc 'B'
        $global:__orb_si.BlockOpen = $true
    }

    # 次回比較用に履歴 ID を記録。
    $global:__orb_si.LastHistoryId = $curId

    # #78 UX-2: PSReadLine は対話開始時に遅延ロードされ、起動時（dot-source 時点）の設定が
    # 空振りすることがあるため、モジュールが実際に使えるようになった最初の prompt でだけ
    # InlineView を適用する（InlineViewApplied フラグで一度きりに限定）。以前はここを
    # 毎 prompt 無条件に強制しており、ユーザーが後から `Set-PSReadLineOption
    # -PredictionViewStyle ListView` 等で明示的に変更してもすぐ戻され続けていた
    # （ユーザー設定の上書き＝バグ）。一度だけにすることで以後の選択は尊重される。
    if (-not $global:__orb_si.InlineViewApplied -and (Get-Module PSReadLine)) {
        try { Set-PSReadLineOption -PredictionViewStyle InlineView -WarningAction SilentlyContinue -ErrorAction SilentlyContinue } catch {}
        $global:__orb_si.InlineViewApplied = $true
    }

    # #33: 同じ遅延ロード事情で、ReadLine のラップも prompt 内で一度だけ行う。
    __orb_wrap_readline

    # 例外系判別のベースラインは「prompt の最後」に取り直す：この prompt 内で積まれた
    # エラー（旧 PSReadLine の InlineView 非対応・starship/zoxide フックの失敗等）を吸収し、
    # 次のユーザーコマンドに誤帰属させない（さもないと native 実コードが 1 に化ける）。
    $global:__orb_si.LastErr = if ($global:Error.Count -gt 0) { $global:Error[0] } else { $null }

    return $out
}

# PromptType 通知。E/C は #33 で nonce 付きで再導入済み（__orb_wrap_readline）。
# コマンド文字列は __orb_escape 済み＋nonce 検証付きなので、過去問題だった
# 「OSC 633;E のエコーバック二重表示」「出力に紛れた偽 E」をフロント側で弾ける。
if ($global:__orb_si.HasPSReadLine -and $env:STARSHIP_SESSION_KEY) {
    # #71: P も nonce 付き（parser 側で P は nonce 必須になった）。捕捉済みローカルから出す。
    [Console]::Write((__orb_osc "P;$($global:__orb_si.Nonce);PromptType=starship"))
}
