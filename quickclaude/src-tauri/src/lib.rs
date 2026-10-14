use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, LogicalPosition, Manager, RunEvent, WebviewWindow, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;

/// Placeholder until you pick your own; override with QUICKCLAUDE_HOTKEY (e.g. "Super+Shift+Space").
const DEFAULT_HOTKEY: &str = "Alt+Space";

/// Dev runs the sidecar source with node; the built app runs the compiled copy bundled next to it.
fn agent_command() -> std::io::Result<Command> {
    if cfg!(debug_assertions) {
        let node = std::env::var("QUICKCLAUDE_NODE").unwrap_or_else(|_| "node".into());
        let mut cmd = Command::new(node);
        cmd.arg(concat!(env!("CARGO_MANIFEST_DIR"), "/../sidecar/agent.mjs"));
        Ok(cmd)
    } else {
        let exe = std::env::current_exe()?;
        Ok(Command::new(exe.with_file_name("quickclaude-agent")))
    }
}

#[derive(Default)]
struct Agent {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    /// The chat of the latest notification, opened when you click it.
    notified: Mutex<Option<String>>,
}

/// A reply that arrived on its own (a background task finished). Notify unless you're looking at it.
fn notify(app: &AppHandle, line: &str) {
    let Ok(msg) = serde_json::from_str::<serde_json::Value>(line) else {
        return;
    };
    let on_screen = msg["current"].as_bool().unwrap_or(false) && panel(app).is_visible().unwrap_or(false);
    if on_screen {
        return;
    }
    let short = |s: &str, n: usize| {
        let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
        if s.chars().count() > n {
            format!("{}…", s.chars().take(n).collect::<String>())
        } else {
            s
        }
    };
    let title = short(msg["title"].as_str().unwrap_or(""), 60);
    let text = short(msg["text"].as_str().unwrap_or(""), 200);
    *app.state::<Agent>().notified.lock().unwrap() = msg["id"].as_str().map(String::from);
    let _ = app
        .notification()
        .builder()
        .title(if title.is_empty() { "Claude".into() } else { format!("Claude · {title}") })
        .body(if text.is_empty() { "Finished.".into() } else { text })
        .show();
}

fn spawn_agent(app: &AppHandle) {
    let mut child = match agent_command().and_then(|mut cmd| {
        cmd.env_remove("ANTHROPIC_API_KEY")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
    }) {
        Ok(child) => child,
        Err(e) => {
            let msg = format!("Could not start the agent sidecar: {e}");
            let _ = app.emit(
                "agent",
                serde_json::json!({ "type": "error", "message": msg }).to_string(),
            );
            return;
        }
    };

    let stdout = child.stdout.take().expect("piped stdout");
    let agent = app.state::<Agent>();
    *agent.stdin.lock().unwrap() = child.stdin.take();
    *agent.child.lock().unwrap() = Some(child);

    let app = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.starts_with(r#"{"type":"notify""#) {
                notify(&app, &line);
            }
            let _ = app.emit("agent", line);
        }
        // The sidecar exited: tell the UI and bring it back, unless we are quitting.
        if app.state::<Agent>().child.lock().unwrap().take().is_some() {
            let msg = "The agent stopped unexpectedly and was restarted.";
            let _ = app.emit(
                "agent",
                serde_json::json!({ "type": "error", "message": msg }).to_string(),
            );
            std::thread::sleep(std::time::Duration::from_secs(1));
            spawn_agent(&app);
        }
    });
}

#[tauri::command]
fn agent_send(line: String, agent: tauri::State<Agent>) -> Result<(), String> {
    let mut stdin = agent.stdin.lock().unwrap();
    let stdin = stdin.as_mut().ok_or("agent is not running")?;
    writeln!(stdin, "{line}")
        .and_then(|_| stdin.flush())
        .map_err(|e| e.to_string())
}

fn panel(app: &AppHandle) -> WebviewWindow {
    app.get_webview_window("main").expect("main window")
}

fn show_panel(app: &AppHandle) {
    let window = panel(app);
    // Spotlight-style placement: horizontally centred, a fifth of the way down.
    if let Ok(Some(monitor)) = window
        .current_monitor()
        .or_else(|_| window.primary_monitor())
    {
        let scale = monitor.scale_factor();
        let pos = monitor.position().to_logical::<f64>(scale);
        let size = monitor.size().to_logical::<f64>(scale);
        let width = window
            .outer_size()
            .map(|s| s.to_logical::<f64>(scale).width)
            .unwrap_or(720.0);
        let _ = window.set_position(LogicalPosition::new(
            pos.x + (size.width - width) / 2.0,
            pos.y + size.height * 0.2,
        ));
    }
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.emit("panel-shown", ());
}

fn toggle_panel(app: &AppHandle) {
    let window = panel(app);
    if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
        let _ = window.hide();
    } else {
        show_panel(app);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let hotkey = std::env::var("QUICKCLAUDE_HOTKEY").unwrap_or_else(|_| DEFAULT_HOTKEY.into());

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_panel(app);
                    }
                })
                .build(),
        )
        .manage(Agent::default())
        .invoke_handler(tauri::generate_handler![agent_send])
        .setup(move |app| {
            // Menu-bar app: no Dock icon, no app switcher entry.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            if let Err(e) = app.global_shortcut().register(hotkey.as_str()) {
                eprintln!("quickclaude: could not register hotkey {hotkey:?}: {e}");
            }

            let show = MenuItem::with_id(app, "show", "Show QuickClaude", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip(format!("QuickClaude ({hotkey})"))
                .menu(&Menu::with_items(app, &[&show, &quit])?)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_panel(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_panel(tray.app_handle());
                    }
                })
                .build(app)?;

            // Clicking a notification opens its chat.
            let handle = app.handle().clone();
            app.notification().on_action(move |_| {
                let id = handle.state::<Agent>().notified.lock().unwrap().clone();
                // Switch to the chat first, so showing the panel doesn't clear it as a finished answer.
                if let Some(id) = id {
                    let _ = panel(&handle).emit("open-chat", id);
                }
                show_panel(&handle);
            })?;

            spawn_agent(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Click-away hides the panel, like Spotlight.
            if let WindowEvent::Focused(false) = event {
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            let agent = app.state::<Agent>();
            if let Some(mut child) = agent.child.lock().unwrap().take() {
                // Closing stdin lets the sidecar shut its Claude processes down; kill if it lingers.
                agent.stdin.lock().unwrap().take();
                for _ in 0..20 {
                    if matches!(child.try_wait(), Ok(Some(_))) {
                        return;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                let _ = child.kill();
            }
        }
    });
}
