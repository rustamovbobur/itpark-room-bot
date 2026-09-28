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
 const ctx=vm.createContext({document:{querySelector:s=>{if(!nodes.has(s))nodes.set(s,new Element());return nodes.get(s);},createElement:t=>new Element(t),querySelectorAll:()=>[],hidden:false},window:{location:{hash:options.hash||'',pathname:'/',search:'',reload(){}},history:{replaceState(){}},confirm:()=>true},sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},URLSearchParams,Date,Intl,AbortSignal,setInterval(){},setTimeout(){},fetch:async(path,options)=>{calls.push({path,options});const result=await responder(path,options);return result instanceof Response?result:Response.json(result);}});
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
