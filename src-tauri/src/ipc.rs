//! Listens for the relay: a per-user named pipe on Windows, a Unix socket on macOS.

use std::sync::Arc;
use std::time::Duration;

use sb_core::hub::Hub;

use crate::log;

#[cfg(windows)]
pub fn start(hub: Arc<Hub>) {
    use tokio::net::windows::named_pipe::ServerOptions;
    tauri::async_runtime::spawn(async move {
        let name = sb_common::pipe_name(&sb_common::user_key());
        // first_pipe_instance: refuse to join a pipe somebody else already owns under our name.
        let mut server = match ServerOptions::new().first_pipe_instance(true).create(&name) {
            Ok(s) => s,
            Err(err) => {
                log::line(format!("cannot open the relay pipe: {err}"));
                return;
            }
        };
        loop {
            if server.connect().await.is_err() {
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
            let next = match ServerOptions::new().create(&name) {
                Ok(s) => s,
                Err(err) => {
                    log::line(format!("cannot reopen the relay pipe: {err}"));
                    return;
                }
            };
            let connected = std::mem::replace(&mut server, next);
            let hub = hub.clone();
            tauri::async_runtime::spawn(async move { hub.serve(connected).await });
        }
    });
}

#[cfg(unix)]
pub fn start(hub: Arc<Hub>) {
    use std::os::unix::fs::PermissionsExt;
    tauri::async_runtime::spawn(async move {
        let path = sb_common::socket_path();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
            // Private directory first, so no other local user can reach the socket before it is chmod-ed.
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
        let _ = std::fs::remove_file(&path);
        let listener = match tokio::net::UnixListener::bind(&path) {
            Ok(l) => l,
            Err(err) => {
                log::line(format!("cannot open the relay socket: {err}"));
                return;
            }
        };
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let hub = hub.clone();
                    tauri::async_runtime::spawn(async move { hub.serve(stream).await });
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(200)).await,
            }
        }
    });
}
