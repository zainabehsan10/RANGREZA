/* ==========================================================================
   RANGREZA MATCHING SCORE (RMS)
   --------------------------------------------------------------------------
   RMS = 0.30·C + 0.25·V + 0.15·F + 0.15·P + 0.15·O      (weights in W_RMS)

     C  colour compatibility    CIELAB harmony rules (tonal / metallic / complementary)
     V  visual compatibility    CLIP image-embedding cosine; falls back to the
                                hand-built texture descriptor if CLIP isn't loaded
     F  fabric compatibility    fabric weight (chiffon … velvet) vs trim weight
     P  pattern compatibility   busy fabric + busy trim is penalised; plain fabric
                                is allowed a statement trim
     O  occasion compatibility  formality / vibrancy / category fit for the occasion

   A signal that cannot be computed (no CLIP, no occasion chosen) is dropped and
   the remaining weights are renormalised, so the score is never silently padded.
   All weights and tables are plain data here so they can be tuned and ablated.
   ========================================================================== */

var W_RMS = { C:0.30, V:0.25, F:0.15, P:0.15, O:0.15 };
var SIGNALS = ['C','V','F','P','O'];

var OCCASIONS = {
  Wedding:{ formality:0.80, vibrancy:0.50, cats:{Dabka:1,Gota:0.9,Motifs:0.9,Lace:0.8,Beads:0.8,Tassels:0.6,Trims:0.6,Buttons:0.5} },
  Mehndi: { formality:0.45, vibrancy:0.90, cats:{Tassels:1,Gota:1,Beads:0.9,Trims:0.8,Buttons:0.7,Lace:0.6,Motifs:0.6,Dabka:0.5} },
  Barat:  { formality:1.00, vibrancy:0.40, cats:{Dabka:1,Motifs:1,Gota:0.9,Beads:0.8,Lace:0.7,Tassels:0.6,Trims:0.5,Buttons:0.5} },
  Walima: { formality:0.65, vibrancy:0.25, cats:{Lace:1,Beads:0.9,Motifs:0.8,Dabka:0.7,Gota:0.7,Trims:0.7,Tassels:0.5,Buttons:0.6} },
  Eid:    { formality:0.50, vibrancy:0.60, cats:{Lace:0.9,Gota:0.9,Trims:0.9,Tassels:0.8,Buttons:0.8,Beads:0.7,Motifs:0.7,Dabka:0.6} },
  Party:  { formality:0.60, vibrancy:0.60, cats:{Beads:1,Lace:0.9,Trims:0.8,Motifs:0.8,Gota:0.7,Tassels:0.6,Dabka:0.6,Buttons:0.6} },
  Casual: { formality:0.20, vibrancy:0.40, cats:{Buttons:1,Trims:1,Lace:0.8,Tassels:0.6,Gota:0.5,Beads:0.4,Motifs:0.4,Dabka:0.2} }
};
var OCCASION_NAMES = Object.keys(OCCASIONS);

// How heavy / busy / formal a trim category is, before looking at the photo.
var CAT_HEFT   = { Lace:0.40, Gota:0.60, Dabka:0.90, Buttons:0.50, Tassels:0.70, Trims:0.40, Beads:0.70, Motifs:0.70 };
var CAT_BUSY   = { Lace:0.50, Gota:0.55, Dabka:0.85, Buttons:0.35, Tassels:0.55, Trims:0.35, Beads:0.65, Motifs:0.80 };
var CAT_FORMAL = { Lace:0.55, Gota:0.65, Dabka:0.95, Buttons:0.30, Tassels:0.55, Trims:0.35, Beads:0.70, Motifs:0.85 };

