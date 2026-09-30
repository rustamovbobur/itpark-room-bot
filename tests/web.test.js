import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {processUpdate} from '../src/bot.js';
import {web} from '../src/web.js';
import worker from '../src/worker.js';
import {client} from '../src/site.js';
const NOW=new Date('2026-09-28T04:00:00Z'),BASE='https://test.example';
const req=(path,method='GET',body,cookie,origin=BASE)=>new Request(BASE+path,{method,headers:{...(method==='POST'?{'content-type':'application/json',origin}:{}),...(cookie?{cookie}:{})},body:body?JSON.stringify(body):undefined});
async function setup(){const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],compatibilityDate:'2026-09-01'}));
 const db=await mf.getD1Database('DB');for(const name of ['0001_initial.sql','0002_web.sql','0003_site_signup.sql','0004_site_links.sql','0005_site_admin.sql','0006_user_colors.sql']){
  const schema=readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8');
  const statements=schema.replace(/^--.*$/gm,'').split(/;\s*(?=CREATE |INSERT |ALTER |$)/).map(s=>s.trim()).filter(Boolean);
  for(const s of statements)await db.prepare(s.replace(/\n/g,' ')).run();
 }
 await db.prepare("INSERT INTO users(id,authorized,name,department) VALUES(42,1,'Бобур','Аналитика')").run();
 return {mf,db,env:{DB:db,STAFF_ACCESS_CODE:'staff',BOT_TOKEN:'test',WEBHOOK_SECRET:'secret',ADMIN_IDS:'42',ADMIN_PASSCODE:'example-admin-pass'}};
}
const handle=(env,path,method='GET',body,cookie,when=NOW,origin=BASE)=>web(req(path,method,body,cookie,origin),env,when);
async function loginCode(env){const response=await processUpdate(env,{update_id:100,message:{text:'/web',from:{id:42},chat:{id:42,type:'private'}}},NOW);return response.text.match(/[A-Z2-9]{10}/)[0];}

