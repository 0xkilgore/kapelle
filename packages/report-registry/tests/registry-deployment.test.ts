import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// @ts-ignore deploy module is plain ESM
import {deploymentReader,modelInventoryDigest} from '../deploy/report-summary-read/deployment.mjs';
import {createHash} from 'node:crypto';

// The Reactor re-attaches MCP tools per request: the boot identity must be per PROCESS, not per deploymentReader instance.
test('boot identity is process state; current values track the files on disk',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'registry-deployment-'))),model=join(root,'model'),release=join(root,'REGISTRY-RELEASE.json');
 mkdirSync(join(model,'v1'),{recursive:true});writeFileSync(join(model,'index.ts'),'a');writeFileSync(join(model,'v1','x.ts'),'b');
 writeFileSync(release,JSON.stringify({schemaVersion:'kapelle.registry-release.v1',releaseId:'r-1'}));
 const a=deploymentReader('drive',{modelDir:model,releaseFile:release})(),b=deploymentReader('drive',{modelDir:model,releaseFile:release})();
 assert.equal(a.bootId,b.bootId);assert.equal(a.bootReleaseId,'r-1');assert.equal(a.releaseId,'r-1');
 const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
 assert.equal(a.bootModelDigest,modelInventoryDigest({'index.ts':sha('a'),'v1/x.ts':sha('b')}));assert.equal(a.currentModelDigest,a.bootModelDigest);
 writeFileSync(join(model,'v1','x.ts'),'changed');writeFileSync(release,JSON.stringify({schemaVersion:'kapelle.registry-release.v1',releaseId:'r-2'}));
 const c=deploymentReader('drive',{modelDir:model,releaseFile:release})();
 assert.equal(c.bootId,a.bootId);assert.equal(c.bootModelDigest,a.bootModelDigest);assert.notEqual(c.currentModelDigest,a.bootModelDigest);
 assert.equal(c.bootReleaseId,'r-1');assert.equal(c.releaseId,'r-2');
 writeFileSync(release,'{"releaseId":"no schema"}');assert.equal(deploymentReader('drive',{modelDir:model,releaseFile:release})().releaseId,null);
});