// Zero-shot label sets for CLIP. `prompt` is the sentence CLIP sees; `v` the value it maps to.
var FABRIC_LABELS = [
  { k:'chiffon', prompt:'a photo of sheer chiffon fabric',       v:0.20 },
  { k:'lawn',    prompt:'a photo of light lawn cotton fabric',   v:0.20 },
  { k:'cotton',  prompt:'a photo of plain cotton fabric',        v:0.30 },
  { k:'net',     prompt:'a photo of net fabric',                 v:0.20 },
  { k:'organza', prompt:'a photo of stiff organza fabric',       v:0.30 },
  { k:'silk',    prompt:'a photo of shiny silk fabric',          v:0.50 },
  { k:'raw silk',prompt:'a photo of textured raw silk fabric',   v:0.60 },
  { k:'velvet',  prompt:'a photo of thick velvet fabric',        v:0.90 },
  { k:'jamawar', prompt:'a photo of heavy brocade jamawar fabric', v:0.90 }
];
var PATTERN_LABELS = [
  { k:'plain',       prompt:'a photo of plain solid-colour fabric',            v:0.00 },
  { k:'floral',      prompt:'a photo of floral printed fabric',                v:0.60 },
  { k:'geometric',   prompt:'a photo of fabric with a geometric pattern',      v:0.60 },
  { k:'printed',     prompt:'a photo of printed fabric',                       v:0.55 },
  { k:'embroidered', prompt:'a photo of embroidered fabric',                   v:0.80 },
  { k:'heavy work',  prompt:'a photo of heavily embellished bridal fabric',    v:1.00 }
];
var ITEM_STYLE_LABELS = [
  { k:'delicate', prompt:'a thin delicate minimal trim for a dress' },
  { k:'ornate',   prompt:'a heavy ornate bridal embellishment' }
];

// Texture descriptor for an item. Real listings carry one from upload; items without
// a stored descriptor get one computed from a procedurally drawn swatch (demo data).
function texOf(item){
  if(item.tex) return item.tex;
  var cat = item.cat === 'Dabka' ? 'Motifs' : item.cat;
  item.tex = textureDescriptor(item.imgEl ? item.imgEl : drawSwatch(cat, item.hex, 128));
  return item.tex;
}

function clamp01(x){ return Math.max(0, Math.min(1, x)); }

/* ---------- colour: which rule made the match ---------- */
function harmonyDetail(fabricHex, itemHex){
  var f = hexToLab(fabricHex), i = hexToLab(itemHex);
  var tonal = Math.max(0, 1 - deltaE(f, i) / 60);
  var dN = Infinity;
  for(var n=0; n<NEUTRAL_LABS.length; n++){ var d = deltaE(NEUTRAL_LABS[n], i); if(d < dN) dN = d; }
  var neutral = Math.max(0, 1 - dN / 25);
  var comp = 0;
  if(chroma(f) > 12 && chroma(i) > 12){
    var gap = Math.abs(hueDeg(f) - hueDeg(i)); gap = Math.min(gap, 360 - gap);
    comp = Math.max(0, 1 - Math.abs(gap - 180) / 60);
  }
  var cand = [ ['tonal', 0.80*tonal], ['metallic', 0.72*neutral], ['complementary', 0.65*comp] ];
  cand.sort(function(a,b){ return b[1]-a[1]; });
  var score = cand[0][1];
  if(f[0] < 30 && i[0] < 30) score *= 0.75;
  return { score: clamp01(score), rule: cand[0][0] };
}

function scoreC(fabric, item){
  var pal = (fabric.palette && fabric.palette.length) ? fabric.palette.slice(0,3) : [{ hex:fabric.hex, prop:1 }];
  var tot = 0, wsum = 0, best = { score:-1, rule:'tonal', fabHex:pal[0].hex };
  pal.forEach(function(p){
    var d = harmonyDetail(p.hex, item.hex);
    tot += d.score * p.prop; wsum += p.prop;
    if(d.score > best.score) best = { score:d.score, rule:d.rule, fabHex:p.hex };
  });
  var avg = wsum ? tot / wsum : 0;
  return { v: clamp01(0.65*avg + 0.35*best.score), rule: best.rule, fabHex: best.fabHex };
}

/* ---------- visual: CLIP if both vectors exist, else texture ---------- */
function dot(a, b){ var s = 0, n = Math.min(a.length, b.length); for(var i=0;i<n;i++) s += a[i]*b[i]; return s; }

function scoreV(fabric, item){
  if(fabric.emb && item.emb){
    // CLIP image-image cosine sits in ~0.5 (unrelated) … ~0.95 (near-identical).
    return { v: clamp01((dot(fabric.emb, item.emb) - 0.5) / 0.45), by:'clip' };
  }
  var ft = fabric.tex, it = ft ? texOf(item) : null;
  if(ft && it) return { v: cosineSim(ft, it), by:'texture' };
  return null;
}

