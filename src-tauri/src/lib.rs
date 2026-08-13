pub mod modules;

use modules::{
    agent, clipboard_files, codex, fs, git, lsp, mcp, net, pty, secrets, shell, ssh, tmux,
    workspace,
};
#[allow(unused_imports)]
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
#[cfg(target_os = "macos")]
use tauri::{PhysicalPosition, WindowEvent};
use tauri_plugin_window_state::StateFlags;

/// Set during setup so native callbacks (macOS dock menu) and on-demand SSH
/// reconnects can reach the app.
pub(crate) static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Labels for additional main windows: main-2, main-3, ... ("main" is the
/// config-defined first window).
static WINDOW_COUNTER: AtomicU32 = AtomicU32::new(2);

/// Creates another top-level Terax window in THIS process, so macOS keeps a
/// single dock icon / app instance. Mirrors the `main` window's config.
fn create_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    let label = format!("main-{}", WINDOW_COUNTER.fetch_add(1, Ordering::Relaxed));
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("Terax")
        .inner_size(800.0, 600.0)
        .min_inner_size(420.0, 280.0)
        // Hidden until the frontend paints, then it calls window.show().
        .visible(false);

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

/// Adds `applicationDockMenu:` and the `teraxNewWindow:` action to the Tauri
/// app delegate so macOS shows a "New Window" item in the dock right-click menu.
#[cfg(target_os = "macos")]
unsafe fn setup_dock_menu() {
    use objc2::ffi::{class_addMethod, objc_getClass};
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::sel;

    unsafe extern "C-unwind" fn dock_menu_imp(
        _this: &AnyObject,
        _cmd: Sel,
        _app: &AnyObject,
    ) -> *mut AnyObject {
        let get_class =
            |name: &core::ffi::CStr| -> *const AnyClass { objc_getClass(name.as_ptr()) };
        let ns_str = |s: &core::ffi::CStr| -> *mut AnyObject {
            let cls = get_class(c"NSString");
            objc2::msg_send![cls, stringWithUTF8String: s.as_ptr()]
        };

        let menu_cls = get_class(c"NSMenu");
        let menu: *mut AnyObject = {
            let alloc: *mut AnyObject = objc2::msg_send![menu_cls, alloc];
            objc2::msg_send![alloc, init]
        };

        let title = ns_str(c"New Window");
        let key = ns_str(c"");
        let action = sel!(teraxNewWindow:);
        let item: *mut AnyObject = {
            let cls = get_class(c"NSMenuItem");
            let alloc: *mut AnyObject = objc2::msg_send![cls, alloc];
            objc2::msg_send![alloc, initWithTitle: title, action: action, keyEquivalent: key]
        };

        let _: () = objc2::msg_send![menu, addItem: item];
        let _: () = objc2::msg_send![item, release];
        objc2::msg_send![menu, autorelease]
    }

    unsafe extern "C-unwind" fn new_window_imp(_this: &AnyObject, _cmd: Sel, _sender: &AnyObject) {
        // AppKit invokes dock-menu actions on the main thread, which is where
        // Tauri requires window creation to happen on macOS.
        if let Some(app) = APP_HANDLE.get() {
            if let Err(e) = create_main_window(app) {
                log::error!("dock New Window failed: {e}");
            }
        }
    }

    let ns_app_cls = objc_getClass(c"NSApplication".as_ptr());
    if ns_app_cls.is_null() {
        return;
    }
    let app: *mut AnyObject = objc2::msg_send![ns_app_cls, sharedApplication];
    if app.is_null() {
        return;
    }
    let delegate: *mut AnyObject = objc2::msg_send![app, delegate];
    if delegate.is_null() {
        return;
    }

    let cls = (*(delegate as *const AnyObject)).class() as *const AnyClass as *mut AnyClass;

    let dock_imp: Imp = std::mem::transmute::<
        unsafe extern "C-unwind" fn(&AnyObject, Sel, &AnyObject) -> *mut AnyObject,
        Imp,
    >(dock_menu_imp);
    class_addMethod(cls, sel!(applicationDockMenu:), dock_imp, c"@@:@".as_ptr());

    let win_imp: Imp = std::mem::transmute::<
        unsafe extern "C-unwind" fn(&AnyObject, Sel, &AnyObject),
        Imp,
    >(new_window_imp);
    class_addMethod(cls, sel!(teraxNewWindow:), win_imp, c"v@:@".as_ptr());
}

/// Drained on first read so HMR / re-mounts can't replay the launch dir.
#[derive(Default)]
struct LaunchDir(Mutex<Option<String>>);

#[tauri::command]
fn get_launch_dir(state: State<'_, LaunchDir>) -> Option<String> {
    state.0.lock().expect("LaunchDir mutex poisoned").take()
}

/// The main window's current project root (explorer root). Mirrored here so the
/// separate settings window can scope its per-repo LSP venv override to the
/// folder the user is actually working in.
#[derive(Default)]
struct ActiveRoot(Mutex<Option<String>>);

#[tauri::command]
fn set_active_root(app: tauri::AppHandle, root: Option<String>, state: State<'_, ActiveRoot>) {
    let root = root.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    *state.0.lock().expect("ActiveRoot mutex poisoned") = root.clone();
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.emit("terax:active-root", root);
    }
}

