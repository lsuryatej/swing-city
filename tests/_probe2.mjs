import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toMono, computeOnsetEnvelope, pickPeaks } from '../src/audio/analyzer/onset.js';
const DIR='tests/audio';
function readWav(p){const b=readFileSync(p);let pos=12,ch=0,sr=0,ds=-1,dl=0;
 while(pos+8<=b.length){const id=b.toString('ascii',pos,pos+4);const sz=b.readUInt32LE(pos+4);const bo=pos+8;
  if(id==='fmt '){ch=b.readUInt16LE(bo+2);sr=b.readUInt32LE(bo+4);}else if(id==='data'){ds=bo;dl=Math.min(sz,b.length-bo);}
  pos=bo+sz+(sz%2);}
 const fr=Math.floor(dl/(2*ch));const out=new Float32Array(fr);
 for(let i=0;i<fr;i++)out[i]=b.readInt16LE(ds+i*ch*2)/32768;return{mono:out,sr};}
const pc=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return s[Math.round(p*(s.length-1))];};
for(const n of ['four-on-floor-128','breakbeat-140-offset','sparse-pad-72']){
  const {mono,sr}=readWav(join(DIR,n+'.wav'));
  const {envelope,frameRate,frameTime}=computeOnsetEnvelope(mono,sr);
  const on=pickPeaks(envelope,frameRate,frameTime);
  const e=Array.from(envelope);
  const desc=[...e].sort((a,b)=>b-a);
  console.log(`\n== ${n}  frames=${e.length} onsets=${on.length}`);
  console.log(`   env p50=${pc(e,.5).toFixed(4)} p90=${pc(e,.9).toFixed(4)} p99=${pc(e,.99).toFixed(4)} 4thMax=${desc[3].toFixed(4)} max=${desc[0].toFixed(4)}`);
  const st=on.map(o=>o.strength).sort((a,b)=>b-a);
  console.log(`   onset strengths: top=${st.slice(0,5).map(x=>x.toFixed(2)).join(',')} med=${pc(st,.5).toFixed(3)} min=${st[st.length-1].toFixed(4)}`);
  const buckets=[0,.02,.05,.1,.2,.4,1.01];
  const hist=buckets.slice(0,-1).map((lo,i)=>`${lo}-${buckets[i+1]}:${st.filter(s=>s>=lo&&s<buckets[i+1]).length}`);
  console.log(`   strength hist ${hist.join('  ')}`);
  console.log(`   first 12 onset t: ${on.slice(0,12).map(o=>o.t.toFixed(3)).join(' ')}`);
}
