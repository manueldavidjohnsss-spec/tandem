#!/bin/bash
# Stamps a new web version so open apps show "A new version of Tandem is ready".
# Keeps the "android" block in version.json untouched.
set -e
V=$(date -u +%Y.%m.%d-%H%M)
cd "$(dirname "$0")/../web"
sed -i.bak "s/var APP_VERSION=\"[^\"]*\"/var APP_VERSION=\"$V\"/" app.js && rm -f app.js.bak
python3 - "$V" <<'PY'
import json,sys
p='version.json'
try: d=json.load(open(p))
except Exception: d={}
d['v']=sys.argv[1]
json.dump(d,open(p,'w'),indent=1)
PY
echo "Version $V"
