#!/bin/sh
# Inside the container (run.sh): start the packaged app as pwuser under Xvfb
# with an unlocked test keyring, then look at it from outside.
set -e
if [ "$KIND" = deb ]; then
  dpkg -s mvs 2>/dev/null | grep -E '^(Package|Version):' || dpkg -l | grep -i mvs
  exe=$(dpkg -L "$(dpkg -l | awk '/mvs/{print $2; exit}')" | grep -E '/(mvs|MVS)$' | while read -r f; do [ -f "$f" ] && [ -x "$f" ] && echo "$f"; done | head -1)
else
  mkdir -p /tmp/ai && cd /tmp/ai && cp "/assets/$IMG" app.AppImage && chmod +x app.AppImage
  ./app.AppImage --appimage-extract >/dev/null
  chown -R pwuser /tmp/ai
  exe=/tmp/ai/squashfs-root/AppRun
fi
echo "exe: $exe"
[ -n "$exe" ] || { echo "FAIL no executable found"; exit 1; }
exec runuser -u pwuser -- env EXE="$exe" dbus-run-session -- sh -c '
  eval "$(gnome-keyring-daemon --start --components=secrets)"; export GNOME_KEYRING_CONTROL
  printf test | gnome-keyring-daemon --replace --unlock --components=secrets >/dev/null
  w=0
  until { dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner string:org.freedesktop.secrets | grep -q "boolean true" &&
          dbus-send --session --print-reply --dest=org.freedesktop.secrets /org/freedesktop/secrets org.freedesktop.Secret.Service.ReadAlias string:default | grep -q collection/login; } || [ $w -ge 150 ]; do
    w=$((w + 1)); sleep 0.2
  done
  Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 &
  export DISPLAY=:99
  sleep 1
  "$EXE" --no-sandbox >/tmp/app.log 2>&1 &
  app=$!
  fail=0
  ok() { if [ "$1" = 0 ]; then echo "PASS $KIND: $2"; else echo "FAIL $KIND: $2"; fail=1; fi; }
  win=""; i=0
  while [ $i -lt 60 ] && [ -z "$win" ]; do
    win=$(xwininfo -root -tree 2>/dev/null | grep -E "\"MVS" | head -1); i=$((i + 1)); sleep 1
  done
  ok "$([ -n "$win" ]; echo $?)" "the main window opens (${i} s: $(echo "$win" | grep -o "\"[^\"]*\"" | head -1))"
  sleep 15
  ok "$(pgrep -f mvs-core >/dev/null; echo $?)" "mvs-core is running 15 s later"
  ok "$(pgrep -f -- "--type=renderer" >/dev/null; echo $?)" "a renderer is running"
  prof=$(ls -d "$HOME"/.config/* 2>/dev/null | grep -i mvs | head -1)
  ok "$([ -n "$prof" ]; echo $?)" "the profile folder is written ($prof)"
  [ -z "$prof" ] || ls "$prof" | head -20 | tr "\n" " "; echo
  if [ $fail != 0 ]; then echo "--- app log"; tail -40 /tmp/app.log; fi
  kill "$app" 2>/dev/null || true
  exit $fail'
