use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use crate::config::{self, Config, Project};
use crate::error::{AppError, Result};
use crate::pty::PtyHandle;
use crate::shell;
use crate::state::{AppState, PaneId};

/// projects.toml の案件一覧（案件ランチャー用）。
#[tauri::command]
pub fn list_projects() -> Vec<Project> {
    config::load_projects()
}

/// #53: 画像バイト列を `%TEMP%\orb-shots\` に保存してフルパスを返す（呼び元は
/// save_clipboard_image。claude ペインへは @パス で挿入される）。
/// 中身が申告 mime のマジックバイトで始まらない場合は保存しない＝ゴミ画像ファイルを作らない。
fn save_image_to(dir: &std::path::Path, bytes: &[u8], mime: &str) -> Result<String> {
    let ext = match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        _ => return Err(AppError::Config(format!("unsupported image mime: {mime}"))),
    };
    let magic_ok = match ext {
        "png" => bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47]),
        "jpg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "gif" => bytes.starts_with(b"GIF8"),
        "webp" => bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        "bmp" => bytes.starts_with(b"BM"),
        _ => false,
    };
    if !magic_ok {
        return Err(AppError::Config("clipboard bytes do not match the claimed image type".into()));
    }
    std::fs::create_dir_all(dir)?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // 同一ミリ秒の連続貼り付けでも上書きしない。
    let mut path = dir.join(format!("orb-{ts}.{ext}"));
    let mut n = 1;
    while path.exists() {
        path = dir.join(format!("orb-{ts}-{n}.{ext}"));
        n += 1;
    }
    std::fs::write(&path, bytes)?;
    prune_shots(dir, MAX_SHOTS);
    Ok(path.to_string_lossy().into_owned())
}

/// orb-shots に残す最大ファイル数。貼り付けのたびに保存されるので上限で刈る。
const MAX_SHOTS: usize = 300;

/// 新しい方 keep 件を残して古い orb-* ファイルを消す（best-effort・失敗は無視）。
/// 直近の貼り付けを claude が読む分には十分で、%TEMP% の無限肥大を防ぐ。
fn prune_shots(dir: &std::path::Path, keep: usize) {
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    let mut files: Vec<(std::time::SystemTime, std::path::PathBuf)> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with("orb-"))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    if files.len() <= keep {
        return;
    }
    files.sort_by(|a, b| b.cmp(a)); // (mtime, path) 降順＝新しい順
    for (_, p) in files.into_iter().skip(keep) {
        let _ = std::fs::remove_file(p);
    }
}

/// RGBA8（row-major・w*h*4 bytes）を PNG にエンコードする。寸法とバッファ長の不一致は拒否。
fn encode_png(w: usize, h: usize, rgba: &[u8]) -> Result<Vec<u8>> {
    if w == 0 || h == 0 || rgba.len() != w.checked_mul(h).and_then(|n| n.checked_mul(4)).unwrap_or(0) {
        return Err(AppError::Config("invalid clipboard image dimensions".into()));
    }
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w as u32, h as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().map_err(|e| AppError::Config(e.to_string()))?;
        writer
            .write_image_data(rgba)
            .map_err(|e| AppError::Config(e.to_string()))?;
    }
    Ok(out)
}

/// #53: クリップボードが「画像のみ」なら PNG 化して `%TEMP%\orb-shots\` に保存しパスを返す。
/// テキストが載っている時は None＝通常のテキスト貼り付けに譲る（Ctrl+V keydown から
/// fire-and-forget で呼ばれるため、どちらか一方しか書かない＝二重ペーストが起きない）。
/// クリップボード API はブロッキングなので専用スレッドへ逃がす。
#[tauri::command]
pub async fn save_clipboard_image() -> Result<Option<String>> {
    tauri::async_runtime::spawn_blocking(|| -> Result<Option<String>> {
        let mut cb = match arboard::Clipboard::new() {
            Ok(c) => c,
            Err(_) => return Ok(None),
        };
        if cb.get_text().map(|t| !t.trim().is_empty()).unwrap_or(false) {
            return Ok(None);
        }
        let img = match cb.get_image() {
            Ok(i) => i,
            Err(_) => return Ok(None), // 画像なし＝何もしない
        };
        let bytes = encode_png(img.width, img.height, &img.bytes)?;
        save_image_to(&std::env::temp_dir().join("orb-shots"), &bytes, "image/png").map(Some)
    })
    .await
    .map_err(|e| AppError::Config(format!("clipboard image task: {e}")))?
}

