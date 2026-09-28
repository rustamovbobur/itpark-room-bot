# Обновление IT Park Meeting Rooms

Исправлены переход «Расписание → Другая дата», название сайта и логотип. Сайт теперь позволяет создать профиль через Telegram ID, код доступа сотрудников и одноразовое подтверждение через Telegram.

## Обновить через PowerShell

Скачайте `IT_Park_Meeting_Rooms_Fix.zip`. Из существующего проекта выполните:

```powershell
cd "C:\Users\user\Desktop\itpark-room-bot"
Expand-Archive -LiteralPath "$env:USERPROFILE\Downloads\IT_Park_Meeting_Rooms_Fix.zip" -DestinationPath "." -Force
npm.cmd test
npm.cmd run db:remote
git add src/bot.js src/web.js src/worker.js src/site.js src/logo.js migrations/0003_site_signup.sql tests/bot.test.js tests/web.test.js README.md UPDATE_LOGIN_RU.md
git commit -m "Fix schedule and simplify website registration"
git push
npm.cmd run deploy
```

Если архив скачан в другую папку, поправьте только путь к ZIP. `db:remote` должен применить `0003_site_signup.sql` **до** публикации Worker. Миграция добавляет таблицы для новых кодов, не удаляет пользователей или брони. Архив не содержит `wrangler.toml`, `.dev.vars` или токен: ваши настройки и секреты останутся на месте. Не запускайте `telegram:setup` повторно.

## Как войти

1. Нажмите Start в боте https://t.me/Meeting_room_IT_Park_bot и отправьте `/id`. Скопируйте числовой Telegram ID из ответа.
2. На сайте https://itpark-room-bot.itpark.workers.dev/ выберите «Первый вход»; укажите ID, имя, отдел и **код доступа сотрудников**, который предоставил ответственный за комнаты. Это постоянный код доступа, а не код администратора и не токен бота.
3. Нажмите «Получить код в Telegram». Бот отправит новый **одноразовый код входа**: вставьте его в появившееся поле на сайте. Он действует 10 минут.
4. В следующий раз выбирайте «У меня есть профиль»: только ID → сообщение с новым одноразовым кодом → вход. На этом устройстве вход сохраняется до 30 дней. Старый способ `/web` для зарегистрированных в боте сотрудников также работает.

Если бот не присылает код, откройте именно бота, нажмите Start и отправьте `/id`, затем повторите запрос. Один Telegram ID не подтверждает владение аккаунтом; именно получение сообщения через бота защищает профиль. Если сайт пишет «Профиль не найден», выберите «Первый вход».

## Логотип Telegram

Сайт обновит логотип после публикации. Для аватара бота самостоятельно откройте BotFather → `/setuserpic` → выберите бота → загрузите приложенный `IT_PARK_Official_Logo.png`. Если нужен именно другой вариант фирменного логотипа IT Park, предоставьте официальный файл бренда.

Источник логотипа: [IT PARK UZBEKISTAN logo, ItparkUz, CC BY 4.0](https://commons.wikimedia.org/wiki/File:IT_PARK_UZBEKISTAN_logo.png).
