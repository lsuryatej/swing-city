import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { computeOnsetEnvelope, pickPeaks, HOP_SIZE } from '../src/audio/analyzer/onset.js';
import { createBeatTracker } from '../src/audio/analyzer/backends/index.js';
const SR=44100;
function dec(p){return new Promise((res,rej)=>{const ff=spawn('ffmpeg',['-v','error','-i',p,'-f','f32le','-ac','1','-ar',String(SR),'-']);
 const c=[];ff.stdout.on('data',d=>c.push(d));ff.on('close',()=>{const b=Buffer.concat(c);const n=(b.length/4)|0;const o=new Float32Array(n);
 for(let i=0;i<n;i++)o[i]=b.readFloatLE(i*4);res(o);});ff.on('error',rej);});}
function readWav(p){const b=readFileSync(p);let pos=12,ch=0,ds=-1,dl=0;
 while(pos+8<=b.length){const id=b.toString('ascii',pos,pos+4);const sz=b.readUInt32LE(pos+4);const bo=pos+8;
  if(id==='fmt '){ch=b.readUInt16LE(bo+2);}else if(id==='data'){ds=bo;dl=Math.min(sz,b.length-bo);}pos=bo+sz+(sz%2);}
 const fr=Math.floor(dl/(2*ch));const o=new Float32Array(fr);for(let i=0;i<fr;i++)o[i]=b.readInt16LE(ds+i*ch*2)/32768;return o;}
const pc=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return s[Math.round(p*(s.length-1))];};
const srcs=[['whats-up-danger',1],['calling',1],['loser',1],['oh-yeah',1],['four-on-floor-128',0],['breakbeat-140-offset',0],['sparse-pad-72',0]];
const cache=new Map();
for(const [n,real] of srcs){
  const mono = real ? await dec(`public/audio/scratch/${n}.mp3`) : readWav(`tests/audio/${n}.wav`);
  cache.set(n,{...computeOnsetEnvelope(mono,SR), duration:mono.length/SR});
}
for(const frac of [0.20,0.15,0.10,0.07,0.05,0.03]){
  console.log(`\n### absoluteFloorFrac=${frac}`);
  for(const [n] of srcs){
    const {envelope,frameRate,frameTime,duration}=cache.get(n);
    const onsets=pickPeaks(envelope,frameRate,frameTime,{absoluteFloorFrac:frac});
    const tr=createBeatTracker('ellis').track(envelope,SR,HOP_SIZE,{frameTime,onsets,duration});
    const P=60/tr.bpm, tol=Math.min(0.1*P,0.06);
    const g=tr.beats; let oi=0; const m=new Uint8Array(onsets.length);
    for(const t of g){while(oi<onsets.length&&onsets[oi].t<t-tol)oi++;for(let j=oi;j<onsets.length&&onsets[j].t<=t+tol;j++)m[j]=1;}
    const st=onsets.map(o=>o.strength); const thr=pc(st,0.75);
    let tot=0,hit=0;for(let i=0;i<onsets.length;i++){if(st[i]<thr)continue;tot+=st[i];if(m[i])hit+=st[i];}
    const hitR=tot>0?hit/tot:0;
    let sup=0;{let oj=0;for(const t of g){while(oj<onsets.length&&onsets[oj].t<t-tol)oj++;if(oj<onsets.length&&onsets[oj].t<=t+tol)sup++;}}
    const support=sup/g.length, supT=Math.pow(Math.min(1,support/0.6),0.7);
    console.log(`  ${n.padEnd(21)} bpm=${tr.bpm.toFixed(2).padStart(7)} onsets=${String(onsets.length).padStart(4)} (${(onsets.length/duration).toFixed(2)}/s) hitR=${hitR.toFixed(3)} supp=${support.toFixed(3)} conf=${(hitR*supT).toFixed(3)}`);
  }
}
