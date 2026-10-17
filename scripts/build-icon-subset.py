"""Optional maintainer tool: regenerate the committed Remix font/CSS subset.
Requires FontTools (fonttools package). Application builds only need Node and use
checked-in assets; no Python dependency or font service is used at runtime.
"""
from pathlib import Path
import json
import subprocess
from fontTools import subset
from fontTools.ttLib import TTFont

root = Path(__file__).resolve().parent.parent
metadata = json.loads(subprocess.check_output(
    ['node', str(root / 'scripts/check-icon-subset.mjs'), '--metadata'], text=True))
font = TTFont(root / 'node_modules/remixicon/fonts/remixicon.ttf', recalcTimestamp=False)
options = subset.Options()
options.recalc_timestamp = False
subsetter = subset.Subsetter(options=options)
subsetter.populate(unicodes=metadata['codepoints'])
subsetter.subset(font)
font.flavor = 'woff'
font.save(metadata['fontPath'])
font.close()
subprocess.run(['node', str(root / 'scripts/check-icon-subset.mjs'), '--write-css'], check=True)
