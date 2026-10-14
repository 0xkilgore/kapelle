import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
/** Registry deployment identity: what THIS Reactor process actually runs, so a host model
 * admission can be bound to the live deployment instead of trusting its own claims. A local immutable-release fence:
 * - releaseId: deploy/REGISTRY-RELEASE.json ({schemaVersion:'kapelle.registry-release.v1', releaseId}), read at boot AND now;
 * - model digest of the Report model files loaded at boot AND of the files on disk now (same canonical form as the
 *   publisher's model-inventory.json: sorted [relative path, sha256] pairs);
 * - bootId: new per process. A model swap needs a restart (new bootId, new digest); a file change under a running process
 *   makes boot != current. Consumers require boot == current == admitted. No body, no reusable grant. */
const MODEL_DIR=fileURLToPath(new URL('../../document-models/report-registry/',import.meta.url));
const RELEASE_FILE=fileURLToPath(new URL('../REGISTRY-RELEASE.json',import.meta.url));
export function modelInventoryDigest(inventory){
 const keys=Object.keys(inventory).sort();return createHash('sha256').update(JSON.stringify(keys.map(k=>[k,inventory[k]]))).digest('hex');
}
function inventoryOf(dir,rel='',out={}){
 for(const name of readdirSync(join(dir,rel)).sort()){const r=rel?rel+'/'+name:name,s=statSync(join(dir,r));
  if(s.isDirectory())inventoryOf(dir,r,out);else if(s.isFile())out[r]=createHash('sha256').update(readFileSync(join(dir,r))).digest('hex');}
 return out;
}
function releaseOf(path){
 try{const r=JSON.parse(readFileSync(path,'utf8'));return r?.schemaVersion==='kapelle.registry-release.v1'&&typeof r.releaseId==='string'&&/^[A-Za-z0-9._:@-]{1,200}$/.test(r.releaseId)?r.releaseId:null;}
 catch{return null;}
}
// Boot identity is PROCESS state (module scope), computed once on first use: the Reactor re-attaches MCP tools per request,
// so anything created inside deploymentReader would change on every call (found on the real Reactor).
const boots=new Map();
function bootOf(modelDir,releaseFile){
 const key=modelDir+'\0'+releaseFile;
 if(!boots.has(key))boots.set(key,{bootId:randomUUID(),startedAt:new Date().toISOString(),bootReleaseId:releaseOf(releaseFile),bootModelDigest:modelInventoryDigest(inventoryOf(modelDir))});
 return boots.get(key);
}
export function deploymentReader(driveId,{modelDir=MODEL_DIR,releaseFile=RELEASE_FILE}={}){
 const {bootId,startedAt,bootReleaseId,bootModelDigest}=bootOf(modelDir,releaseFile);
 return ()=>({schemaVersion:'kapelle.registry-deployment.v1',driveId,bootId,startedAt,bootReleaseId,releaseId:releaseOf(releaseFile),
  bootModelDigest,currentModelDigest:modelInventoryDigest(inventoryOf(modelDir)),observedAt:new Date().toISOString()});
}
