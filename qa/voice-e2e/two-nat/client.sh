#!/bin/sh
# G-81 two-NAT e2e: an app behind its home router. The default route goes
# through the router (ROUTER_IP), so the shell gathers candidates on this one
# interface (WEBRTC_IP_POLICY) and everything leaves through the NAT. Then
# the same call as compose.yaml's apps (call.mjs, unchanged).
set -eu
: "${ROUTER_IP:?}"
ip route replace default via "$ROUTER_IP"
chown pwuser /rendezvous
exec runuser -u pwuser -- dbus-run-session -- sh -c 'echo -n test | gnome-keyring-daemon --unlock --components=secrets >/dev/null && xvfb-run -a node /repo/qa/voice-e2e/call.mjs'
