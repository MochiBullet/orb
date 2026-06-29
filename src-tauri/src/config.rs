use std::path::PathBuf;

use serde::{Deserialize, Serialize};

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
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(pf) = toml::from_str::<ProjectsFile>(&text) {
            if !pf.project.is_empty() {
                return pf.project;
            }
        }
    }
    let defaults = default_projects();
    let dir = config_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(s) = toml::to_string_pretty(&ProjectsFile {
        project: defaults.clone(),
    }) {
        let _ = std::fs::write(dir.join("projects.toml"), s);
    }
    defaults
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
