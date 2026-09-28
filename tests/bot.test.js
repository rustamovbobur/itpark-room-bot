import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {processUpdate} from '../src/bot.js';
import {localNow,config,validRange,validDay} from '../src/time.js';
import worker from '../src/worker.js';

// SQLite adapter with transaction semantics matching D1.batch. The app's actual
// SQL and triggers run unchanged, rather than replacing booking logic with mocks.
class DB {
  constructor(){this.sql=new DatabaseSync(':memory:');this.sql.exec('PRAGMA foreign_keys=ON');for(const name of ['0001_initial.sql','0002_web.sql','0003_site_signup.sql','0004_site_links.sql','0005_site_admin.sql'])this.sql.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));}
  prepare(sql){const db=this; return {args:[],bind(...args){this.args=args;return this;},async first(){return db.sql.prepare(sql).get(...this.args)||null;},async all(){return {results:db.sql.prepare(sql).all(...this.args)};},async run(){return db.sql.prepare(sql).run(...this.args);}, execute(){return db.sql.prepare(sql).run(...this.args);}};}
  async batch(statements){this.sql.exec('BEGIN IMMEDIATE');try{const result=statements.map(s=>s.execute());this.sql.exec('COMMIT');return result;}catch(e){this.sql.exec('ROLLBACK');throw e;}}
}
const NOW=new Date('2026-09-28T04:00:00Z'); // 09:00 Tashkent
const DAY='2026-09-29';
function setup(){return {DB:new DB(),STAFF_ACCESS_CODE:'test-code',ADMIN_IDS:'999',ADMIN_PASSCODE:'test-admin-code'};}
let seq=100;
const update=(id,text)=>({update_id:++seq,message:{text,from:{id},chat:{id,type:'private'}}});
const callback=(id,data)=>({update_id:++seq,callback_query:{id:String(seq),data,from:{id},message:{chat:{id,type:'private'}}}});
async function send(env,id,text){return processUpdate(env,update(id,text),NOW);}
async function click(env,id,action,value=''){const u=await env.DB.prepare('SELECT state FROM users WHERE id=?').bind(id).first();return processUpdate(env,callback(id,`b:${JSON.parse(u.state).nonce}:${action}:${value}`),NOW);}
async function register(env,id){await send(env,id,'test-code');await send(env,id,`Сотрудник ${id}`);await send(env,id,'Отдел аналитики');}
async function prepare(env,id,{room=5,day=DAY,start=600,end=660}={}){await send(env,id,'/book');await click(env,id,'room',room);await click(env,id,'day',day);await click(env,id,'start',start);await click(env,id,'duration',end);return click(env,id,'skip');}
async function book(env,id,opts){await prepare(env,id,opts);return click(env,id,'confirm');}
const rows=(env,sql)=>env.DB.sql.prepare(sql).all();

