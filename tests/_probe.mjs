import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeVerbose } from '../src/audio/analyzer/index.js';
const DIR = 'tests/audio';
function readWav(p){const b=readFileSync(p);let pos=12,ch=0,sr=0,ds=-1,dl=0;
 while(pos+8<=b.length){const id=b.toString('ascii',pos,pos+4);const sz=b.readUInt32LE(pos+4);const bo=pos+8;
  if(id==='fmt '){ch=b.readUInt16LE(bo+2);sr=b.readUInt32LE(bo+4);}else if(id==='data'){ds=bo;dl=Math.min(sz,b.length-bo);}
  pos=bo+sz+(sz%2);}
 const fr=Math.floor(dl/(2*ch));const out=new Float32Array(fr);
 for(let i=0;i<fr;i++)out[i]=b.readInt16LE(ds+i*ch*2)/32768;
 return {mono:out,sr,dur:fr/sr};}
const names=['four-on-floor-128','four-on-floor-90','four-on-floor-174','breakbeat-140-offset','breakbeat-100-offset','sparse-pad-72'];
const pad=(s,n)=>String(s).padEnd(n);
console.log('fixture              truth  bpm      dBPM    off    phaseErr conf   hitR  supp  gridF  beats trk  onsets jitterMs swing ms');
for(const n of names){
  const {mono,sr}=readWav(join(DIR,n+'.wav'));
  const truth=JSON.parse(readFileSync(join(DIR,n+'.truth.json'),'utf8'));
  const t0=Date.now();
  const {beatMap:bm,tracked,onsets}=analyzeVerbose([mono],sr);
  const ms=Date.now()-t0;
  const d=tracked.diagnostics;
  const P=60/bm.bpm;
  let pe=Math.abs(((bm.offset-truth.offset)%P+P)%P); pe=Math.min(pe,P-pe);
  const gaps=bm.beats.slice(1).map((b,i)=>b.t-bm.beats[i].t);
  const mg=gaps.reduce((a,b)=>a+b,0)/gaps.length;
  const jit=Math.sqrt(gaps.reduce((a,g)=>a+(g-mg)**2,0)/gaps.length)*1000;
  console.log(
    pad(n,21)+pad(truth.bpm,7)+pad(bm.bpm.toFixed(2),9)+pad((bm.bpm-truth.bpm).toFixed(2),8)+
    pad(bm.offset.toFixed(3),7)+pad(pe.toFixed(3),9)+pad(bm.bpmConfidence.toFixed(3),7)+
    pad(d.hitRate?.toFixed(2)??'-',6)+pad(d.support?.toFixed(2)??'-',6)+pad(d.gridF?.toFixed(2)??'-',7)+
    pad(bm.beats.length,6)+pad(d.trackedBeats??'-',5)+pad(onsets.length,7)+pad(jit.toFixed(1),9)+
    pad(bm.swingPoints.length,6)+ms);
}