/// config.toml（font/scrollback 等）。
#[tauri::command]
pub fn get_config() -> Config {
    config::load_config()
}

/// 設定GUI からの保存。
#[tauri::command]
pub fn save_config(config: Config) -> Result<()> {
    crate::config::save_config(&config)
}

/// 埋め込んだ既定背景動画を config_dir 下へ冪等展開し、その絶対パスを返す。
/// フロントは bg_image の "__default__" センチネルをこのパスへ解決して表示する。
#[tauri::command]
pub fn get_default_bg() -> Result<String> {
    config::ensure_default_bg().map(|p| p.to_string_lossy().into_owned())
}

/// Claude のトークン使用率（サイドバー用）。401/403 リトライ込みで最悪 ~20s ブロッキングし得るため、
/// 他の重いコマンド（checkpoint_* 等）と同様 async + spawn_blocking で専用スレッドへ逃がす。
#[tauri::command]
pub async fn get_usage() -> Result<crate::usage::Usage> {
    tauri::async_runtime::spawn_blocking(crate::usage::fetch_usage)
        .await
        .map_err(|e| AppError::Config(format!("usage task: {e}")))?
}

/// #52: cwd の案件がローカルで直近24h/1hに消費した token 量（org 全体の 5h/7d % とは別軸）。
/// ファイル走査を挟むため spawn_blocking で専用スレッドへ逃がす（cwd 切替のたびに叩かれる想定）。
#[tauri::command]
pub async fn get_local_usage(cwd: Option<String>) -> crate::usage_local::LocalUsage {
    tauri::async_runtime::spawn_blocking(move || crate::usage_local::fetch_local_usage(cwd))
        .await
        .unwrap_or_default()
}

/// #54: AI ペインのターン開始ごとに呼ばれる fire-and-forget のチェックポイント捕捉。
/// git 未導入・非リポジトリ・無変更は静かに何もしない。
#[tauri::command]
pub async fn checkpoint_capture(cwd: String) {
    let _ = tauri::async_runtime::spawn_blocking(move || crate::checkpoint::capture(&cwd)).await;
}

/// #54: 対象 cwd（の git リポジトリ）が持つチェックポイント一覧（新しい順）。
#[tauri::command]
pub async fn checkpoint_list(cwd: String) -> Vec<crate::checkpoint::Checkpoint> {
    tauri::async_runtime::spawn_blocking(move || crate::checkpoint::list(&cwd))
        .await
        .unwrap_or_default()
}

/// #54: チェックポイント時点と現在の作業ツリーの差分（ロールバック前のプレビュー用）。
#[tauri::command]
pub async fn checkpoint_diff(cwd: String, hash: String) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || crate::checkpoint::diff(&cwd, &hash))
        .await
        .map_err(|e| AppError::Config(format!("checkpoint diff task: {e}")))?
}

/// #54: 唯一の破壊的操作。`git reset --hard` で作業ツリーをチェックポイント時点へ戻す。
/// 呼び出しは UI 側の明示確認（diff プレビュー→確認クリック）を経た後にのみ行われる契約。
#[tauri::command]
pub async fn checkpoint_restore(cwd: String, hash: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || crate::checkpoint::restore(&cwd, &hash))
        .await
        .map_err(|e| AppError::Config(format!("checkpoint restore task: {e}")))?
}

/// Claude Code の設定由来ステータス（モデル/エフォート/MCP）。
#[tauri::command]
pub fn get_claude_status(cwd: Option<String>) -> crate::status::ClaudeStatus {
    crate::status::fetch_status(cwd)
}

/// `claude mcp list` 実測の MCP 生死（サイドバーのチップ色用）。数秒かかる重いブロッキング処理。
/// Tauri v2 の同期コマンドはメインスレッドで走り UI を固めるため、async にして
/// `spawn_blocking` でブロッキング処理を専用スレッドプールへ逃がす（起動時＋5分毎＋手動↻で発火）。
#[tauri::command]
pub async fn get_mcp_health(cwd: Option<String>) -> Vec<crate::status::McpHealth> {
    tauri::async_runtime::spawn_blocking(move || crate::status::fetch_mcp_health(cwd))
        .await
        .unwrap_or_default()
}

