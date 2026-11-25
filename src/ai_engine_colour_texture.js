var D65 = [95.047, 100.000, 108.883];
var M_RGB2XYZ = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.0721750],
  [0.0193339, 0.1191920, 0.9503041]
];

function srgbToLinear(c){
  c = c / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** sRGB (0-255) -> CIELAB [L*, a*, b*] */
function rgbToLab(r, g, b){
  var R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  var X = (M_RGB2XYZ[0][0]*R + M_RGB2XYZ[0][1]*G + M_RGB2XYZ[0][2]*B) * 100;
  var Y = (M_RGB2XYZ[1][0]*R + M_RGB2XYZ[1][1]*G + M_RGB2XYZ[1][2]*B) * 100;
  var Z = (M_RGB2XYZ[2][0]*R + M_RGB2XYZ[2][1]*G + M_RGB2XYZ[2][2]*B) * 100;

  var d = 6/29;
  function f(t){ return t > d*d*d ? Math.cbrt(t) : t/(3*d*d) + 4/29; }
  var fx = f(X/D65[0]), fy = f(Y/D65[1]), fz = f(Z/D65[2]);

  return [116*fy - 16, 500*(fx - fy), 200*(fy - fz)];
}

function hexToRgb(hex){
  var h = String(hex).replace('#','');
  return { r:parseInt(h.substr(0,2),16), g:parseInt(h.substr(2,2),16), b:parseInt(h.substr(4,2),16) };
}
function rgbToHex(r,g,b){
  function p(n){ return ('0' + Math.max(0, Math.min(255, Math.round(n))).toString(16)).slice(-2).toUpperCase(); }
  return '#' + p(r) + p(g) + p(b);
}
function hexToLab(hex){ var c = hexToRgb(hex); return rgbToLab(c.r, c.g, c.b); }

/** CIE76 delta-E. ~2-3 = just noticeable, >10 = clearly different, 100 = black vs white. */
function deltaE(l1, l2){
  var dL = l1[0]-l2[0], da = l1[1]-l2[1], db = l1[2]-l2[2];
  return Math.sqrt(dL*dL + da*da + db*db);
}
function chroma(lab){ return Math.sqrt(lab[1]*lab[1] + lab[2]*lab[2]); }
function hueDeg(lab){ var h = Math.atan2(lab[2], lab[1]) * 180 / Math.PI; return (h + 360) % 360; }

/* ---------- Palette extraction: k-means in Lab space ---------- */

function kmeansLab(pixels, k, iters){
  k = Math.max(1, Math.min(k, pixels.length));
  iters = iters || 12;

  // k-means++ style seeding so clusters start spread out rather than clumped.
  var cents = [pixels[Math.floor(pixels.length/2)]];
  for(var c=1; c<k; c++){
    var best = null, bestD = -1;
    for(var i=0; i<pixels.length; i += Math.max(1, Math.floor(pixels.length/220))){
      var dmin = Infinity;
      for(var j=0; j<cents.length; j++){
        var d = deltaE(pixels[i], cents[j]);
        if(d < dmin) dmin = d;
      }
      if(dmin > bestD){ bestD = dmin; best = pixels[i]; }
    }
    cents.push(best || pixels[0]);
  }

  var labels = new Array(pixels.length).fill(0);
  for(var it=0; it<iters; it++){
    var moved = false;
    for(var p=0; p<pixels.length; p++){
      var bi = 0, bd = Infinity;
      for(var q=0; q<cents.length; q++){
        var dd = deltaE(pixels[p], cents[q]);
        if(dd < bd){ bd = dd; bi = q; }
      }
      if(labels[p] !== bi){ labels[p] = bi; moved = true; }
    }
    if(!moved && it > 0) break;

    var sums = cents.map(function(){ return [0,0,0,0]; });
    for(var s=0; s<pixels.length; s++){
      var L = labels[s], px = pixels[s];
      sums[L][0]+=px[0]; sums[L][1]+=px[1]; sums[L][2]+=px[2]; sums[L][3]++;
    }
    for(var t=0; t<cents.length; t++){
      if(sums[t][3] > 0){
        cents[t] = [sums[t][0]/sums[t][3], sums[t][1]/sums[t][3], sums[t][2]/sums[t][3]];
      }
    }
  }

  var counts = cents.map(function(){ return 0; });
  labels.forEach(function(L){ counts[L]++; });
  return { cents: cents, counts: counts, labels: labels };
}

/**
 * Extract the dominant colours of an image element.
 *
 * Near-white and near-black pixels are dropped first. Bazaar and studio photos
 * are shot on white sheets and in shadow, so without this the "dominant colour"
 * of most uploads is the tablecloth, not the trim. If dropping them removes
 * almost everything (genuinely white lace, black velvet) the raw pixels are
 * used instead.
 */
function extractPalette(imgEl, k){
  k = k || 4;
  var W = 64, H = 64;
  var cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  var ctx = cv.getContext('2d');
  ctx.drawImage(imgEl, 0, 0, W, H);

  var data;
  try { data = ctx.getImageData(0, 0, W, H).data; }
  catch(e){ return [{ hex:'#C9A24B', prop:1 }]; }

  var kept = [], all = [];
  for(var i=0; i<data.length; i+=4){
    var r=data[i], g=data[i+1], b=data[i+2], a=data[i+3];
    if(a < 128) continue;
    var rgb = [r,g,b];
    all.push(rgb);
    var nearWhite = r>235 && g>235 && b>235;
    var nearBlack = r<22 && g<22 && b<22;
    if(!nearWhite && !nearBlack) kept.push(rgb);
  }

  var use = (kept.length >= Math.max(24, all.length * 0.05)) ? kept : all;
  if(!use.length) return [{ hex:'#C9A24B', prop:1 }];

  var labs = use.map(function(c){ return rgbToLab(c[0], c[1], c[2]); });
  var res = kmeansLab(labs, k);

  var total = res.counts.reduce(function(a,b){ return a+b; }, 0) || 1;
  var out = [];
  for(var ci=0; ci<res.cents.length; ci++){
    if(res.counts[ci] === 0) continue;
    // Snap the centroid back to a real pixel so the swatch is a colour that
    // actually occurs in the photo, not an interpolated average.
    var bi = 0, bd = Infinity;
    for(var pi=0; pi<labs.length; pi++){
      var d = deltaE(labs[pi], res.cents[ci]);
      if(d < bd){ bd = d; bi = pi; }
    }
    out.push({ hex: rgbToHex(use[bi][0], use[bi][1], use[bi][2]), prop: res.counts[ci]/total });
  }
  out.sort(function(a,b){ return b.prop - a.prop; });
  return out.length ? out : [{ hex:'#C9A24B', prop:1 }];
}

/* ---------- Domain scoring ---------- */

// Metallics and neutrals that Pakistani formalwear pairs with almost anything.
// This is why real bazaar stalls are dominated by gold and silver stock.
var NEUTRALS = ['#C9A24B','#D4AF5A','#C7C7C7','#B76E79','#F3E9DA'];
var NEUTRAL_LABS = NEUTRALS.map(hexToLab);

/**
 * How well does this embellishment SUIT this fabric? Returns 0..1.
 *
 * Three rules that bazaar tailors actually use:
 *   1. Tonal       — trim close in hue to the fabric reads as coordinated
 *   2. Metallic    — gold/silver/rose gold/ivory work with nearly everything
 *   3. Complement  — a trim opposite on the hue wheel is a deliberate accent
 *                    (emerald fabric + rani pink gota), not a clash
 *
 * We take the BEST rule rather than the average: an item only needs to succeed
 * one way. Averaging would punish a perfect complementary pairing for not also
 * being tonal.
 *
 * Being honest about what this is: hand-tuned domain knowledge, not a learned
 * model. With no user data at launch that's the right cold start — and the
 * upgrade path is to log which suggestions people actually order and fit these
 * weights from real behaviour.
 */
function colorHarmony(fabricHex, itemHex){
  var f = hexToLab(fabricHex), i = hexToLab(itemHex);

  // Rule 1 — tonal proximity. dE ~60+ is a completely unrelated colour.
  var tonal = Math.max(0, 1 - deltaE(f, i) / 60);

  // Rule 2 — closeness to any universal neutral.
  var dN = Infinity;
  for(var n=0; n<NEUTRAL_LABS.length; n++){
    var d = deltaE(NEUTRAL_LABS[n], i);
    if(d < dN) dN = d;
  }
  var neutral = Math.max(0, 1 - dN / 25);

  // Rule 3 — complementary hue. Only meaningful when BOTH colours are
  // saturated; hue is meaningless noise for greys and off-whites.
  var comp = 0;
  if(chroma(f) > 12 && chroma(i) > 12){
    var gap = Math.abs(hueDeg(f) - hueDeg(i));
    gap = Math.min(gap, 360 - gap);
    comp = Math.max(0, 1 - Math.abs(gap - 180) / 60);
  }

  var score = Math.max(0.80 * tonal, 0.72 * neutral, 0.65 * comp);

  // Dark trim on dark fabric vanishes at arm's length.
  if(f[0] < 30 && i[0] < 30) score *= 0.75;

  return Math.max(0, Math.min(1, score));
}

/** Plain perceptual sameness — used by Tab 2, where we want the SAME colour. */
function colorSimilarity(a, b){
  return Math.max(0, Math.min(1, 1 - deltaE(hexToLab(a), hexToLab(b)) / 100));
}

/* ==========================================================================
   2. TEXTURE ENGINE
   --------------------------------------------------------------------------
   Colour alone can't tell a gold gota ribbon from gold tassels. We need some
   sense of PATTERN. A full CNN (ResNet etc.) isn't available in a plain browser
   page with no backend, so we compute a compact hand-built descriptor instead:

     - convert to greyscale at two scales (multi-scale = catches both fine
       weave and coarse repeats)
     - Sobel gradients -> edge magnitude and orientation
     - a magnitude-weighted orientation histogram (12 bins per scale)
     - plus edge density and contrast
     - L2-normalised, compared with cosine similarity

   This is essentially a miniature HOG descriptor. It genuinely separates
   directional weaves (gota stripes) from dotted patterns (buttons, beads) from
   dense fringes (tassels), which is all Tab 2 needs. It is NOT a deep model and
   shouldn't be described as one.
   ========================================================================== */

var TEX_BINS = 12;
var TEX_DIM = TEX_BINS * 2 + 2; // two scales + density + contrast

function greyAt(imgOrCanvas, size){
  var cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  var ctx = cv.getContext('2d');
  ctx.drawImage(imgOrCanvas, 0, 0, size, size);
  var d;
  try { d = ctx.getImageData(0, 0, size, size).data; }
  catch(e){ return null; }

  var g = new Float32Array(size * size);
  for(var i=0, p=0; i<d.length; i+=4, p++){
    // Rec. 601 luma
    g[p] = (0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2]) / 255;
  }
  return g;
}

