import {processUpdate, stmt} from './bot.js';
import {web} from './web.js';
import {html,css,client} from './site.js';
import {logoBase64} from './logo.js';
async function telegram(env, method, payload) {
  const response=await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(12000)
  });
  const data=await response.json();
  if(!data.ok) {
    const error=new Error('Telegram request failed');
    error.code=data.error_code; throw error;
  }
  return data.result;
}
export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if(url.pathname==='/health'&&request.method==='GET') {
      try {await env.DB.prepare('SELECT id FROM rooms LIMIT 1').first();return Response.json({ok:true});}
      catch {return Response.json({ok:false},{status:503});}
    }
    if(url.pathname==='/' && request.method==='GET')return new Response(html,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"}});
    if(url.pathname==='/site.css'&&request.method==='GET')return new Response(css,{headers:{'content-type':'text/css; charset=utf-8','cache-control':'public, max-age=300','x-content-type-options':'nosniff'}});
    if(url.pathname==='/site.js'&&request.method==='GET')return new Response(client,{headers:{'content-type':'application/javascript; charset=utf-8','cache-control':'public, max-age=300','x-content-type-options':'nosniff'}});
    if(url.pathname==='/brand.png'&&request.method==='GET')return new Response(Uint8Array.from(atob(logoBase64),c=>c.charCodeAt(0)),{headers:{'content-type':'image/png','cache-control':'public, max-age=86400','x-content-type-options':'nosniff'}});
    if(url.pathname.startsWith('/api/'))return web(request,env);
    if(url.pathname!=='/webhook'||request.method!=='POST') return new Response('Not found',{status:404});
    if(!env.WEBHOOK_SECRET||request.headers.get('X-Telegram-Bot-Api-Secret-Token')!==env.WEBHOOK_SECRET) return new Response('Forbidden',{status:403});
    if(!env.BOT_TOKEN||!env.STAFF_ACCESS_CODE) return new Response('Not configured',{status:503});
    // Telegram updates are small. Enforce a streamed limit, even without Content-Length.
    const reader=request.body?.getReader(); if(!reader) return new Response('Bad request',{status:400});
    let raw='',size=0; const decoder=new TextDecoder();
    while(true) {const {value,done}=await reader.read();if(done) break;size+=value.length;
      if(size>65536) {await reader.cancel();return new Response('Too large',{status:413});}raw+=decoder.decode(value,{stream:true});}
    raw+=decoder.decode();
    let update;try {update=JSON.parse(raw);}catch {return new Response('Bad JSON',{status:400});}
    try {
      if(update.callback_query?.id) {
        try {await telegram(env,'answerCallbackQuery',{callback_query_id:update.callback_query.id});}catch {/* An expired callback does not invalidate the booking. */}
      }
      const response=await processUpdate(env,update);
      if(response) {
        try {await telegram(env,'sendMessage',response);}catch(error) {
          // A blocked bot cannot deliver. The user can reopen /my after unblocking.
          if(error.code!==403) throw error;
        }
        await stmt(env.DB,'UPDATE receipts SET delivered=1 WHERE update_id=?',update.update_id).run();
      }
      return new Response('OK');
    } catch {
      // Do not log update bodies, personal information or token-bearing URLs.
      console.error('Webhook processing failed; Telegram may retry.');
      return new Response('Retry later',{status:503});
    }
  },
  async scheduled(_event,env) {
    const cutoff=Math.floor(Date.now()/1000)-7*86400;
    await stmt(env.DB,'DELETE FROM receipts WHERE created_at<? AND delivered=1',cutoff).run();
    await stmt(env.DB,'DELETE FROM web_codes WHERE expires_at<?',Math.floor(Date.now()/1000)).run();
    await stmt(env.DB,'DELETE FROM web_sessions WHERE expires_at<?',Math.floor(Date.now()/1000)).run();
    await stmt(env.DB,'DELETE FROM web_login_attempts WHERE window_end<?',Math.floor(Date.now()/1000)).run();
    await stmt(env.DB,'DELETE FROM web_signups WHERE expires_at<?',Math.floor(Date.now()/1000)).run();
    await stmt(env.DB,'DELETE FROM web_code_requests WHERE window_end<?',Math.floor(Date.now()/1000)).run();
    await stmt(env.DB,'DELETE FROM web_links WHERE expires_at<?',Math.floor(Date.now()/1000)).run();
  }
};