/// cwd の git ブランチ名（サイドバー用）。git 不在・非リポジトリ・detached は None。
#[tauri::command]
pub fn get_git_branch(cwd: Option<String>) -> Option<String> {
    let dir = cwd?;
    let out = crate::procutil::new_command("git")
        .args(["-C", &dir, "rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() || s == "HEAD" {
        None
    } else {
        Some(s)
    }
}

/// 出力中の `path:line` リンク（VIBE_IDEAS #37 semantic history）をクリックしたとき、
/// ペインの cwd 基準で解決してエディタの該当行を開く。
/// 既定は Zed（`zed <path>:<line>`、全OS共通）。zed が PATH に無い/失敗時は OS 既定の
/// フォールバックへ（Windows は #72 の RCE 対策で「開く」ではなく reveal-only）。
/// regex の誤マッチで存在しないパスが来ることもあるので、その場合は黙って無視する。
#[tauri::command]
pub fn open_in_editor(cwd: Option<String>, path: String, line: Option<u32>) -> Result<()> {
    // #72: パス解決＋先頭 `-`（flag injection）判定。None＝開かない（存在しないパスと同じ扱い）。
    let abs_str = match resolve_target_path(cwd.as_deref(), &path) {
        Some(s) => s,
        None => return Ok(()),
    };
    if !std::path::Path::new(&abs_str).exists() {
        return Ok(());
    }
    let target = match line {
        Some(l) => format!("{abs_str}:{l}"),
        None => abs_str.clone(),
    };
    // まず Zed（行ジャンプ対応）。PATH に無ければ spawn が Err になるのでフォールバックへ。
    if crate::procutil::new_command("zed").arg(&target).spawn().is_ok() {
        return Ok(());
    }
    open_with_os_default(&abs_str)
}

/// `open_in_editor` のパス解決＋安全判定の純粋部分（FS/spawn を含まない＝単体テスト可能）。
/// - 絶対パスはそのまま、相対パスは cwd 基準（cwd 空なら素の相対）で解決して文字列化する。
/// - #72: 解決後のパスが `-` 始まりなら `None`＝開かない。cwd 空＋相対パス `-x.txt`
///   （`FILE_LINE_RE` がマッチしうる）だけがこの形になり得て、そのまま子プロセス（zed 等）
///   の argv へ渡すと先頭 `-` が CLI フラグと誤解される（flag injection）。絶対パスは
///   drive letter / `\` / `/` 始まりなので `-` にはならず、正常系は影響を受けない。
fn resolve_target_path(cwd: Option<&str>, path: &str) -> Option<String> {
    let p = std::path::Path::new(path);
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::path::Path::new(cwd.unwrap_or_default()).join(p)
    };
    let abs_str = abs.to_string_lossy().into_owned();
    if abs_str.starts_with('-') {
        return None;
    }
    Some(abs_str)
}

/// Zed 不在時の OS 既定フォールバック。`abs_str` はターミナル出力中の `path:line`
/// （正規表現マッチ）由来の**信頼できない**入力（悪意あるリポの出力が
/// `scripts/build.bat:1: warning …` を印字しうる）である点に注意。パスは絶対・`.exists()`
/// 済みで、`Command` はシェルを経由しないため文字列の再解釈は起きない。
///
/// #72 (P0/RCE): Windows の `explorer.exe <path>` は登録シェル動詞＝ダブルクリック相当で、
/// `.bat/.cmd/.com/.exe/.scr/.js/.vbs/.hta/.lnk/.wsf/.msi` 等を**実行**してしまう
/// （git clone 取得ファイルは Mark-of-the-Web 無し→SmartScreen も素通り）。ゆえに「開く/実行」
/// 動詞を絶対に使わず、`explorer.exe /select,<path>` の **reveal-only**＝フォルダ内で当該
/// ファイルを選択表示するだけ（実行しない）にする。
#[cfg(windows)]
fn open_with_os_default(abs_str: &str) -> Result<()> {
    use std::os::windows::process::CommandExt;
    // raw_arg で `/select,"<path>"`（path のみクォート）の生コマンドラインを逐語生成する。
    // `.arg()` だと Rust が `/select,<path>` 全体をクォートしてしまい、空白入りパス
    // （`C:\Users\…`, `Program Files` 等）で explorer が reveal に失敗する（実測）。
    crate::procutil::new_command("explorer")
        .raw_arg(reveal_arg(abs_str))
        .spawn()?;
    Ok(())
}

