const fs=require('fs');
const dir='C:/Users/kenzh/Documents/deepseek-harness/default-workspace/kanju-clone/server/data/_zc_batches';
const n=process.argv[2];
const inIds=JSON.parse(fs.readFileSync(dir+'/b'+n+'.json','utf8')).map(r=>r.id);
const out=JSON.parse(fs.readFileSync(dir+'/b'+n+'.out.json','utf8'));
const keys=Object.keys(out);
const probs=[];
for(const id of inIds){ if(!out[id]) probs.push('MISSING '+id); }
for(const k of keys){ if(!inIds.includes(k)) probs.push('EXTRA '+k); }
for(const k of keys){
  const v=out[k];
  if(!v.title||!v.synopsis){probs.push('EMPTY '+k);continue;}
  if(/[A-Za-z]/.test(v.synopsis)) probs.push('LATIN in synopsis '+k+' :: '+v.synopsis.match(/[A-Za-z]+/g));
  if(/[A-Za-z]/.test(v.title)) probs.push('LATIN in title '+k);
  const L=[...v.synopsis].length;
  if(L<40||L>130) probs.push('LEN '+L+' '+k);
}
console.log('in='+inIds.length+' out='+keys.length+' problems='+probs.length);
probs.slice(0,40).forEach(p=>console.log(' - '+p));