function orientationHist(grey, size){
  var hist = new Float32Array(TEX_BINS);
  var edgeSum = 0, n = 0, mean = 0, m2 = 0;

  for(var y=1; y<size-1; y++){
    for(var x=1; x<size-1; x++){
      var i = y*size + x;

      // Sobel
      var gx = (grey[i-size+1] + 2*grey[i+1] + grey[i+size+1])
             - (grey[i-size-1] + 2*grey[i-1] + grey[i+size-1]);
      var gy = (grey[i+size-1] + 2*grey[i+size] + grey[i+size+1])
             - (grey[i-size-1] + 2*grey[i-size] + grey[i-size+1]);

      var mag = Math.sqrt(gx*gx + gy*gy);
      // Unsigned orientation: a stripe is the same stripe from either side.
      var ang = Math.atan2(gy, gx);
      if(ang < 0) ang += Math.PI;
      var bin = Math.min(TEX_BINS - 1, Math.floor(ang / Math.PI * TEX_BINS));
      hist[bin] += mag;

      edgeSum += mag;
      n++;
      var delta = grey[i] - mean;
      mean += delta / n;
      m2 += delta * (grey[i] - mean);
    }
  }
  return {
    hist: hist,
    density: n ? edgeSum / n : 0,
    contrast: n ? Math.sqrt(m2 / n) : 0
  };
}

