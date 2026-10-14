use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use serde::{Deserialize, Serialize};
use tauri::path::BaseDirectory;
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

/// Preferences (⌘,), saved in ~/Library/Application Support/QuickClaude/settings.json.
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Prefs {
    /// When a chat finishes while you're away, bring QuickClaude forward with that chat open.
    bring_forward: bool,
    /// Play a short sound when a chat finishes while you're away.
    sound: bool,
    /// Show a macOS notification when a chat finishes while you're away.
    notification: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Self { bring_forward: false, sound: true, notification: true }
    }
}

fn prefs_path() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(std::path::Path::new(&home).join("Library/Application Support/QuickClaude/settings.json"))
}

fn load_prefs() -> Prefs {
    prefs_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn get_prefs(prefs: tauri::State<Mutex<Prefs>>) -> Prefs {
    prefs.lock().unwrap().clone()
}

#[tauri::command]
fn set_prefs(new: Prefs, prefs: tauri::State<Mutex<Prefs>>) -> Result<(), String> {
    let path = prefs_path().ok_or("no home folder")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(&new).unwrap()).map_err(|e| e.to_string())?;
    *prefs.lock().unwrap() = new;
    Ok(())
}

fn play_sound(app: &AppHandle) {
    if let Ok(sound) = app.path().resolve("sounds/reply.mp3", BaseDirectory::Resource) {
        let _ = Command::new("afplay").arg(sound).spawn();
    }
}

/// Lets you hear the sound when you switch it on in ⌘,.
#[tauri::command]
fn preview_sound(app: AppHandle) {
    play_sound(&app);
}

#[derive(Default)]
struct Agent {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    /// The chat of the latest notification, opened when you click it.
    notified: Mutex<Option<String>>,
}

/// A chat finished. If you're looking at it, do nothing; otherwise call for attention as set in ⌘,.
fn notify(app: &AppHandle, line: &str) {
    let Ok(msg) = serde_json::from_str::<serde_json::Value>(line) else {
        return;
    };
    let on_screen = msg["current"].as_bool().unwrap_or(false) && panel(app).is_visible().unwrap_or(false);
    if on_screen {
        return;
    }
    let prefs = app.state::<Mutex<Prefs>>().lock().unwrap().clone();
    if prefs.sound {
        play_sound(app);
    }
    let id = msg["id"].as_str().map(String::from);
    // Don't pull you away from another chat you're working in; notify instead.
    if prefs.bring_forward && !panel(app).is_visible().unwrap_or(false) {
        // Switch to the chat first, so showing the panel doesn't clear it as a finished answer.
        if let Some(id) = id {
            let _ = panel(app).emit("open-chat", id);
        }
        show_panel(app);
        return;
    }
    if !prefs.notification {
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
    *app.state::<Agent>().notified.lock().unwrap() = id;
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
        .manage(Mutex::new(load_prefs()))
        .invoke_handler(tauri::generate_handler![agent_send, get_prefs, set_prefs, preview_sound])
        .setup(move |app| {
            // Menu-bar app: no Dock icon, no app switcher entry.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            if let Err(e) = app.global_shortcut().register(hotkey.as_str()) {
                eprintln!("quickclaude: could not register hotkey {hotkey:?}: {e}");
            }

            let show = MenuItem::with_id(app, "show", "Show QuickClaude", true, None::<&str>)?;
            let prefs = MenuItem::with_id(app, "prefs", "Preferences…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            TrayIconBuilder::new()
                // A one-colour spark that macOS tints for light and dark menu bars.
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true)
                .tooltip(format!("QuickClaude ({hotkey})"))
                .menu(&Menu::with_items(app, &[&show, &prefs, &quit])?)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_panel(app),
                    "prefs" => {
                        show_panel(app);
                        let _ = panel(app).emit("open-prefs", ());
                    }
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
