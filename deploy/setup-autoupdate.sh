#!/bin/bash
# Один раз: превращает /opt/fitnes в копию репозитория GitHub и включает автообновление.
# Пароли из deploy/.env не трогает и не показывает.
set -euo pipefail
REPO=git@github.com:AndreyBespalyy/Fitnes.git
KEY=/root/.ssh/fitnes_deploy
mkdir -p /root/.ssh && chmod 700 /root/.ssh
[ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N "" -C "fitnes-server-deploy" -f "$KEY"
grep -q "fitnes_deploy" /root/.ssh/config 2>/dev/null || cat >> /root/.ssh/config <<EOT
Host github.com
  IdentityFile $KEY
  IdentitiesOnly yes
EOT
chmod 600 /root/.ssh/config
ssh-keyscan -t ed25519 github.com 2>/dev/null >> /root/.ssh/known_hosts
command -v git >/dev/null || (apt-get update -qq && apt-get install -y -qq git)
cd /opt/fitnes
[ -d .git ] || (git init -q -b main && git remote add origin "$REPO")
# Первую версию забираем сразу, чтобы скрипт автообновления оказался на месте (если ключ уже добавлен в GitHub)
if git fetch -q origin main 2>/dev/null; then git reset -q --hard origin/main; else echo "GitHub пока не пускает: добавьте ключ ниже, таймер заберёт версию сам"; fi
cat > /etc/systemd/system/fitnes-update.service <<EOT
[Unit]
Description=Fitnes: обновление с GitHub
[Service]
Type=oneshot
ExecStart=/bin/bash -c 'cd /opt/fitnes && if [ -f deploy/autoupdate.sh ]; then exec bash deploy/autoupdate.sh; fi; git fetch -q origin main && git reset -q --hard origin/main && cd deploy && docker compose up -d --build'
StandardOutput=append:/var/log/fitnes-update.log
StandardError=append:/var/log/fitnes-update.log
EOT
cat > /etc/systemd/system/fitnes-update.timer <<EOT
[Unit]
Description=Fitnes: проверка обновлений каждые 5 минут
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
EOT
systemctl daemon-reload
systemctl enable --now fitnes-update.timer >/dev/null
echo
echo "Готово. Автообновление включено (каждые 5 минут, журнал /var/log/fitnes-update.log)."
echo "Добавьте этот ОТКРЫТЫЙ ключ в GitHub: Settings -> Deploy keys -> Add deploy key, галочку записи НЕ ставить:"
echo
cat "$KEY.pub"
