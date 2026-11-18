# G-81 two-NAT e2e: a home router. Alpine with iptables; nat.sh does the rest.
FROM alpine:3.20
RUN apk add --no-cache iptables iproute2
COPY nat.sh /nat.sh
ENTRYPOINT ["sh", "/nat.sh"]
