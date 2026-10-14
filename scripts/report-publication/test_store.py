import copy
import http.server
import json
import subprocess
import sys
import threading
import tempfile
import unittest
import urllib.error
import uuid
from pathlib import Path
from store import Publisher, Conflict, Pending, intent_name, legacy_name

LISTINGS={'getDocuments','getReportIdentities','getReportLibraryMetadata'}
def refused(code,error): return urllib.error.HTTPError('http://127.0.0.1:14250/mcp',code,error,{},None)

class Registry:
    """Bridge-proxy shaped fake: every listing is suspended (503); reads are the native point lookup and scoped point reads."""
    def __init__(self,members=0):
        self.docs={};self.creates=0;self.failure=None;self.calls=[];self.lookup_patch=None;self.read_patch=None;self.on_create=None
        for _ in range(members): self.add(name='other-report',reportRef='report:other:'+str(uuid.uuid4()))
    def add(self,name,reportRef=None):
        g={'reportRef':reportRef,'revision':1,'lifecycle':'FINAL'} if reportRef else {'reportRef':'','revision':0,'lifecycle':'DRAFT'}
        ident=str(uuid.uuid4());self.docs[ident]={'header':{'id':ident,'name':name,'documentType':'kilgore/report'},'state':{'global':g}};return ident
    def call(self,name,args):
        self.calls.append(name)
        if name in LISTINGS: raise refused(503,'listing_suspended')
        if name=='lookupReportPublicationV1':
            ref=args['reportRef'];assert set(args)=={'reportRef'}
            if len(self.docs)>3000: raise Pending('Registry did not confirm the operation. Retry the saved request.')  # V1 native node cap -> MCP isError
            reg=[d for d in self.docs.values() if d['state']['global'].get('reportRef')==ref]
            pend=[d for d in self.docs.values() if not d['state']['global'].get('reportRef') and d['header']['name']==intent_name(ref)]
            body=reg if len(reg)==1 and not pend else pend if not reg and len(pend)==1 else []
            lookup={'schemaVersion':'kapelle.publication-lookup.v1','driveId':'drive-1','reportRef':ref,'intentName':intent_name(ref),'observedAt':'2026-10-14T12:00:00.000Z',
                    'registeredCount':len(reg),'pendingCount':len(pend),'memberCount':len(self.docs),'documents':copy.deepcopy(body)}
            if self.lookup_patch: lookup.update(self.lookup_patch)
            return {'lookup':lookup}
        if name=='getReportDocumentV1':
            assert set(args)=={'id'}
            if args['id'] not in self.docs: raise refused(403,'forbidden_document')
            d=copy.deepcopy(self.docs[args['id']]);g=d['state']['global']
            read={'schemaVersion':'kapelle.report-document-read.v1','driveId':'drive-1','documentId':args['id'],'stamp':'a'*64,'blank':not g.get('reportRef'),
                  'lifecycle':g.get('lifecycle'),'revision':g.get('revision'),'observedAt':'2026-10-14T12:00:00.000Z','document':d}
            if self.read_patch: self.read_patch(read)
            return {'read':read}
        if name=='createDocument':
            self.creates+=1
            if self.failure=='before-create': self.failure=None;raise TimeoutError()
            ident=self.add(args['name'])
            if self.on_create: self.on_create(args['name'])
            if self.failure=='after-create': self.failure=None;raise TimeoutError()
            return {'documentId':ident}
        if name=='addActions':
            d=self.docs[args['documentId']]['state']['global']
            if d.get('reportRef'): raise AssertionError('double register')
            d.update(copy.deepcopy(args['actions'][0]['input']));d['revision']+=1
            if self.failure=='after-register': self.failure=None;raise TimeoutError()
            return {}
        raise AssertionError(name)

