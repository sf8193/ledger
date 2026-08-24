#!/bin/bash
# Run this on a fresh Ubuntu 24.04 EC2 instance to bootstrap ledger.
# Prerequisites: EC2 with ports 22, 80, 443 open. Elastic IP attached.
#
# Usage: ssh ubuntu@<ip> 'bash -s' < deploy/setup.sh
#
# After running, set up:
# 1. Edit /home/ubuntu/app/.env with real secrets
# 2. Point your API domain's DNS A record to this instance's Elastic IP
# 3. docker compose -f docker-compose.prod.yml up -d

set -e

echo "=== Installing dependencies ==="
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2 git curl postgresql-client

sudo systemctl start docker
sudo systemctl enable docker
sudo usermod -aG docker ubuntu

echo "=== Installing Caddy ==="
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install -y caddy

echo "=== Cloning repo ==="
cd /home/ubuntu
# Replace with your repo URL
git clone git@github.com:your-username/ledger.git app
cd app

echo "=== Creating .env ==="
DB_PASSWORD=$(openssl rand -hex 16)
AUTH_SECRET=$(openssl rand -hex 32)
cat > .env <<EOF
NODE_ENV=production
PORT=4000
DATABASE_URL=postgresql://postgres:$DB_PASSWORD@db:5432/ledger?sslmode=disable
DB_PASSWORD=$DB_PASSWORD
BETTER_AUTH_SECRET=$AUTH_SECRET
BASE_URL=https://api.example.com
FRONTEND_URL=https://example.com
PLAID_CLIENT_ID=
PLAID_SECRET=
PLAID_ENV=sandbox
PLAID_WEBHOOK_URL=https://api.example.com/api/webhook/plaid
GITHUB_TOKEN=
EOF
chmod 600 .env

echo ""
echo ">>> Set GITHUB_TOKEN in .env (GitHub PAT with packages:read) for CI deploys."

echo "=== Setting up Caddy ==="
sudo cp Caddyfile /etc/caddy/Caddyfile
sudo systemctl enable caddy
sudo systemctl restart caddy

echo "=== Starting containers ==="
# Need to log out and back in for docker group, or use sudo
sudo docker compose -f docker-compose.prod.yml up -d

echo "=== Setting up daily backups ==="
sudo mkdir -p /home/ubuntu/backups
sudo chown ubuntu:ubuntu /home/ubuntu/backups
cat > /home/ubuntu/backup.sh <<'BACKUP'
#!/bin/bash
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
docker exec ledger_db pg_dump -U postgres ledger | gzip > /home/ubuntu/backups/ledger_$TIMESTAMP.sql.gz
# Keep last 14 days
find /home/ubuntu/backups -name "*.sql.gz" -mtime +14 -delete
BACKUP
chmod +x /home/ubuntu/backup.sh
(crontab -l 2>/dev/null; echo "0 3 * * * /home/ubuntu/backup.sh") | crontab -

echo ""
echo "=== Done ==="
echo "Edit .env with your Plaid keys, then restart:"
echo "  docker compose -f docker-compose.prod.yml restart api"
echo ""
echo "Point api.example.com to this instance's IP."
