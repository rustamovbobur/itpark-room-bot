// Run locally. Secrets are read from .dev.vars and are never printed.
const {BOT_TOKEN,WEBHOOK_SECRET,WORKER_URL}=process.env;
if(!/^\d+:[A-Za-z0-9_-]+$/.test(BOT_TOKEN||'')) throw new Error('Укажите BOT_TOKEN в .dev.vars');
if(!/^[A-Za-z0-9_-]{24,256}$/.test(WEBHOOK_SECRET||'')) throw new Error('WEBHOOK_SECRET: 24–256 символов A-Z, a-z, 0-9, _ или -');
const url=new URL(WORKER_URL||'https://invalid.invalid');
if(url.protocol!=='https:'||url.hostname==='invalid.invalid'||url.pathname!=='/'||url.search||url.hash||url.username||url.password) throw new Error('WORKER_URL должен иметь вид https://имя.workers.dev');
async function api(method,body={}) {
 let response;
 try {response=await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});}catch {throw new Error('Не удалось подключиться к Telegram. Проверьте интернет.');}
 const data=await response.json();if(!data.ok) throw new Error(`Telegram отклонил ${method}: код ${data.error_code}. Проверьте настройки.`);return data.result;
}
const health=await fetch(new URL('/health',url),{signal:AbortSignal.timeout(20000)});
if(!health.ok) throw new Error('Сначала разверните Worker и примените миграции базы. /health должен отвечать {"ok":true}.');
const me=await api('getMe');
await api('setMyCommands',{commands:[
 {command:'start',description:'Главное меню'},
 {command:'book',description:'Забронировать переговорную'},
 {command:'schedule',description:'Расписание переговорных'},
 {command:'my',description:'Мои брони и отмена'},
 {command:'profile',description:'Изменить имя и отдел'},
 {command:'help',description:'Как пользоваться'},
 {command:'id',description:'Мой Telegram ID'},
 {command:'cancel',description:'Выйти из текущего шага'}
]});
await api('setMyDescription',{description:'Бронирование переговорных IT Park: 5-й, 6-й и 9-й этажи. Выбор времени с шагом 30 минут, общее расписание и отмена своих броней. Время — Ташкент. Доступ по коду сотрудников.'});
await api('setWebhook',{url:new URL('/webhook',url).href,secret_token:WEBHOOK_SECRET,max_connections:1,allowed_updates:['message','callback_query'],drop_pending_updates:false});
const info=await api('getWebhookInfo');
console.log(`Бот настроен: https://t.me/${me.username}`);
console.log(`Ожидающих обновлений: ${info.pending_update_count}. Откройте бота и отправьте /start.`);