/// #72: Windows フォールバックの reveal-only コマンドライン片を組み立てる。
/// `explorer.exe /select,<path>` はフォルダ内で当該ファイルを選択表示するだけで
/// **開かない/実行しない**（起動シェル動詞を使わない＝実行ファイルでも実行されない）。
/// explorer は `/select,` の後ろに「path だけをクォートした」形を要求するので
/// `/select,"<path>"` を生成し raw_arg で逐語で渡す。Windows のパスに `"` は使えないため
/// 二重引用符で囲んでも中身で閉じられず（＝クォート注入不可）、`Command` はシェルも介さない。
#[cfg(windows)]
fn reveal_arg(abs_str: &str) -> String {
    format!("/select,\"{abs_str}\"")
}

/// macOS: `open <path>` は既定アプリで開く。ソースファイルは通常テキストエディタに関連付く
/// ため、Windows の ShellExecute のように**スクリプトを実行**する挙動にはならない
/// （#72 の execute-on-open は Windows 固有。ゆえに Windows のみ reveal-only にしてある）。
#[cfg(target_os = "macos")]
fn open_with_os_default(abs_str: &str) -> Result<()> {
    crate::procutil::new_command("open").arg(abs_str).spawn()?;
    Ok(())
}

/// Linux: `xdg-open <path>` も既定アプリで開くだけで、Windows の ShellExecute のように
/// スクリプトを実行する挙動にはならない（#72 の execute-on-open は Windows 固有）。
#[cfg(all(unix, not(target_os = "macos")))]
fn open_with_os_default(abs_str: &str) -> Result<()> {
    crate::procutil::new_command("xdg-open").arg(abs_str).spawn()?;
    Ok(())
}

/// pwsh を spawn し、出力 Channel を結線する。`on_output` はフロントが生成した
/// バイナリ Channel（raw バイトが流れる）。
#[tauri::command]
pub fn spawn_pty(
    state: State<'_, AppState>,
    pane_id: PaneId,
    cols: u16,
    rows: u16,
    on_output: Channel<InvokeResponseBody>,
    initial_cmd: Option<String>,
    nonce: Option<String>,
) -> Result<()> {
    let cmd = shell::build_shell(initial_cmd.as_deref(), nonce.as_deref())?;
    let handle = std::sync::Arc::new(PtyHandle::spawn(cmd, cols, rows, on_output)?);
    // ロックは map 更新の間だけ保持し、置き換えられた旧ハンドルの kill(=taskkill/join)
    // はロックの外で行う（ロックを握ったまま join するのを避ける）。
    let previous = {
        let mut ptys = state.ptys.lock().unwrap_or_else(|p| p.into_inner());
        ptys.insert(pane_id, handle)
    };
    if let Some(prev) = previous {
        prev.kill();
    }
    Ok(())
}

/// map のロックは pane の `Arc<PtyHandle>` を1回 clone する間だけ保持し、実際の
/// （ブロッキングしうる）write はロックを離してから行う。これにより pane A への
/// write が詰まって（例: `less` が stdin を読まない／大きなペーストで PTY バッファが
/// 埋まる）も、pane B の write_pty/resize_pty は state.ptys のロック待ちにならない。
#[tauri::command]
pub fn write_pty(state: State<'_, AppState>, pane_id: PaneId, data: Vec<u8>) -> Result<()> {
    let handle = {
        let ptys = state.ptys.lock().unwrap_or_else(|p| p.into_inner());
        ptys.get(&pane_id).cloned().ok_or(AppError::PaneNotFound(pane_id))?
    };
    handle.write(&data)
}

/// write_pty 同様、map ロックは Arc の clone のみに限定する。
#[tauri::command]
pub fn resize_pty(state: State<'_, AppState>, pane_id: PaneId, cols: u16, rows: u16) -> Result<()> {
    let handle = {
        let ptys = state.ptys.lock().unwrap_or_else(|p| p.into_inner());
        ptys.get(&pane_id).cloned().ok_or(AppError::PaneNotFound(pane_id))?
    };
    handle.resize(cols, rows)
}

