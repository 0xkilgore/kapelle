import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
export function composeRelationshipRuntime(installed) {
 const pre=JSON.parse(readFileSync(new URL('./preimage.json',import.meta.url),'utf8'));
 if(createHash('sha256').update(installed).digest('hex')!==pre.sha256)throw Error('RELATIONSHIP_RUNTIME_PREIMAGE_MISMATCH');
 const source=stripTypeScriptTypes(readFileSync(new URL('./outgoing-page.ts',import.meta.url),'utf8'));
 let method='\t'+source.slice(source.indexOf('export async function outgoingPage')).replace('export async function outgoingPage','async getOutgoingRelationships').replaceAll('outgoingPage.call(this,','this.getOutgoingRelationships(').trim();
 const originalBody=pre.method.slice(pre.method.indexOf('{')+1,pre.method.lastIndexOf('}'));
 const opening=method.indexOf('{')+1;
 method=method.slice(0,opening)+'\n if(sourceIdentifier !== '+JSON.stringify(pre.driveId)+' || relationshipType !== \"child\") {'+originalBody+'\n }\n'+method.slice(opening);
 const text=installed.toString();if(text.split(pre.method).length!==2)throw Error('RELATIONSHIP_RUNTIME_MATCH_INVALID');
 return Buffer.from(text.replace(pre.method,method));
}
