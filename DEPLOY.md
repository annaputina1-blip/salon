# Deployment

The project is already connected to GitHub through `origin`.

Repository:

```text
https://github.com/annaputina1-blip/salon.git
```

## Automatic deploy to a VPS

The workflow in `.github/workflows/deploy.yml` deploys every push to `main`.

Add these repository secrets in GitHub:

```text
SSH_HOST     server IP or domain
SSH_USER     SSH user
SSH_KEY      private SSH key for deploy
DEPLOY_PATH  folder on the server, for example /var/www/salon
```

Optional secrets:

```text
SSH_PORT  SSH port, default 22
APP_NAME  pm2 app name, default laser-body-studio
```

Create `.env` directly on the server in `DEPLOY_PATH`. Do not commit `.env` to GitHub.

Required server environment:

```text
Node.js 20+
npm
pm2 recommended
```

Start command:

```bash
npm start
```
