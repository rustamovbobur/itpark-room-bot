import {spawnSync} from 'node:child_process';
const keys=['BOT_TOKEN','WEBHOOK_SECRET','STAFF_ACCESS_CODE'];
const secrets=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
for(const key of keys) if(!secrets[key]||/PASTE_|REPLACE_/.test(secrets[key])) throw new Error('Заполните '+key+' в .dev.vars');
if(!/^\d+:[A-Za-z0-9_-]+$/.test(secrets.BOT_TOKEN)) throw new Error('Неверный формат BOT_TOKEN');
if(!/^[A-Za-z0-9_-]{24,256}$/.test(secrets.WEBHOOK_SECRET)) throw new Error('WEBHOOK_SECRET должен содержать 24–256 символов A-Z, a-z, 0-9, _ или -');
if(secrets.STAFF_ACCESS_CODE.length<8) throw new Error('Выберите код сотрудников длиной хотя бы 8 символов');
// The command is constant. Secret values travel only through stdin, not arguments.
const result=spawnSync(process.platform==='win32'?'npx.cmd':'npx',['wrangler','secret','bulk'],{
 input:JSON.stringify(secrets),encoding:'utf8',shell:process.platform==='win32',stdio:['pipe','inherit','inherit']
});
if(result.error) throw new Error('Не удалось запустить Wrangler. Сначала выполните npm ci.');
process.exit(result.status??1);
