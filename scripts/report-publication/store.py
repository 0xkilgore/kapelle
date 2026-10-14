"""Owner-scoped publication journal. Report Registry owns published documents.

The journal holds durable intents, immutable source bytes and verified registry
receipts. A process lock spans the remote operation; a lost create response is
reconciled by its retained intent name, never blindly repeated. Registry reads are
the native point lookup and scoped point reads only: no full-Drive listing.
"""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import urllib.request
import uuid
from datetime import datetime, timezone

HASH = re.compile(r'^[a-f0-9]{64}$')
UUID = re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')
MAX_BYTES = 256 * 1024
LOOKUP = 'kapelle.publication-lookup.v1'
SAFE_INTEGER = 2**53 - 1  # counts and revisions come from JavaScript
UNVERIFIED = 'The registry lookup could not be verified. Retry the saved request.'

class Conflict(ValueError): pass
class Pending(ValueError): pass

def digest(b): return hashlib.sha256(b).hexdigest()
def encoded(v): return json.dumps(v, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()
def intent_name(ref): return 'report-promotion-intent:'+digest(ref.encode())[:20]
def legacy_name(ref): return 'kapelle-publication-'+digest(ref.encode())
def now(): return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
def text(v, n):
    if not isinstance(v, str) or not v.strip() or len(v) > n or '\x00' in v: raise ValueError('Invalid publication text')
    return v

def secure_dir(p):
    p.mkdir(parents=True, exist_ok=True, mode=0o700)
    if p.is_symlink() or not p.is_dir() or p.stat().st_uid != os.getuid() or p.stat().st_mode & 0o077:
        raise ValueError('Publication directory must be private to its owner')

class Publisher:
    def __init__(self, root, scope, call=None, drive=None, actor=None):
        self.root = Path(root)
        if not self.root.is_absolute(): raise ValueError('Publication root must be absolute')
        secure_dir(self.root)
        if self.root.resolve() != self.root: raise ValueError('Publication root must be canonical')
        self.scope = digest(text(scope,256).encode())
        self.home = self.root / self.scope
        secure_dir(self.home)
        self.call, self.drive, self.actor = call, drive, actor
        db = self.home / 'intents.sqlite3'
        if db.is_symlink() or (db.exists() and db.stat().st_nlink != 1): raise ValueError('Invalid publication journal')
        self.db = sqlite3.connect(db, timeout=10, isolation_level=None)
        os.chmod(db, 0o600)
        self.db.executescript('''PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS intents(operation_id TEXT PRIMARY KEY, publication_id TEXT NOT NULL, request_hash TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS report_tasks(operation_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, drive_id TEXT NOT NULL, request_hash TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS heads(publication_id TEXT PRIMARY KEY, version INTEGER NOT NULL, operation_id TEXT NOT NULL);
        ''')

    @contextlib.contextmanager
    def lock(self):
        fd = os.open(self.home / 'writer.lock', os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW, 0o600)
        try:
            if os.fstat(fd).st_nlink != 1: raise ValueError('Invalid publication lock')
            try: fcntl.flock(fd, fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError: raise Pending('Another publication is being confirmed. Retry shortly.')
            yield
        finally: os.close(fd)

    def save(self, p):
        self.db.execute('INSERT INTO intents VALUES(?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET data=excluded.data',
                        (p['operationId'],p['publicationId'],p['requestHash'],json.dumps(p)))

    def blob(self, p, content=None):
        h = p['contentHash']
        if not HASH.fullmatch(h): raise ValueError('Invalid content identity')
        folder = self.home / 'objects'; secure_dir(folder)
        path = folder / h
        if content is not None:
            try:
                fd = os.open(path, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
            except FileExistsError: pass
            else:
                with os.fdopen(fd,'wb') as f: f.write(content); f.flush(); os.fsync(f.fileno())
                dfd = os.open(folder, os.O_RDONLY)
                try: os.fsync(dfd)
                finally: os.close(dfd)
        fd = os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
        with os.fdopen(fd,'rb') as f:
            if os.fstat(f.fileno()).st_nlink != 1: raise ValueError('Invalid stored content')
            b = f.read(MAX_BYTES+1)
        if len(b)!=p['byteSize'] or digest(b)!=h: raise ValueError('Stored content failed integrity check')
        b.decode('utf-8',errors='strict')
        return b

    def validate(self, req):
        if not isinstance(req,dict) or set(req) != {'operationId','sourceRef','sourceRevision','expectedVersion','title','project','mimeType','content'}:
            raise ValueError('Invalid publication request fields')
        if not isinstance(req['operationId'],str) or not UUID.fullmatch(req['operationId']): raise ValueError('Invalid operation identity')
        if type(req['expectedVersion']) is not int or req['expectedVersion']<0: raise ValueError('Invalid version')
        if type(req['sourceRevision']) is not int or req['sourceRevision']<0: raise ValueError('Invalid source revision')
        source=text(req['sourceRef'],512)
        if not re.fullmatch(r'kapelle://(?:inbox/[a-f0-9]{64}|documents/[a-f0-9-]{36})',source): raise ValueError('Invalid source reference')
        text(req['title'],200)
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,79}',text(req['project'],80)): raise ValueError('Choose a project')
        if req['mimeType'] not in ('text/markdown','text/csv'): raise ValueError('Only Markdown and CSV are supported')
        content = text(req['content'],MAX_BYTES).encode('utf-8')
        if len(content)>MAX_BYTES: raise ValueError('Content exceeds 256 KiB')
        return content

    def public(self,p):
        return {k:v for k,v in p.items() if k not in ('requestHash','stage')}

    def publish(self, req):
        content=self.validate(req)
        if not self.call or not self.drive or not self.actor: raise ValueError('Publication is not configured')
        request_hash=digest(encoded(req))
        ident=digest(encoded([self.scope,self.drive,req['sourceRef']]))
        with self.lock():
            row=self.db.execute('SELECT data FROM intents WHERE operation_id=?',(req['operationId'],)).fetchone()
            if row:
                p=json.loads(row[0])
                if p['requestHash']!=request_hash or p['driveId']!=self.drive: raise Conflict('This operation belongs to a different publication')
                self.blob(p)
                if p['stage']=='accepted': return self.public(p)
            else:
                head=self.db.execute('SELECT version,operation_id FROM heads WHERE publication_id=?',(ident,)).fetchone()
                version=head[0] if head else 0
                if req['expectedVersion']!=version: raise Conflict('A newer document version exists. Open it before publishing.')
                pending=self.db.execute('SELECT data FROM intents WHERE publication_id=?',(ident,)).fetchall()
                if any(json.loads(r[0])['stage']!='accepted' for r in pending): raise Pending('Recover the saved publication before starting another version.')
                if head:
                    old=json.loads(self.db.execute('SELECT data FROM intents WHERE operation_id=?',(head[1],)).fetchone()[0])
                    if all(old[k]==req[k] for k in ('title','project','mimeType','sourceRevision')) and old['contentHash']==digest(content):
                        self.blob(old)
                        # Retain a distinct request receipt even when bytes need no new version.
                        p={**old,'operationId':req['operationId'],'requestHash':request_hash}
                        self.save(p)
                        return self.public(p)
                p={k:req[k] for k in ('operationId','sourceRef','sourceRevision','title','project','mimeType')}
                p.update(publicationId=ident,driveId=self.drive,scope=self.scope,version=version+1,contentHash=digest(content),byteSize=len(content),
                         requestHash=request_hash,stage='prepared',createdAt=now(),documentId=None,
                         reportRef=f'report:publication:{self.scope}:{ident}:v{version+1}',
                         blobRef=f'blob:kapelle:{self.scope}:{digest(content)}')
                self.blob(p,content)
                self.save(p)
            return self.finish(p)

    def lookup(self,ref):
        """Strict parse of the native point lookup (mirrors the bridge publisher's nativeLookup): exact Drive/ref/intent echo,
        safe counts, at most one body. Never a full-Drive listing; an unverified answer is never read as absence."""
        v=self.call('lookupReportPublicationV1',{'reportRef':ref}).get('lookup')
        if not isinstance(v,dict) or v.get('schemaVersion')!=LOOKUP or v.get('driveId')!=self.drive or v.get('reportRef')!=ref or v.get('intentName')!=intent_name(ref): raise Pending(UNVERIFIED)
        registered,pending,members=(v.get(k) for k in ('registeredCount','pendingCount','memberCount'))
        if any(type(n) is not int or not 0<=n<=SAFE_INTEGER for n in (registered,pending,members)) or registered+pending>members: raise Pending(UNVERIFIED)
        docs=v.get('documents')
        if not isinstance(docs,list) or len(docs)!=(1 if (registered,pending) in ((1,0),(0,1)) else 0): raise Pending(UNVERIFIED)
        for d in docs:
            h=d.get('header') if isinstance(d,dict) else None
            if not isinstance(h,dict) or not isinstance(h.get('id'),str) or not UUID.fullmatch(h['id']) or h.get('documentType')!='kilgore/report' or not isinstance(h.get('name'),str): raise Pending(UNVERIFIED)
        if registered+pending>1: raise Conflict('Duplicate registry identities need reconciliation')
        return registered,pending,(docs[0]['header']['id'] if docs else None)

    def point(self,ident):
        """Scoped native point read: fixed-Drive membership plus this document's heads only. The envelope must agree with the
        body: blank means the initial create intent (empty reportRef, revision 0, DRAFT); otherwise a registered Report."""
        r=self.call('getReportDocumentV1',{'id':ident}).get('read')
        d=r.get('document') if isinstance(r,dict) else None
        h=d.get('header') if isinstance(d,dict) else None
        g=d.get('state',{}).get('global') if isinstance(d,dict) and isinstance(d.get('state'),dict) else None
        if not isinstance(r,dict) or r.get('schemaVersion')!='kapelle.report-document-read.v1' or r.get('driveId')!=self.drive or r.get('documentId')!=ident or not isinstance(r.get('stamp'),str) or not HASH.fullmatch(r['stamp']) \
           or not isinstance(h,dict) or h.get('id')!=ident or h.get('documentType')!='kilgore/report' or not isinstance(h.get('name'),str) or not isinstance(g,dict) or type(r.get('blank')) is not bool \
           or r.get('lifecycle')!=g.get('lifecycle') or r.get('revision')!=g.get('revision') or type(g.get('revision')) is not int or not 0<=g['revision']<=SAFE_INTEGER \
           or (r['blank'] and (g.get('reportRef')!='' or g['revision']!=0 or g.get('lifecycle')!='DRAFT')) or (not r['blank'] and (not isinstance(g.get('reportRef'),str) or not g['reportRef'])):
            raise Pending(UNVERIFIED)
        return d,r['blank']

    def finish(self,p):
        # Single writer: the per-scope process lock spans check -> write -> readback, and every reportRef embeds this scope's
        # publication identity, so no other writer creates or registers this ref. The lookups detect, but cannot fence, a foreign
        # write between a check and the write itself (the Registry has no compare-and-set on reportRef). Every write is preceded
        # by a fresh lookup with no other Registry call in between; a conflicting or unverified answer refuses with zero writes.
        ref=p['reportRef']
        registered,pending,ident=self.lookup(ref)
        legacy=False
        if ident:
            if p['documentId'] and p['documentId']!=ident: raise Conflict('Registry document identity changed')
        elif p['documentId']:
            # A saved creation under the legacy name is invisible to the lookup's pending match; its saved id is read by point.
            ident=p['documentId']; legacy=True
        else:
            if p['stage']!='prepared': raise Pending('The registry has not confirmed the saved creation. Retry to check; a second document will not be created.')
            # The lookup above is the fresh pre-create check: verified absence (0 registered / 0 pending), nothing in between.
            p['stage']='creating'; self.save(p)
            result=self.call('createDocument',{'documentType':'kilgore/report','name':intent_name(ref),'driveId':self.drive})
            ident=result.get('documentId') or result.get('document',{}).get('header',{}).get('id') or result.get('id')
            if not isinstance(ident,str) or not UUID.fullmatch(ident): raise Pending('Creation result needs reconciliation')
            p['documentId']=ident; p['stage']='created'; self.save(p)
            registered,pending=0,1
        doc,blank=self.point(ident)
        if blank:
            if doc['header']['name']!=(legacy_name(ref) if legacy else intent_name(ref)): raise Conflict('Registry document identity changed')
            p['documentId']=ident; p['stage']='registering'; self.save(p)
            # Fresh pre-register check: V1 must select exactly this saved intent (0/1); a legacy-named intent needs verified absence (0/0).
            registered,pending,selected=self.lookup(ref)
            if (registered,pending,selected)!=((0,0,None) if legacy else (0,1,ident)): raise Pending('The registry changed before registration. Retry the saved request.')
            self.call('addActions',{'documentId':ident,'actions':[{'type':'REGISTER_REPORT','scope':'global','input':{
                'id':p['reportRef'],'reportRef':p['reportRef'],'title':p['title'],'projectRef':p['project'],'familyRef':None,
                'sourceRef':p['sourceRef'],'producer':{'kind':'HUMAN','id':self.actor,'label':'Project document'},
                'content':{'storage':'BLOB','mimeType':p['mimeType'],'filename':'document.md' if p['mimeType']=='text/markdown' else 'document.csv',
                           'contentHash':p['contentHash'],'byteSize':p['byteSize'],'markdown':None,'blobRef':p['blobRef']},
                'lifecycle':'FINAL','occurredAt':p['createdAt'],'actorId':self.actor}}]})
            # The lookup must now select exactly this registered document.
            if self.lookup(ref)!=(1,0,ident): raise Pending('The registry has not confirmed the registration. Retry the saved request.')
            doc,blank=self.point(ident)
            if blank: raise Pending('The registry has not confirmed the registration. Retry the saved request.')
        elif (registered,pending)!=(1,0): raise Pending('The registry changed during publication. Retry the saved request.')
        g=doc.get('state',{}).get('global',{}); c=g.get('content') or {}
        if doc.get('header',{}).get('id')!=ident or doc.get('header',{}).get('documentType')!='kilgore/report' or any(g.get(k)!=p[k] for k in ('reportRef','sourceRef','title')) or g.get('projectRef')!=p['project'] or g.get('lifecycle')!='FINAL' or any(c.get(k)!=p[k] for k in ('contentHash','byteSize','mimeType','blobRef')) or c.get('storage')!='BLOB':
            raise Conflict('Published document does not match the saved content')
        self.blob(p)
        p.update(documentId=ident,stage='accepted',acceptedAt=now())
        self.db.execute('BEGIN IMMEDIATE')
        try:
            self.save(p)
            self.db.execute('INSERT INTO heads VALUES(?,?,?) ON CONFLICT(publication_id) DO UPDATE SET version=excluded.version,operation_id=excluded.operation_id',(p['publicationId'],p['version'],p['operationId']))
            self.db.execute('COMMIT')
        except BaseException: self.db.execute('ROLLBACK'); raise
        return self.public(p)

    def task_links(self, ident):
        if not isinstance(ident,str) or not UUID.fullmatch(ident): raise ValueError('Invalid document identity')
        return [json.loads(row[0]) for row in self.db.execute('SELECT data FROM report_tasks WHERE document_id=? AND drive_id=? ORDER BY rowid DESC',(ident,self.drive))]

    def begin_task(self, req):
        if set(req) not in ({'operationId','documentId','title','projectId','dueAt'}, {'operationId','documentId','title','projectId','dueAt','nativeTarget'}): raise ValueError('Invalid linked task request')
        if 'nativeTarget' in req:
            t=req['nativeTarget']
            if not isinstance(t,dict) or set(t)!={'driveId','documentId','documentType','versionId','contentHash'}: raise ValueError('Invalid native source pin')
            for v in t.values(): text(v,256)
            if t['driveId']!=self.drive or t['documentId']!=req['documentId'] or t['documentType'] not in ('kapelle/reference','kapelle/collection') or not re.fullmatch(r'sha256:[a-f0-9]{64}',t['contentHash']): raise ValueError('Native source pin does not match')
        if not UUID.fullmatch(req['operationId']) or not UUID.fullmatch(req['documentId']): raise ValueError('Invalid linked task identity')
        text(req['title'],500)
        if req['projectId'] is not None: text(req['projectId'],500)
        if req['dueAt'] is not None: datetime.fromisoformat(req['dueAt'].replace('Z','+00:00'))
        request_hash=digest(encoded(req))
        with self.lock():
            row=self.db.execute('SELECT request_hash,data FROM report_tasks WHERE operation_id=?',(req['operationId'],)).fetchone()
            if row:
                p=json.loads(row[1])
                if row[0]!=request_hash or p['driveId']!=self.drive: raise Conflict('This task operation belongs to another request')
                return p
            if any(p['receipt'] is None for p in self.task_links(req['documentId'])): raise Conflict('Confirm the pending task before creating another one')
            p={**req,'driveId':self.drive,'receipt':None,'createdAt':now()}
            self.db.execute('INSERT INTO report_tasks VALUES(?,?,?,?,?)',(req['operationId'],req['documentId'],self.drive,request_hash,json.dumps(p)))
            return p

    def finish_task(self, operation_id, receipt):
        with self.lock():
            row=self.db.execute('SELECT data FROM report_tasks WHERE operation_id=?',(operation_id,)).fetchone()
            if not row: raise ValueError('Task intent unavailable')
            p=json.loads(row[0])
            if p['driveId']!=self.drive or receipt.get('operationId')!=operation_id or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,255}',receipt.get('taskId','')) or type(receipt.get('revision')) is not int or receipt['revision']<1: raise ValueError('Task receipt does not match')
            if p['receipt'] is not None and p['receipt']['taskId']!=receipt['taskId']: raise Conflict('Task receipt changed identity')
            p['receipt']=receipt
            self.db.execute('UPDATE report_tasks SET data=? WHERE operation_id=?',(json.dumps(p),operation_id))
            return p

    def by_document(self,ident):
        if not isinstance(ident,str) or not UUID.fullmatch(ident): raise ValueError('Invalid document identity')
        rows=[json.loads(r[0]) for r in self.db.execute('SELECT data FROM intents')]
        matches=[p for p in rows if p['stage']=='accepted' and p['documentId']==ident]
        if not matches: return None
        p=matches[0]
        versions={r['version']:self.public(r) for r in rows if r['stage']=='accepted' and r['publicationId']==p['publicationId']}
        return {'publication':self.public(p),'versions':sorted(versions.values(),key=lambda r:r['version'],reverse=True),'content':self.blob(p).decode('utf-8')}


def main():
    payload=json.loads(sys.stdin.buffer.read(2*MAX_BYTES+8192))
    cfg=payload['config']
    def call(name,args):
        req=urllib.request.Request(cfg['endpoint'],data=encoded({'jsonrpc':'2.0','id':str(uuid.uuid4()),'method':'tools/call','params':{'name':name,'arguments':args}}),
            headers={'Authorization':'Bearer '+cfg['token'],'Content-Type':'application/json','Accept':'application/json, text/event-stream'})
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,*args,**kwargs): return None
        # The lookup head-verifies every member Reactor-side; the proxy bounds it at 15 s.
        with urllib.request.build_opener(NoRedirect).open(req,timeout=20 if name=='lookupReportPublicationV1' else 8) as r:
            raw=r.read(2_000_001)
            if len(raw)>2_000_000: raise ValueError('Registry response too large')
            s=raw.decode('utf-8')
            if 'text/event-stream' in r.headers.get('Content-Type',''):
                events=[json.loads(line[5:].strip()) for line in s.splitlines() if line.startswith('data:')]
                envelope=next((e for e in events if 'result' in e or 'error' in e),{})
            else: envelope=json.loads(s)
        result=envelope.get('result',{})
        if envelope.get('error') or result.get('isError'): raise Pending('Registry did not confirm the operation. Retry the saved request.')
        if 'structuredContent' in result: return result['structuredContent']
        return json.loads(next(c['text'] for c in result.get('content',[]) if c.get('type')=='text'))
    store=Publisher(cfg['root'],cfg['scope'],call,cfg.get('driveId'),cfg.get('actorId'))
    if payload['command']=='validate': store.validate(payload['request']); result=True
    elif payload['command']=='publish': result=store.publish(payload['request'])
    elif payload['command']=='task-links': result=store.task_links(payload['documentId'])
    elif payload['command']=='begin-task': result=store.begin_task(payload['request'])
    elif payload['command']=='finish-task': result=store.finish_task(payload['operationId'],payload['receipt'])
    elif payload['command']=='get': result=store.by_document(payload['documentId'])
    else: raise ValueError('Unsupported publication command')
    print(json.dumps({'ok':True,'result':result}))

if __name__=='__main__':
    try: main()
    except Exception as e:
        print(json.dumps({'ok':False,'conflict':isinstance(e,Conflict),'pending':isinstance(e,Pending),'error':str(e) if isinstance(e,(ValueError,Pending,Conflict)) else 'Publication could not be confirmed. Retry the saved request.'}))
        sys.exit(1)
