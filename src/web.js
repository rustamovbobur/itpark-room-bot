import {stmt} from './bot.js';
import {localNow,validDay,validRange,config} from './time.js';

const encoder=new TextEncoder();
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)))).map(b=>b.toString(16).padStart(2,'0')).join('');
const error=(status,message)=>Response.json({error:message},{status,headers:{'cache-control':'no-store'}});
const ok=(value,status=200,headers={})=>Response.json(value,{status,headers:{'cache-control':'no-store',...headers}});
const cookie=(token,age)=>`itpark_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/api; Max-Age=${age}`;
const sanitize=(str,max)=>typeof str==='string'?str.trim().replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/g,' ').slice(0,max+1):'';
const randomToken=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
const readJson=async request=>{
  if(!(request.headers.get('content-type')||'').toLowerCase().startsWith('application/json'))throw new Error('type');
  if(Number(request.headers.get('content-length'))>4096)throw new Error('size');
  const value=await request.text();if(value.length>4096)throw new Error('size');
  return JSON.parse(value);
};
const ipKey=async request=>hash(request.headers.get('cf-connecting-ip')||'unknown');

export async function web(request,env,clock=new Date()){
  const url=new URL(request.url),method=request.method,db=env.DB,epoch=Math.floor(clock.getTime()/1000),now=localNow(clock),cfg=config(env);
  if(method==='POST' && request.headers.get('origin')!==url.origin)return error(403,'Обновите страницу и попробуйте ещё раз.');
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
      if(!found)return error(401,'Код неверен или его срок истёк. Отправьте /web боту ещё раз.');
      const token=randomToken(),tokenHash=await hash(token);
      // Deletion and guard make the one-time code single-use even with concurrent requests.
      await db.batch([
        stmt(db,'DELETE FROM web_codes WHERE code_hash=? AND expires_at>?',digest,epoch),
        db.prepare('INSERT INTO state_guard(ok) VALUES(changes())'),
        db.prepare('DELETE FROM state_guard'),
        stmt(db,'INSERT INTO web_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)',tokenHash,found.user_id,epoch+30*86400,epoch),
        stmt(db,'DELETE FROM web_login_attempts WHERE source_hash=?',source)
      ]);
      return ok({ok:true},200,{'set-cookie':cookie(token,30*86400)});
    }catch{return error(401,'Код уже использован или временно недоступен. Отправьте /web боту ещё раз.');}
  }
  const token=/^(?:.*;\s*)?itpark_session=([a-f0-9]{64})(?:;.*)?$/.exec(request.headers.get('cookie')||'')?.[1];
  const session=token?await stmt(db,`SELECT u.id,u.name,u.department,u.authorized FROM web_sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>?`,await hash(token),epoch).first():null;
  if(!session||!session.authorized)return error(401,'Войдите через Telegram.');
  if(url.pathname==='/api/me'&&method==='GET')return ok({id:session.id,name:session.name,department:session.department,day:now.day,open:cfg.open,close:cfg.close,horizon:cfg.horizon,maxDuration:cfg.maxDuration});
  if(url.pathname==='/api/logout'&&method==='POST'){
    await stmt(db,'DELETE FROM web_sessions WHERE token_hash=?',await hash(token)).run();
    return ok({ok:true},200,{'set-cookie':cookie('',0)});
  }
  if(url.pathname==='/api/schedule'&&method==='GET'){
    const day=url.searchParams.get('day');if(!validDay(day,now,cfg.horizon))return error(400,'Дата вне доступного периода.');
    const rooms=(await db.prepare('SELECT id,name FROM rooms WHERE active=1 ORDER BY id').all()).results;
    const bookings=(await stmt(db,`SELECT b.id,b.room_id,b.day,b.start_min,b.end_min,b.name,b.department,b.comment,b.user_id
      FROM bookings b JOIN rooms r ON r.id=b.room_id AND r.active=1 WHERE b.day=? AND b.status='active' ORDER BY b.room_id,b.start_min`,day).all()).results;
    return ok({day,rooms,bookings});
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
    await stmt(db,'UPDATE users SET name=?,department=? WHERE id=? AND authorized=1',name,department,session.id).run();
    return ok({name,department});
  }
  if(url.pathname==='/api/book'&&method==='POST'){
    let body;try{body=await readJson(request);}catch{return error(400,'Проверьте введённые данные.');}
    const roomId=Number(body.roomId),start=Number(body.start),end=Number(body.end),day=body.day,comment=sanitize(body.comment||'',300);
    if(!Number.isInteger(roomId)||!validRange(day,start,end,now,cfg)||comment.length>300)return error(400,'Проверьте дату, время и комментарий.');
    const room=await stmt(db,'SELECT id FROM rooms WHERE id=? AND active=1',roomId).first();if(!room)return error(400,'Комната недоступна.');
    try{
      await stmt(db,`INSERT INTO bookings(id,user_id,room_id,day,start_min,end_min,name,department,comment,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`,crypto.randomUUID(),session.id,roomId,day,start,end,session.name,session.department,comment,epoch).run();
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
