#!/bin/sh
# G-81 two-NAT e2e: one home router between a private network (LAN_SUBNET)
# and the shared "internet" (WAN_SUBNET). Everything from the LAN leaves with
# the router's WAN address (MASQUERADE: a port-restricted cone NAT, as most
# home routers). Prints nothing about addresses.
#
#   BLOCK_PEER_UDP=1  drop UDP from this LAN to anything on the WAN except the
#                     STUN server (STUN_IP): STUN still answers, but no media
#                     path between the two homes exists (N-STUN-2).
set -eu
: "${LAN_SUBNET:?}" "${WAN_SUBNET:?}" "${ALL_SUBNETS:?}" "${STUN_IP:?}"

iface_for() { ip -o -4 route show "$1" | awk '{print $3; exit}'; }
wan=$(iface_for "$WAN_SUBNET")
lan=$(iface_for "$LAN_SUBNET")
[ -n "$wan" ] && [ -n "$lan" ] || { echo "nat: interfaces not found"; exit 1; }

# Only LAN -> WAN (and its replies) is forwarded. Never to another home's
# LAN directly: the only way between homes is through the two NATs.
iptables -P FORWARD DROP
iptables -A FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
if [ "${BLOCK_PEER_UDP:-}" = 1 ]; then
  iptables -A FORWARD -i "$lan" -o "$wan" -p udp ! -d "$STUN_IP" -j DROP
fi
iptables -A FORWARD -i "$lan" -o "$wan" -d "$WAN_SUBNET" -j ACCEPT
iptables -t nat -A POSTROUTING -o "$wan" -s "$LAN_SUBNET" -j MASQUERADE
# Belt and braces: nothing for the other homes' subnets, whatever the routes say.
for s in $ALL_SUBNETS; do [ "$s" = "$LAN_SUBNET" ] || [ "$s" = "$WAN_SUBNET" ] || iptables -A FORWARD -d "$s" -j DROP; done

echo "nat ready${BLOCK_PEER_UDP:+ (peer UDP blocked)}"
exec sleep infinity