/** Build the full texture descriptor for an <img> or <canvas>. */
function textureDescriptor(source){
  var fine = greyAt(source, 64);
  var coarse = greyAt(source, 32);
  if(!fine || !coarse) return null;

  var a = orientationHist(fine, 64);
  var b = orientationHist(coarse, 32);

  var v = new Float32Array(TEX_DIM), k = 0, i;
  for(i=0; i<TEX_BINS; i++) v[k++] = a.hist[i];
  for(i=0; i<TEX_BINS; i++) v[k++] = b.hist[i];
  v[k++] = a.density * 8;    // scaled so density/contrast aren't swamped by
  v[k++] = a.contrast * 8;   // the summed histogram magnitudes

  // L2 normalise so cosine similarity is just a dot product, and so overall
  // image brightness/contrast doesn't dominate the comparison.
  var norm = 0;
  for(i=0; i<TEX_DIM; i++) norm += v[i]*v[i];
  norm = Math.sqrt(norm) || 1e-9;
  for(i=0; i<TEX_DIM; i++) v[i] /= norm;

  return v;
}

function cosineSim(a, b){
  if(!a || !b) return 0;
  var s = 0;
  for(var i=0; i<a.length && i<b.length; i++) s += a[i]*b[i];
  return Math.max(0, Math.min(1, s));
}