test('website session belongs to Telegram identity, token is secure and code single use',async()=>{
 const {mf,db,env}=await setup();try{
  assert.equal((await handle(env,'/api/schedule?day=2026-09-29')).status,401);
  const code=await loginCode(env);
  const request=req('/api/login','POST',{code});
  const [a,b]=await Promise.all([web(request.clone(),env,NOW),web(request.clone(),env,NOW)]);
  assert.deepEqual([a.status,b.status].sort(),[200,401]);
  const good=a.status===200?a:b,cookie=good.headers.get('set-cookie');
  assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Lax/);
  assert.deepEqual((await (await handle(env,'/api/me','GET',null,cookie)).json()).name,'Бобур');
  assert.equal((await handle(env,'/api/login','POST',{code})).status,401);
  assert.equal((await handle(env,'/api/login','POST',{code},null,NOW,'https://evil.example')).status,403);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM web_sessions').first()).n,1);
  assert.equal((await handle(env,'/api/logout','POST',{},cookie)).status,200);
  assert.equal((await handle(env,'/api/me','GET',null,cookie)).status,401);
 }finally{await mf.dispose();}
});
test('site signup needs employee code and Telegram-delivered one-time proof; registration survives bot start',async()=>{
 const {mf,db,env}=await setup(),original=globalThis.fetch;let delivered;
 globalThis.fetch=async (_url,options)=>{delivered=JSON.parse(options.body);return Response.json({ok:true});};
 try{
  const newUser={telegramId:'87654321',signup:true,name:'Новый сотрудник',department:'Отдел',staffCode:'staff'};
  assert.equal((await handle(env,'/api/request-code','POST',{...newUser,staffCode:'wrong'})).status,400);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM web_signups').first()).n,0);
  assert.equal((await handle(env,'/api/request-code','POST',newUser)).status,200);
  assert.equal(delivered.chat_id,87654321);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM users WHERE id=87654321').first()).n,0);
  const code=delivered.text.match(/[A-Z2-9]{10}/)[0];
  assert.equal((await handle(env,'/api/login','POST',{code:'AAAAAAAAAA'})).status,401);
  const response=await handle(env,'/api/login','POST',{code});assert.equal(response.status,200);
  const me=await (await handle(env,'/api/me','GET',null,response.headers.get('set-cookie'))).json();
  assert.deepEqual([me.id,me.name,me.department],[87654321,'Новый сотрудник','Отдел']);
  assert.equal((await handle(env,'/api/login','POST',{code})).status,401);
  assert.equal((await handle(env,'/api/request-code','POST',{telegramId:'87654321',signup:false})).status,200);
  const another=delivered.text.match(/[A-Z2-9]{10}/)[0];
  assert.equal((await handle(env,'/api/login','POST',{code:another})).status,200);
 }finally{globalThis.fetch=original;await mf.dispose();}
});
test('Telegram link registers a new user without entering their ID and works once',async()=>{
 const {mf,db,env}=await setup();try{
  const result=await processUpdate(env,{update_id:200,message:{text:'/start site',from:{id:12345},chat:{id:12345,type:'private'}}},NOW);
  const token=result.reply_markup.inline_keyboard[0][0].url.match(/#login=([a-f0-9]{64})$/)[1];
  assert.equal((await handle(env,'/api/link','POST',{token})).status,202);
  assert.equal((await handle(env,'/api/link','POST',{token,register:true,name:'Мария',department:'Отдел',staffCode:'wrong'})).status,400);
  assert.equal((await db.prepare('SELECT authorized FROM users WHERE id=12345').first()).authorized,0);
  const body={token,register:true,name:'Мария',department:'Отдел',staffCode:'staff'};
  const [first,second]=await Promise.all([handle(env,'/api/link','POST',body),handle(env,'/api/link','POST',body)]);
  assert.deepEqual([first.status,second.status].sort(),[200,401]);
  const good=first.status===200?first:second;
  const me=await (await handle(env,'/api/me','GET',null,good.headers.get('set-cookie'))).json();
  assert.deepEqual([me.id,me.name,me.department],[12345,'Мария','Отдел']);
  assert.equal((await handle(env,'/api/link','POST',{token})).status,401);
 }finally{await mf.dispose();}
});
test('existing bot user opens website from one Telegram link without signup',async()=>{
 const {mf,env}=await setup();try{
  const result=await processUpdate(env,{update_id:201,message:{text:'/site',from:{id:42},chat:{id:42,type:'private'}}},NOW);
  const token=result.reply_markup.inline_keyboard[0][0].url.match(/#login=([a-f0-9]{64})$/)[1];
  const login=await handle(env,'/api/link','POST',{token});assert.equal(login.status,200);
  assert.equal((await (await handle(env,'/api/me','GET',null,login.headers.get('set-cookie'))).json()).id,42);
 }finally{await mf.dispose();}
});
test('site cannot register or log in using an ID when the bot cannot reach its owner',async()=>{
 const {mf,db,env}=await setup(),original=globalThis.fetch;
 globalThis.fetch=async()=>Response.json({ok:false,error_code:403},{status:403});
 try{
  const result=await handle(env,'/api/request-code','POST',{telegramId:'77553311',signup:true,name:'Новый сотрудник',department:'Отдел',staffCode:'staff'});
  assert.equal(result.status,400);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM web_signups').first()).n,0);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM users WHERE id=77553311').first()).n,0);
 }finally{globalThis.fetch=original;await mf.dispose();}
});
test('web and bot share the same schedule and prevent overlap; owner cancellation releases slots',async()=>{
 const {mf,db,env}=await setup();try{
  const code=await loginCode(env),response=await handle(env,'/api/login','POST',{code});const cookie=response.headers.get('set-cookie');
  const body={roomId:5,day:'2026-09-29',start:600,end:660,comment:'Совещание'};
  assert.equal((await handle(env,'/api/book','POST',body,cookie)).status,201);
  assert.equal((await handle(env,'/api/book','POST',{...body,start:630,end:690},cookie)).status,409);
  const shown=await (await handle(env,'/api/schedule?day=2026-09-29','GET',null,cookie)).json();
  assert.equal(shown.bookings.length,1);assert.equal(shown.bookings[0].name,'Бобур');
  assert.equal((await db.prepare('SELECT count(*) AS n FROM booking_slots').first()).n,2);
  const mine=await (await handle(env,'/api/mine','GET',null,cookie)).json();
  assert.equal(mine.bookings.length,1);
  assert.equal((await handle(env,'/api/cancel','POST',{id:mine.bookings[0].id},cookie)).status,200);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM booking_slots').first()).n,0);
  assert.equal((await handle(env,'/api/cancel','POST',{id:mine.bookings[0].id},cookie)).status,404);
 }finally{await mf.dispose();}
});
test('website admin requires allowlisted Telegram identity and passcode; books for staff and audits cancellation',async()=>{
 const {mf,db,env}=await setup();try{
  await db.prepare("INSERT INTO users(id,authorized,name,department) VALUES(99,1,'Мария','Инвестиции')").run();
  const code=await loginCode(env),webCookie=(await handle(env,'/api/login','POST',{code})).headers.get('set-cookie');
  assert.equal((await handle(env,'/api/admin/users','GET',null,webCookie)).status,403);
  assert.equal((await handle(env,'/api/admin/login','POST',{passcode:'wrong'},webCookie)).status,401);
  const noSecret={...env,ADMIN_PASSCODE:''};
  assert.equal((await handle(noSecret,'/api/admin/login','POST',{passcode:'example-admin-pass'},webCookie)).status,503);
  const noId={...env,ADMIN_IDS:'99'};
  assert.equal((await handle(noId,'/api/admin/login','POST',{passcode:'example-admin-pass'},webCookie)).status,403);
  const login=await handle(env,'/api/admin/login','POST',{passcode:'example-admin-pass'},webCookie);
  assert.equal(login.status,200);assert.match(login.headers.get('set-cookie'),/HttpOnly/);
  const both=webCookie+'; '+login.headers.get('set-cookie');
  const users=await (await handle(env,'/api/admin/users','GET',null,both)).json();assert.equal(users.users.length,2);
  const booking={userId:99,roomId:5,day:'2026-09-29',start:600,end:660,comment:'Встреча'};
  assert.equal((await handle(env,'/api/admin/book','POST',booking,both)).status,201);
  assert.equal((await handle(env,'/api/admin/book','POST',{...booking,start:630,end:690},both)).status,409);
  const row=await db.prepare("SELECT id,user_id,name,department,created_by FROM bookings WHERE status='active'").first();
  assert.deepEqual([row.user_id,row.name,row.department,row.created_by],[99,'Мария','Инвестиции',42]);
  assert.equal((await handle(env,'/api/admin/cancel','POST',{id:row.id},webCookie)).status,403);
  assert.equal((await handle(env,'/api/admin/cancel','POST',{id:row.id},both,NOW,'https://evil.example')).status,403);
  assert.equal((await handle(env,'/api/admin/cancel','POST',{id:row.id},both)).status,200);
  assert.equal((await db.prepare('SELECT cancelled_by FROM bookings WHERE id=?').bind(row.id).first()).cancelled_by,42);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM booking_slots').first()).n,0);
  assert.equal((await handle(env,'/api/admin/logout','POST',{},both)).status,200);
  assert.equal((await handle(env,'/api/admin/status','GET',null,both)).status,403);
 }finally{await mf.dispose();}
});
test('site updates profile and rejects cross-origin writes or dates outside horizon',async()=>{
 const {mf,db,env}=await setup();try{
  const code=await loginCode(env),cookie=(await handle(env,'/api/login','POST',{code})).headers.get('set-cookie');
  await db.prepare(`INSERT INTO bookings(id,user_id,room_id,day,start_min,end_min,name,department,created_at)
    VALUES('profile-test',42,5,'2026-09-29',600,630,'Бобур','Аналитика',1)`).run();
  assert.equal((await handle(env,'/api/profile','POST',{name:'Новый Бобур',department:'Инвестиции'},cookie)).status,200);
  assert.equal((await db.prepare('SELECT name FROM users WHERE id=42').first()).name,'Новый Бобур');
  assert.deepEqual(await db.prepare("SELECT name,department FROM bookings WHERE id='profile-test'").first(),{name:'Новый Бобур',department:'Инвестиции'});
  assert.equal((await handle(env,'/api/book','POST',{roomId:5,day:'2026-09-29',start:600,end:630},cookie,NOW,'https://evil.example')).status,403);
  assert.equal((await handle(env,'/api/book','POST',{roomId:5,day:'2026-12-29',start:600,end:630},cookie)).status,400);
  assert.equal((await handle(env,'/api/schedule?day=2026-09-29','GET',null,cookie)).status,200);
 }finally{await mf.dispose();}
});
test('opening the site sends the Telegram main menu after a successful link login',async()=>{
 const {mf,env}=await setup(),original=globalThis.fetch,pending=[],sent=[];
 globalThis.fetch=async(url,options)=>{sent.push({url:String(url),body:JSON.parse(options.body)});return Response.json({ok:true});};
 try{
  const result=await processUpdate(env,{update_id:202,message:{text:'/site',from:{id:42},chat:{id:42,type:'private'}}},NOW);
  const token=result.reply_markup.inline_keyboard[0][0].url.match(/#login=([a-f0-9]{64})$/)[1];
  const context={waitUntil(promise){pending.push(promise);}};
  const response=await web(req('/api/link','POST',{token}),env,NOW,context,0);
  assert.equal(response.status,200);await Promise.all(pending);
  assert.match(sent[0].url,/api\.telegram\.org\/bottest\/sendMessage/);
  assert.equal(sent[0].body.chat_id,42);
  assert.match(sent[0].body.text,/Бот тоже готов помочь/);
  assert.deepEqual(sent[0].body.reply_markup.inline_keyboard[0].map(x=>x.callback_data),['menu:new','menu:schedule']);
  assert.equal((await web(req('/api/link','POST',{token}),env,NOW,context,0)).status,401);
  assert.equal(pending.length,1);assert.equal(sent.length,1);
 }finally{globalThis.fetch=original;await mf.dispose();}
});
test('worker serves an actual booking app, without injecting user values into HTML',async()=>{
 const {mf,env}=await setup();try{
  new Function(client);
  const page=await worker.fetch(req('/'),env),html=await page.text();
  assert.equal(page.status,200);assert.match(html,/Расписание/);assert.match(html,/booking-form/);
  assert.match(html,/id="admin-entry"/);assert.match(html,/src="\/brand.png"/);
  assert.doesNotMatch(html,/<footer class="site-credit">/);
  assert.match(page.headers.get('content-security-policy'),/frame-ancestors/);
  assert.equal((await worker.fetch(req('/site.js'),env)).status,200);
  assert.equal((await worker.fetch(req('/site.css'),env)).status,200);
  const brand=await worker.fetch(req('/brand.png'),env);assert.equal(brand.status,200);assert.equal(brand.headers.get('content-type'),'image/png');
 }finally{await mf.dispose();}
});

test('malformed JSON shapes are rejected without throwing',async()=>{
 const {mf,env}=await setup();try{
  for(const path of ['/api/login','/api/link','/api/request-code'])for(const body of ['null','[]','42','"text"']){
   const response=await web(new Request(BASE+path,{method:'POST',headers:{origin:BASE,'content-type':'application/json'},body}),env,NOW);
   assert.equal(response.status,400,path+' '+body);
  }
 }finally{await mf.dispose();}
});
test('web profile edit invalidates a bot snapshot so it cannot overwrite the edit',async()=>{
 const {mf,db,env}=await setup();try{
  const code=await loginCode(env),cookie=(await handle(env,'/api/login','POST',{code})).headers.get('set-cookie');
  const before=await db.prepare('SELECT version FROM users WHERE id=42').first();
  assert.equal((await handle(env,'/api/profile','POST',{name:'Новое имя',department:'Новый отдел'},cookie)).status,200);
  const stale=await db.prepare("UPDATE users SET name='Старое имя' WHERE id=42 AND version=?").bind(before.version).run();
  assert.equal(stale.meta.changes,0);
  assert.equal((await db.prepare('SELECT name FROM users WHERE id=42').first()).name,'Новое имя');
 }finally{await mf.dispose();}
});
test('employee-code guesses are limited across newly issued Telegram links',async()=>{
 const {mf,env}=await setup();try{
  for(let attempt=0;attempt<6;attempt++){
   const response=await processUpdate(env,{update_id:300+attempt,message:{text:'/site',from:{id:123},chat:{id:123,type:'private'}}},NOW);
   const token=response.reply_markup.inline_keyboard[0][0].url.split('#login=')[1];
   const result=await handle(env,'/api/link','POST',{token,register:true,name:'Имя',department:'Отдел',staffCode:'wrong'});
   assert.equal(result.status,attempt<5?400:429);
  }
 }finally{await mf.dispose();}
});
test('20 simultaneous website users compete for one overlapping interval',async()=>{
 const {mf,db,env}=await setup();try{
  const requests=[];
  for(let id=1000;id<1020;id++){
   const token=id.toString(16).padStart(64,'0');
   const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),x=>x.toString(16).padStart(2,'0')).join('');
   await db.prepare("INSERT INTO users(id,authorized,name,department) VALUES(?,1,'Имя','Отдел')").bind(id).run();
   await db.prepare('INSERT INTO web_sessions VALUES(?,?,?,?)').bind(digest,id,Math.floor(NOW.getTime()/1000)+3600,1).run();
   requests.push(req('/api/book','POST',{roomId:5,day:'2026-09-29',start:600,end:720},'itpark_session='+token));
  }
  const results=await Promise.all(requests.map(r=>web(r,env,NOW)));
  assert.equal(results.filter(r=>r.status===201).length,1);assert.equal(results.filter(r=>r.status===409).length,19);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM bookings').first()).n,1);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM booking_slots').first()).n,4);
 }finally{await mf.dispose();}
});
test('admin password lockout survives IP changes and admin sessions expire after one hour',async()=>{
 const {mf,env}=await setup();try{
  const code=await loginCode(env),cookie=(await handle(env,'/api/login','POST',{code})).headers.get('set-cookie');
  const login=await handle(env,'/api/admin/login','POST',{passcode:env.ADMIN_PASSCODE},cookie),both=cookie+'; '+login.headers.get('set-cookie');
  assert.equal((await handle(env,'/api/admin/status','GET',null,both,new Date(NOW.getTime()+3600001))).status,403);
  for(let i=0;i<6;i++){
   const r=req('/api/admin/login','POST',{passcode:'wrong'},cookie);r.headers.set('cf-connecting-ip','192.0.2.'+i);
   assert.equal((await web(r,env,NOW)).status,i<5?401:429);
  }
 }finally{await mf.dispose();}
});
test('API failures return safe JSON, and readiness detects incomplete schema',async()=>{
 const broken={DB:{prepare(){throw new Error('database credentials must not leak');}}};
 assert.equal((await worker.fetch(req('/health'),broken)).status,503);
 const result=await worker.fetch(req('/api/me','GET',null,'itpark_session='+'a'.repeat(64)),broken);
 assert.equal(result.status,503);assert.doesNotMatch(await result.text(),/credentials/);
});

