import { spawn } from 'node:child_process';
import { analyzeVerbose } from '../src/audio/analyzer/index.js';
const SR=44100;
function dec(p){return new Promise((res,rej)=>{const ff=spawn('ffmpeg',['-v','error','-i',p,'-f','f32le','-ac','1','-ar',String(SR),'-']);
 const c=[];ff.stdout.on('data',d=>c.push(d));ff.on('close',()=>{const b=Buffer.concat(c);const n=(b.length/4)|0;const o=new Float32Array(n);
 for(let i=0;i<n;i++)o[i]=b.readFloatLE(i*4);res(o);});ff.on('error',rej);});}
const pc=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return s[Math.round(p*(s.length-1))];};
for(const n of ['whats-up-danger','calling','loser','oh-yeah']){
  const mono=await dec(`public/audio/scratch/${n}.mp3`);
  const {beatMap:bm,tracked,onsets}=analyzeVerbose([mono],SR);
  const d=tracked.diagnostics;
  const P=60/bm.bpm;
  console.log(`\n===== ${n}  ${bm.bpm.toFixed(2)}bpm conf=${bm.bpmConfidence.toFixed(3)} hitR=${d.hitRate.toFixed(3)} supp=${d.support.toFixed(3)} onsets=${onsets.length} beats=${bm.beats.length} trk=${d.trackedBeats}`);
  const st=onsets.map(o=>o.strength);
  console.log(`  onset strength: p10=${pc(st,.1).toFixed(2)} p50=${pc(st,.5).toFixed(2)} p90=${pc(st,.9).toFixed(2)}  onsets/sec=${(onsets.length/bm.duration).toFixed(2)} beats/sec=${(bm.beats.length/bm.duration).toFixed(2)}`);
  // hitRate under different exponents and tolerances
  for(const tolF of [0.06,0.09,0.12]){
    const tol=Math.min(tolF*P, tolF>0.1?0.09:0.07);
    const g=bm.beats.map(b=>b.t); let oi=0; const m=new Uint8Array(onsets.length);
    for(const t of g){while(oi<onsets.length&&onsets[oi].t<t-tol)oi++;
      for(let j=oi;j<onsets.length&&onsets[j].t<=t+tol;j++)m[j]=1;}
    const row=[1,2,3].map(e=>{let tot=0,hit=0;for(let i=0;i<onsets.length;i++){const w=Math.pow(onsets[i].strength,e);tot+=w;if(m[i])hit+=w;}return (hit/tot).toFixed(3);});
    // strong-onset threshold variants
    const thr=[0.3,0.5].map(T=>{let tot=0,hit=0;for(let i=0;i<onsets.length;i++){if(onsets[i].strength<T)continue;const w=onsets[i].strength;tot+=w;if(m[i])hit+=w;}return tot>0?(hit/tot).toFixed(3):'-';});
    let sup=0; { let oj=0; for(const t of g){while(oj<onsets.length&&onsets[oj].t<t-tol)oj++; if(oj<onsets.length&&onsets[oj].t<=t+tol)sup++;} }
    console.log(`  tol=${(tol*1000).toFixed(0)}ms  hitR e1=${row[0]} e2=${row[1]} e3=${row[2]}  strong>0.3=${thr[0]} >0.5=${thr[1]}  support=${(sup/g.length).toFixed(3)}`);
  }
}
