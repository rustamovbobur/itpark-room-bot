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
 const db=await mf.getD1Database('DB');for(const name of ['0001_initial.sql','0002_web.sql']){
  const schema=readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8');
  const statements=schema.replace(/^--.*$/gm,'').split(/;\s*(?=CREATE |INSERT |$)/).map(s=>s.trim()).filter(Boolean);
  for(const s of statements)await db.prepare(s.replace(/\n/g,' ')).run();
 }
 await db.prepare("INSERT INTO users(id,authorized,name,department) VALUES(42,1,'Бобур','Аналитика')").run();
 return {mf,db,env:{DB:db,STAFF_ACCESS_CODE:'staff',BOT_TOKEN:'test',WEBHOOK_SECRET:'secret'}};
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
test('site updates profile and rejects cross-origin writes or dates outside horizon',async()=>{
 const {mf,db,env}=await setup();try{
  const code=await loginCode(env),cookie=(await handle(env,'/api/login','POST',{code})).headers.get('set-cookie');
  assert.equal((await handle(env,'/api/profile','POST',{name:'Новый Бобур',department:'Инвестиции'},cookie)).status,200);
  assert.equal((await db.prepare('SELECT name FROM users WHERE id=42').first()).name,'Новый Бобур');
  assert.equal((await handle(env,'/api/book','POST',{roomId:5,day:'2026-09-29',start:600,end:630},cookie,NOW,'https://evil.example')).status,403);
  assert.equal((await handle(env,'/api/book','POST',{roomId:5,day:'2026-12-29',start:600,end:630},cookie)).status,400);
  assert.equal((await handle(env,'/api/schedule?day=2026-09-29','GET',null,cookie)).status,200);
 }finally{await mf.dispose();}
});
test('worker serves an actual booking app, without injecting user values into HTML',async()=>{
 const {mf,env}=await setup();try{
  new Function(client);
  const page=await worker.fetch(req('/'),env),html=await page.text();
  assert.equal(page.status,200);assert.match(html,/Расписание/);assert.match(html,/booking-form/);
  assert.match(page.headers.get('content-security-policy'),/frame-ancestors/);
  assert.equal((await worker.fetch(req('/site.js'),env)).status,200);
  assert.equal((await worker.fetch(req('/site.css'),env)).status,200);
 }finally{await mf.dispose();}
});
