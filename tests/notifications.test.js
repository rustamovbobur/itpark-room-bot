import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scheduleTelegramMenu} from '../src/web.js';
import {menu} from '../src/bot.js';

test('Telegram menu is sent in the background after 3.5 seconds using the bot menu',async()=>{
 const original=globalThis.fetch,pending=[];let sent=null;
 globalThis.fetch=async(_url,options)=>{sent={at:performance.now(),body:JSON.parse(options.body)};return Response.json({ok:true});};
 try{
  const started=performance.now();
  scheduleTelegramMenu({BOT_TOKEN:'test'},42,{waitUntil(p){pending.push(p);}});
  assert.equal(pending.length,1);assert.equal(sent,null);
  await Promise.all(pending);
  assert.ok(sent.at-started>=3400);assert.equal(sent.body.chat_id,42);
  assert.deepEqual(sent.body.reply_markup.inline_keyboard,menu());
 }finally{globalThis.fetch=original;}
});
test('Telegram rejects or disconnects without rejecting the background task',async()=>{
 const original=globalThis.fetch,warn=console.warn;let warnings=0;
 console.warn=()=>warnings++;
 try{
  for(const failure of ['status','body','network']){
   globalThis.fetch=async()=>{if(failure==='network')throw Error('offline');return Response.json({ok:false},{status:failure==='status'?403:200});};
   const pending=[];scheduleTelegramMenu({BOT_TOKEN:'test'},42,{waitUntil(p){pending.push(p);}},0);
   await Promise.all(pending);
  }
  assert.equal(warnings,3);
 }finally{globalThis.fetch=original;console.warn=warn;}
});
