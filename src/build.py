head = '''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Rangreza — AI Embellishment Matching</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;0,700;1,500&family=Jost:wght@400;500;600;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"></script>\n<script src="config.js"></script>
<script>try{var t=localStorage.getItem("rz_theme");if(t==="dark")document.documentElement.setAttribute("data-theme","dark");}catch(e){}</script>
<style>
/* RANGREZA v4 — three portals (Shop, Vendor, Admin), Supabase-backed, CLIP-assisted matching.
   One self-contained file. Setup: SETUP_GUIDE.md */
'''
css = open('v3.css').read() + open('extra.css').read()
js = '\n'.join(open(f).read() for f in ['engine.js','match.js','app_a.js','app_b.js','app_c.js'])
out = head + css + '</style>\n</head>\n<body>\n' + open('body.html').read() + '\n<script>\n"use strict";\n' + js + '\n</script>\n</body>\n</html>\n'
open('/mnt/user-data/outputs/rangreza/rangreza_version_4.html','w').write(out)
print(len(out.splitlines()), 'lines')
