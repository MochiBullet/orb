// Prevents additional console window on Windows in release, DO NOT REMOVE!!
// `windows_subsystem` is a Windows-only attribute; gate on target_os so non-Windows
// release builds don't trip over an attribute their compiler doesn't recognize.
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

fn main() {
    orb_lib::run()
}
