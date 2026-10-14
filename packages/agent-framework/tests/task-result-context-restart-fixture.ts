import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { taskResultFixture } from './task-result-context-fixture.js';
import { retainedContextReadPorts } from '../src/publication/task-result-read-ports.js';
import { TaskResultContextReader } from '../src/publication/task-result-context.js';
const root=process.argv[2],f=taskResultFixture();
// Host opens the exact existing checkpointed artifact before serving any read.
const db=new DatabaseSync(join(root,'attempts.sqlite'),{readOnly:true});
try {
 const ports=retainedContextReadPorts({binding:f.binding,root,select:(sql,...args)=>db.prepare(sql).get(...args)});
 const projection=await new TaskResultContextReader(f.binding,{...f.ports,...ports}).read();
 process.stdout.write(JSON.stringify({resolved:projection.context.data?.resolved.availability,task:projection.task.data?.status}));
}finally{db.close();}
