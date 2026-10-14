import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {ownedClaudeProcesses} from '../../src/worker/claude-process.js';
import {invocationFence} from '../../src/worker/invocation-fence.js';
import {acquireWriterLock} from '../../src/worker/writer-lock.js';
const root=process.argv[2],fence=invocationFence(acquireWriterLock(root));
const scope=ownedClaudeProcesses({auditPath:join(root,'audit.json'),record:fence.record,uncertain(){}});
scope.spawn({command:process.execPath,args:[join(import.meta.dirname,'graceful-child.mjs'),root,'hold'],cwd:root,env:{PATH:'/usr/bin:/bin'},signal:new AbortController().signal});
setInterval(()=>{if(existsSync(join(root,'ready')))process.exit(77);},10);
