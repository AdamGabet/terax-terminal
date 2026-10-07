# terax-shell-integration (zshrc)
#
# Emits OSC 7 (cwd) + OSC 133 A/B/C/D (prompt-start / prompt-end / pre-exec /
# command-done-with-exit-code) so the host can detect command boundaries and
# track cwd without re-parsing the prompt. `status` is a read-only special in
# zsh, so we shadow $? into `_terax_ret`.

{
  _terax_user_zdotdir="${TERAX_USER_ZDOTDIR:-$HOME}"
  [ -f "$_terax_user_zdotdir/.zshrc" ] && source "$_terax_user_zdotdir/.zshrc"
  unset _terax_user_zdotdir
}

# Re-source guard within a single shell (e.g. user runs `source ~/.zshrc`).
# This is NOT exported, so each nested zsh installs its own hooks — desired,
# since every interactive shell needs its own prompt integration.
if [[ -z "$__TERAX_HOOKS_LOADED" ]]; then
  __TERAX_HOOKS_LOADED=1
  printf '\e]133;S;zsh\e\\'
  autoload -Uz add-zsh-hook 2>/dev/null

  # URL-encode $PWD byte-wise so multi-byte paths stay valid in the `file://`
  # URI emitted via OSC 7. `no_multibyte` forces ${s[i]} to index bytes (not
  # code points), and LC_ALL=C keeps the [a-zA-Z0-9...] class single-byte.
  _terax_urlencode() {
    emulate -L zsh
    setopt localoptions no_multibyte
    local LC_ALL=C s="$1" i byte
    for (( i=1; i<=${#s}; i++ )); do
      byte="${s[i]}"
      case "$byte" in
        [a-zA-Z0-9/._~-]) printf '%s' "$byte" ;;
        *) printf '%%%02X' "'$byte" ;;
      esac
    done
  }

  _terax_precmd() {
    local _terax_ret=$?
    printf '\e]133;D;%s\e\\' "$_terax_ret"
    printf '\e]7;file://%s%s\e\\' "${HOST}" "$(_terax_urlencode "$PWD")"
    # Re-inject prompt-end marker in case a framework rebuilt PS1 (p10k, starship).
    if [[ "$PS1" != *$'\e]133;B\e\\'* ]]; then
      PS1=$'%{\e]133;B\e\\%}'"$PS1"
    fi
    printf '\e]133;A\e\\'
  }

  _terax_preexec() {
    local cmd="${1//[[:cntrl:]]/ }"
    printf '\e]133;C;%s\e\\' "${cmd[1,256]}"
  }

  if (( $+functions[add-zsh-hook] )); then
    add-zsh-hook precmd _terax_precmd
    add-zsh-hook preexec _terax_preexec
  fi

  # Warp/iTerm2-style word-end navigation: zsh's default `forward-word` (M-f /
  # Option+Right) overshoots to the START of the next word; `emacs-forward-word`
  # stops at the END of the current word, which is what nearly every other shell
  # and GUI editor does. Only rebind when the binding is still the stock zsh
  # default — respects any explicit remap in the user's .zshrc.
  if (( $+widgets[emacs-forward-word] )) \
     && [[ "$(bindkey '\ef')" == '"^[f" forward-word' ]]; then
    bindkey '\ef' emacs-forward-word
  fi

  _terax_precmd
fi

# `pifull` (pi agent in tmux) shadow: if the user defined their own `pifull`
# that opens tmux on the default server (status bar and all), replace it in
# Terax shells so pi's session runs on an isolated, chromeless server — the
# same invisible-tmux treatment as Terax tmux tabs. Only shadows; never
# invents the command, and dotfiles are left untouched.
if (( $+functions[pifull] )); then
  pifull() {
    if [ -n "$TMUX" ]; then
      command pi "$@"
    else
      local cmd="pi"
      [ "$#" -gt 0 ] && cmd="pi $(printf '%q ' "$@")"
      local conf="$HOME/.cache/terax/nested-tmux.conf"
      if [ ! -f "$conf" ]; then
        mkdir -p "${conf%/*}" 2>/dev/null
        cat > "$conf" <<'TERAX_TMUX_EOF'
set -g status off
set -g default-terminal "screen-256color"
set -ga terminal-overrides ",xterm-256color:Tc"
set -ga terminal-overrides ",screen-256color:Tc"
set -g focus-events on
set -g aggressive-resize on
set -g history-limit 50000
set -g mouse off
set -sg escape-time 10
set -s set-clipboard on
set -s extended-keys on
TERAX_TMUX_EOF
      fi
      tmux -L pi -f "$conf" new-session -A -s pi "$cmd"
    fi
  }
fi
:
