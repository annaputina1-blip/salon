#!/usr/bin/env bash
set -euo pipefail

DOMAIN="massag-yablonovskiy.ru"
WWW_DOMAIN="www.massag-yablonovskiy.ru"
APP_PORT="${APP_PORT:-4173}"
APP_NAME="${APP_NAME:-laser-body-studio}"
EXPECTED_IP="${EXPECTED_IP:-}"
NGINX_AVAILABLE="/etc/nginx/sites-available/${DOMAIN}"
NGINX_ENABLED="/etc/nginx/sites-enabled/${DOMAIN}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script with sudo:"
  echo "sudo bash deploy/setup-ssl.sh"
  exit 1
fi

if ! command -v nginx >/dev/null 2>&1; then
  apt update
  apt install -y nginx
fi

if ! command -v certbot >/dev/null 2>&1; then
  apt update
  apt install -y certbot python3-certbot-nginx
fi

if command -v curl >/dev/null 2>&1; then
  SERVER_IP="$(curl -4 -sS https://ifconfig.me || true)"
else
  SERVER_IP=""
fi

EXPECTED_IP="${EXPECTED_IP:-$SERVER_IP}"
if [ -n "${EXPECTED_IP}" ]; then
  DOMAIN_IPS="$(getent ahostsv4 "${DOMAIN}" | awk '{print $1}' | sort -u | tr '\n' ' ')"
  WWW_DOMAIN_IPS="$(getent ahostsv4 "${WWW_DOMAIN}" | awk '{print $1}' | sort -u | tr '\n' ' ')"

  if ! printf '%s' "${DOMAIN_IPS}" | grep -qw "${EXPECTED_IP}" || ! printf '%s' "${WWW_DOMAIN_IPS}" | grep -qw "${EXPECTED_IP}"; then
    echo "DNS is not ready for Let's Encrypt."
    echo "${DOMAIN} resolves to: ${DOMAIN_IPS:-none}"
    echo "${WWW_DOMAIN} resolves to: ${WWW_DOMAIN_IPS:-none}"
    echo "Expected server IP: ${EXPECTED_IP}"
    echo "Update both A records first, then run this script again."
    exit 1
  fi
fi

if command -v pm2 >/dev/null 2>&1; then
  pm2 restart "${APP_NAME}" || true
fi

if [ -f "${NGINX_AVAILABLE}" ]; then
  cp "${NGINX_AVAILABLE}" "${NGINX_AVAILABLE}.bak.$(date +%Y%m%d%H%M%S)"
fi

cat > "${NGINX_AVAILABLE}" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} ${WWW_DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX

mkdir -p /var/www/certbot
ln -sfn "${NGINX_AVAILABLE}" "${NGINX_ENABLED}"
nginx -t
systemctl reload nginx

certbot certonly --webroot \
  -w /var/www/certbot \
  -d "${DOMAIN}" \
  -d "${WWW_DOMAIN}" \
  --non-interactive \
  --agree-tos \
  --register-unsafely-without-email

cat > "${NGINX_AVAILABLE}" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} ${WWW_DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${DOMAIN} ${WWW_DOMAIN};

    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
NGINX

nginx -t
systemctl reload nginx
certbot renew --dry-run

echo "Done. Check https://${DOMAIN}"
