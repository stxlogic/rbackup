//! Persist normal window geometry from events, without querying size during destruction.
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Mutex};
use tauri::{Manager, PhysicalPosition, WebviewWindow, WebviewWindowBuilder, WindowEvent};

#[derive(Clone, PartialEq, Deserialize, Serialize)]
struct Geometry {
    // Old caches may contain a maximized allocation recorded as normal geometry.
    #[serde(default)]
    version: u8,
    width: f64,
    height: f64,
    position: Option<(i32, i32)>,
}
impl Default for Geometry {
    fn default() -> Self {
        Self {
            version: 2,
            width: 1100.0,
            height: 760.0,
            position: None,
        }
    }
}
impl Geometry {
    fn fills_work_area(&self, width: u32, height: u32, scale: f64) -> bool {
        // State notifications can lag resize events. Allow for window decorations,
        // using the same margins as restoration below.
        self.width * scale >= f64::from(width) - 40.0 * scale
            && self.height * scale >= f64::from(height) - 80.0 * scale
    }

    fn resize(&mut self, width: u32, height: u32, scale: f64, normal: bool) {
        if normal && width > 0 && height > 0 && scale.is_finite() && scale > 0.0 {
            self.width = f64::from(width) / scale;
            self.height = f64::from(height) / scale;
        }
    }
    fn valid(&self) -> bool {
        self.version == 2
            && self.width.is_finite()
            && self.height.is_finite()
            && (640.0..=10000.0).contains(&self.width)
            && (600.0..=10000.0).contains(&self.height)
    }
}
struct SavedWindow {
    path: PathBuf,
    geometry: Mutex<Geometry>,
}

/// Restore once before showing; persist normal geometry changes without querying size on shutdown.
pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // A separate format intentionally ignores the plugin's physical-pixel cache.
    let path = app.path().app_config_dir()?.join("window-geometry.json");
    let mut geometry = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Geometry>(&bytes).ok())
        .filter(Geometry::valid)
        .unwrap_or_default();
    let monitors = app.available_monitors().unwrap_or_default();
    let target = geometry
        .position
        .and_then(|(x, y)| {
            monitors
                .iter()
                .find(|monitor| {
                    let area = monitor.work_area();
                    i64::from(x) >= i64::from(area.position.x)
                        && i64::from(y) >= i64::from(area.position.y)
                        && i64::from(x) < i64::from(area.position.x) + i64::from(area.size.width)
                        && i64::from(y) < i64::from(area.position.y) + i64::from(area.size.height)
                })
                .cloned()
        })
        .or_else(|| app.primary_monitor().ok().flatten());
    let mut restored_position = None;
    if let Some(monitor) = target {
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        if geometry.fills_work_area(area.size.width, area.size.height, scale) {
            // Recover caches polluted by a maximize transition in older versions.
            geometry = Geometry::default();
        }
        // Leave space for decorations and panels instead of filling the display.
        geometry.width = geometry
            .width
            .min((f64::from(area.size.width) / scale - 40.0).max(640.0));
        geometry.height = geometry
            .height
            .min((f64::from(area.size.height) / scale - 80.0).max(600.0));
        if let Some((x, y)) = geometry.position {
            let max_x = i64::from(area.position.x) + i64::from(area.size.width)
                - (geometry.width * scale) as i64;
            let max_y = i64::from(area.position.y) + i64::from(area.size.height)
                - (geometry.height * scale) as i64
                - (40.0 * scale) as i64;
            let position = PhysicalPosition::new(
                i64::from(x).clamp(
                    i64::from(area.position.x),
                    max_x.max(i64::from(area.position.x)),
                ) as i32,
                i64::from(y).clamp(
                    i64::from(area.position.y),
                    max_y.max(i64::from(area.position.y)),
                ) as i32,
            );
            restored_position = Some(position);
        }
    }
    // Set the native default size at creation. Resizing an already-created hidden
    // GTK window is asynchronous and can lose to its initial size allocation.
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == "main")
        .ok_or("Main window configuration is missing")?;
    let window = WebviewWindowBuilder::from_config(app, config)?
        .icon(tauri::include_image!("./icons/128x128.png"))?
        .inner_size(geometry.width, geometry.height)
        .maximized(false)
        .visible(false)
        .build()?;
    if let Some(position) = restored_position {
        if let Err(error) = window.set_position(position) {
            eprintln!("Could not restore window position: {error}");
        }
    }
    app.manage(SavedWindow {
        path,
        geometry: Mutex::new(geometry),
    });
    let observed = window.clone();
    window.on_window_event(move |event| observe(&observed, event));
    window.show()?;
    // Some compositors restore their own maximized state when mapping the window.
    window.unmaximize()?;
    Ok(())
}