/* ---------- item style: from CLIP attrs if present, else category priors ---------- */
function itemStyle(item){
  var o = item.attrs && typeof item.attrs.ornate === 'number' ? item.attrs.ornate : null;
  var heft = CAT_HEFT[item.cat] != null ? CAT_HEFT[item.cat] : 0.5;
  var busy = CAT_BUSY[item.cat] != null ? CAT_BUSY[item.cat] : 0.5;
  var formal = CAT_FORMAL[item.cat] != null ? CAT_FORMAL[item.cat] : 0.5;
  if(o != null){ heft = 0.5*heft + 0.5*o; busy = 0.5*busy + 0.5*o; formal = 0.5*formal + 0.5*o; }
  var lab = hexToLab(item.hex);
  var metallic = false;
  for(var n=0; n<NEUTRAL_LABS.length; n++) if(deltaE(NEUTRAL_LABS[n], lab) < 22) metallic = true;
  if(metallic) formal = clamp01(formal + 0.08);
  return { heft:heft, busy:busy, formal:formal, metallic:metallic, vib: clamp01(chroma(lab) / 60) };
}

function scoreF(fabric, item){
  if(fabric.heft == null) return null;
  var st = itemStyle(item);
  return clamp01(1 - Math.abs(fabric.heft - st.heft) * 1.6);
}
function scoreP(fabric, item){
  if(fabric.busy == null) return null;
  var s = fabric.busy + itemStyle(item).busy;
  return clamp01(1 - 0.9*clamp01((s - 0.9)/0.8) - 0.4*clamp01((0.5 - s)/0.5));
}
function scoreO(item, occasion){
  var occ = OCCASIONS[occasion]; if(!occ) return null;
  var st = itemStyle(item);
  var catFit = occ.cats[item.cat] != null ? occ.cats[item.cat] : 0.5;
  return clamp01(0.4*(1 - Math.abs(st.formal - occ.formality)) + 0.4*catFit + 0.2*(1 - Math.abs(st.vib - occ.vibrancy)));
}

/**
 * Score one item against one analysed fabric.
 * opts.weights  — override W_RMS (used for baselines and ablations)
 * opts.occasion — one of OCCASION_NAMES or null
 */
function scoreRMS(fabric, item, opts){
  opts = opts || {};
  var W = opts.weights || W_RMS;
  var c = scoreC(fabric, item), v = scoreV(fabric, item);
  var parts = { C:c.v, V: v ? v.v : null, F:scoreF(fabric, item), P:scoreP(fabric, item), O:scoreO(item, opts.occasion) };
  var num = 0, den = 0;
  SIGNALS.forEach(function(k){ if(parts[k] != null && W[k] > 0){ num += W[k]*parts[k]; den += W[k]; } });
  return { rms: den ? num/den : 0, parts:parts, rule:c.rule, fabHex:c.fabHex, vBy: v ? v.by : null };
}

function rankItems(fabric, items, opts){
  return items.map(function(it){
    var s = scoreRMS(fabric, it, opts);
    return { item: it, rms: s.rms, parts: s.parts, rule: s.rule, fabHex: s.fabHex, vBy: s.vBy };
  }).sort(function(a,b){ return b.rms - a.rms; });
}

/* ---------- explanation ---------- */
function explain(fabric, row, opts){
  var item = row.item, p = row.parts, bits = [];
  var fabName = nearestColorName(row.fabHex || fabric.hex), itName = nearestColorName(item.hex);
  var C = '';
  if(row.rule === 'metallic') C = itName + ' is a universal metallic that sits well with ' + fabName.toLowerCase() + ' fabric';
  else if(row.rule === 'complementary') C = itName.toLowerCase() + ' is a deliberate complementary accent against the ' + fabName.toLowerCase();
  else C = itName.toLowerCase() + ' is tonally close to the fabric’s ' + fabName.toLowerCase();
  bits.push({ w:W_RMS.C*p.C, t:C });
  if(p.F != null && p.F >= 0.7 && fabric.fabricName){
    var st = itemStyle(item);
    bits.push({ w:W_RMS.F*p.F, t:'its ' + (st.heft > 0.6 ? 'substantial' : 'light') + ' weight suits ' + fabric.fabricName });
  }
  if(p.P != null && p.P >= 0.7 && fabric.patternName){
    bits.push({ w:W_RMS.P*p.P, t: fabric.busy < 0.35
      ? 'a plain fabric lets this ' + item.cat.toLowerCase() + ' be the statement'
      : 'it keeps the ' + fabric.patternName + ' fabric from looking overworked' });
  }
  if(p.O != null && p.O >= 0.65 && opts && opts.occasion){
    bits.push({ w:W_RMS.O*p.O, t:'it fits the ' + opts.occasion + ' look' });
  }
  if(p.V != null && p.V >= 0.7 && row.vBy === 'clip'){
    bits.push({ w:W_RMS.V*p.V, t:'the AI vision model sees a close visual match' });
  }
  bits.sort(function(a,b){ return b.w - a.w; });
  var top = bits.slice(0, 3).map(function(b){ return b.t; });
  var s = top.length > 1 ? top.slice(0, -1).join(', ') + ' and ' + top[top.length-1] : top[0];
  return 'Recommended because ' + s + '.';
}

