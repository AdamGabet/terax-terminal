//! Reading file paths off the OS clipboard.
//!
//! The Tauri clipboard-manager plugin only handles text and images, so a file
//! copied in Finder/Explorer is invisible to it. This command exposes the
//! local absolute paths that are currently on the system clipboard so the file
//! explorer can paste them into a folder (uploading to the remote host when the
//! destination is an SSH workspace).
//!
//! Only macOS reads real paths today (via `NSPasteboard`). Windows and Linux
//! return an empty list — the in-app "Copy" clipboard still works everywhere.

/// Local absolute paths of files currently on the OS clipboard, newest API
/// available per platform. Empty when the clipboard holds no file references.
#[tauri::command]
pub async fn clipboard_read_files() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(read_clipboard_files)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn read_clipboard_files() -> Vec<String> {
    use objc2::ffi::objc_getClass;
    use objc2::runtime::AnyObject;

    // SAFETY: pure read of the general pasteboard via documented AppKit
    // selectors. `propertyListForType:` returns an autoreleased NSArray of
    // NSString paths (or nil) for the legacy filenames type; we only borrow it
    // for the duration of this call.
    unsafe {
        let pb_cls = objc_getClass(c"NSPasteboard".as_ptr());
        if pb_cls.is_null() {
            return Vec::new();
        }
        let pasteboard: *mut AnyObject = objc2::msg_send![pb_cls, generalPasteboard];
        if pasteboard.is_null() {
            return Vec::new();
        }

        let ns_str_cls = objc_getClass(c"NSString".as_ptr());
        let filenames_type: *mut AnyObject =
            objc2::msg_send![ns_str_cls, stringWithUTF8String: c"NSFilenamesPboardType".as_ptr()];

        let list: *mut AnyObject = objc2::msg_send![pasteboard, propertyListForType: filenames_type];
        if list.is_null() {
            return Vec::new();
        }

        let count: usize = objc2::msg_send![list, count];
        let mut paths = Vec::with_capacity(count);
        for i in 0..count {
            let item: *mut AnyObject = objc2::msg_send![list, objectAtIndex: i];
            if item.is_null() {
                continue;
            }
            let c_str: *const std::os::raw::c_char = objc2::msg_send![item, UTF8String];
            if c_str.is_null() {
                continue;
            }
            if let Ok(s) = std::ffi::CStr::from_ptr(c_str).to_str() {
                paths.push(s.to_owned());
            }
        }
        paths
    }
}

#[cfg(not(target_os = "macos"))]
fn read_clipboard_files() -> Vec<String> {
    // Windows (CF_HDROP) / Linux (text/uri-list) file-clipboard reading is not
    // yet implemented; the in-app file clipboard covers paste within the app.
    Vec::new()
}
