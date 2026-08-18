import { spawn } from 'node:child_process';
import { computeOnsetEnvelope, movingMedian } from '../src/audio/analyzer/onset.js';
const SR=44100;
function dec(p){return new Promise((res,rej)=>{const ff=spawn('ffmpeg',['-v','error','-i',p,'-f','f32le','-ac','1','-ar',String(SR),'-']);
 const c=[];ff.stdout.on('data',d=>c.push(d));ff.on('close',()=>{const b=Buffer.concat(c);const n=(b.length/4)|0;const o=new Float32Array(n);
 for(let i=0;i<n;i++)o[i]=b.readFloatLE(i*4);res(o);});ff.on('error',rej);});}
const pc=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return s[Math.round(p*(s.length-1))];};
for(const n of ['whats-up-danger','calling','loser','oh-yeah']){
  const mono=await dec(`public/audio/scratch/${n}.mp3`);
  let rms=0; for(let i=0;i<mono.length;i++) rms+=mono[i]*mono[i];
  rms=Math.sqrt(rms/mono.length);
  let peak=0; for(let i=0;i<mono.length;i++) if(Math.abs(mono[i])>peak) peak=Math.abs(mono[i]);
  const {envelope,frameRate}=computeOnsetEnvelope(mono,SR);
  const e=Array.from(envelope);
  const med=movingMedian(envelope,Math.round(0.5*frameRate/2));
  let lm=0,passMed=0;
  for(let f=1;f<e.length-1;f++){ if(e[f]<=e[f-1]||e[f]<e[f+1])continue; lm++;
    if(e[f]>=med[f]*1.7) passMed++; }
  console.log(`${n.padEnd(18)} rms=${rms.toFixed(3)} peak=${peak.toFixed(3)} crest=${(peak/rms).toFixed(1)}`);
  console.log(`   env p25=${pc(e,.25).toFixed(4)} p50=${pc(e,.5).toFixed(4)} p75=${pc(e,.75).toFixed(4)} p90=${pc(e,.9).toFixed(4)} p99=${pc(e,.99).toFixed(4)} max=${Math.max(...e).toFixed(4)}`);
  console.log(`   ratio p99/p50=${(pc(e,.99)/Math.max(1e-9,pc(e,.5))).toFixed(1)}  localMax=${lm}  passMedian1.7=${passMed}  frames=${e.length}`);
}
