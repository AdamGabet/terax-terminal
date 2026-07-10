//! Scans terminal output for "a server is now listening on :PORT" lines so the
//! frontend can offer to forward that port over the active SSH connection (the
//! way Cursor/VSCode do). Runs only for SSH-backed PTYs; pure text heuristic.

use std::collections::HashSet;

/// A line longer than this without a newline is scanned and reset, so a stream
/// with no newlines can't grow the buffer without bound.
const MAX_LINE: usize = 8 * 1024;
/// Privileged ports (and 0) are almost never a dev server the user just
/// started; skipping them cuts noise (e.g. an `:80` in a logged URL, `:22`).
const MIN_PORT: u16 = 1024;

pub struct PortScanner {
    line: Vec<u8>,
    announced: HashSet<u16>,
}

impl PortScanner {
    pub fn new() -> Self {
        Self {
            line: Vec::with_capacity(256),
            announced: HashSet::new(),
        }
    }

    /// Feed filtered terminal output. Invokes `on_port` once per port the first
    /// time it's seen this session.
    pub fn process(&mut self, bytes: &[u8], mut on_port: impl FnMut(u16)) {
        for &b in bytes {
            if b == b'\n' || b == b'\r' {
                self.flush_line(&mut on_port);
            } else if self.line.len() >= MAX_LINE {
                // Pathological no-newline line: scan what we have and reset.
                self.flush_line(&mut on_port);
                self.line.push(b);
            } else {
                self.line.push(b);
            }
        }
        self.scan_line(&mut on_port);
    }

    fn flush_line(&mut self, on_port: &mut impl FnMut(u16)) {
        if self.line.is_empty() {
            return;
        }
        self.scan_line(on_port);
        self.line.clear();
    }

    fn scan_line(&mut self, on_port: &mut impl FnMut(u16)) {
        if self.line.is_empty() {
            return;
        }
        let text = String::from_utf8_lossy(&self.line);
        let stripped = strip_ansi(&text);
        for port in scan_ports(&stripped) {
            if port >= MIN_PORT && self.announced.insert(port) {
                on_port(port);
            }
        }
    }
}

/// Removes ANSI/CSI/OSC escape sequences so coloured server banners
/// (`\x1b[32mhttp://localhost:3000\x1b[0m`) still match.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x1b {
            i += 1;
            match bytes.get(i) {
                // CSI: ESC [ ... <final byte 0x40..=0x7e>
                Some(b'[') => {
                    i += 1;
                    while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
                        i += 1;
                    }
                    i += 1; // consume the final byte
                }
                // OSC: ESC ] ... (BEL | ESC \)
                Some(b']') => {
                    i += 1;
                    while i < bytes.len() && bytes[i] != 0x07 {
                        if bytes[i] == 0x1b && bytes.get(i + 1) == Some(&b'\\') {
                            i += 1;
                            break;
                        }
                        i += 1;
                    }
                    i += 1;
                }
                // Other two-byte escape — skip the next byte.
                _ => i += 1,
            }
        } else {
            // Copy whole UTF-8 chars; `s` is valid UTF-8 so byte i starts a char.
            let ch_len = utf8_len(bytes[i]);
            if let Ok(chunk) = std::str::from_utf8(&bytes[i..(i + ch_len).min(bytes.len())]) {
                out.push_str(chunk);
            }
            i += ch_len;
        }
    }
    out
}

fn utf8_len(b: u8) -> usize {
    if b < 0x80 {
        1
    } else if b >> 5 == 0b110 {
        2
    } else if b >> 4 == 0b1110 {
        3
    } else if b >> 3 == 0b11110 {
        4
    } else {
        1
    }
}

