# G-81 two-NAT e2e: the same app image as desktop/Dockerfile.e2e, plus
# iproute2, so each app can route through its home router (client.sh).
FROM mcr.microsoft.com/playwright:v1.56.1-noble
RUN apt-get update && apt-get install -y --no-install-recommends dbus dbus-x11 gnome-keyring iproute2 && rm -rf /var/lib/apt/lists/*
