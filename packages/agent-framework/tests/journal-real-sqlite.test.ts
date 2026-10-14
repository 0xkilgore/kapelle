import {it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CommandJournal} from '../src/service/journal.js';
// Real node:sqlite (no mock): writable mode must open on the pinned runtime, then reopen read-only.
it('opens a writable journal with real node:sqlite and reopens it read-only',()=>{
 const dir=mkdtempSync(join(tmpdir(),'journal-real-'));
 try{
  const w=new CommandJournal(join(dir,'commands.sqlite'),'bound');expect(w.readOnly).toBe(false);w.close();
  const r=new CommandJournal(join(dir,'commands.sqlite'),'bound',true);expect(r.readOnly).toBe(true);r.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
