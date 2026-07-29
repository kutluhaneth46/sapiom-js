#!/usr/bin/env bash
#
# Launch the PACKAGED app's --smoke checks against an isolated state root.
# Used by two workflows (the PR test job and the release build) and usable
# locally after `pnpm --filter @sapiom/harness-desktop dist`:
#
#   packages/harness-desktop/scripts/smoke.sh
#
# Exits with the app's own exit code, after printing its report.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
rel="${SMOKE_RELEASE_DIR:-$here/../release}"

# Kept for the Windows env bisect below: the control launch needs the runner's
# own values, and we are about to overwrite them.
ORIG_HOME="${HOME:-}"; ORIG_USERPROFILE="${USERPROFILE:-}"; ORIG_APPDATA="${APPDATA:-}"

smoke_home="$(mktemp -d)"
mkdir -p "$smoke_home/project" "$smoke_home/AppData"

# The app is a NATIVE process, so every path handed to it must be native too.
# git-bash's mktemp returns a POSIX path (/tmp/tmp.XXXX) with no drive letter, and
# Windows cannot use it: exporting that as APPDATA made Electron fail while
# creating its userData directory — before logging existed — which is the "exit 3
# with no output on any channel" we spent several CI rounds chasing. It was this
# script breaking the app, not the app. `cygpath -w` converts; a no-op elsewhere.
native() {
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*) cygpath -w "$1" ;;
    *) printf '%s' "$1" ;;
  esac
}
app_home="$(native "$smoke_home")"

# Never touch the developer's (or the runner's) real state: ~/.sapiom is shared
# with the npx CLI. HOME covers POSIX, USERPROFILE+APPDATA cover Windows
# (os.homedir and Electron's userData read those).
export HOME="$app_home" USERPROFILE="$app_home" APPDATA="$(native "$smoke_home/AppData")"
export SAPIOM_LAUNCH_DIR="$(native "$smoke_home/project")"
# Two forms of the report path: the app writes to the native one, this script
# reads the POSIX one.
report_file="$smoke_home/smoke.txt"
export SAPIOM_SMOKE_OUT="$(native "$report_file")"

# A stand-in for the coding agent, so the smoke run can create a REAL session
# (POST /api/sessions → pty spawn) on a machine with no agent installed. It is
# deliberately a SCRIPT, not an .exe: npm installs `claude.cmd` on Windows, and
# spawning that is what failed there — CreateProcess does no PATHEXT lookup and
# cannot execute a .cmd. A stub that was an .exe would pass while the real thing
# broke. It just idles briefly so the session is genuinely running.
if [ "$(uname -s)" != "Linux" ] && [ "$(uname -s)" != "Darwin" ]; then
  # Shaped like an npm shim on purpose — a `.cmd` that runs `node <script>` — because
  # that is exactly what `claude.cmd` is, and it's the shape resolveSpawnTarget has
  # to see through. A stub that were a plain .cmd (or an .exe) would exercise a path
  # real agents never take, and is now correctly refused rather than shelled out.
  stub="$smoke_home/stub-agent.cmd"
  printf 'setTimeout(() => process.exit(0), 3000);\n' > "$smoke_home/stub-agent.js"
  printf '@echo off\r\n"%%dp0%%\\node.exe" "%%dp0%%\\stub-agent.js" %%*\r\n' > "$stub"
else
  stub="$smoke_home/stub-agent.sh"
  printf '#!/bin/sh\nsleep 3\nexit 0\n' > "$stub"
  chmod +x "$stub"
fi
# Native, because resolveSpawnTarget resolves this inside the app: a POSIX
# path has no drive letter, so the Windows lookup would never find it.
export SAPIOM_SMOKE_STUB_AGENT="$(native "$stub")"
# CI is not a user.
export SAPIOM_TELEMETRY_DISABLED=1
# Windows: makes Electron log rather than swallow.
export ELECTRON_ENABLE_LOGGING=1

status=0
case "$(uname -s)" in
  Linux)
    # The *-unpacked dir, not the .AppImage: the AppImage wrapper needs FUSE
    # (absent on CI runners) and its extract-and-run fallback both floods the log
    # with an 11k-line file listing and failed to exec the app at all (exit 127).
    # linux-unpacked IS the bundle the AppImage wraps, so every layer these
    # checks cover is identical; the wrapper is verified by launching the
    # .AppImage locally.
    # --no-sandbox: chrome-sandbox is only setuid-root once actually installed.
    app="$rel/linux-unpacked/sapiom"
    if [ -n "${DISPLAY:-}" ]; then
      "$app" --smoke --no-sandbox || status=$?
    else
      # Headless runner: Electron still needs an X display.
      xvfb-run --auto-servernum "$app" --smoke --no-sandbox || status=$?
    fi
    ;;
  Darwin)
    "$rel"/mac-arm64/Sapiom.app/Contents/MacOS/Sapiom --smoke || status=$?
    ;;
  MINGW* | MSYS* | CYGWIN*)
    # TEMPORARY: bisect WHICH environment override kills the app on a Windows
    # runner. Established facts: the app launches on a real Windows desktop, and
    # it launched once in CI when run with the runner's own environment — every
    # isolated launch exits 3 before any output. So an override is responsible,
    # and guessing which has now been wrong twice (asar, then APPDATA's format).
    # Each line prints only an exit code, which is all we need. Remove once known.
    win_exe="$rel/win-unpacked/Sapiom.exe"
    echo "--- env bisect (exit codes; 0 = launched) ---"
    ( env -u SAPIOM_SMOKE_OUT -u SAPIOM_SMOKE_STUB_AGENT -u SAPIOM_LAUNCH_DIR \
          HOME="$ORIG_HOME" USERPROFILE="$ORIG_USERPROFILE" APPDATA="$ORIG_APPDATA" \
          "$win_exe" --smoke >/dev/null 2>&1; echo "  runner env (control): $?" )
    ( env HOME="$ORIG_HOME" USERPROFILE="$ORIG_USERPROFILE" APPDATA="$ORIG_APPDATA" \
          "$win_exe" --smoke >/dev/null 2>&1; echo "  + SAPIOM_* only:      $?" )
    ( env APPDATA="$ORIG_APPDATA" "$win_exe" --smoke >/dev/null 2>&1; echo "  + HOME/USERPROFILE:   $?" )
    ( "$win_exe" --smoke >/dev/null 2>&1; echo "  fully isolated:       $?" )
    echo "--- end bisect ---"

    # The nsis .exe is an installer; smoke the unpacked app it installs.
    # REDIRECTED to a file, not inherited: a GUI-subsystem exe cannot attach to
    # an existing console (piping loses everything) but its handles redirect to a
    # file fine — without this a crash before our own reporting code runs is just
    # an exit code with no message.
    "$rel/win-unpacked/Sapiom.exe" --smoke > "$smoke_home/stdio.txt" 2>&1 || status=$?
    echo "--- app stdout/stderr ---"
    cat "$smoke_home/stdio.txt" || true
    ;;
  *)
    echo "smoke.sh: unsupported platform $(uname -s)" >&2
    exit 2
    ;;
esac

if [ -f "$report_file" ]; then
  echo "--- smoke report ---"
  cat "$report_file"
elif [ "$status" -ne 0 ]; then
  # No file AND a bad exit: the app died before it could report — which is the
  # one case where the exit code is all we have (see the Windows exit-3 bug).
  echo "--- no smoke report written: the app exited ($status) before reporting ---"
fi
exit "$status"
