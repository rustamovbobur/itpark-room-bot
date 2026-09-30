import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {userColor,colorBookings,validColor} from '../src/colors.js';
function setup(){
 const sql=new DatabaseSync(':memory:');for(const file of ['0001_initial.sql','0006_user_colors.sql'])sql.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 for(let id=1;id<=25;id++)sql.prepare('INSERT INTO users(id) VALUES(?)').run(id);
 const db={prepare(query){return {bind(...args){return {first:async()=>sql.prepare(query).get(...args)||null,all:async()=>({results:sql.prepare(query).all(...args)}),run:async()=>sql.prepare(query).run(...args)}}}}};
 return {sql,db};
}
test('initial colors survive reload, retry collisions, and avoid chosen colors',async()=>{
 const {db,sql}=setup();try{
  assert.equal(await userColor(db,1,()=>'#123456'),'#123456');
  let count=0;assert.equal(await userColor(db,2,()=>++count===1?'#123456':'#654321'),'#654321');
  sql.prepare("UPDATE user_colors SET custom_color='#abcdef' WHERE user_id=1").run();count=0;
  assert.equal(await userColor(db,3,()=>++count===1?'#abcdef':'#112233'),'#112233');
  assert.equal(await userColor(db,1),'#abcdef');
  const rows=await colorBookings(db,[{user_id:1},{user_id:1},{user_id:2}]);
  assert.deepEqual(rows.map(r=>r.color),['#abcdef','#abcdef','#654321']);
 }finally{sql.close();}
});
test('concurrent color requests have one persistent winner per user and distinct initial colors',async()=>{
 const {db,sql}=setup();try{
  const same=await Promise.all(Array.from({length:20},()=>userColor(db,1)));
  assert.equal(new Set(same).size,1);
  const all=await Promise.all(Array.from({length:25},(_,i)=>userColor(db,i+1)));
  assert.equal(new Set(all).size,25);assert.ok(all.every(validColor));
  sql.prepare("UPDATE user_colors SET custom_color='#000000' WHERE user_id IN (1,2)").run();
  assert.equal(await userColor(db,1),await userColor(db,2));
 }finally{sql.close();}
});

test('large admin history stays within bounded SQL parameter batches',async()=>{
 const {db,sql}=setup();try{
  for(let id=1;id<=130;id++){
   if(id>25)sql.prepare('INSERT INTO users(id) VALUES(?)').run(id);
   sql.prepare('INSERT INTO user_colors(user_id,initial_color) VALUES(?,?)').run(id,'#'+id.toString(16).padStart(6,'0'));
  }
  const guarded={prepare(query){const statement=db.prepare(query);return {bind(...args){assert.ok(args.length<=80);return statement.bind(...args);}};}};
  const rows=await colorBookings(guarded,Array.from({length:130},(_,i)=>({user_id:i+1})));
  assert.equal(rows.length,130);assert.equal(rows.at(-1).color,'#000082');
 }finally{sql.close();}
});
