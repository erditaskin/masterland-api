#!/usr/bin/env bash
# Run only on the dedicated Masterland VPS. This does not modify SSH configuration or DNS.
set -euo pipefail
test "$(id -u)" = 0
test "$(hostname)" = ubuntu-s-1vcpu-512mb-10gb-sfo2
if ! swapon --show=NAME --noheadings | grep -q .; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq docker.io docker-compose-v2 nginx certbot python3-certbot-nginx
id masterland >/dev/null 2>&1 || useradd --system --uid 10001 --home-dir /opt/masterland --shell /usr/sbin/nologin masterland
install -d -m 755 /opt/masterland /opt/masterland/releases /opt/masterland/web
install -d -m 700 /opt/masterland/env /opt/masterland/backups
install -d -m 750 -o masterland -g masterland /opt/masterland/secrets
cat > /etc/docker/daemon.json <<'JSON'
{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"}}
JSON
systemctl enable --now docker nginx
# Allow SSH before enabling the firewall. Docker publishes the API only on loopback; PostgreSQL has no published port.
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
systemctl is-active docker nginx
free -m
df -h /
