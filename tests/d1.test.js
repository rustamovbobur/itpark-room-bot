import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFileSync} from 'node:fs';
import {processUpdate} from '../src/bot.js';

test('real local D1 runtime: 12 simultaneous overlapping confirmations and atomic rollback',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['DB'],compatibilityDate:'2026-09-01'}));
 try {
  const db=await mf.getD1Database('DB');
  const schema=readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8');
  // D1 exec accepts one statement per line. Preserve trigger bodies on one line.
  const statements=schema.replace(/^--.*$/gm,'').split(/;\s*(?=CREATE |INSERT |$)/).map(x=>x.trim()).filter(Boolean);
  for(const sql of statements) await db.prepare(sql.replace(/\n/g,' ')).run();
  const env={DB:db,STAFF_ACCESS_CODE:'test'},now=new Date('2026-09-28T04:00:00Z');
  const events=[];
  for(let id=1;id<=12;id++) {
   const state={step:'confirm',nonce:'n'+id,expires:Math.floor(now.getTime()/1000)+3600,room:5,day:'2026-09-29',start:600,end:660,comment:''};
   await db.prepare('INSERT INTO users(id,authorized,name,department,state) VALUES(?,1,?,?,?)').bind(id,'Имя '+id,'Отдел',JSON.stringify(state)).run();
   events.push({update_id:id,callback_query:{id:String(id),data:`b:n${id}:confirm:`,from:{id},message:{chat:{id,type:'private'}}}});
  }
  const responses=await Promise.all(events.map(e=>processUpdate(env,e,now)));
  assert.equal(responses.filter(r=>r.text.includes('забронирована!')).length,1);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM bookings').first()).n,1);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM booking_slots').first()).n,2);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM receipts').first()).n,12);
 } finally {await mf.dispose();}
});