test('profile change during normal or admin booking cannot insert an old name',async()=>{
 for(const admin of [false,true]){
  const {mf,db,env}=await setup();try{
   const code=await loginCode(env),cookie=(await handle(env,'/api/login','POST',{code})).headers.get('set-cookie');
   const adminToken=admin?(await handle(env,'/api/admin/login','POST',{passcode:env.ADMIN_PASSCODE},cookie)).headers.get('set-cookie'):'';
   const combined=admin?cookie.split(';')[0]+'; '+adminToken.split(';')[0]:cookie;
   let intercepted=false;
   const racingEnv={...env,DB:{prepare(sql){
    if(!sql.includes('INSERT INTO bookings'))return db.prepare(sql);
    return {bind(...args){const bound=db.prepare(sql).bind(...args);return {async run(){
     intercepted=true;
     assert.equal((await handle(env,'/api/profile','POST',{name:'Актуальное имя',department:'Актуальный отдел'},cookie)).status,200);
     return bound.run();
    }}}};
   }}};
   assert.equal((await handle(racingEnv,admin?'/api/admin/book':'/api/book','POST',{userId:42,roomId:5,day:'2026-09-29',start:600,end:630},combined)).status,201);
   assert.ok(intercepted);
   const row=await db.prepare('SELECT name,department,user_id FROM bookings').first();
   assert.deepEqual(row,{name:'Актуальное имя',department:'Актуальный отдел',user_id:42});
  }finally{await mf.dispose();}
 }
});

