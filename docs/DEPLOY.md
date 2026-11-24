# Публикация

Приложение — статический сайт (PWA): после `npm run build` достаточно раздать папку `dist/` по HTTPS. HTTPS обязателен: браузеры дают доступ к микрофону только на защищённых страницах.

## Опубликованная версия

- Приложение: https://salsa-radar.89.124.65.229.nip.io
- Руководство: https://salsa-radar.89.124.65.229.nip.io/guide

## Деплой на VDS

```bash
VDS_HOST=<host> VDS_USER=<user> VDS_KEY=<path-to-ssh-key> \
VDS_PATH=/var/www/salsa-radar scripts/deploy.sh
```

Скрипт:
1. собирает приложение (`npm run build`) и автономное руководство (`npm run guide`);
2. кладёт руководство в сборку как `guide.html`;
3. копирует `dist/` в `VDS_PATH` через rsync по SSH. Существующие файлы перезаписываются, лишние не удаляются, ничего вне `VDS_PATH` не трогается.

Перезапускать веб-сервер при обновлении не нужно. Ассеты имеют хэш в имени, а `index.html`, `sw.js` и `guide.html` отдаются с `Cache-Control: no-cache`, поэтому браузеры сразу получают новую версию.

Данные доступа к серверу (адрес, пользователь, ключ) в репозиторий не кладутся.

## Конфигурация Caddy

Один блок сайта; сертификат Let's Encrypt Caddy выпускает автоматически.

```caddyfile
salsa-radar.example.org {
    root * /var/www/salsa-radar
    encode gzip
    redir /guide /guide.html
    header /manifest.webmanifest Content-Type "application/manifest+json"
    @nocache path / /index.html /sw.js /guide.html
    header @nocache Cache-Control "no-cache"
    header /assets/* Cache-Control "public, max-age=31536000, immutable"
    file_server
}
```

Порядок изменения конфигурации на работающем сервере:
1. сделать резервную копию Caddyfile;
2. собрать новый конфиг во временном файле и проверить его: `caddy validate --config <file> --adapter caddyfile`;
3. только после успешной проверки заменить Caddyfile и выполнить `systemctl reload caddy` — без остановки других сайтов.

## Проверка после деплоя

```bash
curl -sI https://<host>/ | head -1           # 200
curl -sI https://<host>/guide | grep -i location   # /guide.html
```

В браузере: Demo → «Старт», через ~10 с в Диагностике трекер должен быть «захвачен», а ошибка фазы против эталона — несколько миллисекунд.
