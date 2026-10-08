"""Download pinned optional benchmark models; never read a checkpoint corpus."""
import argparse
import json
import os
from pathlib import Path

from huggingface_hub import snapshot_download

parser = argparse.ArgumentParser()
parser.add_argument('--out', required=True)
args = parser.parse_args()
registry = json.loads(Path(__file__).with_name('models.json').read_text())
output = Path(args.out)
if output.exists():
    raise SystemExit('Manifest exists; choose another output.')
manifest = {}
for name, entry in registry.items():
    try:
        path = snapshot_download(entry['model'], revision=entry['revision'],
            allow_patterns=['*.json', '*.safetensors', '*.txt', '*.md', '*.jinja', '*.model', 'LICENSE'])
        manifest[name] = {**entry, 'path': path}
        print(json.dumps({'candidate': name, 'status': 'downloaded'}), flush=True)
    except Exception as error:
        # Hub errors can include credentials/URLs. Only the class is reported.
        manifest[name] = {**entry, 'downloadError': type(error).__name__}
        print(json.dumps({'candidate': name, 'status': 'unavailable', 'errorClass': type(error).__name__}), flush=True)
output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
with os.fdopen(os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as file:
    json.dump(manifest, file, indent=2)
    file.write('\n')
