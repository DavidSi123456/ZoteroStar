from pathlib import Path
import json,zipfile,hashlib

root=Path(__file__).resolve().parent
manifest=json.loads((root/'manifest.json').read_text())
assert manifest['applications']['zotero']['update_url'].startswith('https:'), 'Zotero requires secure update URLs'
out=root/'dist';out.mkdir(exist_ok=True)
package=out/('journal-stars-'+manifest['version']+'.xpi')
files=['manifest.json','bootstrap.js','core.js','plugin.js','rankings.json','icon.svg']
with zipfile.ZipFile(package,'w',zipfile.ZIP_DEFLATED) as z:
    for name in files:z.write(root/name,name)
with zipfile.ZipFile(package) as z:
    assert z.testzip() is None
    assert set(z.namelist())==set(files)
    assert json.loads(z.read('manifest.json'))['applications']['zotero']['strict_max_version']=='10.0.*'
print(json.dumps({'package':str(package),'bytes':package.stat().st_size,
    'sha256':hashlib.sha256(package.read_bytes()).hexdigest(),'version':manifest['version']},ensure_ascii=False))
