use std::os::windows::process::CommandExt;

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

/// Claude のトークン使用率（サイドバー用、ブロッキング HTTP は別スレッドで実行される）。
#[tauri::command]
pub fn get_usage() -> Result<crate::usage::Usage> {
    crate::usage::fetch_usage()
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
pub async fn get_mcp_health() -> Vec<crate::status::McpHealth> {
    tauri::async_runtime::spawn_blocking(crate::status::fetch_mcp_health)
        .await
        .unwrap_or_default()
}

/// cwd の git ブランチ名（サイドバー用）。git 不在・非リポジトリ・detached は None。
#[tauri::command]
pub fn get_git_branch(cwd: Option<String>) -> Option<String> {
    let dir = cwd?;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("git")
        .args(["-C", &dir, "rev-parse", "--abbrev-ref", "HEAD"])
        .creation_flags(CREATE_NO_WINDOW)
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
/// 既定は Zed（`zed <path>:<line>`）。zed が PATH に無い/失敗時は OS 既定アプリで開く（行ジャンプ無し）。
/// regex の誤マッチで存在しないパスが来ることもあるので、その場合は黙って無視する。
#[tauri::command]
pub fn open_in_editor(cwd: Option<String>, path: String, line: Option<u32>) -> Result<()> {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let p = std::path::Path::new(&path);
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::path::Path::new(&cwd.unwrap_or_default()).join(p)
    };
    if !abs.exists() {
        return Ok(());
    }
    let abs_str = abs.to_string_lossy().to_string();
    let target = match line {
        Some(l) => format!("{abs_str}:{l}"),
        None => abs_str.clone(),
    };
    // まず Zed（行ジャンプ対応）。PATH に無ければ spawn が Err になるのでフォールバックへ。
    if std::process::Command::new("zed")
        .arg(&target)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .is_ok()
    {
        return Ok(());
    }
    // フォールバック: OS 既定アプリで開く（cmd start。行ジャンプは無し）。
    std::process::Command::new("cmd")
        .args(["/C", "start", "", abs_str.as_str()])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()?;
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
    let cmd = shell::build_pwsh(initial_cmd.as_deref(), nonce.as_deref())?;
    let handle = PtyHandle::spawn(cmd, cols, rows, on_output)?;
    // ロックは map 更新の間だけ保持し、置き換えられた旧ハンドルの kill(=taskkill/join)
    // はロックの外で行う（ロックを握ったまま join するのを避ける）。
    let previous = {
        let mut ptys = state.ptys.lock().unwrap();
        ptys.insert(pane_id, handle)
    };
    if let Some(mut prev) = previous {
        prev.kill();
    }
    Ok(())
}

#[tauri::command]
pub fn write_pty(state: State<'_, AppState>, pane_id: PaneId, data: Vec<u8>) -> Result<()> {
    let ptys = state.ptys.lock().unwrap();
    let handle = ptys.get(&pane_id).ok_or(AppError::PaneNotFound(pane_id))?;
    handle.write(&data)
}

#[tauri::command]
pub fn resize_pty(state: State<'_, AppState>, pane_id: PaneId, cols: u16, rows: u16) -> Result<()> {
    let ptys = state.ptys.lock().unwrap();
    let handle = ptys.get(&pane_id).ok_or(AppError::PaneNotFound(pane_id))?;
    handle.resize(cols, rows)
}

#[tauri::command]
pub fn close_pty(state: State<'_, AppState>, pane_id: PaneId) -> Result<()> {
    // ロックは remove の間だけ。kill(taskkill/join) はロックの外で。
    let removed = state.ptys.lock().unwrap().remove(&pane_id);
    if let Some(mut handle) = removed {
        handle.kill();
    }
    Ok(())
}

/// フロントの起動/リロード時に呼ぶ。旧ペインの PTY を全破棄して孤児
/// reader スレッド・pwsh を防ぐ（HMR/WebView リロードは Channel を再bind できないため
/// 全 drop が正しい）。kill はロックの外で。
#[tauri::command]
pub fn close_all_ptys(state: State<'_, AppState>) {
    let drained: Vec<_> = state.ptys.lock().unwrap().drain().collect();
    for (_, mut handle) in drained {
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
}
