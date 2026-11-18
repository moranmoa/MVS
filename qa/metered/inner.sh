#!/bin/sh
# Inside the container (run.sh): a system bus and NetworkManager, then a
# session bus with the test keyring, then the check.
set -e
mkdir -p /run/dbus /etc/NetworkManager/conf.d
# Ubuntu's NetworkManager manages only Wi-Fi and WWAN by default; manage the dummy too.
printf '[keyfile]\nunmanaged-devices=none\n' > /etc/NetworkManager/conf.d/99-qa.conf
: > /etc/NetworkManager/conf.d/10-globally-managed-devices.conf
dbus-daemon --system --fork
NetworkManager --no-daemon >/tmp/nm.log 2>&1 &
i=0
until nmcli -t -f RUNNING general 2>/dev/null | grep -q running || [ $i -ge 300 ]; do i=$((i + 1)); sleep 0.2; done
nmcli connection add type dummy ifname dummy0 con-name qa ipv4.method manual \
  ipv4.addresses 10.99.0.2/24 ipv4.gateway 10.99.0.1 ipv6.method disabled >/dev/null
nmcli --wait 30 connection up qa >/dev/null
exec dbus-run-session -- sh -c '
  eval "$(gnome-keyring-daemon --start --components=secrets)"; export GNOME_KEYRING_CONTROL
  printf test | gnome-keyring-daemon --replace --unlock --components=secrets >/dev/null
  w=0
  until { dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner string:org.freedesktop.secrets | grep -q "boolean true" &&
          dbus-send --session --print-reply --dest=org.freedesktop.secrets /org/freedesktop/secrets org.freedesktop.Secret.Service.ReadAlias string:default | grep -q collection/login; } || [ $w -ge 150 ]; do
    w=$((w + 1)); sleep 0.2
  done
  node /qa/metered.mjs'
