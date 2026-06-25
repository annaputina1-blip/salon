# SSL for massag-yablonovskiy.ru

The domain currently points to:

```text
massag-yablonovskiy.ru      31.31.197.38
www.massag-yablonovskiy.ru  31.31.197.38
```

Run these commands on the VPS that has IP `31.31.197.38`.

The SSL certificate must be created on the VPS. Do not generate or commit
`privkey.pem` manually in the project folder.

If you deploy this site on `myserver`, the server public IP is `5.35.124.76`.
Both DNS records must point to that IP before Let's Encrypt can issue HTTPS:

```text
massag-yablonovskiy.ru      A  5.35.124.76
www.massag-yablonovskiy.ru  A  5.35.124.76
```

At the moment of setup on June 17, 2026, both records pointed to `31.31.197.38`,
so certificate issuance from `myserver` could not pass domain validation.

## 1. Make sure the Node app is local only

Create or update `.env` in the deploy folder:

```text
HOST=127.0.0.1
PORT=4173
```

Restart the app:

```bash
pm2 restart laser-body-studio
```

## 2. Automatic setup

From the project deploy folder on the VPS, run:

```bash
sudo bash deploy/setup-ssl.sh
```

The script:

- installs Nginx and Certbot if needed;
- writes a safe Nginx proxy config for the Node app;
- backs up an existing domain config before replacing it;
- runs `nginx -t` before reloading;
- asks Let's Encrypt for a trusted certificate;
- enables HTTP to HTTPS redirect;
- checks automatic renewal.

## 3. Manual setup

Install Nginx and Certbot

Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
```

Add the initial Nginx config

Copy `deploy/nginx/massag-yablonovskiy.ru.conf` to:

```text
/etc/nginx/sites-available/massag-yablonovskiy.ru
```

Enable it:

```bash
sudo ln -s /etc/nginx/sites-available/massag-yablonovskiy.ru /etc/nginx/sites-enabled/massag-yablonovskiy.ru
sudo nginx -t
sudo systemctl reload nginx
```

Create the trusted SSL certificate

```bash
sudo certbot --nginx \
  -d massag-yablonovskiy.ru \
  -d www.massag-yablonovskiy.ru
```

When Certbot asks whether to redirect HTTP to HTTPS, choose the redirect option.

Certbot creates the private key and certificate here:

```text
/etc/letsencrypt/live/massag-yablonovskiy.ru/privkey.pem
/etc/letsencrypt/live/massag-yablonovskiy.ru/fullchain.pem
```

Do not commit these files to GitHub.

## 4. Check renewal

```bash
sudo certbot renew --dry-run
```

After this, the site should open at:

```text
https://massag-yablonovskiy.ru
https://www.massag-yablonovskiy.ru
```
