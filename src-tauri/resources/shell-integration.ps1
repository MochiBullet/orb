# orb shell integration for PowerShell 7+ — OSC 633 command-block markers.
# profile.ps1 が定義した prompt（starship 等）をラップし、見た目を壊さず OSC を
# 前後に挿入する。手本: VS Code shellIntegration.ps1。
#
# マーカー: A=プロンプト開始 / B=コマンド入力開始 / C=実行開始 / D;<code>=実行終了
#           E;<cmd>=コマンドライン / P;Cwd=<path>=作業ディレクトリ

if ($global:__orb_si_loaded) { return }
$global:__orb_si_loaded = $true

# PSReadLine の ListView 警告（狭い/低いペインで連発）を含む警告出力を抑制する。
$global:WarningPreference = 'SilentlyContinue'

# profile が PSReadLine をロード済みなら、起動直後に InlineView へ固定して
# profile の ListView 設定を上書きする（prompt 内の毎回強制と二段構え）。
if (Get-Module PSReadLine) {
    try { Set-PSReadLineOption -PredictionViewStyle InlineView -ErrorAction SilentlyContinue } catch {}
}

$global:__orb_si = @{
    OriginalPrompt = $function:prompt
    LastHistoryId  = -1
    # 現在ブロックが開いているか（A を出して D 未了）。空Enter等でコマンド未実行のときは
    # このまま開き続け、A/D を重複させない＝幻ブロックで耐久ログ #31 を汚さない。
    BlockOpen      = $false
    HasPSReadLine  = $null -ne (Get-Module -Name PSReadLine)
}

# orb は分割多用ターミナルのため PSReadLine 予測を InlineView に固定する。
# ListView は「幅50・高さ5」未満で警告を出し、リサイズに prompt 単位でしか追従できず
# 分割直後の警告を防げない。予測自体は1行インラインで残る。元の好みは orb の外では不変
# （この pwsh プロセス内だけの変更）。
if ($global:__orb_si.HasPSReadLine) {
    try { Set-PSReadLineOption -PredictionViewStyle InlineView -ErrorAction SilentlyContinue } catch {}
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
    # 直前コマンドの終了状態を最優先で捕捉（後続処理で壊さないため）。
    $LastExit = $global:LASTEXITCODE
    $LastOk = $?
    $FakeCode = [int](-not $LastOk)

    # 前回プロンプト以降に「実際にコマンドが実行された」かを履歴 ID の前進で判定する
    # （VS Code shell integration と同流儀）。空Enter・Ctrl+C で入力破棄・シェル内部の
    # プロンプト再描画では履歴 ID が進まない＝コマンド未実行として D/A を出さない。
    $h = Get-History -Count 1
    $curId = if ($h) { [int]$h.Id } else { -1 }
    $ranCommand = $curId -ne $global:__orb_si.LastHistoryId

    $out = ''

    # D: コマンドが実際に走ったら、開いているブロックを終了コード付きで閉じる。
    if ($ranCommand -and $global:__orb_si.BlockOpen) {
        $code = if ($LastOk) { 0 } elseif ($LastExit) { $LastExit } else { 1 }
        $out += __orb_osc "D;$code"
        $global:__orb_si.BlockOpen = $false
    }

    # A: 開いているブロックが無ければ新ブロックを開く（初回 or D 直後）。
    # 開いたままなら（空Enter等）新 A を出さず待機ブロックを継続＝幻ブロックを作らない。
    $openBlock = -not $global:__orb_si.BlockOpen
    if ($openBlock) {
        $out += __orb_osc 'A'
        # P: 作業ディレクトリ（新ブロックにだけ付ける）。
        if ($pwd.Provider.Name -eq 'FileSystem') {
            $out += __orb_osc "P;Cwd=$(__orb_escape $pwd.ProviderPath)"
        }
    }

    # 元の prompt（starship 等）は $? / $LASTEXITCODE を見るので状態を復元してから呼ぶ。
    $global:LASTEXITCODE = $LastExit
    if ($FakeCode -ne 0) { Write-Error 'orb' -ErrorAction SilentlyContinue }

    $out += [string]($global:__orb_si.OriginalPrompt.Invoke())

    # B: コマンド入力開始（新ブロックを開いたときだけ）。
    if ($openBlock) {
        $out += __orb_osc 'B'
        $global:__orb_si.BlockOpen = $true
    }

    # 次回比較用に履歴 ID を記録。
    $global:__orb_si.LastHistoryId = $curId

    # PSReadLine は対話開始時に遅延ロードされ、起動時の設定が空振りすることがある。
    # prompt ごとに InlineView を強制し、ListView の「画面が小さい」警告を完全に根絶する。
    if (Get-Module PSReadLine) {
        try { Set-PSReadLineOption -PredictionViewStyle InlineView -ErrorAction SilentlyContinue } catch {}
    }

    return $out
}

# PromptType 通知のみ。コマンドライン(E)/実行開始(C) の PSConsoleHostReadLine ラップは、
# Windows ConPTY で OSC 633;E のコマンド文字列がエコーバックされ入力が二重表示される
# 既知問題があるため P1 では行わない（ブロック境界は prompt の A/D だけで成立する）。
# E/C は P3 でコマンドライン取得が必要になったら nonce 付きで安全に再導入する。
if ($global:__orb_si.HasPSReadLine -and $env:STARSHIP_SESSION_KEY) {
    [Console]::Write((__orb_osc 'P;PromptType=starship'))
}
