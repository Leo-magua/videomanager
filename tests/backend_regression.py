import os
import sys
import tempfile
import unittest
from pathlib import Path

BASE = Path(__file__).resolve().parents[1] / 'packages/coordinator'
ROOT = tempfile.TemporaryDirectory()
os.environ['VM_DATA_DIR'] = str(Path(ROOT.name) / 'db')
os.environ['VM_MODE'] = 'coordinator'
sys.dont_write_bytecode = True
sys.path.insert(0, str(BASE))
import app, auth, config, db, filesystem, nodes, scanner, store, tickets, writes
config.ensure_dirs()
db.get_conn()
nodes.ensure_loopback()

class Integration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = app.app.test_client()
        cls.headers = {'Authorization': 'Bearer ' + auth._token()}
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT.name)
        self.root = Path(self.temp.name)
        c = db.get_conn()
        for table in ['storages','media','marks','media_cast','actors','actor_tags','media_tags','tombstones','jobs']:
            c.execute('DELETE FROM ' + table)
        c.execute("INSERT INTO storages(id,name,kind,root_path,online,added_at) VALUES('test','test','local',?,1,0)", (str(self.root),))
        c.commit()
    def tearDown(self):
        self.temp.cleanup()
    def browse(self, path=''):
        return self.client.get('/api/storages/test/entries', query_string={'path': path}, headers=self.headers)
    def delete(self, path):
        return self.client.delete('/api/storages/test/entries', json={'path': path}, headers=self.headers)
    def test_auth_required(self):
        self.assertEqual(self.client.get('/api/storages/test/entries').status_code, 401)
        self.assertEqual(self.client.post('/api/actors/delete', json={'names':['x']}).status_code, 401)
    def test_full_listing_and_nested_navigation(self):
        (self.root/'empty').mkdir()
        (self.root/'sub').mkdir()
        (self.root/'sub'/'movie.mp4').write_bytes(b'video')
        (self.root/'notes.txt').write_text('hello')
        listing = self.browse().json['data']
        self.assertEqual((listing['directoryCount'], listing['fileCount']), (2, 1))
        self.assertEqual({x['name'] for x in listing['entries']}, {'empty','sub','notes.txt'})
        self.assertTrue(self.browse('sub').json['data']['entries'][0]['isVideo'])
        self.assertEqual(self.browse('empty').json['data']['entries'], [])
    def test_file_delete_and_failure(self):
        (self.root/'a.txt').write_text('a')
        self.assertEqual(self.delete('a.txt').status_code, 200)
        self.assertFalse((self.root/'a.txt').exists())
        self.assertEqual(self.delete('a.txt').status_code, 404)
    def test_reject_root_traversal_absolute_and_symlink(self):
        outside = Path(ROOT.name)/'outside.txt'; outside.write_text('keep')
        (self.root/'link').symlink_to(outside)
        for path in ['', '.', '..', '../outside.txt', '/tmp/test', 'C:/Windows', 'link', 'x/../../outside.txt']:
            with self.subTest(path=path): self.assertEqual(self.delete(path).status_code, 400)
        self.assertEqual(outside.read_text(), 'keep')
        self.assertFalse(any(e['name']=='link' for e in self.browse().json['data']['entries']))
    def test_recursive_delete_cleans_metadata_and_preserves_sibling(self):
        (self.root/'sub_%').mkdir()
        (self.root/'sub_%'/'v.mp4').write_bytes(b'v')
        (self.root/'sub_X').mkdir()
        (self.root/'sub_X'/'keep.mp4').write_bytes(b'k')
        result = scanner.apply_scan_report('test', [{'rel_path':'sub_%/v.mp4'}, {'rel_path':'sub_X/keep.mp4'}])
        doomed, keep = result['new_media_ids']
        writes.add_mark(doomed, 1, 'mark', None)
        writes.create_clip(doomed, 0, 1, 'clip')
        self.assertEqual(self.delete('sub_%').status_code, 200)
        self.assertIsNone(store.get_media_row(doomed))
        self.assertIsNotNone(store.get_media_row(keep))
        self.assertFalse((self.root/'sub_%').exists())
        self.assertTrue((self.root/'sub_X'/'keep.mp4').exists())
    def test_actor_batch_delete_keeps_media_and_tags(self):
        result = scanner.apply_scan_report('test', [{'rel_path':'movie.mp4'}])
        mid = result['new_media_ids'][0]
        for name in ['Actor A', 'Actor B', 'Actor C']: writes.upsert_actor({'name':name,'tags':['tag']})
        writes.set_cast(mid, ['Actor A', 'Actor B', 'Actor C'])
        rev = db.current_revision()
        response = self.client.post('/api/actors/delete',json={'names':['Actor A','Actor B','Actor A']}, headers=self.headers)
        self.assertEqual(response.json['data']['removed'], 2)
        self.assertEqual(store.get_media(mid)['cast'], ['Actor C'])
        self.assertIn('tag', store.get_media(mid)['tags'])
        self.assertIsNotNone(store.get_media_row(mid))
        self.assertGreater(db.current_revision(), rev)
        self.assertEqual(self.client.post('/api/actors/delete', json={'names':'bad'}, headers=self.headers).status_code, 400)
    def test_original_windows_path_and_source(self):
        c = db.get_conn()
        c.execute("INSERT INTO storages(id,name,kind,root_path,online,node_id,added_at) VALUES('win','Windows','remote',?,1,'remote-node',0)", ('E:\\video-test',)); c.commit()
        mid = scanner.apply_scan_report('win',[{'rel_path':'sub/video.mp4'}])['new_media_ids'][0]
        item = store.get_media(mid)
        self.assertEqual(item['originalPath'], 'E:\\video-test\\sub\\video.mp4')
        self.assertEqual(item['sourceKind'], 'remote')
    def test_media_delete_removes_actual_file(self):
        (self.root/'delete.mp4').write_bytes(b'x')
        mid = scanner.apply_scan_report('test', [{'rel_path':'delete.mp4'}])['new_media_ids'][0]
        r = self.client.delete('/api/media/'+mid,headers=self.headers)
        self.assertEqual(r.status_code, 200)
        self.assertFalse((self.root/'delete.mp4').exists())
        self.assertIsNone(store.get_media_row(mid))
    def test_overlap_registration_cleanup(self):
        child = self.root/'sub'; child.mkdir(); (child/'same.mp4').write_bytes(b'x')
        c = db.get_conn();c.execute("INSERT INTO storages(id,name,kind,root_path,online,added_at) VALUES('overlap','overlap','local',?,1,0)",(str(child),));c.commit()
        a = scanner.apply_scan_report('test',[{'rel_path':'sub/same.mp4'}])['new_media_ids'][0]
        b = scanner.apply_scan_report('overlap',[{'rel_path':'same.mp4'}])['new_media_ids'][0]
        self.assertEqual(self.delete('sub/same.mp4').status_code,200)
        self.assertIsNone(store.get_media_row(a));self.assertIsNone(store.get_media_row(b))
    def test_remote_browse_delegates_signed_operation(self):
        from unittest.mock import patch, Mock
        c=db.get_conn();c.execute("INSERT INTO storages(id,name,kind,root_path,online,node_id,added_at) VALUES('rpc','rpc','remote','E:/video-test',1,'test-node',0)");c.commit()
        node={'stream_key':'rpc-secret','base_url':'http://connector:8788'}
        response=Mock(ok=True,status_code=200);response.json.return_value={'ok':True,'data':{'entries':[],'fileCount':0,'directoryCount':0}}
        with patch.object(nodes,'get_node',return_value=node),patch.object(nodes,'is_online',return_value=True),patch('storage_files.requests.request',return_value=response) as request:
            r=self.client.get('/api/storages/rpc/entries?path=sub',headers=self.headers)
            self.assertEqual(r.status_code,200)
            claims=tickets.verify('rpc-secret',request.call_args.kwargs['params']['ticket'])
            self.assertEqual((claims['purpose'],claims['storage_id'],claims['rel_path']),('browse','rpc','sub'))
    def test_batch_cast_preserves_existing_and_merges_tags(self):
        ids=scanner.apply_scan_report('test',[{'rel_path':'batch1.mp4'},{'rel_path':'batch2.mp4'}])['new_media_ids']
        writes.upsert_actor({'name':'Existing','tags':['keep']})
        writes.upsert_actor({'name':'Batch Actor','tags':['carry']})
        writes.set_cast(ids[0],['Existing'])
        payload={'mediaIds':ids,'names':['Batch Actor',' New Actor ','Batch Actor']}
        response=self.client.post('/api/media/batch-cast',json=payload,headers=self.headers)
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.json['data']['updated'],2)
        self.assertEqual(store.get_media(ids[0])['cast'],['Existing','Batch Actor','New Actor'])
        self.assertEqual(store.get_media(ids[1])['cast'],['Batch Actor','New Actor'])
        self.assertIn('keep',store.get_media(ids[0])['tags'])
        self.assertIn('carry',store.get_media(ids[1])['tags'])
        self.assertEqual(self.client.post('/api/media/batch-cast',json=payload,headers=self.headers).status_code,200)
        self.assertEqual(len(store.get_media(ids[0])['cast']),3)
    def test_batch_cast_missing_video_is_atomic(self):
        mid=scanner.apply_scan_report('test',[{'rel_path':'atomic.mp4'}])['new_media_ids'][0]
        response=self.client.post('/api/media/batch-cast',json={'mediaIds':[mid,'missing'],'names':['Must not be created']},headers=self.headers)
        self.assertEqual(response.status_code,400)
        self.assertEqual(store.get_media(mid)['cast'],[])
        self.assertIsNone(db.get_conn().execute("SELECT 1 FROM actors WHERE name=?",('Must not be created',)).fetchone())
    def test_batch_cast_requires_auth_and_valid_names(self):
        self.assertEqual(self.client.post('/api/media/batch-cast',json={'mediaIds':['x'],'names':['A']}).status_code,401)
        for payload in [{'mediaIds':[],'names':['A']},{'mediaIds':['x'],'names':[]},{'mediaIds':['x'],'names':[' ']}]:
            self.assertEqual(self.client.post('/api/media/batch-cast',json=payload,headers=self.headers).status_code,400)
    def test_ticket_purpose(self):
        token, _ = tickets.sign('secret','node','root','','file.txt',purpose='delete')
        self.assertEqual(tickets.verify('secret',token)['purpose'],'delete')
        self.assertIsNone(tickets.verify('different',token))

    def patch_entry(self, path, **body):
        return self.client.patch('/api/storages/test/entries', json={'path':path, **body}, headers=self.headers)
    def test_folder_rename_keeps_video_marks_cast_and_clip(self):
        folder=self.root/'old';(folder/'nested').mkdir(parents=True)
        (folder/'nested'/'Movie.mp4').write_bytes(b'video')
        mid=scanner.apply_scan_report('test',[{'rel_path':'old/nested/Movie.mp4'}])['new_media_ids'][0]
        writes.set_cast(mid,['Keep Actor']);writes.add_mark(mid,1,'Keep Mark',None)
        clip=writes.create_clip(mid,0,1,'Keep Clip')
        result=self.patch_entry('old',action='rename',name='新文件夹')
        self.assertEqual(result.status_code,200,result.json)
        self.assertTrue((self.root/'新文件夹'/'nested'/'Movie.mp4').exists())
        item=store.get_media(mid)
        self.assertEqual(item['filePath'],'新文件夹/nested/Movie.mp4')
        self.assertEqual(item['name'],'Movie')
        self.assertEqual(item['cast'],['Keep Actor'])
        self.assertEqual(db.get_conn().execute('SELECT label FROM marks WHERE media_id=?',(mid,)).fetchone()['label'],'Keep Mark')
        self.assertEqual(store.get_media(clip['id'])['folder'],'新文件夹/nested')
        self.assertEqual(scanner.apply_scan_report('test',[{'rel_path':'新文件夹/nested/Movie.mp4'}])['added'],0)
    def test_file_move_and_rename_updates_actual_file_and_clip_parent(self):
        (self.root/'Dest').mkdir();(self.root/'Original.mp4').write_bytes(b'video')
        mid=scanner.apply_scan_report('test',[{'rel_path':'Original.mp4'}])['new_media_ids'][0]
        clip=writes.create_clip(mid,0,1,'clip')
        self.assertEqual(self.patch_entry('Original.mp4',action='move',directory='Dest').status_code,200)
        self.assertEqual(self.patch_entry('Dest/Original.mp4',action='rename',name='新名字.mp4').status_code,200)
        self.assertFalse((self.root/'Original.mp4').exists())
        self.assertTrue((self.root/'Dest'/'新名字.mp4').exists())
        self.assertEqual(store.get_media(mid)['filePath'],'Dest/新名字.mp4')
        self.assertEqual(store.get_media(clip['id'])['parentName'],'新名字')
    def test_conflict_and_invalid_moves_keep_files_and_metadata(self):
        (self.root/'a.txt').write_text('a');(self.root/'b.txt').write_text('b')
        (self.root/'sub'/'child').mkdir(parents=True)
        for path,body,status in [
            ('a.txt',{'action':'rename','name':'b.txt'},409),
            ('a.txt',{'action':'rename','name':'../escape'},400),
            ('a.txt',{'action':'rename','name':'NUL.txt'},400),
            ('a.txt',{'action':'move','directory':'missing'},404),
            ('a.txt',{'action':'move','directory':'../outside'},400),
            ('sub',{'action':'move','directory':'sub/child'},400),
            ('',{'action':'rename','name':'bad'},400),
            ('a.txt',{'action':'move','directory':''},400)]:
            with self.subTest(path=path,body=body): self.assertEqual(self.patch_entry(path,**body).status_code,status)
        self.assertEqual((self.root/'a.txt').read_text(),'a');self.assertEqual((self.root/'b.txt').read_text(),'b')
        (self.root/'alias').symlink_to(self.root/'sub',target_is_directory=True)
        self.assertEqual(self.patch_entry('a.txt',action='move',directory='alias').status_code,400)
        self.assertEqual(self.client.patch('/api/storages/test/entries',json={'path':'a.txt','action':'rename','name':'z.txt'}).status_code,401)
    def test_windows_remote_move_binds_destination_and_preserves_case(self):
        from unittest.mock import patch,Mock
        c=db.get_conn();c.execute("INSERT INTO storages(id,name,kind,root_path,online,node_id,added_at) VALUES('rpc','rpc','remote',?,1,'test-node',0)",('E:\\Video-Test',));c.commit()
        mid=scanner.apply_scan_report('rpc',[{'rel_path':'Folder/Movie.mp4'}])['new_media_ids'][0]
        response=Mock(ok=True,status_code=200);response.json.return_value={'ok':True,'data':{'path':'Dest/Movie.mp4'}}
        with patch.object(nodes,'get_node',return_value={'stream_key':'rpc-secret','base_url':'http://connector:8788'}),patch.object(nodes,'is_online',return_value=True),patch('storage_files.requests.request',return_value=response) as rpc:
            r=self.client.patch('/api/storages/rpc/entries',json={'path':'Folder/Movie.mp4','action':'move','directory':'Dest'},headers=self.headers)
            self.assertEqual(r.status_code,200,r.json)
            claims=tickets.verify('rpc-secret',rpc.call_args.kwargs['params']['ticket'])
            self.assertEqual((claims['purpose'],claims['rel_path'],claims['destination']),('relocate','Folder/Movie.mp4','Dest/Movie.mp4'))
            self.assertEqual(store.get_media(mid)['filePath'],'Dest/Movie.mp4')


