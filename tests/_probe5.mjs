import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { analyzeVerbose } from '../src/audio/analyzer/index.js';
import { autocorrelate, standardize, logTempoPrior } from '../src/audio/analyzer/tempo.js';
const SR=44100;
function dec(p){return new Promise((res,rej)=>{const ff=spawn('ffmpeg',['-v','error','-i',p,'-f','f32le','-ac','1','-ar',String(SR),'-']);
 const c=[];ff.stdout.on('data',d=>c.push(d));ff.on('close',()=>{const b=Buffer.concat(c);const n=(b.length/4)|0;const o=new Float32Array(n);
 for(let i=0;i<n;i++)o[i]=b.readFloatLE(i*4);res(o);});ff.on('error',rej);});}
function readWav(p){const b=readFileSync(p);let pos=12,ch=0,sr=0,ds=-1,dl=0;
 while(pos+8<=b.length){const id=b.toString('ascii',pos,pos+4);const sz=b.readUInt32LE(pos+4);const bo=pos+8;
  if(id==='fmt '){ch=b.readUInt16LE(bo+2);sr=b.readUInt32LE(bo+4);}else if(id==='data'){ds=bo;dl=Math.min(sz,b.length-bo);}
  pos=bo+sz+(sz%2);}
 const fr=Math.floor(dl/(2*ch));const o=new Float32Array(fr);for(let i=0;i<fr;i++)o[i]=b.readInt16LE(ds+i*ch*2)/32768;return o;}
const pc=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return s[Math.round(p*(s.length-1))];};
const srcs=[['whats-up-danger',1],['calling',1],['loser',1],['oh-yeah',1],['four-on-floor-128',0],['sparse-pad-72',0]];
for(const [n,real] of srcs){
  const mono = real ? await dec(`public/audio/scratch/${n}.mp3`) : readWav(`tests/audio/${n}.wav`);
  const {beatMap:bm,tracked,onsets,envelope,frameRate}=analyzeVerbose([mono],SR);
  const P=60/bm.bpm, tol=Math.min(0.1*P,0.06);
  const g=bm.beats.map(b=>b.t); let oi=0; const m=new Uint8Array(onsets.length);
  for(const t of g){while(oi<onsets.length&&onsets[oi].t<t-tol)oi++;for(let j=oi;j<onsets.length&&onsets[j].t<=t+tol;j++)m[j]=1;}
  const st=onsets.map(o=>o.strength);
  const thr=pc(st,0.75);
  let tot=0,hit=0;for(let i=0;i<onsets.length;i++){if(st[i]<thr)continue;tot+=st[i];if(m[i])hit+=st[i];}
  const hitR=tot>0?hit/tot:0;
  let sup=0;{let oj=0;for(const t of g){while(oj<onsets.length&&onsets[oj].t<t-tol)oj++;if(oj<onsets.length&&onsets[oj].t<=t+tol)sup++;}}
  const support=sup/g.length;
  const supTerm=Math.pow(Math.min(1,support/0.6),0.7);
  console.log(`${n.padEnd(20)} bpm=${bm.bpm.toFixed(2).padStart(7)} thr=${thr.toFixed(2)} hitR=${hitR.toFixed(3)} supp=${support.toFixed(3)} supT=${supTerm.toFixed(3)} => conf=${(hitR*supTerm).toFixed(3)}  (was ${bm.bpmConfidence.toFixed(3)})`);
  if(n==='oh-yeah'){
    const x=standardize(envelope);
    const minL=1,maxL=Math.ceil(frameRate*60/40);
    const acf=autocorrelate(x,minL,maxL);
    let mx=0;for(let l=Math.ceil(frameRate*60/200);l<=Math.floor(frameRate*60/60);l++)if(acf[l]>mx)mx=acf[l];
    console.log('   --- oh-yeah ACF probe (normalised to max in 60-200 range) ---');
    for(const b of [286.6,178.2,143.31,89.08,71.66,44.5]){
      const lag=frameRate*60/b; const i=Math.floor(lag),f=lag-i;
      const r=(acf[i]??0)*(1-f)+(acf[i+1]??0)*f;
      console.log(`   ${String(b).padStart(7)} bpm  lag=${lag.toFixed(2)}fr  acf=${r.toFixed(4)}  acfNorm=${(r/mx).toFixed(3)}  logPrior=${logTempoPrior(b).toFixed(3)}  inRange=${b>=60&&b<=200}`);
    }
    console.log('   candidates:');
    for(const c of tracked.diagnostics.candidates)
      console.log(`     ${c.bpm.toFixed(2).padEnd(8)} gridF=${c.gridF.toFixed(3)} supp=${c.support.toFixed(3)} cov=${c.coverage.toFixed(3)} acfN=${c.acfNorm.toFixed(3)} sel=${c.selection.toFixed(4)}`);
  }
}
