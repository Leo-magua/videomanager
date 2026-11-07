import importlib.util, os, sys, tempfile, unittest
from pathlib import Path
sys.dont_write_bytecode=True
ROOT=Path(__file__).resolve().parents[1]/'packages'
sys.path.insert(0,str(ROOT/'connector'))
temp=tempfile.TemporaryDirectory()
os.environ['VM_STATE_FILE']=str(Path(temp.name)/'state.json')
import app
spec=importlib.util.spec_from_file_location('signer',ROOT/'coordinator/tickets.py'); signer=importlib.util.module_from_spec(spec);spec.loader.exec_module(signer)
app.NODE.update(id='node',stream_key='secret')
app._storage_root['root']=temp.name
client=app.app.test_client()
def ticket(purpose,path): return signer.sign('secret','node','root','',path,purpose=purpose)[0]
class ConnectorTest(unittest.TestCase):
 def test_1_stream_cannot_delete_or_browse(self):
  path=Path(temp.name)/'keep.txt';path.write_text('keep')
  t=ticket('stream','keep.txt')
  self.assertEqual(client.delete('/files/entries',query_string={'ticket':t}).status_code,403)
  self.assertEqual(client.get('/files/entries',query_string={'ticket':t}).status_code,403)
  self.assertTrue(path.exists())
 def test_2_browse_all_files(self):
  (Path(temp.name)/'empty').mkdir()
  r=client.get('/files/entries',query_string={'ticket':ticket('browse','')})
  self.assertEqual(r.status_code,200)
  self.assertEqual({e['name'] for e in r.json['data']['entries']},{'empty','keep.txt'})
 def test_3_delete_scoped_path_only(self):
  t=ticket('delete','keep.txt')
  r=client.delete('/files/entries',query_string={'ticket':t,'path':'empty'})
  self.assertEqual(r.status_code,200)
  self.assertFalse((Path(temp.name)/'keep.txt').exists())
  self.assertTrue((Path(temp.name)/'empty').is_dir())
 def test_4_file_operation_ticket_cannot_upload(self):
  path=Path(temp.name)/'guard.txt';path.write_text('keep')
  t=ticket('delete','guard.txt')
  r=client.post('/files/upload',query_string={'ticket':t},data=b'replacement')
  self.assertEqual(r.status_code,403)
  self.assertEqual(path.read_text(),'keep')
 def test_5_reject_root_and_wrong_owner(self):
  self.assertEqual(client.delete('/files/entries',query_string={'ticket':ticket('delete','')}).status_code,400)
  t=signer.sign('secret','other','root','','',purpose='browse')[0]
  self.assertEqual(client.get('/files/entries',query_string={'ticket':t}).status_code,403)
 def test_6_move_uses_signed_destination_only(self):
  root=Path(temp.name);(root/'move.txt').write_text('keep')
  t=signer.sign('secret','node','root','','move.txt',purpose='relocate',destination='moved.txt')[0]
  r=client.patch('/files/entries',query_string={'ticket':t},json={'destination':'guard.txt'})
  self.assertEqual(r.status_code,200,r.json)
  self.assertEqual((root/'moved.txt').read_text(),'keep')
  self.assertEqual((root/'guard.txt').read_text(),'keep')
  self.assertFalse((root/'move.txt').exists())
 def test_7_wrong_ticket_purpose_cannot_move_or_stream(self):
  for purpose in ['stream','browse','delete']:
   self.assertEqual(client.patch('/files/entries',query_string={'ticket':ticket(purpose,'guard.txt')}).status_code,403)
  t=signer.sign('secret','node','root','','guard.txt',purpose='relocate',destination='../outside')[0]
  self.assertEqual(client.patch('/files/entries',query_string={'ticket':t}).status_code,400)
  self.assertEqual(client.get('/files/stream',query_string={'ticket':t}).status_code,403)
  self.assertEqual((Path(temp.name)/'guard.txt').read_text(),'keep')

 def test_8_mkdir_upload_scope_conflict_and_empty_file(self):
  r=client.post('/files/entries',query_string={'ticket':ticket('mkdir','created')})
  self.assertEqual(r.status_code,200,r.json)
  for purpose in ['stream','browse','delete','relocate','mkdir']:
   self.assertEqual(client.put('/files/content',query_string={'ticket':ticket(purpose,'created/phone.txt')},data=b'bad').status_code,403)
  t=ticket('upload-file','created/phone.txt')
  r=client.put('/files/content',query_string={'ticket':t,'path':'elsewhere.txt'},data=b'phone')
  self.assertEqual(r.status_code,200,r.json)
  self.assertEqual((Path(temp.name)/'created/phone.txt').read_bytes(),b'phone')
  self.assertFalse((Path(temp.name)/'elsewhere.txt').exists())
  self.assertEqual(client.put('/files/content',query_string={'ticket':t},data=b'overwrite').status_code,409)
  self.assertEqual((Path(temp.name)/'created/phone.txt').read_bytes(),b'phone')
  self.assertEqual(client.put('/files/content',query_string={'ticket':ticket('upload-file','created/empty.txt')},data=b'').status_code,200)
  self.assertEqual(client.put('/files/content',query_string={'ticket':ticket('upload-file','../escape.txt')},data=b'x').status_code,400)
  self.assertEqual(client.post('/files/entries',query_string={'ticket':ticket('browse','bad')}).status_code,403)
  self.assertEqual(client.get('/files/stream',query_string={'ticket':t}).status_code,403)
if __name__=='__main__': unittest.main(verbosity=2)