/* ==========================================================================
   3. PROCEDURAL SWATCHES
   --------------------------------------------------------------------------
   Seeded demo items have no real photograph, so we draw a category-specific
   texture onto an offscreen canvas and take its descriptor from that. This
   keeps texture matching honest: it runs the same pixel maths on every item,
   whether the pixels came from a vendor's camera or from this generator.

   Real vendor uploads use their actual photo, which is strictly better — swap
   these for real product photography before measuring accuracy.
   ========================================================================== */

function drawSwatch(cat, hex, size){
  size = size || 128;
  var cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  var g = cv.getContext('2d');
  var c = hexToRgb(hex);
  var lab = rgbToLab(c.r, c.g, c.b);
  var fg = hex;
  var bg = lab[0] < 62 ? '#F4ECDD' : '#E7DDCE';
  var S = size / 128;

  g.fillStyle = bg; g.fillRect(0, 0, size, size);
  g.strokeStyle = fg; g.fillStyle = fg;
  var i, x, y;

  if(cat === 'Lace'){
    g.lineWidth = 2*S;
    for(y=0; y<size; y+=14*S){
      for(x=0; x<size; x+=14*S){
        g.beginPath(); g.arc(x+7*S, y+7*S, 5*S, 0, Math.PI*2); g.stroke();
      }
    }
    for(y=7*S; y<size; y+=28*S){
      g.beginPath(); g.moveTo(0,y); g.lineTo(size,y); g.stroke();
    }
  } else if(cat === 'Gota'){
    for(i=-size; i<size*2; i+=13*S){
      g.beginPath();
      g.moveTo(i, 0); g.lineTo(i+6*S, 0); g.lineTo(i+6*S-size, size); g.lineTo(i-size, size);
      g.closePath(); g.fill();
    }
  } else if(cat === 'Buttons'){
    var pts = [[30,32],[86,30],[54,72],[100,86],[26,96]];
    g.lineWidth = 2*S;
    pts.forEach(function(p){
      g.beginPath(); g.arc(p[0]*S, p[1]*S, 15*S, 0, Math.PI*2); g.fill();
      g.strokeStyle = '#2A1E28'; g.stroke(); g.strokeStyle = fg;
      g.fillStyle = bg;
      [[-4,-4],[4,-4],[-4,4],[4,4]].forEach(function(o){
        g.beginPath(); g.arc((p[0]+o[0])*S, (p[1]+o[1])*S, 1.6*S, 0, Math.PI*2); g.fill();
      });
      g.fillStyle = fg;
    });
  } else if(cat === 'Tassels'){
    g.lineWidth = 2.4*S;
    for(x=0; x<size; x+=5.5*S){
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x + (((x*7)%11)-5)*S, size); g.stroke();
    }
    g.fillStyle = bg; g.fillRect(0, 0, size, 14*S);
    g.fillStyle = fg;  g.fillRect(0, 3*S, size, 8*S);
  } else if(cat === 'Beads'){
    for(i=0; i<70; i++){
      var bx = ((i*37) % 120 + 4) * S, by = ((i*61) % 120 + 4) * S;
      g.beginPath(); g.arc(bx, by, (4 + (i%3)*2)*S, 0, Math.PI*2); g.fill();
    }
  } else if(cat === 'Motifs'){
    var cx = size/2, cy = size/2;
    g.lineWidth = 3.5*S;
    for(i=0; i<8; i++){
      var a = i * Math.PI/4;
      g.beginPath();
      g.arc(cx + Math.cos(a)*28*S, cy + Math.sin(a)*28*S, 14*S, 0, Math.PI*2);
      g.stroke();
    }
    g.beginPath(); g.arc(cx, cy, 11*S, 0, Math.PI*2); g.fill();
  } else { // Trims
    g.lineWidth = 4.5*S;
    for(i=-size; i<size*2; i+=10*S){
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i+size, size); g.stroke();
    }
  }
  return cv;
}



