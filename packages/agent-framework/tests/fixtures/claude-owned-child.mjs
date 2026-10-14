import {existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const [root,mode]=process.argv.slice(2);
process.on('SIGTERM',()=>{
 writeFileSync(join(root,'aborted'),'yes');
 if(mode==='cooperative')process.exit(0);
 if(mode==='close-output')process.stdout.end();
});
writeFileSync(join(root,'ready'),'yes');
const watch=setInterval(()=>{if(existsSync(join(root,'release'))){clearInterval(watch);process.exit(0);}},10);
setTimeout(()=>process.exit(0),10000).unref();