class FileManagement(unittest.TestCase):
    setUpClass = Integration.__dict__['setUpClass']
    setUp = Integration.setUp
    tearDown = Integration.tearDown
    browse = Integration.browse
    delete = Integration.delete
    # New end-to-end cases use a fresh temporary storage for every test.
    def test_create_nested_folder_and_upload_any_file_to_current_path(self):
        (self.root/'parent').mkdir()
        response = self.client.post('/api/storages/test/entries', json={'path':'parent/新文件夹'}, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.json)
        for name, content in [('notes.txt', b'hello'), ('movie.mp4', b'video'), ('empty.txt', b'')]:
            path = 'parent/新文件夹/' + name
            response = self.client.put('/api/storages/test/files', query_string={'path':path}, data=content, headers=self.headers)
            self.assertEqual(response.status_code, 200, response.json)
            self.assertEqual((self.root/path).read_bytes(), content)
            self.assertFalse((self.root/name).exists())
        listing = self.browse('parent/新文件夹').json['data']
        self.assertEqual(listing['fileCount'], 3)
        self.assertTrue(any(item['filePath']=='parent/新文件夹/movie.mp4' for item in store.snapshot()['media']))
    def test_upload_conflict_and_invalid_paths_keep_existing_content(self):
        (self.root/'keep.txt').write_bytes(b'keep')
        for path in ['keep.txt','../escape.txt','C:/escape.txt','/escape.txt','missing/file.txt','CON','bad?.txt']:
            r=self.client.put('/api/storages/test/files', query_string={'path':path}, data=b'replacement', headers=self.headers)
            self.assertIn(r.status_code,[400,404,409], (path,r.json))
        self.assertEqual((self.root/'keep.txt').read_bytes(),b'keep')
        self.assertFalse(list(self.root.glob('.vm-upload-*')))
        self.assertEqual(self.client.put('/api/storages/test/files?path=no.txt',data=b'x').status_code,401)
        self.assertEqual(self.client.post('/api/storages/test/entries',json={'path':'no'}).status_code,401)
    def test_partial_upload_cleans_temp_and_never_publishes(self):
        import io
        with self.assertRaises(ValueError): filesystem.upload(str(self.root),'partial.txt',io.BytesIO(b'partial'),100)
        self.assertFalse((self.root/'partial.txt').exists())
        self.assertFalse(list(self.root.glob('.vm-upload-*')))
    def test_mixed_files_and_folder_move_then_delete(self):
        (self.root/'dest').mkdir(); (self.root/'folder').mkdir()
        (self.root/'folder'/'nested.txt').write_bytes(b'nested')
        (self.root/'note.txt').write_bytes(b'note'); (self.root/'movie.mp4').write_bytes(b'video')
        mid=scanner.apply_scan_report('test',[{'rel_path':'movie.mp4'}])['new_media_ids'][0]
        writes.add_mark(mid,1,'keep',None)
        for path in ['folder','note.txt','movie.mp4']:
            r=self.client.patch('/api/storages/test/entries',json={'path':path,'action':'move','directory':'dest'},headers=self.headers)
            self.assertEqual(r.status_code,200,r.json)
        self.assertEqual(store.get_media(mid)['filePath'],'dest/movie.mp4')
        self.assertEqual(len(store.snapshot()['marks']),1)
        for path in ['dest/note.txt','dest/folder','dest/movie.mp4']:
            self.assertEqual(self.delete(path).status_code,200)
        self.assertEqual(list((self.root/'dest').iterdir()),[])
        self.assertIsNone(store.get_media_row(mid))
    def test_actor_rename_preserves_profile_and_all_cast_links(self):
        mid=scanner.apply_scan_report('test',[{'rel_path':'actor.mp4'}])['new_media_ids'][0]
        writes.upsert_actor({'name':'Before','tags':['tag'],'photoPath':'photo.jpg','bio':'bio','ratings':{'looks':8,'figure':7,'acting':6}})
        writes.set_cast(mid,['Before'])
        clip=writes.create_clip(mid,0,1,'clip')
        writes.set_cast(clip['id'], ['Before'])
        rev=db.current_revision()
        response=self.client.post('/api/actors/rename',json={'name':'Before','newName':' After '},headers=self.headers)
        self.assertEqual(response.status_code,200,response.json)
        self.assertEqual(store.get_media(mid)['cast'],['After'])
        self.assertEqual(store.get_media(clip['id'])['cast'],['After'])
        row=db.get_conn().execute('SELECT * FROM actors WHERE name=?',('After',)).fetchone()
        self.assertEqual((row['photo_path'],row['bio'],row['rating_looks']),('photo.jpg','bio',8))
        self.assertEqual(db.get_conn().execute('SELECT tag FROM actor_tags WHERE actor_name=?',('After',)).fetchone()['tag'],'tag')
        delta=store.delta(rev)
        self.assertIn('Before',delta['deleteActorNames'])
    def test_actor_rename_conflict_is_atomic(self):
        writes.upsert_actor({'name':'Original'});writes.upsert_actor({'name':'Occupied'})
        for name in ['Occupied',' ','x'*201]:
            response=self.client.post('/api/actors/rename',json={'name':'Original','newName':name},headers=self.headers)
            self.assertEqual(response.status_code,400,response.json)
        self.assertIsNotNone(db.get_conn().execute("SELECT 1 FROM actors WHERE name='Original'").fetchone())
        self.assertEqual(self.client.post('/api/actors/rename',json={'name':'Original','newName':'New'}).status_code,401)
        self.assertEqual(self.client.post('/api/actors/rename',json={'name':'Missing','newName':'New'},headers=self.headers).status_code,404)
    def test_remote_create_upload_bind_signed_path_and_index_video(self):
        from unittest.mock import patch, Mock
        c=db.get_conn();c.execute("INSERT INTO storages(id,name,kind,root_path,online,node_id,added_at) VALUES('rpc','rpc','remote','E:/video-test',1,'test-node',0)");c.commit()
        response=Mock(ok=True,status_code=200);response.json.return_value={'ok':True,'data':{'path':'sub/movie.mp4','size':5}}
        captures=[]
        def rpc(method,url,**kw):
            claims=tickets.verify('rpc-secret',kw['params']['ticket'])
            captures.append((method,claims,kw['data'].read() if kw['data'] is not None else None))
            return response
        with patch.object(nodes,'get_node',return_value={'stream_key':'rpc-secret','base_url':'http://connector:8788'}),patch.object(nodes,'is_online',return_value=True),patch('storage_files.requests.request',side_effect=rpc):
            r=self.client.post('/api/storages/rpc/entries',json={'path':'sub/new'},headers=self.headers)
            self.assertEqual(r.status_code,200,r.json)
            r=self.client.put('/api/storages/rpc/files?path=sub/movie.mp4',data=b'video',headers=self.headers)
            self.assertEqual(r.status_code,200,r.json)
        self.assertEqual((captures[0][0],captures[0][1]['purpose'],captures[0][1]['rel_path']),('POST','mkdir','sub/new'))
        self.assertEqual((captures[1][0],captures[1][1]['purpose'],captures[1][1]['rel_path'],captures[1][2]),('PUT','upload-file','sub/movie.mp4',b'video'))

if __name__=='__main__': unittest.main(verbosity=2)