/* ==========================================================================
   DATA SHAPE + SCORING (also reused from v2, unchanged)
   ========================================================================== */

var CATS = ['All','Lace','Gota','Buttons','Tassels','Trims','Beads','Motifs'];
var PATTERN = { Lace:'p-lace', Gota:'p-gota', Buttons:'p-buttons', Tassels:'p-tassels',
                Trims:'p-trims', Beads:'p-beads', Motifs:'p-motifs' };
var STOCK_LABEL = { in_stock:'In Stock', low_stock:'Low Stock', pre_order:'Pre-Order', out_of_stock:'Out of Stock' };

var COLOR_NAMES = [
  {n:'Ivory',h:'#F3E9DA'},{n:'Antique Gold',h:'#C9A24B'},{n:'Zari Gold',h:'#D4AF5A'},
  {n:'Rose Gold',h:'#B76E79'},{n:'Silver',h:'#C7C7C7'},{n:'Emerald',h:'#0B6E4F'},
  {n:'Rani Pink',h:'#C2185B'},{n:'Magenta',h:'#A62C6B'},{n:'Ruby Red',h:'#9B1B30'},
  {n:'Royal Navy',h:'#1B2A4A'},{n:'Charcoal',h:'#2B2530'},{n:'Blush',h:'#D9A8A0'},
  {n:'Mustard',h:'#C99A2E'},{n:'Sky Blue',h:'#5B8FBF'},{n:'Lilac',h:'#9B85B0'},
  {n:'Black',h:'#111111'},{n:'White',h:'#FFFFFF'}
];
function nearestColorName(hex){
  var lab = hexToLab(hex), best = COLOR_NAMES[0], bd = Infinity;
  COLOR_NAMES.forEach(function(c){
    var d = deltaE(lab, hexToLab(c.h));
    if(d < bd){ bd = d; best = c; }
  });
  return best.n;
}

var W_FABRIC        = { color:0.80, texture:0.20 };
var W_EMBELLISHMENT = { color:0.45, texture:0.55 };