// GTK configure events include client-side decoration extents, while its size
// setter expects the content size. Saving event dimensions makes each launch grow.
fn record_size(
    window: &WebviewWindow,
    geometry: &mut Geometry,
    width: u32,
    height: u32,
    normal: bool,
) {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::GtkWindowExt;
        let _ = (width, height);
        if let Ok(native) = window.gtk_window() {
            let (width, height) = native.size();
            if width > 0 && height > 0 {
                geometry.resize(width as u32, height as u32, 1.0, normal);
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    if let Ok(scale) = window.scale_factor() {
        geometry.resize(width, height, scale, normal);
    }
}

fn observe(window: &WebviewWindow, event: &WindowEvent) {
    let saved = window.state::<SavedWindow>();
    let Ok(mut geometry) = saved.geometry.lock() else {
        return;
    };
    let previous = geometry.clone();
    match event {
        WindowEvent::Resized(size) => {
            let normal = !window.is_maximized().unwrap_or(true)
                && !window.is_minimized().unwrap_or(true)
                && !window.is_fullscreen().unwrap_or(true);
            record_size(window, &mut geometry, size.width, size.height, normal);
        }
        WindowEvent::ScaleFactorChanged { new_inner_size, .. } => {
            let normal = !window.is_maximized().unwrap_or(true)
                && !window.is_minimized().unwrap_or(true)
                && !window.is_fullscreen().unwrap_or(true);
            record_size(
                window,
                &mut geometry,
                new_inner_size.width,
                new_inner_size.height,
                normal,
            );
        }
        WindowEvent::Moved(position)
            if !window.is_maximized().unwrap_or(true)
                && !window.is_minimized().unwrap_or(true)
                && !window.is_fullscreen().unwrap_or(true) =>
        {
            // Move notifications can precede the maximized-state update too.
            if let (Ok(size), Ok(_scale), Ok(Some(monitor))) = (
                window.inner_size(),
                window.scale_factor(),
                window.current_monitor(),
            ) {
                let mut current = geometry.clone();
                record_size(window, &mut current, size.width, size.height, true);
                let area = monitor.work_area();
                if current.fills_work_area(
                    area.size.width,
                    area.size.height,
                    monitor.scale_factor(),
                ) {
                    return;
                }
            }
            geometry.position = Some((position.x, position.y));
        }

        _ => {}
    }
    if let Ok(Some(monitor)) = window.current_monitor() {
        let area = monitor.work_area();
        if geometry.fills_work_area(area.size.width, area.size.height, monitor.scale_factor()) {
            // A resize may arrive before is_maximized() reflects the native state.
            // Retain both the normal size and position through that transition.
            *geometry = previous.clone();
        }
    }
    if *geometry != previous || matches!(event, WindowEvent::CloseRequested { .. }) {
        // Save events immediately, so dev-server restarts and process exits cannot lose a resize.
        // Never query native dimensions during close/destroy, when they can be stale.
        let result = (|| -> Result<(), Box<dyn std::error::Error>> {
            std::fs::create_dir_all(saved.path.parent().ok_or("Missing config directory")?)?;
            let temporary = saved
                .path
                .with_extension(format!("{}.tmp", std::process::id()));
            std::fs::write(&temporary, serde_json::to_vec_pretty(&*geometry)?)?;
            std::fs::rename(temporary, &saved.path)?;
            Ok(())
        })();
        if let Err(error) = result {
            eprintln!("Could not save window geometry: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discards_legacy_geometry_that_may_contain_a_maximized_size() {
        let legacy: Geometry =
            serde_json::from_str(r#"{"width":1829.0,"height":1127.0,"position":[0,0]}"#).unwrap();
        assert!(!legacy.valid());
        let current: Geometry =
            serde_json::from_slice(&serde_json::to_vec(&Geometry::default()).unwrap()).unwrap();
        assert!(current.valid());
    }

    #[test]
    fn detects_maximized_geometry_even_before_state_notification() {
        for scale in [1.0, 1.5, 2.0] {
            let mut geometry = Geometry::default();
            geometry.resize(
                (2032.0 * scale) as u32,
                (1163.0 * scale) as u32,
                scale,
                true,
            );
            assert!(geometry.fills_work_area(
                (2032.0 * scale) as u32,
                (1200.0 * scale) as u32,
                scale
            ));
            assert!(!Geometry::default().fills_work_area(
                (2032.0 * scale) as u32,
                (1200.0 * scale) as u32,
                scale
            ));
            // A window tiled to half of the display is still normal geometry.
            geometry.width /= 2.0;
            assert!(!geometry.fills_work_area(
                (2032.0 * scale) as u32,
                (1200.0 * scale) as u32,
                scale
            ));
        }
    }
    #[test]
    fn keeps_last_normal_size_in_logical_units() {
        let mut geometry = Geometry::default();
        geometry.resize(1800, 1300, 2.0, true);
        assert_eq!((geometry.width, geometry.height), (900.0, 650.0));
        // The same logical window on a monitor with a different scale retains its size.
        geometry.resize(1350, 975, 1.5, true);
        assert_eq!((geometry.width, geometry.height), (900.0, 650.0));
        for (width, height, scale, normal) in [
            (3840, 2160, 2.0, false),
            (0, 0, 1.0, true),
            (1000, 700, 0.0, true),
        ] {
            geometry.resize(width, height, scale, normal);
        }
        assert_eq!((geometry.width, geometry.height), (900.0, 650.0));
        geometry.position = Some((-1200, 80));
        let restored: Geometry =
            serde_json::from_slice(&serde_json::to_vec(&geometry).unwrap()).unwrap();
        assert!(restored.valid());
        assert_eq!(restored.position, Some((-1200, 80)));
        assert_eq!((restored.width, restored.height), (900.0, 650.0));
    }
}