test('admin history includes five previous days, expired slots and cancellation audit; employees cannot read it',async()=>{
 const {mf,db,env}=await setup();try{
  const code=await loginCode(env),cookie=(await handle(env,'/api/login','POST',{code})).headers.get('set-cookie');
  const ac=(await handle(env,'/api/admin/login','POST',{passcode:env.ADMIN_PASSCODE},cookie)).headers.get('set-cookie');
  const both=cookie.split(';')[0]+'; '+ac.split(';')[0];
  await db.prepare("INSERT INTO bookings(id,user_id,room_id,day,start_min,end_min,name,department,created_at) VALUES('history',42,5,'2026-09-23',480,540,'Историческое имя','Отдел',1)").run();
  await db.prepare("INSERT INTO bookings(id,user_id,room_id,day,start_min,end_min,name,department,created_at,status,cancelled_by,cancelled_at) VALUES('cancelled-history',42,5,'2026-09-23',480,540,'Имя','Отдел',1,'cancelled',42,2)").run();
  await db.prepare("INSERT INTO bookings(id,user_id,room_id,day,start_min,end_min,name,department,created_at) VALUES('expired-today',42,6,'2026-09-28',480,510,'Имя','Отдел',1)").run();
  assert.equal((await handle(env,'/api/admin/bookings?day=2026-09-23','GET',null,cookie)).status,403);
  const response=await handle(env,'/api/admin/bookings?day=2026-09-23','GET',null,both);assert.equal(response.status,200);
  const data=await response.json();assert.equal(data.bookings.length,2);assert.equal(data.rooms.length,3);
  assert.ok(data.bookings.every(b=>b.canCancel===false));assert.equal(data.bookings.find(b=>b.status==='cancelled').cancelled_by,42);
  assert.equal(data.bookings.find(b=>b.id==='history').name,'Историческое имя');
  assert.equal((await handle(env,'/api/admin/bookings?day=2026-09-22','GET',null,both)).status,400);
  assert.equal((await handle(env,'/api/admin/bookings?day=2026-09-31','GET',null,both)).status,400);
  assert.equal((await handle(env,'/api/schedule?day=2026-09-23','GET',null,both)).status,400);
  const today=await (await handle(env,'/api/admin/bookings?day=2026-09-28','GET',null,both)).json();
  assert.equal(today.bookings[0].id,'expired-today');assert.equal(today.bookings[0].canCancel,false);
  assert.equal((await handle(env,'/api/admin/book','POST',{userId:42,roomId:5,day:'2026-09-23',start:600,end:630},both)).status,400);
  const ordinary={...env,ADMIN_IDS:'999'};
  assert.equal((await handle(ordinary,'/api/admin/bookings?day=2026-09-23','GET',null,both)).status,403);
 }finally{await mf.dispose();}
});
test('profile color persists, changes every booking color, permits shared custom colors, and rejects unsafe input',async()=>{
 const {mf,db,env}=await setup();try{
  const code=await loginCode(env),cookie=(await handle(env,'/api/login','POST',{code})).headers.get('set-cookie');
  const initial=await (await handle(env,'/api/me','GET',null,cookie)).json();assert.match(initial.color,/^#[a-f0-9]{6}$/);
  assert.equal((await (await handle(env,'/api/me','GET',null,cookie)).json()).color,initial.color);
  await handle(env,'/api/book','POST',{roomId:5,day:'2026-09-29',start:600,end:630},cookie);
  for(const color of ['#ABCDEF','#000000','#ffffff']){
   assert.equal((await handle(env,'/api/profile','POST',{name:'Бобур',department:'Аналитика',color},cookie)).status,200);
   const schedule=await (await handle(env,'/api/schedule?day=2026-09-29','GET',null,cookie)).json();assert.equal(schedule.bookings[0].color,color.toLowerCase());
  }
  for(const color of ['red','#123','url(https://evil.test)',null,{},'#123456;'])assert.equal((await handle(env,'/api/profile','POST',{name:'Бобур',department:'Аналитика',color},cookie)).status,400);
  assert.equal((await (await handle(env,'/api/me','GET',null,cookie)).json()).color,'#ffffff');
  await db.prepare("INSERT INTO users(id,authorized,name,department) VALUES(43,1,'Коллега','Отдел')").run();
  const link=await processUpdate(env,{update_id:900,message:{text:'/site',from:{id:43},chat:{id:43,type:'private'}}},NOW);
  const token=link.reply_markup.inline_keyboard[0][0].url.split('#login=')[1];
  const other=(await handle(env,'/api/link','POST',{token})).headers.get('set-cookie');
  await handle(env,'/api/profile','POST',{name:'Коллега',department:'Отдел',color:'#ffffff'},other);
  assert.equal((await (await handle(env,'/api/me','GET',null,other)).json()).color,'#ffffff');
  const saved=await db.prepare('SELECT custom_color FROM user_colors WHERE user_id=42').first();assert.equal(saved.custom_color,'#ffffff');
 }finally{await mf.dispose();}
});
