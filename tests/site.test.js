import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {html,client} from '../src/site.js';
// A small DOM harness executes the real client script; this is not a browser render test.
class Element {
 constructor(tag='div'){this.tag=tag;this.children=[];this.hidden=false;this.disabled=false;this.handlers={};this.style={};this.classList={toggle(){}};this._value='';}
 get value(){return this._value||(this.tag==='select'?String(this.children[0]?.value??''):'');}set value(v){this._value=String(v);}
 get options(){return this.children;}
 append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;this._value='';}
 setAttribute(k,v){this[k]=v;}addEventListener(k,v){this.handlers[k]=v;}focus(){}showModal(){this.open=true;}close(){this.open=false;}
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function harness(options={}){
 const storage=options.storage||new Map();
 const nodes=new Map();for(const match of html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"/g))nodes.set('#'+match[2],new Element(match[1]));
 const calls=[],me={id:42,name:'Имя',department:'Отдел',day:'2030-12-31',horizon:3,open:480,close:1200,maxDuration:240,adminEligible:true};
 let responder=options.responder|| (async path=>path==='/api/me'?me:path.startsWith('/api/schedule')?{rooms:[{id:5,name:'Комната'}],bookings:[]}:{ok:true});
 const FixedDate=class extends Date{static now(){return options.now??Date.now();}};
 const ctx=vm.createContext({document:{querySelector:s=>{if(!nodes.has(s))nodes.set(s,new Element());return nodes.get(s);},createElement:t=>new Element(t),querySelectorAll:()=>[],hidden:false},window:{location:{hash:options.hash||'',pathname:'/',search:'',reload(){}},history:{replaceState(){}},confirm:()=>true},sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},URLSearchParams,Date:FixedDate,Intl,AbortSignal,setInterval(){},setTimeout(){},fetch:async(path,options)=>{calls.push({path,options});const result=await responder(path,options);return result instanceof Response?result:Response.json(result);}});
 vm.runInContext(client,ctx);await tick();await tick();
 return {ctx,nodes,calls,storage,setResponder:r=>responder=r};
}
test('date arrows cross year boundary and stop at both date limits',async()=>{
 const {nodes}=await harness();assert.equal(nodes.get('#prev-day').disabled,true);
 nodes.get('#next-day').onclick();assert.equal(nodes.get('#day').value,'2031-01-01');
 nodes.get('#next-day').onclick();assert.equal(nodes.get('#day').value,'2031-01-02');assert.equal(nodes.get('#next-day').disabled,true);
 nodes.get('#next-day').onclick();assert.equal(nodes.get('#day').value,'2031-01-02');
 nodes.get('#prev-day').onclick();assert.equal(nodes.get('#day').value,'2031-01-01');
});
test('open booking retains its selected date even if the page date changes',async()=>{
 const {ctx,nodes,calls}=await harness();vm.runInContext("openBooking(state.rooms[0],600);state.day='2031-01-01'",ctx);
 await nodes.get('#booking-form').handlers.submit({preventDefault(){},submitter:new Element('button')});
 const body=JSON.parse(calls.find(c=>c.path==='/api/book').options.body);assert.equal(body.day,'2030-12-31');
});
test('older schedule response cannot overwrite a newer response for the same day',async()=>{
 const {ctx,setResponder}=await harness(),pending=[];
 setResponder(()=>new Promise(resolve=>pending.push(resolve)));
 const first=vm.runInContext('refresh()',ctx),second=vm.runInContext('refresh()',ctx);
 pending[1]({rooms:[{id:5,name:'New'}],bookings:[]});await second;
 pending[0]({rooms:[{id:5,name:'Old'}],bookings:[]});await first;
 assert.equal(vm.runInContext('state.rooms[0].name',ctx),'New');
});
test('today schedule starts at the current half-hour and date arrows load full future days',async()=>{
 const {nodes,ctx}=await harness({now:Date.parse('2030-12-31T10:05:00Z')});
 let labels=nodes.get('#schedule-grid').children.filter(node=>node.className==='time-cell').map(node=>node.textContent);
 assert.equal(labels[0],'15:00');assert.equal(labels.includes('14:30'),false);assert.equal(labels.includes('08:00'),false);
 nodes.get('#next-day').onclick();await tick();await tick();
 labels=nodes.get('#schedule-grid').children.filter(node=>node.className==='time-cell').map(node=>node.textContent);
 assert.equal(labels[0],'08:00');
});
test('expired normal session returns the user to the login view',async()=>{
 const {ctx,nodes,setResponder}=await harness();setResponder(()=>Response.json({error:'Expired'},{status:401}));
 await assert.rejects(vm.runInContext("api('me')",ctx));assert.equal(nodes.get('#workspace').hidden,true);assert.equal(nodes.get('#login').hidden,false);
});
test('logo links to homepage and attribution has a separate local page',()=>{
 assert.match(html,/<a class="brand-logo" href="\/"/);assert.match(html,/href="\/credits"/);
});

test('unfinished first registration survives a page reload without re-opening Telegram',async()=>{
 const first=await harness({hash:'#login='+'a'.repeat(64),responder:async()=>({needsProfile:true})});
 assert.equal(first.storage.get('itpark_pending_link'),'a'.repeat(64));
 const second=await harness({storage:first.storage,responder:async()=>({needsProfile:true})});
 assert.equal(second.nodes.get('#link-profile-form').hidden,false);
 assert.equal(second.calls[0].path,'/api/link');
});

test('morning, closing time, and ongoing meetings render correctly',async()=>{
 const {ctx,nodes}=await harness();
 vm.runInContext("state.now={day:'2030-12-31',minute:360};renderSchedule()",ctx);
 const grid=nodes.get('#schedule-grid');
 assert.equal(grid.children.find(n=>n.className==='time-cell').textContent,'08:00');
 vm.runInContext("state.now.minute=905;state.bookings=[{id:'ongoing',room_id:5,start_min:840,end_min:960,name:'Имя',department:'Отдел',user_id:42}];renderSchedule()",ctx);
 const meeting=grid.children.find(n=>n.className==='event mine');
 assert.ok(meeting);assert.equal(meeting.style.gridArea,'2 / 2 / span 2 / span 1');
 assert.equal(meeting.children[0].textContent,'14:00–16:00');
 meeting.onclick();assert.equal(nodes.get('#detail-dialog').open,true);
 vm.runInContext("state.now.minute=1200;renderSchedule()",ctx);
 assert.equal(grid.children.filter(n=>n.className==='time-cell').length,0);
 assert.match(grid.children.at(-1).textContent,/рабочее время закончилось/);
 assert.doesNotMatch(grid.style.gridTemplateRows,/repeat\(0/);
});
test('saving profile immediately reloads the schedule with the new name',async()=>{
 const {nodes,calls,setResponder,ctx}=await harness();
 setResponder(async path=>path==='/api/profile'?{name:'Новое имя',department:'Новый отдел'}:{rooms:[{id:5,name:'Комната'}],bookings:[{room_id:5,start_min:600,end_min:630,name:'Новое имя',department:'Новый отдел',user_id:42}]});
 nodes.get('#profile-name').value='Новое имя';nodes.get('#profile-department').value='Новый отдел';
 await nodes.get('#profile-form').handlers.submit({preventDefault(){},submitter:new Element('button')});
 assert.equal(vm.runInContext('state.bookings[0].name',ctx),'Новое имя');
 assert.equal(calls.at(-1).path,'/api/schedule?day=2030-12-31');
});
