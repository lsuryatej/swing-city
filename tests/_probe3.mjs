import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeVerbose } from '../src/audio/analyzer/index.js';
const DIR='tests/audio';
function readWav(p){const b=readFileSync(p);let pos=12,ch=0,sr=0,ds=-1,dl=0;
 while(pos+8<=b.length){const id=b.toString('ascii',pos,pos+4);const sz=b.readUInt32LE(pos+4);const bo=pos+8;
  if(id==='fmt '){ch=b.readUInt16LE(bo+2);sr=b.readUInt32LE(bo+4);}else if(id==='data'){ds=bo;dl=Math.min(sz,b.length-bo);}
  pos=bo+sz+(sz%2);}
 const fr=Math.floor(dl/(2*ch));const out=new Float32Array(fr);
 for(let i=0;i<fr;i++)out[i]=b.readInt16LE(ds+i*ch*2)/32768;return{mono:out,sr};}
for(const n of process.argv.slice(2)){
  const {mono,sr}=readWav(join(DIR,n+'.wav'));
  const {tracked}=analyzeVerbose([mono],sr);
  console.log(`\n== ${n}  chose ${tracked.bpm.toFixed(2)}  seed ${tracked.diagnostics.seedBpm.toFixed(2)}`);
  console.log('   bpm      gridF  supp   cov    acfN   selection');
  for(const c of tracked.diagnostics.candidates){
    console.log(`   ${c.bpm.toFixed(2).padEnd(9)}${c.gridF.toFixed(3).padEnd(7)}${c.support.toFixed(3).padEnd(7)}${c.coverage.toFixed(3).padEnd(7)}${c.acfNorm.toFixed(3).padEnd(7)}${c.selection.toFixed(4)}`);
  }
}
