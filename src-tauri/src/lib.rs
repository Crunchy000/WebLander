// The whole desktop app: open a window, point it at the staged web build.
// There are no commands and no IPC -- the game runs entirely in the webview,
// exactly as it does in a browser tab.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("failed to start WebLander");
}
