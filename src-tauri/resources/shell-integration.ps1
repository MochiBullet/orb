# orb shell integration for PowerShell 7+ — OSC 633 command-block markers.
# profile.ps1 が定義した prompt（starship 等）をラップし、見た目を壊さず OSC を
# 前後に挿入する。手本: VS Code shellIntegration.ps1。
#
# マーカー: A=プロンプト開始 / B=コマンド入力開始 / C=実行開始 / D;<code>=実行終了
#           E;<cmd>=コマンドライン / P;Cwd=<path>=作業ディレクトリ

if ($global:__orb_si_loaded) { return }
$global:__orb_si_loaded = $true

$global:__orb_si = @{
    OriginalPrompt = $function:prompt
    LastHistoryId  = -1
    HasPSReadLine  = $null -ne (Get-Module -Name PSReadLine)
    OrigPredStyle  = $null
    PredStyle      = $null
}

# 元の PredictionViewStyle を記憶（狭ペインでの自動退避＆復元に使う）。
if ($global:__orb_si.HasPSReadLine) {
    try { $global:__orb_si.OrigPredStyle = (Get-PSReadLineOption).PredictionViewStyle } catch {}
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

    $out = ''

    # D: 直前コマンド終了 + 終了コード（初回プロンプトでは出さない）。
    if ($global:__orb_si.LastHistoryId -ne -1) {
        $code = if ($LastOk) { 0 } elseif ($LastExit) { $LastExit } else { 1 }
        $out += __orb_osc "D;$code"
    }

    # A: プロンプト開始。
    $out += __orb_osc 'A'

    # P: 作業ディレクトリ。
    if ($pwd.Provider.Name -eq 'FileSystem') {
        $out += __orb_osc "P;Cwd=$(__orb_escape $pwd.ProviderPath)"
    }

    # 元の prompt（starship 等）は $? / $LASTEXITCODE を見るので状態を復元してから呼ぶ。
    $global:LASTEXITCODE = $LastExit
    if ($FakeCode -ne 0) { Write-Error 'orb' -ErrorAction SilentlyContinue }

    $out += [string]($global:__orb_si.OriginalPrompt.Invoke())

    # B: コマンド入力開始（プロンプト表示の終端）。
    $out += __orb_osc 'B'

    $h = Get-History -Count 1
    if ($h) { $global:__orb_si.LastHistoryId = $h.Id }

    # 狭いペイン(幅<50)では PSReadLine の ListView 予測が警告を連発するため
    # InlineView に退避する（元が ListView の人のみ。幅が戻れば ListView を復元＝好みを壊さない）。
    if ($global:__orb_si.HasPSReadLine -and $global:__orb_si.OrigPredStyle -eq 'ListView') {
        $want = if ($Host.UI.RawUI.WindowSize.Width -lt 50) { 'InlineView' } else { 'ListView' }
        if ($global:__orb_si.PredStyle -ne $want) {
            try { Set-PSReadLineOption -PredictionViewStyle $want -ErrorAction SilentlyContinue } catch {}
            $global:__orb_si.PredStyle = $want
        }
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
