import {stmt,menu} from './bot.js';
import {localNow,validDay,validRange,config} from './time.js';

const encoder=new TextEncoder();
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)))).map(b=>b.toString(16).padStart(2,'0')).join('');
const error=(status,message)=>Response.json({error:message},{status,headers:{'cache-control':'no-store'}});
const ok=(value,status=200,headers={})=>Response.json(value,{status,headers:{'cache-control':'no-store',...headers}});
const cookie=(token,age)=>`itpark_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/api; Max-Age=${age}`;
const adminCookie=(token,age)=>`itpark_admin=${token}; HttpOnly; Secure; SameSite=Lax; Path=/api/admin; Max-Age=${age}`;
const adminListed=(env,id)=>String(env.ADMIN_IDS||'').split(',').map(x=>x.trim()).includes(String(id));
const sanitize=(str,max)=>typeof str==='string'?str.trim().replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/g,' ').slice(0,max+1):'';
const randomToken=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
const loginCode=()=>{const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';const bytes=crypto.getRandomValues(new Uint8Array(10));return Array.from(bytes,b=>alphabet[b%alphabet.length]).join('');};
const readJson=async request=>{
  if(!(request.headers.get('content-type')||'').toLowerCase().startsWith('application/json'))throw new Error('type');
  if(Number(request.headers.get('content-length'))>4096)throw new Error('size');
  const reader=request.body?.getReader();if(!reader)throw new Error('body');
  const decoder=new TextDecoder();let value='',size=0;
  while(true){const {value:chunk,done}=await reader.read();if(done)break;size+=chunk.byteLength;if(size>4096){await reader.cancel();throw new Error('size');}value+=decoder.decode(chunk,{stream:true});}
  value+=decoder.decode();const parsed=JSON.parse(value);
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('object');
  return parsed;
};
const ipKey=async request=>hash(request.headers.get('cf-connecting-ip')||'unknown');

export function scheduleTelegramMenu(env,userId,context,delayMs=3500){
  if(!context?.waitUntil||!env.BOT_TOKEN)return;
  const task=(async()=>{
    if(delayMs>0)await new Promise(resolve=>setTimeout(resolve,delayMs));
    try{
      const response=await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`,{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({chat_id:userId,text:'✅ Вы вошли в Meeting Rooms через сайт. Бот тоже готов помочь — выберите действие:',reply_markup:{inline_keyboard:menu()}}),signal:AbortSignal.timeout(12000)
      });
    if(!response.ok||!(await response.json()).ok)console.warn('Telegram site menu was not delivered.');
    }catch{console.warn('Telegram site menu was not delivered.');}
  })();
  context.waitUntil(task.catch(()=>{}));
}

export async function web(request,env,clock=new Date(),context,menuDelayMs=3500){
  const url=new URL(request.url),method=request.method,db=env.DB,epoch=Math.floor(clock.getTime()/1000),now=localNow(clock),cfg=config(env);
  if(method==='POST' && request.headers.get('origin')!==url.origin)return error(403,'Обновите страницу и попробуйте ещё раз.');
  if(url.pathname==='/api/link'&&method==='POST'){
    let body;try{body=await readJson(request);}catch{return error(400,'Неверная ссылка. Запросите новую командой /site.');}
    if(typeof body.token!=='string'||!(/^[a-f0-9]{64}$/.test(body.token)))return error(400,'Неверная ссылка. Запросите новую командой /site.');
    const digest=await hash(body.token);
    const link=await stmt(db,`SELECT l.user_id,u.authorized,u.name,u.department FROM web_links l JOIN users u ON u.id=l.user_id
      WHERE l.token_hash=? AND l.expires_at>?`,digest,epoch).first();
    if(!link)return error(401,'Ссылка устарела или уже использована. Отправьте боту /site ещё раз.');
    const registered=link.authorized && link.name && link.department;
    if(!registered && body.register!==true)return ok({needsProfile:true},202);
    if(!registered){
      const key=await hash('signup:'+link.user_id);
      await stmt(db,`INSERT INTO web_code_requests(source_hash,attempts,window_end) VALUES(?,1,?)
        ON CONFLICT(source_hash) DO UPDATE SET attempts=CASE WHEN window_end<? THEN 1 ELSE attempts+1 END,
        window_end=CASE WHEN window_end<? THEN excluded.window_end ELSE window_end END`,key,epoch+900,epoch,epoch).run();
      if((await stmt(db,'SELECT attempts FROM web_code_requests WHERE source_hash=?',key).first()).attempts>5)return error(429,'Слишком много попыток. Повторите через 15 минут.');
    }
    const name=sanitize(body.name,80),department=sanitize(body.department,100);
    if(!registered && (!env.STAFF_ACCESS_CODE||body.staffCode!==env.STAFF_ACCESS_CODE||name.length<2||name.length>80||department.length<2||department.length>100))
      return error(400,'Проверьте имя, отдел и код доступа сотрудников у ответственного.');
    const token=randomToken(),tokenHash=await hash(token);
    try{
      await db.batch([
        stmt(db,'DELETE FROM web_links WHERE token_hash=? AND expires_at>?',digest,epoch),
        db.prepare('INSERT INTO state_guard(ok) VALUES(changes())'),
        db.prepare('DELETE FROM state_guard'),
        ...(!registered?[stmt(db,`UPDATE users SET authorized=1,name=?,department=?,version=version+1,state='{"step":"home"}' WHERE id=? AND (authorized=0 OR length(name)=0 OR length(department)=0)`,name,department,link.user_id)]:[]),
        stmt(db,'INSERT INTO web_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)',tokenHash,link.user_id,epoch+30*86400,epoch)
      ]);
      scheduleTelegramMenu(env,link.user_id,context,menuDelayMs);
      return ok({ok:true},200,{'set-cookie':cookie(token,30*86400)});
    }catch{return error(401,'Ссылка уже использована. Отправьте боту /site ещё раз.');}
  }
  if(url.pathname==='/api/request-code'&&method==='POST'){
    let body;try{body=await readJson(request);}catch{return error(400,'Проверьте данные формы.');}
    const id=Number(body.telegramId),signup=body.signup===true;
    if(!Number.isSafeInteger(id)||id<=0||String(id)!==String(body.telegramId).trim())return error(400,'Введите свой числовой Telegram ID из команды /id.');
    const source=await ipKey(request),perUser=await hash(source+':'+id);
    try{
      for(const key of [source,perUser]){
        await stmt(db,`INSERT INTO web_code_requests(source_hash,attempts,window_end) VALUES(?,1,?)
          ON CONFLICT(source_hash) DO UPDATE SET attempts=CASE WHEN window_end<? THEN 1 ELSE attempts+1 END,
          window_end=CASE WHEN window_end<? THEN excluded.window_end ELSE window_end END`,key,epoch+900,epoch,epoch).run();
      }
      const ip=await stmt(db,'SELECT attempts FROM web_code_requests WHERE source_hash=?',source).first();
      const userAttempts=await stmt(db,'SELECT attempts FROM web_code_requests WHERE source_hash=?',perUser).first();
      if(ip.attempts>30||userAttempts.attempts>5)return error(429,'Слишком много запросов кода. Повторите через 15 минут.');
      const existing=await stmt(db,'SELECT authorized,name,department FROM users WHERE id=?',id).first();
      if(signup && existing?.authorized && existing.name && existing.department)return error(400,'Вы уже зарегистрированы. Выберите «У меня есть профиль».');
      if(!signup && (!existing?.authorized||!existing.name||!existing.department))return error(400,'Профиль не найден. Выберите «Первый вход».');
      const name=sanitize(body.name,80),department=sanitize(body.department,100);
      if(signup && (name.length<2||name.length>80||department.length<2||department.length>100||!env.STAFF_ACCESS_CODE||body.staffCode!==env.STAFF_ACCESS_CODE))
        return error(400,'Проверьте имя, отдел и код доступа сотрудников у ответственного.');
      const code=loginCode(),digest=await hash(code);
      const endpoint=`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;
      let sent=false;
      try{const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:id,text:`🔐 Код входа на сайт IT Park: ${code}\n\nДействует 10 минут и только один раз. Никому его не пересылайте.`}),signal:AbortSignal.timeout(10000)});sent=response.ok&&(await response.json()).ok===true;}catch{/* Bot cannot reach Telegram. */}
      if(!sent)return error(400,'Бот не смог отправить код. Откройте бота в Telegram, нажмите Start, отправьте /id и попробуйте ещё раз.');
      if(signup){
        await db.batch([stmt(db,'DELETE FROM web_signups WHERE user_id=?',id),stmt(db,'INSERT INTO web_signups(code_hash,user_id,name,department,expires_at) VALUES(?,?,?,?,?)',digest,id,name,department,epoch+600)]);
      }else{
        await db.batch([stmt(db,'DELETE FROM web_codes WHERE user_id=?',id),stmt(db,'INSERT INTO web_codes(code_hash,user_id,expires_at) VALUES(?,?,?)',digest,id,epoch+600)]);
      }
      return ok({ok:true});
    }catch{return error(503,'Сервис временно недоступен. Попробуйте ещё раз позже.');}
  }
  if(url.pathname==='/api/login'&&method==='POST'){
    let body;try{body=await readJson(request);}catch{return error(400,'Введите код с сайта в правильном формате.');}
    const code=String(body.code||'').trim().toUpperCase();if(!/^[A-Z2-9]{10}$/.test(code))return error(400,'Введите 10-символьный код из Telegram.');
    const source=await ipKey(request);
    try{
      await stmt(db,`INSERT INTO web_login_attempts(source_hash,attempts,window_end) VALUES(?,1,?)
        ON CONFLICT(source_hash) DO UPDATE SET attempts=CASE WHEN window_end<? THEN 1 ELSE attempts+1 END,
        window_end=CASE WHEN window_end<? THEN excluded.window_end ELSE window_end END`,source,epoch+900,epoch,epoch).run();
      const attempts=await stmt(db,'SELECT attempts FROM web_login_attempts WHERE source_hash=?',source).first();
      if(attempts.attempts>60)return error(429,'Слишком много попыток. Повторите через 15 минут.');
      const digest=await hash(code);
      const found=await stmt(db,`SELECT c.user_id FROM web_codes c JOIN users u ON u.id=c.user_id
        WHERE c.code_hash=? AND c.expires_at>? AND u.authorized=1 AND length(u.name)>0 AND length(u.department)>0`,digest,epoch).first();
      const pending=found?null:await stmt(db,'SELECT user_id,name,department FROM web_signups WHERE code_hash=? AND expires_at>?',digest,epoch).first();
      if(!found&&!pending)return error(401,'Код неверен или истёк. Запросите новый код на странице входа.');
      const token=randomToken(),tokenHash=await hash(token);
      // Deletion and guard make the one-time code single-use even with concurrent requests.
      await db.batch(pending?[
        stmt(db,'DELETE FROM web_signups WHERE code_hash=? AND expires_at>?',digest,epoch),
        db.prepare('INSERT INTO state_guard(ok) VALUES(changes())'),
        db.prepare('DELETE FROM state_guard'),
        stmt(db,'INSERT INTO users(id) VALUES(?) ON CONFLICT(id) DO NOTHING',pending.user_id),
        stmt(db,`UPDATE users SET authorized=1,name=?,department=?,version=version+1,state='{"step":"home"}' WHERE id=? AND (authorized=0 OR length(name)=0 OR length(department)=0)`,pending.name,pending.department,pending.user_id),
        stmt(db,'INSERT INTO web_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)',tokenHash,pending.user_id,epoch+30*86400,epoch),
        stmt(db,'DELETE FROM web_login_attempts WHERE source_hash=?',source)
      ]:[
        stmt(db,'DELETE FROM web_codes WHERE code_hash=? AND expires_at>?',digest,epoch),
        db.prepare('INSERT INTO state_guard(ok) VALUES(changes())'),
        db.prepare('DELETE FROM state_guard'),
        stmt(db,'INSERT INTO web_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)',tokenHash,found.user_id,epoch+30*86400,epoch),
        stmt(db,'DELETE FROM web_login_attempts WHERE source_hash=?',source)
      ]);
      return ok({ok:true},200,{'set-cookie':cookie(token,30*86400)});
    }catch{return error(401,'Код уже использован или временно недоступен. Запросите новый код.');}
  }
  const token=/^(?:.*;\s*)?itpark_session=([a-f0-9]{64})(?:;.*)?$/.exec(request.headers.get('cookie')||'')?.[1];
  const session=token?await stmt(db,`SELECT u.id,u.name,u.department,u.authorized FROM web_sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>?`,await hash(token),epoch).first():null;
  if(!session||!session.authorized)return error(401,'Войдите через Telegram.');
  if(url.pathname.startsWith('/api/admin/')){
    if(!adminListed(env,session.id))return error(403,'Панель доступна только назначенным администраторам.');
    if(url.pathname==='/api/admin/login'&&method==='POST'){
      if(!env.ADMIN_PASSCODE)return error(503,'ADMIN_PASSCODE не задан в Cloudflare. Администратору нужно выполнить: npx wrangler secret put ADMIN_PASSCODE');
      let body;try{body=await readJson(request);}catch{return error(400,'Введите код администратора.');}
      const source=await hash('admin:'+session.id);
      await stmt(db,`INSERT INTO web_admin_attempts(source_hash,attempts,window_end) VALUES(?,1,?)
        ON CONFLICT(source_hash) DO UPDATE SET attempts=CASE WHEN window_end<? THEN 1 ELSE attempts+1 END,
        window_end=CASE WHEN window_end<? THEN excluded.window_end ELSE window_end END`,source,epoch+900,epoch,epoch).run();
      const attempts=await stmt(db,'SELECT attempts FROM web_admin_attempts WHERE source_hash=?',source).first();
      if(attempts.attempts>5)return error(429,'Слишком много попыток. Повторите через 15 минут.');
      if(typeof body.passcode!=='string'||body.passcode!==env.ADMIN_PASSCODE)return error(401,'Неверный код администратора.');
      const adminToken=randomToken(),digest=await hash(adminToken);
      await db.batch([stmt(db,'INSERT INTO web_admin_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)',digest,session.id,epoch+3600),stmt(db,'DELETE FROM web_admin_attempts WHERE source_hash=?',source)]);
      return ok({ok:true},200,{'set-cookie':adminCookie(adminToken,3600)});
    }
    const rawAdmin=/(?:^|;\s*)itpark_admin=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get('cookie')||'')?.[1];
    const admin=rawAdmin?await stmt(db,'SELECT user_id FROM web_admin_sessions WHERE token_hash=? AND user_id=? AND expires_at>?',await hash(rawAdmin),session.id,epoch).first():null;
    if(!admin)return error(403,'Сессия администратора истекла. Введите код ещё раз.');
    if(url.pathname==='/api/admin/status'&&method==='GET')return ok({ok:true});
    if(url.pathname==='/api/admin/logout'&&method==='POST'){
      await stmt(db,'DELETE FROM web_admin_sessions WHERE token_hash=? AND user_id=?',await hash(rawAdmin),session.id).run();
      return ok({ok:true},200,{'set-cookie':adminCookie('',0)});
    }
    if(url.pathname==='/api/admin/users'&&method==='GET'){
      const users=(await db.prepare("SELECT id,name,department FROM users WHERE authorized=1 AND length(name)>0 AND length(department)>0 ORDER BY name,id LIMIT 500").all()).results;
      return ok({users});
    }
    if(url.pathname==='/api/admin/bookings'&&method==='GET'){
      const day=url.searchParams.get('day');if(!validDay(day,now,cfg.horizon))return error(400,'Дата вне доступного периода.');
      const bookings=(await stmt(db,`SELECT b.id,b.room_id,r.name AS room_name,b.day,b.start_min,b.end_min,b.name,b.department,b.comment,b.user_id,b.created_by
        FROM bookings b JOIN rooms r ON r.id=b.room_id WHERE b.day=? AND b.status='active' ORDER BY b.room_id,b.start_min`,day).all()).results;
      return ok({bookings});
    }
    if(url.pathname==='/api/admin/book'&&method==='POST'){
      let body;try{body=await readJson(request);}catch{return error(400,'Проверьте данные брони.');}
      const roomId=Number(body.roomId),userId=Number(body.userId),start=Number(body.start),end=Number(body.end),day=body.day,comment=sanitize(body.comment||'',300);
      if(!Number.isInteger(roomId)||!Number.isSafeInteger(userId)||userId<=0||!validRange(day,start,end,now,cfg)||comment.length>300)return error(400,'Проверьте сотрудника, дату и время.');
      const owner=await stmt(db,'SELECT id,name,department FROM users WHERE id=? AND authorized=1 AND length(name)>0 AND length(department)>0',userId).first();
      const room=await stmt(db,'SELECT id FROM rooms WHERE id=? AND active=1',roomId).first();
      if(!owner||!room)return error(400,'Сотрудник или комната недоступны.');
      try{
        await stmt(db,`INSERT INTO bookings(id,user_id,room_id,day,start_min,end_min,name,department,comment,created_at,created_by)
          SELECT ?,id,?,?,?,?,name,department,?,?,? FROM users WHERE id=?`,crypto.randomUUID(),roomId,day,start,end,comment,epoch,session.id,owner.id).run();
        return ok({ok:true},201);
      }catch(e){if(/booking_slots|UNIQUE|constraint/i.test(String(e.message)))return error(409,'Это время уже занято. Обновите расписание.');throw e;}
    }
    if(url.pathname==='/api/admin/cancel'&&method==='POST'){
      let body;try{body=await readJson(request);}catch{return error(400,'Неверный запрос.');}
      if(typeof body.id!=='string'||!/^[-0-9a-f]{36}$/.test(body.id))return error(400,'Неверный ID брони.');
      const result=await stmt(db,`UPDATE bookings SET status='cancelled',cancelled_by=?,cancelled_at=?
        WHERE id=? AND status='active' AND (day>? OR (day=? AND end_min>?))`,session.id,epoch,body.id,now.day,now.day,now.minute).run();
      if(!result.meta?.changes)return error(404,'Бронь не найдена или уже отменена.');
      return ok({ok:true});
    }
    return error(404,'Страница не найдена.');
  }
  if(url.pathname==='/api/me'&&method==='GET')return ok({id:session.id,name:session.name,department:session.department,adminEligible:adminListed(env,session.id),day:now.day,open:cfg.open,close:cfg.close,horizon:cfg.horizon,maxDuration:cfg.maxDuration});
  if(url.pathname==='/api/logout'&&method==='POST'){
    await stmt(db,'DELETE FROM web_sessions WHERE token_hash=?',await hash(token)).run();
    await stmt(db,'DELETE FROM web_admin_sessions WHERE user_id=?',session.id).run();
    return ok({ok:true},200,{'set-cookie':cookie('',0)});
  }
  if(url.pathname==='/api/schedule'&&method==='GET'){
    const day=url.searchParams.get('day');if(!validDay(day,now,cfg.horizon))return error(400,'Дата вне доступного периода.');
    const rooms=(await db.prepare('SELECT id,name FROM rooms WHERE active=1 ORDER BY id').all()).results;
    const bookings=(await stmt(db,`SELECT b.id,b.room_id,b.day,b.start_min,b.end_min,b.name,b.department,b.comment,b.user_id
      FROM bookings b JOIN rooms r ON r.id=b.room_id AND r.active=1 WHERE b.day=? AND b.status='active' ORDER BY b.room_id,b.start_min`,day).all()).results;
    return ok({day,rooms,bookings,now});
  }
  if(url.pathname==='/api/mine'&&method==='GET'){
    const bookings=(await stmt(db,`SELECT b.id,b.room_id,r.name AS room_name,b.day,b.start_min,b.end_min,b.comment FROM bookings b JOIN rooms r ON r.id=b.room_id
      WHERE b.user_id=? AND b.status='active' AND (b.day>? OR (b.day=? AND b.end_min>?)) ORDER BY b.day,b.start_min LIMIT 200`,session.id,now.day,now.day,now.minute).all()).results;
    return ok({bookings});
  }
  if(url.pathname==='/api/profile'&&method==='POST'){
    let body;try{body=await readJson(request);}catch{return error(400,'Проверьте введённые данные.');}
    const name=sanitize(body.name,80),department=sanitize(body.department,100);
    if(name.length<2||name.length>80||department.length<2||department.length>100)return error(400,'Имя и отдел: минимум 2 символа; максимум 80 и 100 соответственно.');
    await db.batch([
      stmt(db,'UPDATE users SET name=?,department=?,version=version+1 WHERE id=? AND authorized=1',name,department,session.id),
      db.prepare('INSERT INTO state_guard(ok) VALUES(changes())'),
      db.prepare('DELETE FROM state_guard'),
      stmt(db,`UPDATE bookings SET name=?,department=? WHERE user_id=? AND status='active' AND (day>? OR (day=? AND end_min>?))`,name,department,session.id,now.day,now.day,now.minute)
    ]);
    return ok({name,department});
  }
  if(url.pathname==='/api/book'&&method==='POST'){
    let body;try{body=await readJson(request);}catch{return error(400,'Проверьте введённые данные.');}
    const roomId=Number(body.roomId),start=Number(body.start),end=Number(body.end),day=body.day,comment=sanitize(body.comment||'',300);
    if(!Number.isInteger(roomId)||!validRange(day,start,end,now,cfg)||comment.length>300)return error(400,'Проверьте дату, время и комментарий.');
    const room=await stmt(db,'SELECT id FROM rooms WHERE id=? AND active=1',roomId).first();if(!room)return error(400,'Комната недоступна.');
    try{
      await stmt(db,`INSERT INTO bookings(id,user_id,room_id,day,start_min,end_min,name,department,comment,created_at)
        SELECT ?,id,?,?,?,?,name,department,?,? FROM users WHERE id=?`,crypto.randomUUID(),roomId,day,start,end,comment,epoch,session.id).run();
      return ok({ok:true},201);
    }catch(e){if(/booking_slots|UNIQUE|constraint/i.test(String(e.message)))return error(409,'Это время уже заняли. Расписание обновлено.');throw e;}
  }
  if(url.pathname==='/api/cancel'&&method==='POST'){
    let body;try{body=await readJson(request);}catch{return error(400,'Неверный запрос.');}
    if(typeof body.id!=='string'||!/^[-0-9a-f]{36}$/.test(body.id))return error(400,'Неверный ID брони.');
    const result=await stmt(db,`UPDATE bookings SET status='cancelled',cancelled_by=?,cancelled_at=?
      WHERE id=? AND user_id=? AND status='active' AND (day>? OR (day=? AND end_min>?))`,session.id,epoch,body.id,session.id,now.day,now.day,now.minute).run();
    if(!result.meta?.changes)return error(404,'Бронь не найдена или уже отменена.');
    return ok({ok:true});
  }
  return error(404,'Страница не найдена.');
}
