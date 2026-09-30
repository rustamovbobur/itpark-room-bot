import {stmt} from './bot.js';
export const validColor=value=>typeof value==='string'&&/^#[0-9a-f]{6}$/i.test(value);
const randomColor=()=>'#'+Array.from(crypto.getRandomValues(new Uint8Array(3)),x=>x.toString(16).padStart(2,'0')).join('');

export async function userColor(db,id,generate=randomColor){
  for(let attempt=0;attempt<12;attempt++){
    const found=await stmt(db,'SELECT COALESCE(custom_color,initial_color) AS color FROM user_colors WHERE user_id=?',id).first();
    if(found)return found.color;
    const color=generate();
    if(!validColor(color))throw new Error('Invalid generated color');
    // Both uniqueness checks happen inside the INSERT. Concurrent requests for
    // the same employee reuse the winner; a random collision is retried.
    await stmt(db,`INSERT OR IGNORE INTO user_colors(user_id,initial_color)
      SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM user_colors WHERE custom_color=?)`,id,color.toLowerCase(),color.toLowerCase()).run();
  }
  const found=await stmt(db,'SELECT COALESCE(custom_color,initial_color) AS color FROM user_colors WHERE user_id=?',id).first();
  if(found)return found.color;
  throw new Error('Could not allocate a user color');
}
export async function colorBookings(db,rows){
  const ids=[...new Set(rows.map(row=>row.user_id))];if(!ids.length)return rows;
  const colors=new Map();
  for(let offset=0;offset<ids.length;offset+=80){
    const part=ids.slice(offset,offset+80);
    const stored=(await stmt(db,`SELECT user_id,COALESCE(custom_color,initial_color) AS color FROM user_colors WHERE user_id IN (${part.map(()=>'?').join(',')})`,...part).all()).results;
    for(const row of stored)colors.set(row.user_id,row.color);
  }
  for(const id of ids)if(!colors.has(id))colors.set(id,await userColor(db,id));
  return rows.map(row=>({...row,color:colors.get(row.user_id)}));
}
