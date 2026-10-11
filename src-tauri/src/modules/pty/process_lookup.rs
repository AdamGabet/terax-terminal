use std::collections::HashMap;

use crate::modules::workspace::WorkspaceEnv;

/// Resolve the nearest Terax shell ancestor, not just a terminal in the same cwd.
pub(crate) fn find_pty(
    mut pid: u32,
    parents: &HashMap<u32, u32>,
    shells: &HashMap<u32, u32>,
) -> Option<u32> {
    for _ in 0..=parents.len() {
        if pid == 0 {
            break;
        }
        if let Some(id) = shells.get(&pid) {
            return Some(*id);
        }
        pid = *parents.get(&pid)?;
    }
    None
}

pub(crate) fn parse_pairs(text: &str) -> HashMap<u32, u32> {
    text.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            Some((fields.next()?.parse().ok()?, fields.next()?.parse().ok()?))
        })
        .collect()
}

pub(super) fn lookup(
    pid: u32,
    workspace: WorkspaceEnv,
    terminals: Vec<(u32, u32)>,
) -> Result<Option<u32>, String> {
    match workspace {
        WorkspaceEnv::Local => {
            #[cfg(unix)]
            {
                let output = std::process::Command::new("ps")
                    .args(["-axo", "pid=,ppid="])
                    .output()
                    .map_err(|e| e.to_string())?;
                if !output.status.success() {
                    return Err("Could not read the terminal process tree".to_string());
                }
                let parents = parse_pairs(&String::from_utf8_lossy(&output.stdout));
                let shells = terminals
                    .into_iter()
                    .map(|(id, shell)| (shell, id))
                    .collect();
                Ok(find_pty(pid, &parents, &shells))
            }
            #[cfg(not(unix))]
            {
                let _ = (pid, terminals);
                Err("Finding interactive Fleet terminals is not supported on this host".to_string())
            }
        }
        WorkspaceEnv::Ssh { host } => {
            crate::modules::fleet::ensure_posix(&host)?;
            // Remote shell startup records its PID under its native PTY id.
            // Read-only lookup; only this window's live PTY ids can be returned.
            let output = crate::modules::ssh::exec_capture(
                &host,
                "ps -axo pid=,ppid= || exit 1\n\
                 printf '\\nTERAX_SHELLS\\n'\n\
                 for f in \"$HOME\"/.cache/terax/remote/pty-*.pid; do\n\
                   [ -f \"$f\" ] || continue\n\
                   id=${f##*/pty-}; id=${id%.pid}\n\
                   printf '%s %s\\n' \"$(cat \"$f\")\" \"$id\"\n\
                 done",
            )?;
            let (processes, shells) = output
                .split_once("\nTERAX_SHELLS\n")
                .ok_or_else(|| "Could not read the remote terminal process tree".to_string())?;
            let shells = parse_pairs(shells)
                .into_iter()
                .filter(|(_, id)| terminals.iter().any(|(live_id, _)| live_id == id))
                .collect();
            Ok(find_pty(pid, &parse_pairs(processes), &shells))
        }
        WorkspaceEnv::Wsl { .. } => Err(crate::modules::fleet::UNSUPPORTED_WSL.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn follows_wrappers_to_the_nearest_terminal() {
        let parents = parse_pairs("50 40\n40 30\n30 20\n20 1");
        let shells = HashMap::from([(20, 7), (30, 8)]);
        assert_eq!(find_pty(50, &parents, &shells), Some(8));
    }

    #[test]
    fn does_not_guess_when_agent_is_outside_terax() {
        assert_eq!(
            find_pty(50, &parse_pairs("50 1"), &HashMap::from([(20, 7)])),
            None
        );
    }

    #[test]
    fn handles_missing_exited_and_cyclic_processes() {
        assert_eq!(find_pty(50, &HashMap::new(), &HashMap::new()), None);
        assert_eq!(
            find_pty(50, &parse_pairs("50 40\n40 50"), &HashMap::new()),
            None
        );
    }

    #[test]
    fn ignores_malformed_process_rows() {
        assert_eq!(
            parse_pairs("PID PPID\n50 40\nbad\n"),
            HashMap::from([(50, 40)])
        );
    }
}
