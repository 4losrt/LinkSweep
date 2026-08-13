from pathlib import Path

root = Path('/home/ubuntu/CleanURLs-Copy-MV3')
parts = [root / 'rules.js', root / 'cleaner.js', root / 'special_urls.js', root / 'navigation_main.js']
out = root / 'navigation_main_bundle.js'
content = '/* Generated MAIN-world navigation cleaner bundle. */\n' + '\n'.join(path.read_text() for path in parts)
out.write_text(content)
print(f'Wrote {out} with {out.stat().st_size} bytes.')
