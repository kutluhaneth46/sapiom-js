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

# Never touch the developer's (or the runner's) real state: ~/.sapiom is shared
# with the npx CLI. HOME covers POSIX, USERPROFILE+APPDATA cover Windows
# (os.homedir and Electron's userData read those).
smoke_home="$(mktemp -d)"
mkdir -p "$smoke_home/project"
export HOME="$smoke_home" USERPROFILE="$smoke_home" APPDATA="$smoke_home/AppData"
export SAPIOM_LAUNCH_DIR="$smoke_home/project"
export SAPIOM_SMOKE_OUT="$smoke_home/smoke.txt"

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
export SAPIOM_SMOKE_STUB_AGENT="$stub"
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
    # TEMPORARY (Phase 6): the Windows app exits 3 with no output on any channel,
    # even redirected — so before launching it, ask the bundled runtime what it can
    # and cannot load. Exit 3 is Node's "Internal JavaScript Parse Failure", i.e. a
    # module that fails before our code runs, and these probes name which one.
    # Remove once Windows launches.
    exe_probe="$rel/win-unpacked/Sapiom.exe"
    app_dir="$rel/win-unpacked/resources/app"
    echo "--- windows startup probes ---"
    ELECTRON_RUN_AS_NODE=1 "$exe_probe" -e "console.log('runtime ok:', process.versions.node)" 2>&1 | head -3
    echo "app dir contents:"; ls "$app_dir" 2>&1 | head -6
    # Is the entry Electron is told to load actually IN the package? A missing
    # bootstrap.cjs and an unloadable one look identical from outside (exit 3,
    # no output), so distinguish them before theorising further.
    echo "packaged main:"; grep -o '"main":[^,]*' "$app_dir/package.json" 2>&1 | head -1
    echo "dist/main contents:"; ls "$app_dir/dist/main" 2>&1 | head -8
    echo "harness package present:"; ls "$app_dir/node_modules/@sapiom/harness/package.json" 2>&1 | head -2
    # The decisive one: load our own entry the way Electron would and print the
    # real error instead of a bare exit code. `require('electron')` will fail
    # under RUN_AS_NODE — that failure is EXPECTED and tells us the module graph
    # itself resolved; anything else (ERR_MODULE_NOT_FOUND, SyntaxError) is the bug.
    #
    # Run FROM the app dir with a relative specifier: `$app_dir` here is a git-bash
    # path (/d/a/…), and handing that to pathToFileURL produced "D:\d\a\…" — the
    # probe's own bug, diagnosing nothing. A relative import resolves against cwd,
    # so no path translation is involved at all.
    exe_abs="$(cd "$(dirname "$exe_probe")" && pwd)/Sapiom.exe"
    ( cd "$app_dir" && ELECTRON_RUN_AS_NODE=1 "$exe_abs" -e "
        import('./node_modules/@sapiom/harness/dist/index.js')
          .then(() => console.log('harness index: loaded'))
          .catch((e) => console.log('harness index FAILED:', e.code || e.name, '|', String(e.message).split('\n')[0]));
      " 2>&1 | head -4 )
    ( cd "$app_dir" && ELECTRON_RUN_AS_NODE=1 "$exe_abs" -e "
        import('./dist/main/index.js')
          .then(() => console.log('entry imported cleanly'))
          .catch((e) => console.log('ENTRY FAILED:', e.code || e.name, '|', String(e.message).split('\n')[0]));
      " 2>&1 | head -6 )
    echo "--- end probes ---"

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

if [ -f "$SAPIOM_SMOKE_OUT" ]; then
  echo "--- smoke report ---"
  cat "$SAPIOM_SMOKE_OUT"
elif [ "$status" -ne 0 ]; then
  # No file AND a bad exit: the app died before it could report — which is the
  # one case where the exit code is all we have (see the Windows exit-3 bug).
  echo "--- no smoke report written: the app exited ($status) before reporting ---"
fi
exit "$status"