test('Russian onboarding, optional comment, booking and profile snapshot',async()=>{
 const env=setup(); await register(env,1); const response=await book(env,1);
 assert.match(response.text,/забронирована/);const b=rows(env,'SELECT * FROM bookings')[0];
 assert.equal(b.name,'Сотрудник 1');assert.equal(b.department,'Отдел аналитики');assert.equal(b.comment,'');
 assert.equal(rows(env,'SELECT * FROM booking_slots').length,2);
 await send(env,1,'/profile');await click(env,1,'edit_name');await send(env,1,'Новое Имя');await click(env,1,'edit_department');await send(env,1,'Другой отдел');assert.equal(rows(env,'SELECT name FROM bookings')[0].name,'Сотрудник 1');
});
test('schedule keeps its mode when selecting another day',async()=>{
 const env=setup();await register(env,1);
 await send(env,1,'/schedule');await click(env,1,'room',5);
 assert.match((await click(env,1,'day',DAY)).text,/Свободно:/);
 await click(env,1,'dates');
 const next=await click(env,1,'day','2026-09-30');
 assert.match(next.text,/Свободно:/);
 assert.doesNotMatch(next.text,/Выберите начало/);
});
test('new user gets a website link without registering inside the bot',async()=>{
 const env=setup(),response=await send(env,101,'/start site');
 assert.match(response.text,/регистрироваться не нужно/);
 assert.match(response.reply_markup.inline_keyboard[0][0].url,/#login=[a-f0-9]{64}$/);
 assert.equal(rows(env,'SELECT authorized FROM users WHERE id=101')[0].authorized,0);
 assert.equal(rows(env,'SELECT count(*) AS n FROM web_links')[0].n,1);
});
test('25 concurrent users: exactly one success, no orphan booking or partial slots',async()=>{
 const env=setup();for(let id=1;id<=25;id++){await register(env,id);await prepare(env,id);}
 const results=await Promise.all(Array.from({length:25},(_,i)=>click(env,i+1,'confirm')));
 assert.equal(results.filter(x=>x.text.includes('забронирована!')).length,1);
 assert.equal(results.filter(x=>x.text.includes('другой сотрудник')).length,24);
 assert.equal(rows(env,'SELECT * FROM bookings').length,1);assert.equal(rows(env,'SELECT * FROM booking_slots').length,2);
});
test('partial overlap rolls back entire booking; adjacent and different room succeed',async()=>{
 const env=setup();await register(env,1);await register(env,2);
 await prepare(env,1,{start:570,end:630});await book(env,2,{start:600,end:660});
 assert.match((await click(env,1,'confirm')).text,/другой сотрудник/);
 assert.equal(rows(env,'SELECT * FROM booking_slots WHERE minute=570').length,0);
 await book(env,1,{start:660,end:690});await book(env,2,{room:6,start:600,end:660});
 assert.equal(rows(env,'SELECT * FROM bookings').length,3);
});
test('database trigger independently rejects conflicting inserts and rolls back slots',async()=>{
 const env=setup();await register(env,1);await book(env,1);
 assert.throws(()=>env.DB.sql.prepare(`INSERT INTO bookings(id,user_id,room_id,day,start_min,end_min,name,department,created_at) VALUES('bad',1,5,?,570,630,'A','B',1)`).run(DAY),/UNIQUE/);
 assert.equal(rows(env,"SELECT * FROM bookings WHERE id='bad'").length,0);
 assert.equal(rows(env,'SELECT * FROM booking_slots WHERE minute=570').length,0);
});
test('duplicate update and double-click confirmation create only one booking',async()=>{
 const env=setup();await register(env,1);await prepare(env,1);
 const u=rows(env,'SELECT state FROM users')[0],cb=`b:${JSON.parse(u.state).nonce}:confirm:`;
 const event=callback(1,cb);await Promise.all([processUpdate(env,event,NOW),processUpdate(env,event,NOW)]);
 await processUpdate(env,callback(1,cb),NOW);
 assert.equal(rows(env,'SELECT * FROM bookings').length,1);
 assert.equal(rows(env,`SELECT * FROM receipts WHERE update_id=${event.update_id}`).length,1);
});
test('receipt retry returns same success; marked delivered retry is ignored',async()=>{
 const env=setup();await register(env,1);await prepare(env,1);const state=JSON.parse(rows(env,'SELECT state FROM users')[0].state);
 const event=callback(1,`b:${state.nonce}:confirm:`),a=await processUpdate(env,event,NOW),b=await processUpdate(env,event,NOW);assert.deepEqual(a,b);
 env.DB.sql.prepare('UPDATE receipts SET delivered=1 WHERE update_id=?').run(event.update_id);
 assert.equal(await processUpdate(env,event,NOW),null);
});
test('owner cancellation releases all slots and can be rebooked',async()=>{
 const env=setup();await register(env,1);await register(env,2);await book(env,1);
 const id=rows(env,'SELECT id FROM bookings')[0].id;await send(env,1,'/my');await click(env,1,'cancel',id);
 assert.equal(rows(env,'SELECT * FROM booking_slots').length,2);await click(env,1,'cancel_yes');
 assert.equal(rows(env,'SELECT * FROM booking_slots').length,0);assert.match((await book(env,2)).text,/забронирована/);
 assert.equal(rows(env,"SELECT cancelled_by FROM bookings WHERE status='cancelled'")[0].cancelled_by,1);
});
test('other user cannot cancel; admin can cancel with audit identity',async()=>{
 const env=setup();await register(env,1);await register(env,2);await register(env,999);await book(env,1);
 const id=rows(env,'SELECT id FROM bookings')[0].id;await send(env,2,'/my');assert.match((await click(env,2,'cancel',id)).text,/нет права/);
 assert.equal(rows(env,'SELECT * FROM booking_slots').length,2);
 await send(env,999,'/admin');await send(env,999,'test-admin-code');await send(env,999,'/cancel_booking '+id);await click(env,999,'cancel_yes');assert.equal(rows(env,'SELECT * FROM booking_slots').length,0);
 assert.equal(rows(env,'SELECT cancelled_by FROM bookings')[0].cancelled_by,999);
});
test('forged duration, past time and stale callback cannot book',async()=>{
 const env=setup();await register(env,1);await send(env,1,'/book');const old=JSON.parse(rows(env,'SELECT state FROM users')[0].state).nonce;
 await click(env,1,'room',5);assert.match((await processUpdate(env,callback(1,`b:${old}:room:6`),NOW)).text,/устарела/);
 await click(env,1,'day',DAY);await click(env,1,'start',600);await click(env,1,'duration',631);
 assert.equal(rows(env,'SELECT * FROM bookings').length,0);
 const c=config({});const local=localNow(NOW);
 for(const [start,end] of [[600,631],[600,600],[480,780],[1170,1230],[NaN,660]]) assert.equal(validRange(DAY,start,end,local,c),false);
 assert.equal(validRange(local.day,540,570,local,c),false);assert.equal(validDay('2026-02-31',local,30),false);
});
test('timezone crosses UTC date correctly and horizon is exclusive',()=>{
 assert.deepEqual(localNow(new Date('2026-09-28T20:05:00Z')),{day:'2026-09-29',minute:65});
 assert.equal(validDay('2026-10-28',localNow(NOW),30),false);assert.equal(validDay('2026-10-27',localNow(NOW),30),true);
});
test('code gate throttles, group messages ignored, old update cannot replace state',async()=>{
 const env=setup();for(let i=0;i<5;i++) await send(env,1,'wrong');assert.match((await send(env,1,'test-code')).text,/много попыток/);
 assert.equal(rows(env,'SELECT authorized FROM users')[0].authorized,0);
 const group=update(2,'test-code');group.message.chat.type='group';assert.equal(await processUpdate(env,group,NOW),null);
 await register(env,3);const old=update(3,'/profile');await send(env,3,'/book');assert.equal(await processUpdate(env,old,NOW),null);
 assert.equal(JSON.parse(rows(env,'SELECT state FROM users WHERE id=3')[0].state).step,'room');
});
test('comment limits and schedule expose useful details as plain text',async()=>{
 const env=setup();await register(env,1);await send(env,1,'/book');await click(env,1,'room',5);await click(env,1,'day',DAY);await click(env,1,'start',600);await click(env,1,'duration',630);
 assert.match((await send(env,1,'я'.repeat(301))).text,/Сократите/);
 await send(env,1,'Встреча с <партнёрами>');await click(env,1,'confirm');
 await send(env,1,'/schedule');await click(env,1,'room',5);const response=await click(env,1,'day',DAY);
 assert.match(response.text,/Встреча с <партнёрами>/);assert.equal(response.parse_mode,undefined);assert.match(response.text,/Свободно/);
});
test('webhook requires secret and validates JSON; health checks schema',async()=>{
 const env=setup();env.WEBHOOK_SECRET='secret';env.BOT_TOKEN='test';
 assert.equal((await worker.fetch(new Request('https://test/webhook',{method:'POST',body:'{}'}),env)).status,403);
 assert.equal((await worker.fetch(new Request('https://test/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'secret'},body:'{' }),env)).status,400);
 assert.equal((await worker.fetch(new Request('https://test/health'),env)).status,200);
});

test('profile editing can be abandoned with /cancel without losing saved profile',async()=>{
 const env=setup();await register(env,1);await send(env,1,'/profile');const response=await send(env,1,'/cancel');
 assert.match(response.text,/Выберите действие/);assert.equal(rows(env,'SELECT name FROM users')[0].name,'Сотрудник 1');
});
test('Telegram random update ID after a week of inactivity is accepted',async()=>{
 const env=setup();await register(env,1);const event=update(1,'/book');event.update_id=1;
 const result=await processUpdate(env,event,new Date(NOW.getTime()+8*86400000));assert.match(result.text,/Выберите переговорную/);
});
test('Telegram send failure returns 503; replay delivers persisted response once',async()=>{
 const env=setup();env.BOT_TOKEN='test';env.WEBHOOK_SECRET='secret';await register(env,1);
 const event=update(1,'/menu'),originalFetch=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return Response.json(calls===1?{ok:false,error_code:429}:{ok:true,result:{message_id:1}});};
 const request=()=>new Request('https://test/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'secret'},body:JSON.stringify(event)});
 try{
  assert.equal((await worker.fetch(request(),env)).status,503);
  assert.equal((await worker.fetch(request(),env)).status,200);
  assert.equal((await worker.fetch(request(),env)).status,200);assert.equal(calls,2);
  assert.equal(rows(env,`SELECT delivered FROM receipts WHERE update_id=${event.update_id}`)[0].delivered,1);
 }finally{globalThis.fetch=originalFetch;}
});

test('profile opens read-only, persists across start, edits fields independently',async()=>{
 const env=setup();await register(env,1);
 for(let i=0;i<3;i++) {assert.match((await send(env,1,'/profile')).text,/Сотрудник 1/);await send(env,1,'/start');}
 await send(env,1,'/profile');await click(env,1,'edit_name');await send(env,1,'Бобур Рустамов');
 let u=rows(env,'SELECT * FROM users')[0];assert.equal(u.name,'Бобур Рустамов');assert.equal(u.department,'Отдел аналитики');
 await click(env,1,'edit_department');await send(env,1,'Инвестиции');u=rows(env,'SELECT * FROM users')[0];assert.equal(u.name,'Бобур Рустамов');assert.equal(u.department,'Инвестиции');
 await send(env,1,'/start');assert.equal(rows(env,'SELECT name FROM users')[0].name,'Бобур Рустамов');
});
test('admin requires allowlisted ID and passcode; ordinary user cannot forge admin callback',async()=>{
 const env=setup();await register(env,1);await register(env,999);await book(env,1);
 assert.match((await send(env,1,'/admin')).text,/только назначенным/);
 await send(env,1,'test-admin-code');assert.match((await click(env,1,'admin_active',0)).text,/Нет доступа/);
 await send(env,999,'/admin');assert.match((await send(env,999,'wrong')).text,/Неверный/);
 assert.match((await click(env,999,'admin_users',0)).text,/Нет доступа/);
 await send(env,999,'/admin');assert.match((await send(env,999,'test-admin-code')).text,/Панель администратора/);
 const response=await click(env,999,'admin_active',0);assert.match(response.text,/Telegram ID: 1/);
 await send(env,1,'/schedule');await click(env,1,'room',5);assert.doesNotMatch((await click(env,1,'day',DAY)).text,/Telegram ID/);
});
test('admin list, detail, cancel confirmation, history, users and create booking',async()=>{
 const env=setup();await register(env,1);await register(env,999);await book(env,1);
 await send(env,999,'/admin');await send(env,999,'test-admin-code');
 await click(env,999,'admin_active',0);const id=rows(env,'SELECT id FROM bookings')[0].id;
 assert.match((await click(env,999,'admin_view',id)).text,/Telegram ID: 1/);
 await click(env,999,'admin_cancel',id);assert.equal(rows(env,'SELECT * FROM booking_slots').length,2);
 await click(env,999,'cancel_yes');assert.equal(rows(env,'SELECT * FROM booking_slots').length,0);
 await send(env,999,'/admin');assert.match((await click(env,999,'admin_history',0)).text,/Отменил \(Telegram ID\): 999/);
 assert.match((await click(env,999,'admin_users',0)).text,/Telegram ID: 1/);
 await click(env,999,'admin_new');await click(env,999,'room',5);await click(env,999,'day',DAY);await click(env,999,'start',600);await click(env,999,'duration',630);await click(env,999,'skip');await click(env,999,'confirm');
 assert.equal(rows(env,"SELECT user_id FROM bookings WHERE status='active'")[0].user_id,999);
});
test('admin brute force limit survives /start and /admin; logout and expiry revoke privileges',async()=>{
 const env=setup();await register(env,999);
 for(let i=0;i<5;i++){await send(env,999,'/admin');await send(env,999,'wrong');await send(env,999,'/start');}
 await send(env,999,'/admin');assert.match((await send(env,999,'test-admin-code')).text,/много попыток/);
 const later=new Date(NOW.getTime()+16*60000);
 assert.match((await processUpdate(env,update(999,'test-admin-code'),later)).text,/Панель администратора/);
 const expired=new Date(later.getTime()+61*60000);
 assert.match((await processUpdate(env,update(999,'/admin'),expired)).text,/Введите код/);
 await processUpdate(env,update(999,'test-admin-code'),expired);
 const u=rows(env,'SELECT state FROM users')[0],state=JSON.parse(u.state);
 await processUpdate(env,callback(999,`b:${state.nonce}:admin_logout:`),expired);
 assert.match((await processUpdate(env,update(999,'/admin'),expired)).text,/Введите код/);
});
test('admin expired after opening cancellation cannot cancel another user booking',async()=>{
 const env=setup();await register(env,1);await register(env,999);await book(env,1);
 await send(env,999,'/admin');await send(env,999,'test-admin-code');
 const id=rows(env,'SELECT id FROM bookings')[0].id;
 const later=new Date(NOW.getTime()+59*60000);
 await processUpdate(env,update(999,'/cancel_booking '+id),later);
 const state=JSON.parse(rows(env,'SELECT state FROM users WHERE id=999')[0].state);
 const response=await processUpdate(env,callback(999,`b:${state.nonce}:cancel_yes:`),new Date(NOW.getTime()+61*60000));
 assert.match(response.text,/Нет права/);assert.equal(rows(env,'SELECT * FROM booking_slots').length,2);
});