class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.registry=Registry();self.store=self.open()
        self.req={'operationId':str(uuid.uuid4()),'sourceRef':'kapelle://documents/'+str(uuid.uuid4()),'sourceRevision':0,'expectedVersion':0,'title':'Field notes','project':'personal','mimeType':'text/markdown','content':'# Notes\n\n[Source](https://example.com)'}
    def open(self,scope='human:owner'):
        p=Publisher(str(Path(self.temp.name).resolve()),scope,self.registry.call,'drive-1',scope);self.addCleanup(p.db.close);return p
    def test_task_intent_recovery_and_no_duplicate_pending(self):
        req={'operationId':str(uuid.uuid4()),'documentId':str(uuid.uuid4()),'title':'Check reference','projectId':'pipeline','dueAt':None}
        first=self.store.begin_task(req)
        self.assertEqual(self.open().begin_task(req),first)
        with self.assertRaises(Conflict):self.store.begin_task({**req,'title':'Changed task'})
        with self.assertRaises(Conflict):self.store.begin_task({**req,'operationId':str(uuid.uuid4())})
        receipt={'operationId':req['operationId'],'taskId':str(uuid.uuid4()),'revision':1}
        accepted=self.store.finish_task(req['operationId'],receipt)
        self.assertEqual(self.open().task_links(req['documentId']),[accepted])
        self.assertEqual(self.store.begin_task(req),accepted)
        with self.assertRaises(Conflict):self.store.finish_task(req['operationId'],{**receipt,'taskId':str(uuid.uuid4())})
        self.assertEqual(self.open('human:someone-else').task_links(req['documentId']),[])

    def test_native_task_pin_survives_restart_and_cannot_change(self):
        ident=str(uuid.uuid4())
        pin={'driveId':'drive-1','documentId':ident,'documentType':'kapelle/reference','versionId':'sha256:'+'a'*64,'contentHash':'sha256:'+'b'*64}
        req={'operationId':str(uuid.uuid4()),'documentId':ident,'title':'Work from saved context','projectId':'kapelle','dueAt':None,'nativeTarget':pin}
        intent=self.store.begin_task(req)
        self.assertEqual(self.open().begin_task(req),intent)
        with self.assertRaises(Conflict): self.store.begin_task({**req,'nativeTarget':{**pin,'versionId':'sha256:'+'c'*64}})
        with self.assertRaises(ValueError): self.store.begin_task({**req,'nativeTarget':{**pin,'driveId':'other-drive'}})
        receipt={'operationId':req['operationId'],'taskId':str(uuid.uuid4()),'revision':1}
        self.store.finish_task(req['operationId'],receipt)
        self.assertEqual(self.open().task_links(ident)[0]['nativeTarget'],pin)
        # Only the existing intent/receipt journal is used; no native document mirror.
        tables={r[0] for r in self.store.db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertEqual(tables,{'intents','report_tasks','heads'})

    def test_persist_and_replay_after_restart(self):
        r=self.store.publish(self.req);again=self.open().publish(self.req)
        self.assertEqual(r,again);self.assertEqual(self.registry.creates,1)
        self.assertEqual(self.store.by_document(r['documentId'])['content'],self.req['content'])
    def test_changed_payload_same_operation_rejected(self):
        self.store.publish(self.req)
        with self.assertRaises(Conflict):self.store.publish({**self.req,'content':'changed'})
    def test_new_version_and_old_retry_preserve_latest(self):
        one=self.store.publish(self.req)
        two=self.store.publish({**self.req,'operationId':str(uuid.uuid4()),'expectedVersion':1,'content':'new'})
        self.store.publish(self.req)
        read=self.store.by_document(one['documentId'])
        self.assertEqual([v['version'] for v in read['versions']],[2,1]);self.assertEqual(two['version'],2)
        self.assertEqual(read['content'],self.req['content'])
    def test_unchanged_republish_has_same_document(self):
        one=self.store.publish(self.req)
        two=self.store.publish({**self.req,'operationId':str(uuid.uuid4()),'expectedVersion':1})
        self.assertEqual(one['documentId'],two['documentId']);self.assertEqual(self.registry.creates,1)
    def test_stale_version_rejected(self):
        self.store.publish(self.req)
        with self.assertRaises(Conflict):self.store.publish({**self.req,'operationId':str(uuid.uuid4()),'content':'new'})
    def test_lost_create_reply_recovers_same_document(self):
        self.registry.failure='after-create'
        with self.assertRaises(TimeoutError):self.store.publish(self.req)
        r=self.open().publish(self.req)
        self.assertEqual(self.registry.creates,1);self.assertEqual(r['version'],1)
    def test_uncertain_empty_create_does_not_retry_mutation(self):
        self.registry.failure='before-create'
        with self.assertRaises(TimeoutError):self.store.publish(self.req)
        with self.assertRaises(Pending):self.open().publish(self.req)
        self.assertEqual(self.registry.creates,1)
    def test_lost_registration_reply_recovers(self):
        self.registry.failure='after-register'
        with self.assertRaises(TimeoutError):self.store.publish(self.req)
        self.assertEqual(self.open().publish(self.req)['version'],1);self.assertEqual(self.registry.creates,1)
    def test_pending_blocks_new_operation(self):
        self.registry.failure='after-create'
        with self.assertRaises(TimeoutError):self.store.publish(self.req)
        with self.assertRaises(Pending):self.store.publish({**self.req,'operationId':str(uuid.uuid4())})
    def test_publishes_at_scale_with_every_listing_suspended(self):
        self.registry=Registry(members=2500);self.store=self.open()
        r=self.store.publish(self.req)
        # Each write directly follows a fresh lookup: lookup->create, lookup->register; then lookup + point readback.
        self.assertEqual(self.registry.calls,['lookupReportPublicationV1','createDocument','getReportDocumentV1','lookupReportPublicationV1','addActions','lookupReportPublicationV1','getReportDocumentV1'])
        self.assertEqual(self.registry.docs[r['documentId']]['header']['name'],intent_name(r['reportRef']))
        self.assertEqual(self.open().publish(self.req),r)
        two=self.store.publish({**self.req,'operationId':str(uuid.uuid4()),'expectedVersion':1,'content':'new'})
        self.assertEqual(two['version'],2);self.assertEqual(len(self.registry.docs),2502)
        self.assertFalse(LISTINGS&set(self.registry.calls))
    def test_registered_elsewhere_is_reused_without_create(self):
        # A lost local receipt: the Registry already holds this reportRef, so the lookup selects it and nothing is created.
        self.registry.failure='after-register'
        with self.assertRaises(TimeoutError):self.store.publish(self.req)
        p=json.loads(self.store.db.execute('SELECT data FROM intents').fetchone()[0]);p['stage']='creating';p['documentId']=None;self.store.save(p)
        r=self.open().publish(self.req);self.assertEqual(r['documentId'],next(iter(self.registry.docs)));self.assertEqual(self.registry.creates,1)
    def test_legacy_named_saved_creation_registers_by_point_read(self):
        self.registry.failure='after-create'
        with self.assertRaises(TimeoutError):self.store.publish(self.req)
        p=json.loads(self.store.db.execute('SELECT data FROM intents').fetchone()[0])
        ident=next(iter(self.registry.docs));self.registry.docs[ident]['header']['name']=legacy_name(p['reportRef'])
        p['stage']='created';p['documentId']=ident;self.store.save(p)
        r=self.open().publish(self.req);self.assertEqual(r['documentId'],ident);self.assertEqual(self.registry.creates,1)
    def test_legacy_named_lost_create_stays_pending(self):
        self.registry.failure='after-create'
        with self.assertRaises(TimeoutError):self.store.publish(self.req)
        ident=next(iter(self.registry.docs));self.registry.docs[ident]['header']['name']=legacy_name(json.loads(self.store.db.execute('SELECT data FROM intents').fetchone()[0])['reportRef'])
        with self.assertRaises(Pending):self.open().publish(self.req)
        self.assertEqual(self.registry.creates,1)
    def test_duplicate_identities_conflict_without_write(self):
        ref=self.store.publish(self.req)['reportRef'];self.registry.add('copy',ref);n=len(self.registry.calls)
        req={**self.req,'operationId':str(uuid.uuid4()),'expectedVersion':1,'content':'new'}
        self.registry.add(intent_name(ref.replace(':v1',':v2')),None);self.registry.add(intent_name(ref.replace(':v1',':v2')),None)
        with self.assertRaises(Conflict):self.store.publish(req)
        self.assertEqual(self.registry.calls[n:],['lookupReportPublicationV1']);self.assertEqual(self.registry.creates,1)
    def test_unverified_lookup_is_never_absence(self):
        for patch in ({'intentName':'report-promotion-intent:'+'0'*20},{'driveId':'drive-2'},{'reportRef':'report:other'},{'schemaVersion':'v0'},{'registeredCount':1},{'registeredCount':-1},{'documents':[{}]},{'memberCount':2**53},{'pendingCount':2**53},{'memberCount':True},{'memberCount':1.0}):
            with self.subTest(patch=list(patch)):
                self.registry.lookup_patch=patch
                with self.assertRaises(Pending):self.store.publish(self.req)
        self.assertEqual(self.registry.creates,0)
    def test_unavailable_lookup_creates_nothing(self):
        real=self.registry.call
        def call(name,args):
            if name=='lookupReportPublicationV1': raise refused(503,'upstream_unavailable')
            return real(name,args)
        self.store.call=call
        with self.assertRaises(urllib.error.HTTPError):self.store.publish(self.req)
        self.assertEqual(self.registry.creates,0)
        self.store.call=real;self.assertEqual(self.store.publish(self.req)['version'],1)
    def test_console_process_publishes_over_http_with_listings_503(self):
        # The path the console button and inbox publication take: store.py as a child process over HTTP MCP.
        self.http_publish(Registry(members=2500))
    def test_console_process_over_v1_node_cap_is_pending_without_create(self):
        registry=Registry(members=3001);out=self.http_publish(registry,expect_ok=False)
        self.assertTrue(out['pending'],out);self.assertEqual(registry.creates,0);self.assertEqual(registry.calls,['lookupReportPublicationV1'])
    def http_publish(self,registry,expect_ok=True):
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*a): pass
            def do_POST(self):
                b=json.loads(self.rfile.read(int(self.headers['Content-Length'])));p=b['params']
                try: out=json.dumps({'jsonrpc':'2.0','id':b['id'],'result':{'structuredContent':registry.call(p['name'],p['arguments']),'content':[]}}).encode();code=200
                except urllib.error.HTTPError as e: out=json.dumps({'error':e.msg}).encode();code=e.code
                except Pending: out=json.dumps({'jsonrpc':'2.0','id':b['id'],'result':{'isError':True,'content':[{'type':'text','text':'PUBLICATION_LOOKUP_UNVERIFIED'}]}}).encode();code=200
                self.send_response(code);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(out)
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start();self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        cfg={'root':str(Path(self.temp.name).resolve()),'scope':'human:owner','driveId':'drive-1','actorId':'human:owner','endpoint':'http://127.0.0.1:%d/mcp'%server.server_port,'token':'t'}
        run=lambda: subprocess.run([sys.executable,'-I',str(Path(__file__).with_name('store.py'))],input=json.dumps({'command':'publish','request':self.req,'config':cfg}),capture_output=True,text=True,timeout=60)
        out=json.loads(run().stdout)
        if not expect_ok: return out
        self.assertTrue(out['ok'],out);self.assertEqual(out['result']['version'],1)
        self.assertEqual(json.loads(run().stdout)['result'],out['result']);self.assertEqual(registry.creates,1)
        self.assertFalse(LISTINGS&set(registry.calls))
    def test_v1_node_cap_refusal_is_pending_with_zero_creates(self):
        self.registry=Registry(members=3001);self.store=self.open()
        with self.assertRaises(Pending):self.store.publish(self.req)
        self.assertEqual(self.registry.creates,0);self.assertEqual(self.registry.calls,['lookupReportPublicationV1'])
    def test_pre_create_conflict_writes_nothing(self):
        ref=self.reference()
        self.registry.add(intent_name(ref));self.registry.add(intent_name(ref))
        with self.assertRaises(Conflict):self.store.publish(self.req)
        self.assertEqual(self.registry.calls,['lookupReportPublicationV1']);self.assertEqual(self.registry.creates,0)
    def test_pre_register_lookup_change_writes_nothing(self):
        cases={'duplicate pending intent':(lambda name:self.registry.add(name),Conflict),
               'registered elsewhere':(lambda name:self.registry.add('other',self.reference()),Conflict),
               'lookup unverified':(lambda name:setattr(self.registry,'lookup_patch',{'intentName':'report-promotion-intent:'+'0'*20}),Pending)}
        for label,(hook,error) in cases.items():
            with self.subTest(label):
                self.setUp();self.registry.on_create=hook
                with self.assertRaises(error):self.store.publish(self.req)
                self.assertNotIn('addActions',self.registry.calls);self.assertEqual(self.registry.creates,1)
    def test_point_proof_must_be_consistent_before_register(self):
        patches={'blank false over a blank body':lambda r:r.update(blank=False),
                 'blank true over a registered body':lambda r:r['document']['state']['global'].update(reportRef='report:x',lifecycle='FINAL',revision=1),
                 'lifecycle envelope vs body':lambda r:r.update(lifecycle='FINAL'),
                 'revision envelope vs body':lambda r:r.update(revision=1),
                 'revision beyond safe integer':lambda r:(r.update(revision=2**53),r['document']['state']['global'].update(revision=2**53)),
                 'blank not boolean':lambda r:r.update(blank=1),
                 'stamp':lambda r:r.update(stamp='x'),
                 'drive':lambda r:r.update(driveId='drive-2'),
                 'document id':lambda r:r.update(documentId=str(uuid.uuid4())),
                 'document type':lambda r:r['document']['header'].update(documentType='kapelle/reference'),
                 'no body':lambda r:r.pop('document')}
        for label,patch in patches.items():
            with self.subTest(label):
                self.setUp();self.registry.read_patch=patch
                with self.assertRaises(Pending):self.store.publish(self.req)
                self.assertNotIn('addActions',self.registry.calls)
    def test_blank_flag_must_match_body(self):
        # Envelope and body agree on lifecycle/revision; only the blank claim contradicts the body.
        def registered_but_blank(r):
            r.update(blank=True,lifecycle='FINAL',revision=1);r['document']['state']['global'].update(reportRef='report:x',lifecycle='FINAL',revision=1)
        self.registry.read_patch=registered_but_blank
        with self.assertRaises(Pending):self.store.publish(self.req)
        self.assertNotIn('addActions',self.registry.calls)
        self.setUp();self.registry.failure='after-register'
        with self.assertRaises(TimeoutError):self.store.publish(self.req)
        def blank_body_not_blank(r): r.update(blank=False);r['document']['state']['global'].update(reportRef='')
        self.registry.read_patch=blank_body_not_blank
        with self.assertRaises(Pending):self.open().publish(self.req)
    def test_legacy_saved_id_needs_exact_name_and_verified_absence(self):
        for label in ('other name','v1 intent also present'):
            with self.subTest(label):
                self.setUp();self.registry.failure='after-create'
                with self.assertRaises(TimeoutError):self.store.publish(self.req)
                p=json.loads(self.store.db.execute('SELECT data FROM intents').fetchone()[0]);ident=next(iter(self.registry.docs))
                self.registry.docs[ident]['header']['name']='kapelle-publication-'+'0'*64 if label=='other name' else legacy_name(p['reportRef'])
                if label!='other name': self.registry.add(intent_name(p['reportRef']))
                p['stage']='created';p['documentId']=ident;self.store.save(p)
                with self.assertRaises(Conflict):self.open().publish(self.req)
                self.assertNotIn('addActions',self.registry.calls);self.assertEqual(self.registry.creates,1)
    def reference(self):
        """The reportRef publish() will derive for self.req (v1)."""
        import store;ident=store.digest(store.encoded([self.store.scope,'drive-1',self.req['sourceRef']]))
        return f'report:publication:{self.store.scope}:{ident}:v1'
    def test_owner_scope_cannot_read_another_blob(self):
        r=self.store.publish(self.req)
        self.assertIsNone(self.open('human:other').by_document(r['documentId']))
    def test_corrupt_blob_fails_read_and_replay(self):
        r=self.store.publish(self.req)
        (self.store.home/'objects'/r['contentHash']).write_text('changed')
        with self.assertRaises(ValueError):self.store.by_document(r['documentId'])
        with self.assertRaises(ValueError):self.store.publish(self.req)
    def test_csv_preserves_exact_bytes(self):
        req={**self.req,'mimeType':'text/csv','content':'name,value\r\n"A, B",12\r\n'}
        r=self.store.publish(req);self.assertEqual(self.store.by_document(r['documentId'])['content'],req['content'])
    def test_bad_fields_rejected_before_registry(self):
        for patch in ({'sourceRef':'file:///etc/passwd'},{'project':'../other'},{'mimeType':'text/html'},{'expectedVersion':True},{'content':'é'*262144},{'unknown':'bad'}):
            with self.subTest(patch=list(patch)):
                with self.assertRaises(ValueError):self.store.publish({**self.req,**patch})
        self.assertEqual(self.registry.creates,0)
    def test_scope_lock_rejects_concurrent_writer(self):
        with self.store.lock():
            with self.assertRaises(Pending):self.open().publish(self.req)
    def test_symlink_blob_rejected(self):
        r=self.store.publish(self.req);blob=self.store.home/'objects'/r['contentHash'];target=Path(self.temp.name)/'target';target.write_text(self.req['content']);blob.unlink();blob.symlink_to(target)
        with self.assertRaises(OSError):self.store.by_document(r['documentId'])

if __name__=='__main__':unittest.main()
