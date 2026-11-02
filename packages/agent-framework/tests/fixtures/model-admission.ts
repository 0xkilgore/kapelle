/** Test-only QUALIFIED_LIVE model admission for the publisher under test: v2 bound to the fake Registry deployment
 * ('fixture-release' + the package's pinned model digest) when the publisher has the deployment fence (d089023+), else v1. */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
export const FIXTURE_RELEASE='fixture-release';
export function fencedPublisher(root:string){return readFileSync(join(root,'src/private-publication.ts'),'utf8').includes('report-publication-model-admission.v2');}
export function modelDigest(inventory:Record<string,string>){const keys=Object.keys(inventory).sort();return createHash('sha256').update(JSON.stringify(keys.map(k=>[k,inventory[k]]))).digest('hex');}
export function packageInventory(root:string):Record<string,string>{return JSON.parse(readFileSync(join(root,'deploy/report-listing-runtime/model-inventory.json'),'utf8'));}
export function qualifiedAdmission(root:string,endpoint:string,driveId:string){
 const runtimeInventory=packageInventory(root);
 const base={status:'QUALIFIED_LIVE',endpoint,driveId,nativeSchemaHash:createHash('sha256').update(readFileSync(join(root,'document-models/report-registry/v1/schema.graphql'))).digest('hex'),releaseReceiptRef:'fixture://qualified-runtime',runtimeInventory};
 return fencedPublisher(root)
  ?{schemaVersion:'kapelle.report-publication-model-admission.v2',...base,deployment:{releaseId:FIXTURE_RELEASE,modelDigest:modelDigest(runtimeInventory)},validUntil:new Date(Date.now()+7*86400000).toISOString().replace(/\.\d{3}Z$/,'.000Z')}
  :{schemaVersion:'kapelle.report-publication-model-admission.v1',...base};
}
/** The matching getRegistryDeploymentV1 answer for an in-memory Registry. */
export function fixtureDeployment(root:string,driveId:string,bootId='fixture-boot'){
 const d=modelDigest(packageInventory(root));
 return {deployment:{schemaVersion:'kapelle.registry-deployment.v1',driveId,bootId,startedAt:'2026-10-01T00:00:00.000Z',bootReleaseId:FIXTURE_RELEASE,releaseId:FIXTURE_RELEASE,bootModelDigest:d,currentModelDigest:d,observedAt:new Date().toISOString()}};
}
