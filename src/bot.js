import {localNow, addDays, validDay, validRange, config, time, date} from './time.js';
const button = (text, callback_data) => ({text, callback_data});
const grid = (items, width=3) => Array.from({length:Math.ceil(items.length/width)},(_,i)=>items.slice(i*width,(i+1)*width));
export const menu = () => [
  [button('📅 Забронировать','menu:new'),button('🗓 Расписание','menu:schedule')],
  [button('📋 Мои брони','menu:mine:0'),button('👤 Мой профиль','menu:profile')],
  [button('❓ Помощь','menu:help')]
];
const home = [button('🏠 Главное меню','menu:home')];
const clean = value => value.trim().replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/g,' ');
const nonce = () => crypto.randomUUID().slice(0,8);
const stmt = (db,sql,...args) => db.prepare(sql).bind(...args);
export {stmt};

export async function plan(env, user, update, nowDate = new Date()) {
  const db=env.DB, cfg=config(env), now=localNow(nowDate), epoch=Math.floor(nowDate.getTime()/1000);
  let state=JSON.parse(user.state), authorized=user.authorized, name=user.name, department=user.department;
  const mutations=[];
  const listedAdmin=String(env.ADMIN_IDS||'').split(',').map(x=>x.trim()).includes(String(user.id));
  let admin=listedAdmin && (state.adminUntil||0)>epoch;
  const text=typeof update.message?.text==='string'?update.message.text.trim():'';
  const cb=typeof update.callback_query?.data==='string'?update.callback_query.data:'';
  const move=(step, data={}) => {state={adminUntil:state.adminUntil||0,adminAttempts:state.adminAttempts||0,adminRetryAt:state.adminRetryAt||0,step,nonce:nonce(),expires:epoch+3600,...data};};
  const b=(label, action, value='') => button(label,`b:${state.nonce}:${action}:${value}`);
  const reply=(message,keyboard=menu()) => ({user:{authorized,name,department,state},mutations,
    response:{chat_id:user.id,text:message,reply_markup:{inline_keyboard:keyboard}}});
  const main=(message='🏢 Meeting Rooms IT Park\n\nВыберите действие. Время — Ташкент (UTC+5).') => {move('home'); return reply(message);};
  const room=async id=>stmt(db,'SELECT * FROM rooms WHERE id=? AND active=1',id).first();
  const occupied=async (id,day)=> (await stmt(db,'SELECT minute FROM booking_slots WHERE room_id=? AND day=?',id,day).all()).results.map(x=>x.minute);
  const chooseRooms=async mode=> {
    move('room',{mode});
    const rooms=(await db.prepare('SELECT * FROM rooms WHERE active=1 ORDER BY id').all()).results;
    return reply('🏢 Выберите переговорную.',[...rooms.map(r=>[b(r.name,'room',r.id)]),home]);
  };
  const chooseDays=async (id,mode,offset=0)=> {
    const r=await room(id); if(!r) return main('Эта переговорная недоступна.');
    offset=Math.max(0,Math.min(cfg.horizon-1,offset));
    move('day',{room:id,mode});
    const days=Array.from({length:Math.min(7,cfg.horizon-offset)},(_,i)=>addDays(now.day,offset+i));
    const keyboard=days.map((d,i)=>[b(`${offset+i===0?'Сегодня · ':offset+i===1?'Завтра · ':''}${date(d)}`,'day',d)]);
    const nav=[];
    if(offset>0) nav.push(b('← Раньше','days',Math.max(0,offset-7)));
    if(offset+7<cfg.horizon) nav.push(b('Позже →','days',offset+7));
    if(nav.length) keyboard.push(nav);
    keyboard.push([b('← Другой этаж','rooms')],home);
    return reply(`${r.name}\nВыберите дату. Доступны ближайшие ${cfg.horizon} дней.`,keyboard);
  };
  const chooseStart=async (id,day,notice='')=> {
    const r=await room(id);
    if(!r || !validDay(day,now,cfg.horizon)) return chooseRooms('book');
    const busy=new Set(await occupied(id,day));
    move('start',{room:id,day,mode:'book'});
    const slots=[];
    for(let m=cfg.open;m<cfg.close;m+=30) if(!busy.has(m) && (day>now.day || m>now.minute)) slots.push(b(time(m),'start',m));
    return reply(`${notice ? notice+'\n\n':''}${r.name}\n📅 ${date(day)} · Ташкент\n\n${slots.length?'Выберите начало. Показано только свободное время.':'Свободного времени на эту дату нет.'}\nБронь появится только после подтверждения.`,[...grid(slots,4),[b('← Другая дата','dates')],home]);
  };
  const duration=async (id,day,start)=> {
    const busy=new Set(await occupied(id,day));
    if(!validRange(day,start,start+30,now,cfg) || busy.has(start)) return chooseStart(id,day,'Это время уже недоступно. Выберите другое.');
    move('duration',{room:id,day,start});
    const choices=[];
    for(let end=start+30;end<=Math.min(cfg.close,start+cfg.maxDuration);end+=30) {
      if(busy.has(end-30)) break;
      choices.push(b(`${end-start} мин · до ${time(end)}`,'duration',end));
    }
    return reply(`📅 ${date(day)} · с ${time(start)}\nНа сколько времени нужна переговорная?`,[...grid(choices,2),[b('← Другое время','times')],home]);
  };
  const details=(booking,r)=> `${r.name}\n📅 ${date(booking.day)} · ${time(booking.start_min??booking.start)}–${time(booking.end_min??booking.end)}\n👤 ${booking.name??name}\n🏷 ${booking.department??department}${booking.comment?'\n💬 '+booking.comment:''}`;
  const confirm=async comment=> {
    const r=await room(state.room); if(!r) return main('Переговорная больше недоступна.');
    move('confirm',{room:state.room,day:state.day,start:state.start,end:state.end,comment});
    return reply('Проверьте бронь:\n\n'+details(state,r)+'\n\nПодтвердить?',[[b('✅ Подтвердить','confirm')],[b('← Изменить время','times')],home]);
  };
  const schedule=async (id,day,page=0)=> {
    const r=await room(id); if(!r || !validDay(day,now,cfg.horizon)) return chooseRooms('schedule');
    const rows=(await stmt(db,`SELECT * FROM bookings WHERE room_id=? AND day=? AND status='active' ORDER BY start_min`,id,day).all()).results;
    page=Math.max(0,Math.min(Math.floor(Math.max(0,rows.length-1)/5),page));
    move('schedule',{room:id,day,mode:'schedule'});
    const blocks=rows.slice(page*5,page*5+5).map(x=>`${time(x.start_min)}–${time(x.end_min)} · ${x.name}\n${x.department}${x.comment?'\n'+x.comment:''}${admin?'\nTelegram ID: '+x.user_id+'\nID брони: '+x.id:''}`);
    const busy=new Set(await occupied(id,day)), free=[];
    let start=null;
    for(let m=cfg.open;m<=cfg.close;m+=30) {
      const available=m<cfg.close&&!busy.has(m)&&(day>now.day||m>now.minute);
      if(available&&start===null) start=m;
      if(!available&&start!==null) {free.push(`${time(start)}–${time(m)}`);start=null;}
    }
    const nav=[];
    if(page>0) nav.push(b('← Назад','page',page-1));
    if((page+1)*5<rows.length) nav.push(b('Далее →','page',page+1));
    return reply(`🗓 ${r.name}\n${date(day)} · Ташкент\n\n${blocks.join('\n\n')||'Броней пока нет.'}\n\nСвободно: ${free.join(', ')||'нет доступного времени'}${rows.length>5?'\nСтраница '+(page+1):''}`,[...(nav.length?[nav]:[]),[b('🔄 Обновить','page',page)],[b('📅 Забронировать на эту дату','times')],[b('← Другая дата','dates')],home]);
  };
  const mine=async page=> {
    const rows=(await stmt(db,`SELECT b.*,r.name AS room_name FROM bookings b JOIN rooms r ON r.id=b.room_id
      WHERE user_id=? AND status='active' AND (day>? OR (day=? AND end_min>?)) ORDER BY day,start_min`,user.id,now.day,now.day,now.minute).all()).results;
    page=Math.max(0,Math.min(Math.floor(Math.max(0,rows.length-1)/5),page)); move('mine');
    const part=rows.slice(page*5,page*5+5);
    const blocks=part.map((x,i)=>`${i+1}. ${x.room_name}\n${date(x.day)} · ${time(x.start_min)}–${time(x.end_min)}${x.comment?'\n'+x.comment:''}`);
    const nav=[];
    if(page>0) nav.push(button('← Назад',`menu:mine:${page-1}`));
    if((page+1)*5<rows.length) nav.push(button('Далее →',`menu:mine:${page+1}`));
    return reply('📋 Ваши текущие и будущие брони\n\n'+(blocks.join('\n\n')||'У вас пока нет броней.'),[...part.map((x,i)=>[b(`Отменить №${i+1}`,'cancel',x.id)]),...(nav.length?[nav]:[]),home]);
  };
  const cancelPrompt=async id=> {
    const row=await stmt(db,`SELECT b.*,r.name AS room_name FROM bookings b JOIN rooms r ON r.id=b.room_id WHERE b.id=?`,id).first();
    if(!row || (row.user_id!==user.id&&!admin)) return main('Бронь не найдена или у вас нет права её отменить.');
    if(row.status!=='active') return main('Эта бронь уже отменена.');
    move('cancel_confirm',{booking:id});
    return reply('Отменить эту бронь?\n\n'+details(row,{name:row.room_name}),[[b('Да, отменить бронь','cancel_yes')],home]);
  };

  const profile=()=> {
    move('profile');
    return reply(`👤 Мой профиль\n\nИмя: ${name}\nОтдел: ${department}\nTelegram ID: ${user.id}\n\nДанные сохранены. Повторно вводить их не нужно.`,[
      [b('✏️ Изменить имя','edit_name')],[b('✏️ Изменить отдел','edit_department')],home]);
  };
  const adminHome=()=> {
    move('admin_home');
    return reply('🛠 Панель администратора\n\nВыберите действие. Доступ открыт на 1 час.\nПри создании брони владельцем будете вы; назначение встречи можно указать в комментарии.',[
      [b('📋 Текущие и будущие брони','admin_active',0)],
      [b('🗂 История всех броней','admin_history',0)],
      [b('👥 Сотрудники и Telegram ID','admin_users',0)],
      [b('➕ Создать бронь','admin_new')],
      [b('🔎 Найти бронь по ID','admin_find')],
      [b('📊 Статистика','admin_stats')],
      [b('🔒 Выйти из админ-панели','admin_logout')],home]);
  };
  const adminBack=()=>[b('← Админ-панель','admin_home')];
  const adminBookings=async (history,page=0)=> {
    page=Math.max(0,Math.trunc(Number(page)||0));
    const where=history?'1=1':"b.status='active' AND (b.day>? OR (b.day=? AND b.end_min>?))";
    const args=history?[]:[now.day,now.day,now.minute];
    const count=await stmt(db,`SELECT count(*) AS n FROM bookings b WHERE ${where}`,...args).first();
    page=Math.min(page,Math.floor(Math.max(0,count.n-1)/4));
    const rows=(await stmt(db,`SELECT b.*,r.name AS room_name FROM bookings b JOIN rooms r ON r.id=b.room_id WHERE ${where} ORDER BY b.day ${history?'DESC':'ASC'},b.start_min,b.id LIMIT 4 OFFSET ?`,...args,page*4).all()).results;
    move('admin_list',{history});
    const lines=rows.map((x,i)=>`${i+1}. ${x.room_name}\n${date(x.day)} · ${time(x.start_min)}–${time(x.end_min)}\n${x.name} · ${x.department}\nTelegram ID: ${x.user_id}\nID брони: ${x.id}\nСтатус: ${x.status==='cancelled'?'отменена':x.day<now.day||(x.day===now.day&&x.end_min<=now.minute)?'завершена':'активна'}${x.cancelled_by?'\nОтменил (Telegram ID): '+x.cancelled_by:''}${x.comment?'\n💬 '+x.comment:''}`);
    const action=history?'admin_history':'admin_active',nav=[];
    if(page>0)nav.push(b('← Назад',action,page-1));
    if((page+1)*4<count.n)nav.push(b('Далее →',action,page+1));
    return reply(`${history?'🗂 История':'📋 Текущие и будущие брони'} · всего ${count.n}\nСтраница ${page+1}\n\n${lines.join('\n\n')||'Броней нет.'}`,[
      ...rows.map((x,i)=>[b(`Открыть №${i+1}`,'admin_view',x.id)]),...(nav.length?[nav]:[]),adminBack(),home]);
  };
  const adminView=async id=> {
    const row=await stmt(db,'SELECT b.*,r.name AS room_name FROM bookings b JOIN rooms r ON r.id=b.room_id WHERE b.id=?',id).first();
    if(!row)return reply('Бронь с таким ID не найдена.',[adminBack(),home]);
    move('admin_view',{booking:id});
    return reply(details(row,{name:row.room_name})+`\n\nTelegram ID: ${row.user_id}\nID брони: ${row.id}\nСтатус: ${row.status==='cancelled'?'отменена':'не отменена'}${row.cancelled_by?'\nОтменил (Telegram ID): '+row.cancelled_by:''}`,[
      ...(row.status==='active'?[[b('❌ Отменить эту бронь','admin_cancel',row.id)]]:[]),adminBack(),home]);
  };
  const adminUsers=async page=> {
    page=Math.max(0,Math.trunc(Number(page)||0));
    const count=await db.prepare('SELECT count(*) AS n FROM users WHERE authorized=1').first();
    page=Math.min(page,Math.floor(Math.max(0,count.n-1)/8));
    const rows=(await stmt(db,'SELECT id,name,department FROM users WHERE authorized=1 ORDER BY id LIMIT 8 OFFSET ?',page*8).all()).results;
    move('admin_users');const nav=[];
    if(page>0)nav.push(b('← Назад','admin_users',page-1));
    if((page+1)*8<count.n)nav.push(b('Далее →','admin_users',page+1));
    return reply(`👥 Сотрудники · всего ${count.n}\nСтраница ${page+1}\n\n`+rows.map(x=>`${x.name||'Профиль не заполнен'}\n${x.department||'Отдел не указан'}\nTelegram ID: ${x.id}`).join('\n\n'),[...(nav.length?[nav]:[]),adminBack(),home]);
  };
  if(text==='/site'||text==='/website'||text==='/start site') {
    const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))).map(x=>x.toString(16).padStart(2,'0')).join('');
    mutations.push(stmt(db,'DELETE FROM web_links WHERE user_id=?',user.id));
    mutations.push(stmt(db,'INSERT INTO web_links(token_hash,user_id,expires_at) VALUES(?,?,?)',digest,user.id,epoch+600));
    return reply('🌐 Нажмите кнопку ниже, чтобы открыть Meeting Rooms. Ссылка действует 10 минут и только один раз.\n\nЕсли вы ещё не регистрировались, укажите имя, отдел и код доступа сотрудников уже на сайте. В боте регистрироваться не нужно.',[
      [{text:'Открыть Meeting Rooms',url:`https://itpark-room-bot.itpark.workers.dev/#login=${token}`}]
    ]);
  }
  if(text==='/web' && authorized && name && department) {
    const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const random=new Uint8Array(10);crypto.getRandomValues(random);
    const code=Array.from(random,x=>alphabet[x%alphabet.length]).join('');
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(code)))).map(x=>x.toString(16).padStart(2,'0')).join('');
    mutations.push(stmt(db,'DELETE FROM web_codes WHERE user_id=?',user.id));
    mutations.push(stmt(db,'INSERT INTO web_codes(code_hash,user_id,expires_at) VALUES(?,?,?)',hash,user.id,epoch+600));
    return reply(`🔐 Код входа на сайт: ${code}\n\nДействует 10 минут и только один раз. Никому его не пересылайте.\n\nСайт: https://itpark-room-bot.itpark.workers.dev`,menu());
  }
  if(text==='/id') return reply(`Ваш Telegram ID: ${user.id}`,authorized?menu():[]);
  if(!authorized) {
    if(listedAdmin) { authorized=1; move('name'); return reply('Добро пожаловать! Напишите ваше имя и фамилию.',[]); }
    const attempts=state.attempts||0, until=state.until||0;
    if(until>epoch && attempts>=5) return reply('Слишком много попыток. Повторите через 15 минут.',[]);
    if(!text || text.startsWith('/')) return reply('🏢 Meeting Rooms IT Park\n\nДля сайта отправьте /site — регистрация в боте не требуется.\n\nЧтобы бронировать прямо в боте, введите код доступа сотрудников. Его можно получить у ответственного за комнаты.',[]);
    if(text!==env.STAFF_ACCESS_CODE) {
      state={step:'access',attempts:until>epoch?attempts+1:1,until:until>epoch?until:epoch+900};
      return reply('Код не подошёл. Проверьте его у ответственного за переговорные.',[]);
    }
    authorized=1; move('name'); return reply('Доступ открыт ✅\nНапишите ваше имя и фамилию (2–80 символов).',[]);
  }
  if(name && department && (['/start','/menu','/cancel'].includes(text)||cb==='menu:home')) return main();
  if((text==='/profile'||cb==='menu:profile') && name && department) return profile();
  if(state.step==='name'||(!name&&state.step!=='department')) {
    if(!text || text.startsWith('/') || clean(text).length<2 || clean(text).length>80) return reply('Напишите ваше имя и фамилию: от 2 до 80 символов.',[]);
    name=clean(text);move('department');return reply('Как называется ваш отдел? (2–100 символов)',[]);
  }
  if(state.step==='department'||!department) {
    if(!text || text.startsWith('/') || clean(text).length<2 || clean(text).length>100) return reply('Напишите название отдела: от 2 до 100 символов.',[]);
    department=clean(text);return main(`Профиль сохранён ✅\n👤 ${name}\n🏷 ${department}\n\nТеперь можно бронировать переговорные.`);
  }

  if(text==='/admin') {
    if(!listedAdmin)return reply('Админ-панель доступна только назначенным администраторам. Ваш ID: '+user.id);
    if(!env.ADMIN_PASSCODE)return reply('Не задан ADMIN_PASSCODE в настройках Cloudflare.');
    if(admin)return adminHome();
    move('admin_password');return reply('🔐 Введите код администратора. /cancel — выйти.',[home]);
  }
  if(state.step==='admin_password' && text && !text.startsWith('/')) {
    if(!listedAdmin || !env.ADMIN_PASSCODE)return main('Нет доступа к админ-панели.');
    if(state.adminRetryAt>epoch && state.adminAttempts>=5)return reply('Слишком много попыток. Повторите через 15 минут.',[home]);
    if(text!==env.ADMIN_PASSCODE) {
      if(!(state.adminRetryAt>epoch)){state.adminAttempts=0;state.adminRetryAt=epoch+900;}
      state.adminAttempts=(state.adminAttempts||0)+1;
      return reply('Неверный код администратора.',[home]);
    }
    state.adminUntil=epoch+3600;state.adminAttempts=0;state.adminRetryAt=0;admin=true;return adminHome();
  }
  if(state.step==='admin_find' && text && !text.startsWith('/')) {
    if(!admin)return main('Доступ истёк. Войдите через /admin.');
    return adminView(text);
  }
  if(['edit_name','edit_department'].includes(state.step) && text && !text.startsWith('/')) {
    if(state.expires<epoch)return profile();
    const value=clean(text),limit=state.step==='edit_name'?80:100;
    if(value.length<2||value.length>limit)return reply(`Введите от 2 до ${limit} символов.`,[home]);
    if(state.step==='edit_name')name=value;else department=value;
    mutations.push(stmt(db,`UPDATE bookings SET name=?,department=? WHERE user_id=? AND status='active' AND (day>? OR (day=? AND end_min>?))`,name,department,user.id,now.day,now.day,now.minute));
    return profile();
  }
  if(text==='/start'||text==='/menu'||text==='/cancel'||cb==='menu:home') return main();
  if(text==='/help'||cb==='menu:help') return reply(`Как забронировать:\n1. Нажмите «Забронировать».\n2. Выберите этаж, дату и время.\n3. Укажите длительность (шаг 30 минут).\n4. Добавьте комментарий или пропустите.\n5. Нажмите «Подтвердить».\n\nДо подтверждения время не закрепляется. При одновременных заявках выигрывает первая успешная запись в базу.\n\nЧасы: ${time(cfg.open)}–${time(cfg.close)}, включая выходные. Максимум ${cfg.maxDuration/60} ч. за одну бронь.\nВсе даты и время — Ташкент. Имя, отдел и комментарий видны сотрудникам.\nОтмена: «Мои брони». Изменение: отмените бронь и создайте новую.\n/cancel — выйти из текущего шага. /profile — посмотреть или изменить профиль. /id — ваш ID.${admin?'\n\nАдминистратор: /cancel_booking ID — отменить любую бронь. ID отображаются в расписании. /admin — панель управления.':''}`);
  if(text==='/book'||cb==='menu:new') return chooseRooms('book');
  if(text==='/schedule'||cb==='menu:schedule') return chooseRooms('schedule');
  if(text==='/my'||cb.startsWith('menu:mine:')) return mine(Number(cb.split(':')[2])||0);
  if(text.startsWith('/cancel_booking ')) return admin?cancelPrompt(text.split(/\s+/)[1]):main('Эта команда доступна только администратору.');
  if(cb.startsWith('b:')) {
    const [,token,action,value]=cb.split(':');
    if(token!==state.nonce || state.expires<epoch) return reply('Эта кнопка устарела. Начните заново через меню.');

    if(action==='edit_name'||action==='edit_department') {
      if(state.step!=='profile')return profile();
      move(action);return reply(action==='edit_name'?'Введите новое имя и фамилию (2–80 символов).':'Введите новое название отдела (2–100 символов).',[home]);
    }
    if(action.startsWith('admin_')) {
      if(!admin)return main('Нет доступа или сессия истекла. Войдите через /admin.');
      if(action==='admin_home')return adminHome();
      if(action==='admin_active')return adminBookings(false,value);
      if(action==='admin_history')return adminBookings(true,value);
      if(action==='admin_users')return adminUsers(value);
      if(action==='admin_view')return adminView(value);
      if(action==='admin_cancel')return cancelPrompt(value);
      if(action==='admin_new')return chooseRooms('book');
      if(action==='admin_find'){move('admin_find');return reply('Отправьте полный ID брони.',[adminBack(),home]);}
      if(action==='admin_logout'){state.adminUntil=0;admin=false;return main('Вы вышли из админ-панели.');}
      if(action==='admin_stats'){
        const stats=await stmt(db,`SELECT count(*) AS total,sum(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled,sum(CASE WHEN status='active' AND (day>? OR (day=? AND end_min>?)) THEN 1 ELSE 0 END) AS upcoming FROM bookings`,now.day,now.day,now.minute).first();
        move('admin_stats');return reply(`📊 Статистика\nВсего броней: ${stats.total}\nТекущих и будущих: ${stats.upcoming||0}\nОтменённых: ${stats.cancelled||0}`,[adminBack(),home]);
      }
      return adminHome();
    }
    if(action==='rooms') return chooseRooms(state.mode||'book');
    if(action==='dates') return chooseDays(state.room,state.mode||'book');
    if(action==='days' && state.step==='day') return chooseDays(state.room,state.mode,Number(value)||0);
    if(action==='room' && state.step==='room') return chooseDays(Number(value),state.mode);
    if(action==='day' && state.step==='day' && validDay(value,now,cfg.horizon)) return state.mode==='schedule'?schedule(state.room,value):chooseStart(state.room,value);
    if(action==='times' && state.room&&state.day) return chooseStart(state.room,state.day);
    if(action==='start' && state.step==='start') return duration(state.room,state.day,Number(value));
    if(action==='duration' && state.step==='duration') {
      if(!validRange(state.day,state.start,Number(value),now,cfg)) return chooseStart(state.room,state.day,'Недопустимое время.');
      move('comment',{room:state.room,day:state.day,start:state.start,end:Number(value)});
      return reply('Для чего нужна переговорная?\nНапишите комментарий (до 300 символов) или пропустите этот шаг.\nКомментарий будет виден сотрудникам.',[[b('Пропустить','skip')],home]);
    }
    if(action==='skip'&&state.step==='comment') return confirm('');
    if(action==='page'&&state.step==='schedule') return schedule(state.room,state.day,Number(value)||0);
    if(action==='cancel'&&state.step==='mine') return cancelPrompt(value);
    if(action==='cancel_yes'&&state.step==='cancel_confirm') {
      const row=await stmt(db,'SELECT * FROM bookings WHERE id=?',state.booking).first();
      if(!row || (row.user_id!==user.id&&!admin)) return main('Нет права отменить эту бронь.');
      mutations.push(stmt(db,`UPDATE bookings SET status='cancelled',cancelled_by=?,cancelled_at=? WHERE id=? AND status='active' AND (user_id=? OR ?=1)`,user.id,epoch,row.id,user.id,admin?1:0));
      return main('Бронь отменена ✅\nВремя снова доступно для бронирования.');
    }
    if(action==='confirm'&&state.step==='confirm') {
      if(!validRange(state.day,state.start,state.end,now,cfg)) return chooseStart(state.room,state.day,'Время бронирования уже недоступно.');
      const r=await room(state.room); if(!r) return main('Переговорная недоступна.');
      const busy=await occupied(state.room,state.day);
      if(busy.some(m=>m>=state.start&&m<state.end)) return chooseStart(state.room,state.day,'⚠️ Это время уже забронировал другой сотрудник. Выберите другое.');
      const id=crypto.randomUUID();
      mutations.push(stmt(db,`INSERT INTO bookings(id,user_id,room_id,day,start_min,end_min,name,department,comment,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,id,user.id,state.room,state.day,state.start,state.end,name,department,state.comment,epoch));
      const message='✅ Переговорная забронирована!\n\n'+details(state,r)+'\n\nОтменить можно в разделе «Мои брони».';
      return main(message);
    }
    return reply('Эта кнопка недоступна на текущем шаге. Выберите действие в меню.');
  }
  if(state.step==='comment' && text && !text.startsWith('/')) {
    if(state.expires<epoch) return main('Время заполнения истекло. Начните бронирование заново.');
    if(clean(text).length>300) return reply('Сократите комментарий до 300 символов.',[[b('Пропустить','skip')],home]);
    return confirm(clean(text));
  }
  return reply('Выберите действие кнопками ниже.');
}

// State, reservation and response are committed together. Telegram retries cannot
// create another booking; optimistic state checks also protect simultaneous clicks.
export async function processUpdate(env, update, now = new Date()) {
  if(!update||typeof update!=='object'||Array.isArray(update))return null;
  const source=update.callback_query?.message || update.message;
  const from=update.callback_query?.from || update.message?.from;
  if(!source || source.chat?.type!=='private' || !from || from.is_bot || !Number.isSafeInteger(from.id)||from.id<=0 || source.chat.id!==from.id || !Number.isSafeInteger(update.update_id)) return null;
  const db=env.DB,id=from.id;
  await stmt(db,'INSERT OR IGNORE INTO users(id) VALUES(?)',id).run();
  for(let attempt=0;attempt<6;attempt++) {
    const receipt=await stmt(db,'SELECT * FROM receipts WHERE update_id=?',update.update_id).first();
    if(receipt) return receipt.delivered?null:JSON.parse(receipt.response);
    const user=await stmt(db,'SELECT * FROM users WHERE id=?',id).first();
    if(update.update_id<=user.last_update && Math.floor(now.getTime()/1000)-user.last_seen<7*86400) return null;
    const result=await plan(env,user,update,now), next=result.user;
    try {
      await db.batch([
        stmt(db,`UPDATE users SET authorized=?,name=?,department=?,state=?,version=version+1,last_update=?,last_seen=? WHERE id=? AND version=?`,next.authorized,next.name,next.department,JSON.stringify(next.state),update.update_id,Math.floor(now.getTime()/1000),id,user.version),
        db.prepare('INSERT INTO state_guard(ok) VALUES(changes())'),
        db.prepare('DELETE FROM state_guard'),
        ...result.mutations,
        stmt(db,'INSERT INTO receipts(update_id,response,created_at) VALUES(?,?,?)',update.update_id,JSON.stringify(result.response),Math.floor(now.getTime()/1000))
      ]);
      return result.response;
    } catch(error) {
      const message=String(error.message);
      if(!/stale_state|state_guard|booking_slots|receipts.update_id/.test(message)) throw error;
      // Re-read current state and occupied slots, then build a correct response.
    }
  }
  throw new Error('Concurrent update retry limit');
}