/// Extracts candidate listening ports from one (ANSI-stripped) line.
fn scan_ports(line: &str) -> Vec<u16> {
    let low = line.to_ascii_lowercase();
    let mut out = Vec::new();

    // Loopback / wildcard host followed immediately by `:PORT`. Covers Vite
    // ("Local: http://localhost:5173/"), Next ("http://localhost:3000"),
    // python http.server ("(http://0.0.0.0:8000/)"), etc.
    const HOSTS: [&str; 5] = ["localhost:", "127.0.0.1:", "0.0.0.0:", "[::]:", "[::1]:"];
    for h in HOSTS {
        let mut from = 0;
        while let Some(rel) = low[from..].find(h) {
            let at = from + rel + h.len();
            if let Some(p) = parse_port(&low[at..]) {
                out.push(p);
            }
            from = at;
        }
    }

    // "...port 8000" style, only when the line announces a server.
    const TRIGGERS: [&str; 7] = [
        "listening",
        "running at",
        "running on",
        "started server",
        "serving",
        "local:",
        "available on",
    ];
    if TRIGGERS.iter().any(|t| low.contains(t)) {
        let mut from = 0;
        while let Some(rel) = low[from..].find("port ") {
            let at = from + rel + "port ".len();
            if let Some(p) = parse_port(&low[at..]) {
                out.push(p);
            }
            from = at;
        }
    }

    out
}

/// Leading run of digits (max 5) parsed as a valid TCP port.
fn parse_port(s: &str) -> Option<u16> {
    let digits: String = s.chars().take_while(char::is_ascii_digit).take(5).collect();
    if digits.is_empty() {
        return None;
    }
    digits
        .parse::<u32>()
        .ok()
        .filter(|&p| (1..=65535).contains(&p))
        .map(|p| p as u16)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ports(line: &str) -> Vec<u16> {
        scan_ports(&strip_ansi(line))
    }

    #[test]
    fn detects_common_dev_server_banners() {
        assert_eq!(ports("  ➜  Local:   http://localhost:5173/"), vec![5173]);
        assert_eq!(ports("listening on http://127.0.0.1:3000"), vec![3000]);
        assert_eq!(
            ports("Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ..."),
            vec![8000, 8000]
        );
        assert_eq!(ports("Now listening on: http://localhost:5000"), vec![5000]);
    }

    #[test]
    fn ignores_lines_without_a_port() {
        assert!(ports("just some regular output").is_empty());
        assert!(ports("error: connection refused").is_empty());
    }

    #[test]
    fn strips_ansi_colour_before_matching() {
        assert_eq!(
            ports("\x1b[32m\x1b[1mhttp://localhost:4321\x1b[0m"),
            vec![4321]
        );
    }

    #[test]
    fn parses_port_stopping_at_non_digits() {
        assert_eq!(parse_port("3000/foo"), Some(3000));
        assert_eq!(parse_port("8080"), Some(8080));
        assert_eq!(parse_port(""), None);
        assert_eq!(parse_port("abc"), None);
        // 70000 > u16 range → rejected.
        assert_eq!(parse_port("70000"), None);
    }

    #[test]
    fn announces_each_port_once_and_skips_privileged() {
        let mut scanner = PortScanner::new();
        let mut seen = Vec::new();
        scanner.process(b"listening on http://localhost:3000\n", |p| seen.push(p));
        // Repeat line: no second announce.
        scanner.process(b"listening on http://localhost:3000\n", |p| seen.push(p));
        // Privileged port: skipped.
        scanner.process(b"bound http://localhost:80\n", |p| seen.push(p));
        assert_eq!(seen, vec![3000]);
    }

    #[test]
    fn handles_split_lines_across_chunks() {
        let mut scanner = PortScanner::new();
        let mut seen = Vec::new();
        scanner.process(b"Local: http://localho", |p| seen.push(p));
        scanner.process(b"st:5173/\n", |p| seen.push(p));
        assert_eq!(seen, vec![5173]);
    }

    #[test]
    fn detects_without_waiting_for_newline() {
        let mut scanner = PortScanner::new();
        let mut seen = Vec::new();
        scanner.process(b"ready at http://localhost:5173/", |p| seen.push(p));
        assert_eq!(seen, vec![5173]);
    }

    #[test]
    fn detects_nested_bash_server_output() {
        let mut scanner = PortScanner::new();
        let mut seen = Vec::new();
        scanner.process(
            b"adamgab@genie65:~$ excalidraw-toolkit start\r\n  \xe2\x9c\x93 Canvas server started at http://localhost:3000 (pid: 3388423)\r\n  Open http://localhost:3000 in your browser\r\nadamgab@genie65:~$ ",
            |p| seen.push(p),
        );
        assert_eq!(seen, vec![3000]);
    }
}
