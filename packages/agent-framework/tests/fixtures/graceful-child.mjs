import {existsSync,writeFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
const [root,mode]=process.argv.slice(2);
process.on('SIGTERM',()=>appendFileSync(join(root,'terms'),'TERM\n'));
process.on('exit',()=>writeFileSync(join(root,mode==='grandchild'?'grandchild-exit':'child-exit'),'yes'));
if(mode==='pipe'){
 const descendant=spawn(process.execPath,[import.meta.filename,root,'grandchild'],{stdio:['ignore',process.stdout,'ignore']});
 descendant.unref();
 const timer=setInterval(()=>{if(existsSync(join(root,'grandchild-ready'))){clearInterval(timer);process.exit(0);}},10);
}else{
 writeFileSync(join(root,mode==='grandchild'?'grandchild-ready':'ready'),'yes');
 const lines=readline.createInterface({input:process.stdin});
 lines.on('line',line=>{const m=JSON.parse(line);if(m.type==='control_request')process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{}}})+'\n');});
 setInterval(()=>{if(existsSync(join(root,'release')))process.exit(0);},10);
}
// Disposable fixtures exit voluntarily even if an assertion interrupts the harness.
setTimeout(()=>process.exit(0),30000).unref();