#[tauri::command]
fn get_active_root(state: State<'_, ActiveRoot>) -> Option<String> {
    state.0.lock().expect("ActiveRoot mutex poisoned").clone()
}

#[tauri::command]
fn open_new_window(app: tauri::AppHandle) -> Result<(), String> {
    create_main_window(&app)
}

#[cfg(target_os = "macos")]
fn show_main_window(app: &tauri::AppHandle) {
    let _ = app.show();
    // Any open Terax window counts ("main", "main-2", ...).
    let main_like = app
        .webview_windows()
        .into_iter()
        .find(|(label, _)| label == "main" || label.starts_with("main-"));
    if let Some((_, win)) = main_like {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    } else {
        let _ = create_main_window(app);
    }
}

fn parse_launch_dir() -> Option<String> {
    for arg in std::env::args().skip(1) {
        if arg.starts_with('-') {
            continue;
        }
        let Ok(canon) = std::fs::canonicalize(&arg) else {
            continue;
        };
        if !canon.is_dir() {
            continue;
        }
        return Some(crate::modules::fs::to_canon(&canon));
    }
    None
}

#[tauri::command]
async fn open_settings_window(app: tauri::AppHandle, tab: Option<String>) -> Result<(), String> {
    let url_path = match tab.as_deref() {
        Some(t) if !t.is_empty() => format!("settings.html?tab={}", t),
        _ => "settings.html".to_string(),
    };

    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.set_always_on_top(true);
        let _ = window.show();
        let _ = window.set_focus();
        if let Some(t) = tab.as_deref().filter(|s| !s.is_empty()) {
            // emit() serializes via JSON — no string-escape footgun, unlike
            // eval() with format!(). Frontend listens via Tauri event API.
            let _ = window.emit("terax:settings-tab", t);
        }
        return Ok(());
    }

    let builder = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App(url_path.into()))
        .title("Settings")
        .inner_size(900.0, 700.0)
        .min_inner_size(820.0, 620.0)
        .resizable(true)
        .visible(false)
        // Keep settings above the main app window so it doesn't get hidden
        // when the user clicks back into the editor or terminal (#33).
        .always_on_top(true);

    // Tie lifecycle to the main window so settings minimizes/closes with it.
    // macOS: skip parent() — child + always_on_top leaves the settings webview
    // behind the main window except while the parent is being dragged (#33).
    #[cfg(not(target_os = "macos"))]
    let builder = if let Some(main) = app.get_webview_window("main") {
        builder.parent(&main).map_err(|e| e.to_string())?
    } else {
        builder
    };

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    // On Linux/Windows we render our own titlebar, so drop native chrome
    // and make the window transparent.
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    let builder = builder.decorations(false).transparent(true);

    let window = builder.build().map_err(|e| e.to_string())?;

    // Some Linux compositors (GNOME/Mutter with CSD-by-default) ignore the
    // builder-time decorations flag — re-assert it after realize.
    #[cfg(target_os = "linux")]
    {
        let _ = window.set_decorations(false);
    }

    #[cfg(target_os = "macos")]
    if let Some(main) = app.get_webview_window("main") {
        if let (Ok(main_pos), Ok(main_size), Ok(settings_size)) = (
            main.outer_position(),
            main.outer_size(),
            window.outer_size(),
        ) {
            let x = main_pos.x
                + ((main_size.width as i32).saturating_sub(settings_size.width as i32)) / 2;
            let y = main_pos.y
                + ((main_size.height as i32).saturating_sub(settings_size.height as i32)) / 2;
            let _ = window.set_position(PhysicalPosition::new(x, y));
        } else {
            let _ = window.center();
        }
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cli_dir = parse_launch_dir();
    workspace::init_launch_cwd(cli_dir.as_deref());

    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        // Skip restoring VISIBLE — frontend calls window.show() after first
        // paint so the user never sees a transparent window-shadow flash on
        // Windows/Linux.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|_app| {
            let _ = APP_HANDLE.set(_app.handle().clone());
            #[cfg(target_os = "macos")]
            // SAFETY: called on the main thread during app setup; NSApp and its
            // delegate are guaranteed initialized by Tauri/WRY at this point.
            unsafe {
                setup_dock_menu()
            };

            // macOS skips parent() for the settings window, so tie its lifecycle
            // to the main window here instead. Other platforms keep parent().
            #[cfg(target_os = "macos")]
            if let Some(main) = _app.get_webview_window("main") {
                let handle = _app.handle().clone();
                main.on_window_event(move |event| {
                    if matches!(
                        event,
                        WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
                    ) {
                        if let Some(settings) = handle.get_webview_window("settings") {
                            let _ = settings.close();
                        }
                    }
                });
            }
            Ok(())
        })
        .manage(pty::PtyState::default())
        .manage(shell::ShellState::default())
        .manage(secrets::SecretsState::default())
        .manage(lsp::LspState::default())
        .manage(mcp::McpState::default())
        .manage(fs::watch::FsWatchState::default())
        .manage({
            let registry = workspace::WorkspaceRegistry::default();
            workspace::bootstrap_registry(&registry);
            if let Some(ref launch_dir) = cli_dir {
                let _ = registry.authorize(launch_dir);
            }
            registry
        })
        .manage(LaunchDir(Mutex::new(cli_dir)))
        .manage(ActiveRoot::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            pty::pty_close_all,
            pty::pty_has_foreground_process,
            fs::tree::list_subdirs,
            fs::tree::fs_read_dir,
            fs::file::fs_read_file,
            fs::file::fs_read_file_base64,
            fs::file::fs_write_file,
            fs::file::fs_write_file_base64,
            fs::file::fs_append_file,
            fs::file::fs_stat,
            fs::file::fs_canonicalize,
            fs::mutate::fs_create_file,
            fs::mutate::fs_create_dir,
            fs::mutate::fs_rename,
            fs::mutate::fs_delete,
            fs::watch::fs_watch_add,
            fs::watch::fs_watch_remove,
            fs::search::fs_search,
            fs::search::fs_list_files,
            fs::grep::fs_grep,
            fs::grep::fs_glob,
            git::commands::git_resolve_repo,
            git::commands::git_panel_snapshot,
            git::commands::git_status,
            git::commands::git_diff,
            git::commands::git_diff_content,
            git::commands::git_stage,
            git::commands::git_unstage,
            git::commands::git_discard,
            git::commands::git_commit,
            git::commands::git_fetch,
            git::commands::git_pull_ff_only,
            git::commands::git_push,
            git::commands::git_log,
            git::commands::git_show_commit,
            git::commands::git_commit_files,
            git::commands::git_commit_file_diff,
            git::commands::git_remote_url,
            git::commands::git_list_branches,
            git::commands::git_checkout_branch,
            git::commands::git_create_branch,
            shell::shell_run_command,
            shell::shell_rtk_rewrite,
            shell::shell_session_open,
            shell::shell_session_run,
            shell::shell_session_close,
            shell::shell_bg_spawn,
            shell::shell_bg_logs,
            shell::shell_bg_kill,
            shell::shell_bg_list,
            workspace::wsl_list_distros,
            workspace::wsl_default_distro,
            workspace::wsl_home,
            ssh::ssh_connect,
            ssh::ssh_disconnect,
            ssh::ssh_list_hosts,
            ssh::ssh_home,
            ssh::ssh_set_clipboard_image,
            ssh::ssh_port_listening,
            ssh::ssh_forward_port,
            ssh::ssh_cancel_port,
            tmux::tmux_available,
            tmux::tmux_list,
            tmux::tmux_kill,
            workspace::workspace_authorize,
            workspace::workspace_current_dir,
            get_launch_dir,
            set_active_root,
            get_active_root,
            open_new_window,
            open_settings_window,
            agent::agent_enable_claude_hooks,
            agent::agent_claude_hooks_status,
            secrets::secrets_get,
            secrets::secrets_set,
            secrets::secrets_delete,
            secrets::secrets_get_all,
            net::lm_ping,
            net::ai_http_request,
            net::ai_http_stream,
            codex::codex_auth_status,
            codex::codex_get_access_token,
            codex::codex_list_models,
            clipboard_files::clipboard_read_files,
            lsp::lsp_spawn,
            lsp::lsp_send,
            lsp::lsp_kill,
            lsp::lsp_resolve_root,
            lsp::lsp_detect,
            lsp::lsp_host_pid,
            mcp::mcp_start,
            mcp::mcp_stop,
            mcp::mcp_status,
            mcp::mcp_register,
            mcp::mcp_respond,
            mcp::mcp_notify,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. }) {
                show_main_window(app);
            }
        });
}
