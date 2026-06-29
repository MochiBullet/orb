use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

/// 案件ランチャー1件分。warp の gen-warp-launch-configs.ps1 の $projects に対応。
#[derive(Serialize, Deserialize, Clone)]
pub struct Project {
    pub slug: String,
    pub name: String,
    pub dir: String,
    #[serde(default)]
    pub dev_cmd: String,
    /// モノレポ等で dev サーバの cwd が dir と異なる場合のみ。空なら dir を使う。
    #[serde(default)]
    pub dev_cwd: String,
}

#[derive(Serialize, Deserialize, Default)]
struct ProjectsFile {
    #[serde(default, rename = "project")]
    project: Vec<Project>,
}

fn default_font_size() -> u16 {
    13
}
fn default_font_family() -> String {
    "\"Cascadia Code\", \"FiraCode Nerd Font\", \"Consolas\", monospace".into()
}
fn default_scrollback() -> u32 {
    1000
}

/// orb 本体の設定（config.toml）。
#[derive(Serialize, Deserialize, Clone)]
pub struct Config {
    #[serde(default = "default_font_size")]
    pub font_size: u16,
    #[serde(default = "default_font_family")]
    pub font_family: String,
    #[serde(default = "default_scrollback")]
    pub scrollback: u32,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            font_size: default_font_size(),
            font_family: default_font_family(),
            scrollback: default_scrollback(),
        }
    }
}

/// config.toml を書き出す（設定GUI からの保存）。
pub fn save_config(cfg: &Config) -> Result<()> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir)?;
    let s = toml::to_string_pretty(cfg).map_err(|e| AppError::Config(e.to_string()))?;
    std::fs::write(dir.join("config.toml"), s)?;
    Ok(())
}

/// config.toml を読む。無ければデフォルトを書き出して返す（projects.toml と同じ方針）。
pub fn load_config() -> Config {
    let path = config_dir().join("config.toml");
    match std::fs::read_to_string(&path) {
        Ok(text) => toml::from_str::<Config>(&text).unwrap_or_default(),
        Err(_) => {
            let cfg = Config::default();
            let dir = config_dir();
            let _ = std::fs::create_dir_all(&dir);
            if let Ok(s) = toml::to_string_pretty(&cfg) {
                let _ = std::fs::write(&path, s);
            }
            cfg
        }
    }
}

/// $XDG_CONFIG_HOME/orb（未設定なら ~/.config/orb）。
fn config_dir() -> PathBuf {
    if let Some(x) = std::env::var_os("XDG_CONFIG_HOME") {
        return PathBuf::from(x).join("orb");
    }
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(".config")
        .join("orb")
}

/// projects.toml を読む。無ければデフォルト案件を書き出して返す。
pub fn load_projects() -> Vec<Project> {
    let path = config_dir().join("projects.toml");
    match std::fs::read_to_string(&path) {
        // ファイルが存在する: ユーザー設定を尊重し、デフォルトで上書きしない。
        // 空リストは「意図的に空」として尊重、パース失敗時のみメモリ上の既定を返す
        // （ファイルは触らずユーザーが直せるよう温存）。
        Ok(text) => match toml::from_str::<ProjectsFile>(&text) {
            Ok(pf) => pf.project,
            Err(_) => default_projects(),
        },
        // ファイルが無い: 初回のみ既定を書き出して返す。
        Err(_) => {
            let defaults = default_projects();
            let dir = config_dir();
            let _ = std::fs::create_dir_all(&dir);
            if let Ok(s) = toml::to_string_pretty(&ProjectsFile {
                project: defaults.clone(),
            }) {
                let _ = std::fs::write(&path, s);
            }
            defaults
        }
    }
}

fn default_projects() -> Vec<Project> {
    let p = |slug: &str, name: &str, dir: &str, dev_cwd: &str| Project {
        slug: slug.into(),
        name: name.into(),
        dir: dir.into(),
        dev_cmd: "npm run dev".into(),
        dev_cwd: dev_cwd.into(),
    };
    vec![
        p("plimal-ms", "PLIMAL-Ms", r"C:\Users\hiyok\PLIMAL-Ms", ""),
        p("plimal", "PLIMAL", r"C:\Users\hiyok\PLIMAL", ""),
        p(
            "ms-kintai",
            "Ms-kintai",
            r"C:\Users\hiyok\Ms-kintai-app",
            r"C:\Users\hiyok\Ms-kintai-app\frontend",
        ),
        p("creft", "CREFT", r"C:\Users\hiyok\client-creft-cojp-website", ""),
        p("dev-division", "dev-division", r"C:\Users\hiyok\dev-division-site", ""),
        p("kokoronomori", "kokoronomori", r"C:\Users\hiyok\kokoronomori-web", ""),
        p("level88", "level88", r"C:\Users\hiyok\Client-level88-site", ""),
        p(
            "mochibullet",
            "mochibullet",
            r"C:\Users\hiyok\projects\corporate-website-template-cloudflare",
            "",
        ),
        p("beat-beasts", "beat-beasts", r"C:\Users\hiyok\Desktop\beat-beasts", ""),
        p("ms-garage", "ms-garage", r"C:\Users\hiyok\projects\ms-garage-app", ""),
    ]
}
