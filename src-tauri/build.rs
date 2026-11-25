fn main() {
    if std::env::var("PROFILE").as_deref() == Ok("release") && tauri_build::is_dev() {
        panic!(
            "Refusing to build a release binary without Tauri `custom-protocol` \
             (otherwise WebView connects to devUrl http://localhost:1420 and fails with ERR_CONNECTION_REFUSED). \
             Run `npm run build:exe` or `npm run deploy:local` (which invokes `tauri build --no-bundle`)."
        );
    }
    tauri_build::build()
}