#[tauri::command]
pub fn close_pty(state: State<'_, AppState>, pane_id: PaneId) -> Result<()> {
    // ロックは remove の間だけ。kill(taskkill/join) はロックの外で。
    let removed = state.ptys.lock().unwrap_or_else(|p| p.into_inner()).remove(&pane_id);
    if let Some(handle) = removed {
        handle.kill();
    }
    Ok(())
}

/// フロントの起動/リロード時に呼ぶ。旧ペインの PTY を全破棄して孤児
/// reader スレッド・pwsh を防ぐ（HMR/WebView リロードは Channel を再bind できないため
/// 全 drop が正しい）。kill はロックの外で。
#[tauri::command]
pub fn close_all_ptys(state: State<'_, AppState>) {
    // ロックは drain の間だけ保持（既に kill() はロック外＝他箇所と同じ形）。poisoning は
    // kill_all_ptys 系と同じ方針で復旧する（一貫性のため、パニックさせて再起動不能にしない）。
    let drained: Vec<_> = state
        .ptys
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .drain()
        .collect();
    for (_, handle) in drained {
        handle.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 1x1 の実 PNG（マジック含む最小構成）。
    const TINY_PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
        0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
        0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78,
        0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
        0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    #[test]
    fn save_image_to_writes_png_and_uniquifies() {
        let dir = std::env::temp_dir().join("orb-shots-test");
        let _ = std::fs::remove_dir_all(&dir);
        let p1 = save_image_to(&dir, TINY_PNG, "image/png").unwrap();
        let p2 = save_image_to(&dir, TINY_PNG, "image/png").unwrap();
        assert!(p1.ends_with(".png"));
        assert_ne!(p1, p2); // 同一ミリ秒でも上書きしない
        assert_eq!(std::fs::read(&p1).unwrap(), TINY_PNG);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_shots_keeps_newest() {
        let dir = std::env::temp_dir().join("orb-shots-test-prune");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..5 {
            std::fs::write(dir.join(format!("orb-{i}.png")), b"x").unwrap();
            std::thread::sleep(std::time::Duration::from_millis(15)); // mtime に順序を付ける
        }
        std::fs::write(dir.join("other.txt"), b"keep").unwrap(); // orb-* 以外は対象外
        prune_shots(&dir, 2);
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, ["orb-3.png", "orb-4.png", "other.txt"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn encode_png_roundtrips_magic_and_rejects_bad_dims() {
        // 2x1 RGBA（赤・緑）→ PNG マジックで始まり、save_image_to の検証も通る。
        let rgba = [255u8, 0, 0, 255, 0, 255, 0, 255];
        let png = encode_png(2, 1, &rgba).unwrap();
        assert!(png.starts_with(&[0x89, 0x50, 0x4e, 0x47]));
        let dir = std::env::temp_dir().join("orb-shots-test-enc");
        let _ = std::fs::remove_dir_all(&dir);
        let p = save_image_to(&dir, &png, "image/png").unwrap();
        assert!(p.ends_with(".png"));
        let _ = std::fs::remove_dir_all(&dir);
        // 寸法とバッファ長の不一致・ゼロ寸法は拒否
        assert!(encode_png(2, 2, &rgba).is_err());
        assert!(encode_png(0, 1, &[]).is_err());
    }

    #[test]
    fn save_image_to_rejects_mismatch_and_unknown_mime() {
        let dir = std::env::temp_dir().join("orb-shots-test-rej");
        let _ = std::fs::remove_dir_all(&dir);
        // 申告 mime とマジック不一致（テキストを png と偽る）
        assert!(save_image_to(&dir, b"hello world", "image/png").is_err());
        // 未対応 mime
        assert!(save_image_to(&dir, TINY_PNG, "image/tiff").is_err());
        // 拒否時はディレクトリ自体作られない（副作用なし）
        assert!(!dir.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Bug1 回帰テスト: write_pty/resize_pty/spawn_pty が使っている「map ロックは
    /// Arc を1回 clone する間だけ保持し、実際の（ブロッキングしうる）操作はロックを
    /// 離してから行う」というパターン（AppState.ptys: Mutex<HashMap<PaneId, Arc<..>>>
    /// と同型）を、PtyHandle 実体無しで再現して検証する。
    ///
    /// pane 1 のハンドル内ロック（PtyHandle::write 相当の writer ロックを模した
    /// Mutex<()>）を長時間（stuck write を模擬）握りっぱなしにしても、pane 2 が
    /// map ロックを取得してハンドルを clone する一連の操作が待たされないことを
    /// 確認する＝一つのペインの詰まりが他ペインの I/O を道連れにしないことの保証。
    #[test]
    fn per_pane_lock_does_not_block_other_panes() {
        use std::collections::HashMap;
        use std::sync::{Arc, Mutex};
        use std::time::{Duration, Instant};

        let ptys: Arc<Mutex<HashMap<u64, Arc<Mutex<()>>>>> = Arc::new(Mutex::new(HashMap::new()));
        ptys.lock().unwrap().insert(1, Arc::new(Mutex::new(())));
        ptys.lock().unwrap().insert(2, Arc::new(Mutex::new(())));

        let stall = Duration::from_millis(300);

        // pane 1: write_pty と同じ手順（map ロック→Arc clone→ロック解放→ハンドル
        // 側ロックを長時間占有 = stuck write の模擬）。
        let ptys_for_pane1 = Arc::clone(&ptys);
        let pane1 = std::thread::spawn(move || {
            let handle = {
                let map = ptys_for_pane1.lock().unwrap();
                Arc::clone(map.get(&1).unwrap())
            };
            let _held = handle.lock().unwrap();
            std::thread::sleep(stall);
        });

        std::thread::sleep(Duration::from_millis(50)); // pane1 が握るのを待つ

        // pane 2: 同じ手順を実行し、所要時間を計測する。
        let start = Instant::now();
        let handle2 = {
            let map = ptys.lock().unwrap();
            Arc::clone(map.get(&2).unwrap())
        };
        let _held2 = handle2.lock().unwrap();
        let elapsed = start.elapsed();

        pane1.join().unwrap();

        // pane1 が stall 分ハンドル内ロックを握っていても、map ロックはとうに
        // 解放済みなので pane2 の一連の操作はほぼ即座に終わるはず。
        assert!(
            elapsed < stall / 2,
            "pane2 op took {elapsed:?}, expected to be unaffected by pane1's stalled lock ({stall:?})"
        );
    }

    /// #72: resolve_target_path — 絶対パスは素通し、相対は cwd と結合、先頭 `-`（flag
    /// injection 経路）は None＝開かない。open_in_editor が子プロセスへ渡す文字列の安全判定。
    #[test]
    fn resolve_target_path_joins_and_blocks_leading_dash() {
        // 絶対パスはそのまま（cwd は無視）。
        #[cfg(windows)]
        assert_eq!(
            resolve_target_path(Some("C:\\ignored"), "C:\\src\\main.rs").as_deref(),
            Some("C:\\src\\main.rs")
        );
        #[cfg(unix)]
        assert_eq!(
            resolve_target_path(Some("/ignored"), "/src/main.rs").as_deref(),
            Some("/src/main.rs")
        );
        // 相対パスは cwd 基準で結合される（正常系）。
        let joined = resolve_target_path(Some("root"), "sub.rs").unwrap();
        assert!(joined.starts_with("root") && joined.contains("sub.rs"));
        // #72: cwd 空 + 先頭 `-` の相対パス → None（zed 等へ CLI フラグとして渡さない）。
        assert_eq!(resolve_target_path(None, "-x.txt"), None);
        assert_eq!(resolve_target_path(Some(""), "-rf.sh"), None);
        // cwd があれば先頭 `-` のパスでも結合後は `-` 始まりにならない＝開いてよい。
        assert!(!resolve_target_path(Some("proj"), "-x.txt").unwrap().starts_with('-'));
    }

    /// #72 回帰: Windows フォールバックは「開く/実行」ではなく reveal-only（`/select,`）で
    /// あり続けること。ここが素の open 引数に戻ると RCE が再発するのでロックする。
    #[cfg(windows)]
    #[test]
    fn reveal_arg_is_select_only() {
        // 実行ファイルでも `/select,` 前置＝開かず選択表示のみ。path のみクォート＝空白入り
        // パスでも explorer が reveal できる形。
        assert_eq!(
            reveal_arg("C:\\repo\\scripts\\build.bat"),
            "/select,\"C:\\repo\\scripts\\build.bat\""
        );
        assert!(reveal_arg("C:\\x\\y.exe").starts_with("/select,\""));
    }
}