/* ---------- styling bundle ---------- */
var BUNDLE_SLOTS = [
  { slot:'Border',   cats:['Dabka','Lace','Gota','Trims'] },
  { slot:'Neckline', cats:['Lace','Beads','Motifs','Buttons'] },
  { slot:'Sleeves',  cats:['Gota','Trims','Lace','Beads'] },
  { slot:'Dupatta',  cats:['Tassels','Gota','Motifs','Trims'] }
];

function buildBundle(rows){
  var used = {}, usedCats = {}, picks = [];
  BUNDLE_SLOTS.forEach(function(sl){
    var best = null, bestS = -1;
    rows.forEach(function(r){
      var ci = sl.cats.indexOf(r.item.cat);
      if(ci < 0 || used[r.item.id] || r.item.stock === 'out_of_stock') return;
      var s = r.rms + (ci === 0 ? 0.05 : 0) - (usedCats[r.item.cat] ? 0.06 : 0);
      if(s > bestS){ bestS = s; best = r; }
    });
    if(best){ used[best.item.id] = 1; usedCats[best.item.cat] = 1; picks.push({ slot:sl.slot, row:best }); }
  });
  if(picks.length < 2) return null;
  var mean = picks.reduce(function(a,p){ return a + p.row.rms; }, 0) / picks.length;
  var coh = 0, n = 0;
  for(var i=0;i<picks.length;i++) for(var j=i+1;j<picks.length;j++){
    coh += colorHarmony(picks[i].row.item.hex, picks[j].row.item.hex); n++;
  }
  coh = n ? coh/n : 1;
  return { picks:picks, overall: clamp01(mean * (0.92 + 0.08*coh)) };
}

/* ---------- fabric attributes from CLIP zero-shot probabilities ---------- */
function softmax(xs, T){
  var m = Math.max.apply(null, xs), e = xs.map(function(x){ return Math.exp((x - m) * T); });
  var s = e.reduce(function(a,b){ return a+b; }, 0);
  return e.map(function(x){ return x / s; });
}
// imgEmb: unit vector; labelEmbs: array of unit vectors aligned with `labels`.
function zeroShot(imgEmb, labelEmbs, labels){
  var probs = softmax(labelEmbs.map(function(l){ return dot(imgEmb, l); }), 100); // CLIP logit scale
  var exp = 0, bi = 0;
  probs.forEach(function(p, i){ if(labels[i].v != null) exp += p * labels[i].v; if(p > probs[bi]) bi = i; });
  return { probs:probs, expected:exp, top:labels[bi].k, topP:probs[bi] };
}

/* ---------- evaluation metrics ---------- */
function precisionAtK(rel, k){ var s = 0; rel.slice(0,k).forEach(function(r){ s += r ? 1 : 0; }); return k ? s / k : 0; }
function recallAtK(rel, k, totalRel){ if(!totalRel) return 0; var s = 0; rel.slice(0,k).forEach(function(r){ s += r ? 1 : 0; }); return s / totalRel; }
function ndcgAtK(rel, k, totalRel){
  var dcg = 0; rel.slice(0,k).forEach(function(r, i){ if(r) dcg += 1 / Math.log2(i + 2); });
  var ideal = 0, m = Math.min(k, totalRel); for(var i=0;i<m;i++) ideal += 1 / Math.log2(i + 2);
  return ideal ? dcg / ideal : 0;
}
