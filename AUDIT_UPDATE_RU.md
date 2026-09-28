# Установить исправления после проверки

Скачайте `IT_Park_Meeting_Rooms_Audit_Update.zip` в «Загрузки». В PowerShell:

```powershell
cd "C:\Users\user\Desktop\itpark-room-bot"
Expand-Archive -LiteralPath "$env:USERPROFILE\Downloads\IT_Park_Meeting_Rooms_Audit_Update.zip" -DestinationPath "." -Force
npm.cmd test
npm.cmd run db:remote
git add src tests migrations scripts/upload-secrets.js README.md ADMIN_SITE_UPDATE_RU.md AUDIT_REPORT_RU.md AUDIT_UPDATE_RU.md TEST_REPORT.md
git commit -m "Fix audit findings and align IT Park colors"
git push
npm.cmd run deploy
```

Если какая-либо команда завершилась ошибкой, остановитесь перед deploy и посмотрите её вывод. Для этой проверки новых миграций нет: `db:remote` проверит, что предыдущие миграции применены. Архив содержит предыдущие миграции 0002–0005 для проектов, где они ещё не установлены; при их добавлении включите папку migrations в git commit. Пользовательские настройки и секреты в архив не включены.

После публикации откройте сайт и нажмите Ctrl+F5. Логотип должен открывать главную страницу, основной зелёный станет фирменным. Действующие профили и брони сохраняются.

Старый пароль администратора был указан в прежней инструкции. Если она уже попала в GitHub, установите новый секрет (значение вводится только в запросе Wrangler):

```powershell
npx.cmd wrangler secret put ADMIN_PASSCODE
```

Новый пароль будет общим для админ-панели сайта и команды `/admin`. Не записывайте его в README и GitHub. В случае локальной разработки можно обновить ADMIN_PASSCODE в игнорируемом файле `.dev.vars`.

Полный список находок и ограничений проверки: `AUDIT_REPORT_RU.md`.
