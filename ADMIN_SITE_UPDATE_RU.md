# Обновление панели администратора IT Park Meeting Rooms

Сайт: администратор может смотреть брони выбранного дня, выбирать сотрудника из зарегистрированных профилей, создавать для него бронь и отменять конкретную бронь. Комната освобождается сразу после отмены. В базе остаются ID администратора, который создал или отменил бронь. Кнопка входа расположена в разделе «Профиль» и видна только назначенным администраторам. Текст с указанием авторства логотипа убран из нижней части страницы; атрибуция доступна по клику на логотип в шапке сайта.

## Почему `/admin` сообщает об отсутствии ADMIN_PASSCODE

В Cloudflare Worker пока не задан секрет `ADMIN_PASSCODE`. Пароль нельзя записывать в `src/bot.js`, GitHub или `wrangler.toml`: это откроет его всем, у кого есть доступ к коду. В PowerShell из папки проекта выполните:

```powershell
npx.cmd wrangler secret put ADMIN_PASSCODE
```

Wrangler предложит ввести значение секрета. Введите выбранный вами пароль администратора. Не сохраняйте значение в документации или GitHub. Команда сохраняет его в Cloudflare. Не вводите токен Telegram. Убедитесь, что в вашем `wrangler.toml` в `ADMIN_IDS` указан ваш числовой Telegram ID (у вас ранее был `1314420035`). Пароль сам по себе не даёт права администрировать: доступ есть только у ID из списка. Если ID не указан, исправьте `ADMIN_IDS` и снова выполните `npm.cmd run deploy`.

## Применить обновление

Скачайте `IT_Park_Meeting_Rooms_Admin_Update.zip` в «Загрузки». Затем выполните в PowerShell:

```powershell
cd "C:\Users\user\Desktop\itpark-room-bot"
Expand-Archive -LiteralPath "$env:USERPROFILE\Downloads\IT_Park_Meeting_Rooms_Admin_Update.zip" -DestinationPath "." -Force
npm.cmd test
npm.cmd run db:remote
npx.cmd wrangler secret put ADMIN_PASSCODE
git add src/bot.js src/web.js src/worker.js src/site.js src/logo.js migrations/0003_site_signup.sql migrations/0004_site_links.sql migrations/0005_site_admin.sql tests/bot.test.js tests/web.test.js README.md UPDATE_LOGIN_RU.md ADMIN_SITE_UPDATE_RU.md
git commit -m "Add secure website admin dashboard"
git push
npm.cmd run deploy
```

Перед развертыванием должна примениться `0005_site_admin.sql`; если предыдущие обновления ещё не были установлены, Wrangler сначала применит `0003_site_signup.sql` и `0004_site_links.sql`. Таблица броней и данные сотрудников сохраняются. Архив не содержит ваш `wrangler.toml`, токен бота или секреты. Команда `telegram:setup` не нужна.

Откройте сайт, войдите через ссылку из бота, перейдите в «Профиль» → «Войти как администратор», введите пароль. Выберите дату, сотрудника, комнату и время. В списке броней выбранного дня есть кнопка «Отменить бронь» с подтверждением. Панель действует один час; по кнопке «Закрыть панель» админ-доступ завершается. Брони от имени другого сотрудника появятся у него в разделе «Мои брони», но отдельное уведомление в Telegram не отправляется.

В боте после настройки секрета отправьте `/admin` и введите тот же пароль. Если bot всё ещё сообщает «Не задан ADMIN_PASSCODE», проверьте, что команда `secret put` выполнена именно для Worker `itpark-room-bot` в нужной учетной записи Cloudflare.
