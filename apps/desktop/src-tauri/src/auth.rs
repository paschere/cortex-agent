use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;

pub fn setup_deep_link<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            // Accept: zipdev-agent://auth/callback?session=<token>
            //     or: zipdev-agent://auth?token=<token>
            if url.scheme() != "zipdev-agent" {
                continue;
            }
            let session = url
                .query_pairs()
                .find(|(k, _)| k == "session" || k == "token")
                .map(|(_, v)| v.into_owned());

            if let Some(session_token) = session {
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();

                    // Use serde_json to safely produce an escaped JSON string literal,
                    // preventing injection via tokens containing quotes, backslashes, etc.
                    let payload = serde_json::json!({
                        "type": "zipdev-auth",
                        "session": session_token
                    });
                    let js = format!("window.postMessage({}, '*');", payload);
                    let _ = window.eval(&js);
                }
            }
        }
    });
    Ok(())
}
