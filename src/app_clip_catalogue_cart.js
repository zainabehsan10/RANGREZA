/* ==========================================================================
   CONFIG — paste these two values from Supabase (Project Settings -> API).
   The anon key is MEANT to be public; Row Level Security in schema_v4.sql is
   what protects the data. Never paste the service_role key here.
   ========================================================================== */
var SUPABASE_URL = 'PASTE_YOUR_SUPABASE_URL_HERE';
var SUPABASE_ANON_KEY = 'PASTE_YOUR_SUPABASE_ANON_KEY_HERE';
var CLIP_MODEL = 'Xenova/clip-vit-base-patch32';
var TRANSFORMERS_URLS = [
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/+esm',
  'https://esm.sh/@huggingface/transformers@3.8.1'
];
async function loadTF(){
  var lastErr;
  for(var i=0;i<TRANSFORMERS_URLS.length;i++){
    try { return await import(TRANSFORMERS_URLS[i]); }
    catch(e){ lastErr = e; console.warn('transformers.js CDN failed, trying next:', TRANSFORMERS_URLS[i]); }
  }
  throw lastErr || new Error('transformers.js could not be loaded');
}

var CONFIGURED = SUPABASE_URL.indexOf('PASTE_') === -1 && SUPABASE_ANON_KEY.indexOf('PASTE_') === -1;
var sb = null;

/* ---------- vocab ---------- */
CATS = ['All','Lace','Gota','Dabka','Buttons','Tassels','Trims','Beads','Motifs'];
PATTERN.Dabka = 'p-motifs';
var VENDOR_CATS = CATS.slice(1);
var ORDER_STATUS = ['new','confirmed','ready','fulfilled','cancelled'];
var ITEM_STOCK_OPTS = [['in_stock','In stock'],['low_stock','Low stock'],['pre_order','Pre-order'],['out_of_stock','Out of stock']];
var SAMPLE_FABRICS = [
  { name:'Ruby Red', hex:'#9B1B30' }, { name:'Emerald', hex:'#0B6E4F' }, { name:'Mustard', hex:'#C99A2E' },
  { name:'Rose', hex:'#D9859E' }, { name:'Plum', hex:'#6E3E7A' }, { name:'Ivory', hex:'#F3E9DA' }
];

/* ---------- state ---------- */
var ITEMS = [];
var CONFIG = {};
var state = {
  portal:'shop', tab:'match', vtab:'stock', atab:'overview',
  match:{ cat:'All', fulfil:'all', sort:'match', occasion:null, fabric:null, preview:null },
  vendor:{ cat:'All', fulfil:'all', city:'', query:null, preview:null },
  cart:{}, checkoutStep:'cart',
  session:null, profile:null, myVendor:null, myItems:[], vendorOrders:[], myOrders:[],
  add:{ hex:null, palette:null, tex:null, imgEl:null, file:null, busy:false },
  admin:{ vendors:[], items:[], orders:[], stats:null, loaded:false },
  evalQ:[]
};

/* ---------- helpers ---------- */
function $(id){ return document.getElementById(id); }
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function money(n){ return 'PKR ' + Number(n || 0).toLocaleString('en-PK'); }
function pct(x){ return Math.round(clamp01(x) * 100); }
function shade(hex){
  var c = hexToRgb(hex), lab = rgbToLab(c.r, c.g, c.b);
  if(lab[0] > 62) return rgbToHex(c.r*0.62 + 18, c.g*0.62 + 18, c.b*0.62 + 18);
  return rgbToHex(c.r*0.35 + 214, c.g*0.35 + 208, c.b*0.35 + 196);
}
function displayLocation(v){
  if(v.fulfil === 'online') return 'Ships Nationwide';
  var parts = [v.bazaar, v.shopNo, v.city].filter(Boolean);
  return parts.length ? parts.join(', ') : 'Ships Nationwide';
}
function mapsUrl(v){ return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent([v.name, v.bazaar, v.shopNo, v.city].filter(Boolean).join(' ')); }
function deriveStock(qty){ return qty <= 0 ? 'out_of_stock' : (qty <= 5 ? 'low_stock' : 'in_stock'); }
function fmtDate(s){ try { return new Date(s).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }); } catch(e){ return ''; } }
function fmtDateTime(s){ try { return new Date(s).toLocaleString('en-GB', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }); } catch(e){ return ''; } }
var STOCK_LABEL = { in_stock:'In Stock', low_stock:'Low Stock', pre_order:'Pre-Order', out_of_stock:'Out of Stock' };
var PIN = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s7-7.58 7-13a7 7 0 1 0-14 0c0 5.42 7 13 7 13Z"/><circle cx="12" cy="9" r="2.5"/></svg>';
var TRUCK = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 7h11v9H2z"/><path d="M13 10h4l4 3.2V16h-8z"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/></svg>';
var BAG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 8h12l-1 12H7L6 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>';
var TICK = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="m5 12 5 5 9-10"/></svg>';

var toastTimer;
function toast(msg, kind){
  var t = $('toast'); t.textContent = msg; t.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(function(){ t.className = 'toast'; }, 4200);
}
function swatchHTML(item, extra){
  if(item.img) return '<div class="swatch">' + (extra || '') + '<img src="' + esc(item.img) + '" alt="' + esc(item.name) + '" loading="lazy" /></div>';
  return '<div class="swatch ' + (PATTERN[item.cat] || 'p-trims') + '" style="--sc:' + item.hex + ';--sc-base:' + shade(item.hex) + ';">' + (extra || '') + '</div>';
}
function thumbHTML(item, cls){
  if(item.img) return '<div class="' + cls + '"><img src="' + esc(item.img) + '" alt="" loading="lazy" /></div>';
  return '<div class="' + cls + ' ' + (PATTERN[item.cat] || 'p-trims') + '" style="--sc:' + item.hex + ';--sc-base:' + shade(item.hex) + ';"></div>';
}
function errMsg(e){ return (e && (e.message || e.error_description)) || 'Something went wrong. Please try again.'; }

/* ==========================================================================
   AI VISION (CLIP in the browser via transformers.js)
   --------------------------------------------------------------------------
   Optional by design. Matching works without it (colour + texture); when the
   model finishes loading the results are re-ranked with the V/F/P signals.
   The model files (~90 MB for the image model) download once and are cached
   by the browser. Customers can switch it off to save mobile data.
   ========================================================================== */
var AI = {
  state: 'idle', progress: 0, TF: null, vision: null, proc: null, text: null, tok: null, labels: null, labelsPromise: null,
  enabled: function(){ try { return localStorage.getItem('rz_ai') !== 'off'; } catch(e){ return true; } },
  setEnabled: function(on){ try { localStorage.setItem('rz_ai', on ? 'on' : 'off'); } catch(e){} if(on) AI.start(); else { AI.state = 'idle'; } renderAiStatus(); },
  ready: function(){ return AI.state === 'ready' && !!AI.vision; },
  _progress: function(p){
    if(p && typeof p.progress === 'number'){ AI.progress = Math.max(AI.progress, Math.min(99, Math.round(p.progress))); renderAiStatus(); }
  },
  start: function(){
    if(!AI.enabled() || AI.state === 'loading' || AI.state === 'ready') return Promise.resolve(AI.ready());
    AI.state = 'loading'; AI.progress = 0; renderAiStatus();
    AI._p = (async function(){
      try {
        AI.TF = AI.TF || await loadTF();
        AI.TF.env.allowLocalModels = false;
        AI.proc = await AI.TF.AutoProcessor.from_pretrained(CLIP_MODEL);
        AI.vision = await AI.TF.CLIPVisionModelWithProjection.from_pretrained(CLIP_MODEL, { dtype:'q8', progress_callback: AI._progress });
        await AI.loadLabels();
        AI.state = 'ready'; AI.progress = 100;
      } catch(e){
        console.warn('CLIP unavailable, staying on colour + texture:', e);
        AI.state = 'failed';
      }
      renderAiStatus();
      if(AI.state === 'ready') onAiReady();
      return AI.ready();
    })();
    return AI._p;
  },
  embed: async function(src){
    var cv = document.createElement('canvas'); cv.width = 224; cv.height = 224;
    cv.getContext('2d').drawImage(src, 0, 0, 224, 224);
    var blob = await new Promise(function(res){ cv.toBlob(res, 'image/png'); });
    var img = await AI.TF.RawImage.fromBlob(blob);
    var inputs = await AI.proc(img);
    var out = await AI.vision(inputs);
    return unitVec(out.image_embeds.data);
  },
  promptSig: function(){
    var s = FABRIC_LABELS.concat(PATTERN_LABELS, ITEM_STYLE_LABELS).map(function(l){ return l.prompt; }).join('|'), h = 0;
    for(var i=0;i<s.length;i++) h = (h*31 + s.charCodeAt(i)) | 0;
    return String(h);
  },
  loadLabels: async function(){
    if(AI.labels) return AI.labels;
    var c = CONFIG.clip_labels;
    if(c && c.sig === AI.promptSig() && c.fabric && c.pattern && c.style){
      AI.labels = { fabric:c.fabric.map(unitVec), pattern:c.pattern.map(unitVec), style:c.style.map(unitVec) };
      return AI.labels;
    }
    return AI.buildLabels();
  },
  // Needs the text model (extra download). Normally only an admin does this, once.
  buildLabels: async function(){
    if(AI.labelsPromise) return AI.labelsPromise;
    AI.labelsPromise = (async function(){
      AI.TF = AI.TF || await loadTF();
      AI.TF.env.allowLocalModels = false;
      AI.tok = AI.tok || await AI.TF.AutoTokenizer.from_pretrained(CLIP_MODEL);
      AI.text = AI.text || await AI.TF.CLIPTextModelWithProjection.from_pretrained(CLIP_MODEL, { dtype:'q8', progress_callback: AI._progress });
      async function enc(list){
        var tok = AI.tok(list.map(function(l){ return l.prompt; }), { padding:true, truncation:true });
        var out = await AI.text(tok), d = out.text_embeds.data, dim = d.length / list.length, res = [];
        for(var i=0;i<list.length;i++) res.push(unitVec(d.slice(i*dim, (i+1)*dim)));
        return res;
      }
      AI.labels = { fabric: await enc(FABRIC_LABELS), pattern: await enc(PATTERN_LABELS), style: await enc(ITEM_STYLE_LABELS) };
      return AI.labels;
    })();
    return AI.labelsPromise;
  },
  labelsPayload: function(){
    var L = AI.labels; if(!L) return null;
    function r(a){ return a.map(function(v){ return roundVec(v); }); }
    return { sig: AI.promptSig(), fabric:r(L.fabric), pattern:r(L.pattern), style:r(L.style) };
  },
  describeFabric: function(emb){
    if(!AI.labels || !emb) return {};
    var f = zeroShot(emb, AI.labels.fabric, FABRIC_LABELS), p = zeroShot(emb, AI.labels.pattern, PATTERN_LABELS);
    return { heft:f.expected, busy:p.expected, fabricName:f.top, patternName:p.top };
  },
  describeItem: function(emb){
    if(!AI.labels || !emb) return null;
    var s = zeroShot(emb, AI.labels.style, ITEM_STYLE_LABELS);
    return { ornate: Math.round(s.probs[1]*1000)/1000 };
  }
};
function unitVec(a){
  var n = 0, i, out = new Float32Array(a.length);
  for(i=0;i<a.length;i++) n += a[i]*a[i];
  n = Math.sqrt(n) || 1;
  for(i=0;i<a.length;i++) out[i] = a[i] / n;
  return out;
}
function roundVec(v){ return Array.from(v, function(x){ return Math.round(x*1e4)/1e4; }); }

function renderAiStatus(){
  var el = $('aiStatus'); if(!el) return;
  var cls = 'ai-status', html = '';
  if(!AI.enabled()) html = '<span class="ai-dot"></span> AI vision off (colour + texture only) <button id="aiOn">Turn on</button>';
  else if(AI.state === 'ready'){ cls += ' ready'; html = '<span class="ai-dot"></span> AI vision on &middot; fabric, pattern &amp; visual matching <button id="aiOff">Turn off</button>'; }
  else if(AI.state === 'loading') html = '<span class="ai-dot"></span> Loading AI vision model (one time) <span class="ai-bar"><i style="width:' + AI.progress + '%"></i></span> ' + AI.progress + '%';
  else if(AI.state === 'failed'){ cls += ' failed'; html = '<span class="ai-dot"></span> AI vision unavailable &middot; using colour + texture <button id="aiRetry">Retry</button>'; }
  else html = '<svg class="ai-cam" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 8a2 2 0 0 1 2-2h2l1.2-1.6A1 1 0 0 1 11 4h2a1 1 0 0 1 .8.4L15 6h4a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><circle cx="12" cy="12.5" r="3.2"/></svg> AI vision starts when you upload a photo';
  el.className = cls; el.innerHTML = html;
  var a;
  if((a = $('aiOn'))) a.onclick = function(){ AI.setEnabled(true); };
  if((a = $('aiOff'))) a.onclick = function(){ AI.setEnabled(false); };
  if((a = $('aiRetry'))) a.onclick = function(){ AI.state = 'idle'; AI.start(); };
}
// When the model becomes ready, upgrade whatever the customer is looking at.
async function onAiReady(){
  try {
    if(state.match.fabric && state.match.preview && !state.match.fabric.emb){
      var f = state.match.fabric;
      f.emb = await AI.embed(state.match.preview);
      Object.assign(f, AI.describeFabric(f.emb));
      renderMatch();
    }
    if(state.vendor.query && state.vendor.preview && !state.vendor.query.emb){
      state.vendor.query.emb = await AI.embed(state.vendor.preview); renderVendor();
    }
  } catch(e){ console.warn('AI upgrade failed', e); }
}

/* ==========================================================================
   CATALOGUE
   ========================================================================== */
function publicPhotoUrl(path){ return sb.storage.from('vendor-photos').getPublicUrl(path).data.publicUrl; }
function rowToItem(row){
  var v = row.vendors || {};
  return {
    id: row.id, name: row.name, cat: row.category, hex: row.dominant_hex || '#C9A24B',
    price: Number(row.price), unit: row.unit, qty: row.quantity, stock: row.stock_status,
    img: row.image_path ? publicPhotoUrl(row.image_path) : null,
    palette: row.palette || null,
    tex: Array.isArray(row.texture) ? row.texture : null,
    emb: Array.isArray(row.embedding) && row.embedding.length >= 64 ? unitVec(row.embedding) : null,
    attrs: row.attrs || null, active: row.is_active, analyzedBy: row.analyzed_by,
    vendor: { id: v.id || row.vendor_id, name: v.shop_name, bazaar: v.bazaar || '', shopNo: v.shop_number || '',
              city: v.city || '', fulfil: v.fulfillment || 'pickup', phone: v.phone || '', status: v.status }
  };
}
var catalogLoading = false, reloadTimer = null;
function scheduleReload(ms){ clearTimeout(reloadTimer); reloadTimer = setTimeout(loadCatalog, ms || 700); }
async function loadCatalog(){
  if(catalogLoading) return; catalogLoading = true;
  try {
    var res = await sb.from('inventory_items')
      .select('id,vendor_id,name,category,price,unit,quantity,stock_status,image_path,dominant_hex,palette,texture,embedding,attrs,analyzed_by,is_active,vendors!inner(id,shop_name,bazaar,shop_number,city,fulfillment,phone,status,is_active)')
      .eq('is_active', true).order('created_at', { ascending:false });
    if(res.error){
      $('gridMatch').innerHTML = '<div class="empty">Could not load the catalogue (' + esc(res.error.message) + ').<br>Check your connection and reload.</div>'; return;
    }
    // Vendors and admins can also SEE unapproved shops through RLS; the shop must not show them.
    ITEMS = res.data.filter(function(r){ return r.vendors && r.vendors.status === 'approved' && r.vendors.is_active !== false; }).map(rowToItem);
    var cfg = await sb.from('app_config').select('key,value');
    if(!cfg.error && cfg.data) cfg.data.forEach(function(r){ CONFIG[r.key] = r.value; });
    refreshCities(); renderMatch(); renderVendor();
    // Cart lines for items that vanished (sold out / suspended shop) are dropped.
    Object.keys(state.cart).forEach(function(id){ if(!ITEMS.some(function(i){ return i.id === id; })) delete state.cart[id]; });
    renderCartCount();
  } finally { catalogLoading = false; }
}
function refreshCities(){
  var sel = $('cityVendor'), cities = [];
  ITEMS.forEach(function(it){ if(it.vendor.city && cities.indexOf(it.vendor.city) === -1) cities.push(it.vendor.city); });
  cities.sort();
  sel.innerHTML = '<option value="">All cities</option>' + cities.map(function(c){ return '<option' + (c === state.vendor.city ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('');
}

/* ==========================================================================
   SHOP — shared pieces
   ========================================================================== */
function eligible(cfg){
  return ITEMS.filter(function(it){
    if(cfg.cat && cfg.cat !== 'All' && it.cat !== cfg.cat) return false;
    if(cfg.fulfil === 'pickup' && it.vendor.fulfil === 'online') return false;
    if(cfg.fulfil === 'online' && it.vendor.fulfil === 'pickup') return false;
    if(cfg.city && it.vendor.city !== cfg.city) return false;
    return true;
  });
}
function renderChips(hostId, cur, onPick){
  var h = $(hostId);
  h.innerHTML = CATS.map(function(c){ return '<button class="chip' + (c === cur ? ' active' : '') + '" data-c="' + c + '">' + (c === 'All' ? 'All' : c) + '</button>'; }).join('');
  h.querySelectorAll('.chip').forEach(function(b){ b.onclick = function(){ onPick(b.dataset.c); }; });
}
function renderFulfil(hostId, cur, onPick){
  var h = $(hostId), opts = [['all','All'],['pickup','In-Store'],['online','Online']];
  h.innerHTML = opts.map(function(o){ return '<button class="fulfill-btn' + (o[0] === cur ? ' active' : '') + '" data-f="' + o[0] + '">' + o[1] + '</button>'; }).join('');
  h.querySelectorAll('.fulfill-btn').forEach(function(b){ b.onclick = function(){ onPick(b.dataset.f); }; });
}
function vendorLineHTML(it){
  var v = it.vendor;
  return '<div class="vendor-line">' + PIN + '<div><div class="vendor-name">' + esc(v.name) + '<span class="verified">' + TICK + ' Verified</span></div>' +
         '<div class="vendor-addr">' + esc(displayLocation(v)) + '</div></div></div>';
}
function cardActions(it){
  var dir = it.vendor.fulfil === 'online'
    ? '<span class="btn-outline btn-disabled">' + TRUCK + ' Online only</span>'
    : '<a class="btn-outline" href="' + esc(mapsUrl(it.vendor)) + '" target="_blank" rel="noopener">' + PIN + ' Get Directions</a>';
  var oos = it.stock === 'out_of_stock', inCart = !!state.cart[it.id];
  var order = oos ? '<span class="btn-solid btn-disabled">Out of stock</span>'
    : '<button class="btn-solid add-btn' + (inCart ? ' added' : '') + '" data-id="' + it.id + '">' + BAG + (inCart ? ' Added' : ' Add to order') + '</button>';
  return '<div class="card-actions">' + dir + order + '</div>';
}
function wireAddButtons(host){
  host.querySelectorAll('.add-btn').forEach(function(b){ b.onclick = function(){ addToCart(b.dataset.id); }; });
}
function statusRowHTML(it){
  return '<div class="status-row"><div class="price">' + money(it.price) + ' <small>/ ' + esc(it.unit) + '</small></div><span class="pill pill-' + it.stock + '">' + STOCK_LABEL[it.stock] + '</span></div>';
}

/* ---------- image analysis ---------- */
function loadImageFromFile(file){
  return new Promise(function(res, rej){
    var url = URL.createObjectURL(file), img = new Image();
    img.onload = function(){ res(img); }; img.onerror = function(){ rej(new Error('That file could not be read as an image.')); };
    img.src = url;
  });
}
function analyseImage(img){
  var palette = extractPalette(img, 4), tex = textureDescriptor(img);
  return { hex: palette[0].hex, palette: palette, tex: tex };
}
function paletteHTML(palette){
  return '<div class="palette">' + (palette || []).map(function(p){
    return '<span class="pal-chip"><span class="pal-sq" style="background:' + p.hex + '"></span>' + Math.round(p.prop*100) + '%</span>';
  }).join('') + '</div>';
}
function previewHTML(label, imgSrc, hex, palette, clearId, extra){
  return '<div class="pimg">' + (imgSrc ? '<img src="' + esc(imgSrc) + '" alt="" />' : '<div style="width:100%;height:100%;background:' + hex + '"></div>') + '</div>' +
    '<div class="pinfo"><div class="label">' + label + '</div><div class="cname">' + esc(nearestColorName(hex)) + '</div>' +
    '<div class="chex">' + hex + (extra ? ' &middot; ' + extra : '') + '</div>' + paletteHTML(palette) +
    '<button class="change-link" id="' + clearId + '">Use a different one</button></div>';
}
function wireDropzone(dzId, fileId, onFile){
  var dz = $(dzId), fi = $(fileId);
  ['dragenter','dragover'].forEach(function(ev){ dz.addEventListener(ev, function(e){ e.preventDefault(); dz.classList.add('drag'); }); });
  ['dragleave','drop'].forEach(function(ev){ dz.addEventListener(ev, function(e){ e.preventDefault(); dz.classList.remove('drag'); }); });
  dz.addEventListener('drop', function(e){ if(e.dataTransfer && e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]); });
  fi.addEventListener('change', function(){ if(fi.files[0]) onFile(fi.files[0]); fi.value = ''; });
}
function sampleStrip(hostId, label, onPick, activeHex){
  var h = $(hostId);
  h.innerHTML = '<span class="strip-label">' + label + '</span>' + SAMPLE_FABRICS.map(function(s){
    return '<button class="sample-item" title="' + s.name + '" data-hex="' + s.hex + '"><span class="sample-sq' + (activeHex === s.hex ? ' active' : '') + '" style="--sw:' + s.hex + '"></span></button>';
  }).join('');
  h.querySelectorAll('.sample-item').forEach(function(b){ b.onclick = function(){ onPick(b.dataset.hex); }; });
}

/* ==========================================================================
   TAB 1 — MATCH FABRIC (RMS)
   ========================================================================== */
var matchToken = 0;
function setFabricFromHex(hex){
  state.match.preview = null;
  state.match.fabric = { hex:hex, palette:[{ hex:hex, prop:1 }], tex:null, emb:null };
  renderMatchPreview(null); renderMatch();
}
async function onMatchFile(file){
  var token = ++matchToken;
  try {
    var img = await loadImageFromFile(file);
    var a = analyseImage(img);
    state.match.preview = img;
    state.match.fabric = { hex:a.hex, palette:a.palette, tex:a.tex, emb:null };
    renderMatchPreview(img.src); renderMatch();
    if(AI.enabled()){
      var ok = await AI.start();
      if(ok && token === matchToken && !state.match.fabric.emb){
        state.match.fabric.emb = await AI.embed(img);
        Object.assign(state.match.fabric, AI.describeFabric(state.match.fabric.emb));
        renderMatch();
      }
    }
  } catch(e){ toast(errMsg(e), 'err'); }
}
function renderMatchPreview(src){
  var f = state.match.fabric, h = $('previewMatch');
  if(!f){ h.hidden = true; h.innerHTML = ''; } else {
    h.hidden = false;
    h.innerHTML = previewHTML('Your fabric', src, f.hex, f.palette, 'clearMatch');
    $('clearMatch').onclick = function(){ state.match.fabric = null; state.match.preview = null; renderMatchPreview(null); renderMatch(); };
  }
  sampleStrip('samplesMatch', 'No photo? Try one:', setFabricFromHex, f && !src ? f.hex : null);
}
function renderOccasions(){
  var h = $('occChips');
  h.innerHTML = ['Any'].concat(OCCASION_NAMES).map(function(o){
    var on = (o === 'Any' && !state.match.occasion) || o === state.match.occasion;
    return '<button class="chip' + (on ? ' active' : '') + '" data-o="' + o + '">' + o + '</button>';
  }).join('');
  h.querySelectorAll('.chip').forEach(function(b){ b.onclick = function(){ state.match.occasion = b.dataset.o === 'Any' ? null : b.dataset.o; renderOccasions(); renderMatch(); }; });
}
function sigBars(row){
  var L = { C:'Colour', V:'Visual', F:'Fabric', P:'Pattern', O:'Occasion' };
  return '<div class="sig-bars">' + SIGNALS.map(function(k){
    var v = row.parts[k];
    return '<div class="sig' + (v == null ? ' na' : '') + '" title="' + L[k] + (v == null ? ' (not available)' : ' ' + pct(v) + '%') + '"><b><i style="width:' + (v == null ? 0 : pct(v)) + '%"></i></b>' + k + '</div>';
  }).join('') + '</div>';
}
function matchCard(row, f, opts){
  var it = row.item;
  var badge = '<div class="rms-badge">' + pct(row.rms) + '%<small>match</small></div>';
  var tag = '<span class="tag">' + esc(it.cat) + '</span>';
  return '<article class="card">' + swatchHTML(it, tag + badge) + '<div class="card-body">' +
    '<div class="name">' + esc(it.name) + '</div><div class="meta">' + esc(nearestColorName(it.hex)) + ' &middot; ' + esc(it.cat) + '</div>' +
    '<div class="why">' + esc(explain(f, row, opts)) + '</div>' + sigBars(row) +
    vendorLineHTML(it) + statusRowHTML(it) + cardActions(it) + '</div></article>';
}
function renderBundle(rows, f){
  var host = $('bundleHost');
  var pool = rows.filter(function(r){ return r.item.stock !== 'out_of_stock'; });
  var b = pool.length >= 2 ? buildBundle(pool) : null;
  if(!f || !b){ host.innerHTML = ''; return; }
  var total = b.picks.reduce(function(a,p){ return a + p.row.item.price; }, 0);
  host.innerHTML = '<div class="bundle"><div class="bundle-head"><h2 class="display">Complete the look</h2>' +
    '<div class="bundle-score"><b>' + pct(b.overall) + '%</b> overall compatibility</div></div>' +
    '<div class="bundle-grid">' + b.picks.map(function(p){
      var it = p.row.item;
      return '<div class="bslot"><div class="bl">' + p.slot + '</div><div class="bn">' + esc(it.name) + '</div>' +
        '<div class="bm">' + esc(it.vendor.name) + ' &middot; ' + money(it.price) + '</div>' +
        '<div class="bsw ' + (it.img ? '' : (PATTERN[it.cat] || '')) + '" style="--sc:' + it.hex + ';--sc-base:' + shade(it.hex) + '">' + (it.img ? '<img src="' + esc(it.img) + '" alt="" />' : '') + '</div></div>';
    }).join('') + '</div>' +
    '<div class="bundle-foot"><div class="mini">1 ' + 'unit of each &middot; ' + money(total) + ' &middot; adjust quantities in your order</div>' +
    '<button class="btn btn-gold" id="bundleAdd">Add the whole look to my order</button></div></div>';
  $('bundleAdd').onclick = function(){ b.picks.forEach(function(p){ addToCart(p.row.item.id, true); }); toast('Added ' + b.picks.length + ' items to your order', 'ok'); openDrawer(); };
}
function renderMatch(){
  renderChips('chipsMatch', state.match.cat, function(c){ state.match.cat = c; renderMatch(); });
  renderFulfil('fulMatch', state.match.fulfil, function(f){ state.match.fulfil = f; renderMatch(); });
  renderOccasions();
  var f = state.match.fabric, grid = $('gridMatch');
  var items = eligible({ cat:state.match.cat, fulfil:state.match.fulfil });
  if(!ITEMS.length){ grid.innerHTML = '<div class="empty">No embellishments are listed yet.<br>Vendors can add stock from the Vendor Portal.</div>'; $('bundleHost').innerHTML = ''; return; }
  if(!f){
    $('headMatch').textContent = 'Top picks for your fabric';
    $('noteMatch').textContent = items.length + ' items · upload a fabric to rank them';
    $('bundleHost').innerHTML = '';
    grid.innerHTML = items.slice(0, 24).map(function(it){
      return '<article class="card">' + swatchHTML(it, '<span class="tag">' + esc(it.cat) + '</span>') + '<div class="card-body"><div class="name">' + esc(it.name) + '</div><div class="meta">' + esc(nearestColorName(it.hex)) + ' &middot; ' + esc(it.cat) + '</div>' +
        vendorLineHTML(it) + statusRowHTML(it) + cardActions(it) + '</div></article>';
    }).join('');
    wireAddButtons(grid); return;
  }
  var opts = { occasion: state.match.occasion };
  var rows = rankItems(f, items, opts);
  if(state.match.sort === 'priceLow') rows.sort(function(a,b){ return a.item.price - b.item.price; });
  if(state.match.sort === 'priceHigh') rows.sort(function(a,b){ return b.item.price - a.item.price; });
  $('headMatch').textContent = 'Top picks for your fabric' + (opts.occasion ? ' · ' + opts.occasion : '');
  var mode = f.emb ? 'AI vision + colour' : 'colour + texture';
  $('noteMatch').textContent = rows.length + ' items ranked · ' + mode + (f.fabricName ? ' · looks like ' + f.patternName + ' ' + f.fabricName : '');
  // The bundle always uses the whole catalogue (not the category chip) so a look can span categories.
  renderBundle(rankItems(f, eligible({ fulfil:state.match.fulfil }), opts), f);
  grid.innerHTML = rows.length ? rows.slice(0, 24).map(function(r){ return matchCard(r, f, opts); }).join('') : '<div class="empty">Nothing matches these filters.</div>';
  wireAddButtons(grid);
}

/* ==========================================================================
   TAB 2 — FIND VENDOR BY EMBELLISHMENT
   ========================================================================== */
var vendorToken = 0;
function scoreEmbellishment(items, q){
  return items.map(function(it){
    var color = colorSimilarity(q.hex, it.hex), vis = null, by = 'colour';
    if(q.emb && it.emb){ vis = clamp01((dot(q.emb, it.emb) - 0.5) / 0.45); by = 'ai'; }
    else if(q.tex){ vis = cosineSim(q.tex, texOf(it)); by = 'texture'; }
    var s = vis == null ? color : (0.4 * color + 0.6 * vis);
    return { item: it, score: s, by: by };
  }).sort(function(a,b){ return b.score - a.score; });
}
function setQueryFromHex(hex){ state.vendor.preview = null; state.vendor.query = { hex:hex, palette:[{ hex:hex, prop:1 }], tex:null, emb:null }; renderVendorPreview(null); renderVendor(); }
async function onVendorFile(file){
  var token = ++vendorToken;
  try {
    var img = await loadImageFromFile(file), a = analyseImage(img);
    state.vendor.preview = img; state.vendor.query = { hex:a.hex, palette:a.palette, tex:a.tex, emb:null };
    renderVendorPreview(img.src); renderVendor();
    if(AI.enabled()){
      var ok = await AI.start();
      if(ok && token === vendorToken && !state.vendor.query.emb){ state.vendor.query.emb = await AI.embed(img); renderVendor(); }
    }
  } catch(e){ toast(errMsg(e), 'err'); }
}
function renderVendorPreview(src){
  var q = state.vendor.query, h = $('previewVendor');
  if(!q){ h.hidden = true; h.innerHTML = ''; } else {
    h.hidden = false; h.innerHTML = previewHTML('Your embellishment', src, q.hex, q.palette, 'clearVendor');
    $('clearVendor').onclick = function(){ state.vendor.query = null; state.vendor.preview = null; renderVendorPreview(null); renderVendor(); };
  }
  sampleStrip('samplesVendor', 'No photo? Try a colour:', setQueryFromHex, q && !src ? q.hex : null);
}
function renderVendor(){
  renderChips('chipsVendor', state.vendor.cat, function(c){ state.vendor.cat = c; renderVendor(); });
  renderFulfil('fulVendor', state.vendor.fulfil, function(f){ state.vendor.fulfil = f; renderVendor(); });
  var grid = $('gridVendor'), q = state.vendor.query;
  if(!q){ $('headVendor').textContent = 'Vendors who stock it'; $('noteVendor').textContent = ''; grid.innerHTML = '<div class="empty">Upload a photo of an embellishment above to see which shops sell it.</div>'; return; }
  var rows = scoreEmbellishment(eligible({ cat:state.vendor.cat, fulfil:state.vendor.fulfil, city:state.vendor.city }), q);
  $('headVendor').textContent = rows.length ? 'Closest matches' : 'No matches';
  $('noteVendor').textContent = rows.length + ' listings · ' + (q.emb ? 'AI vision + colour' : (q.tex ? 'colour + texture' : 'colour only'));
  grid.innerHTML = rows.length ? rows.slice(0, 24).map(function(r){
    var it = r.item;
    return '<article class="card">' + swatchHTML(it, '<span class="tag">' + esc(it.cat) + '</span><div class="simbadge v">' + pct(r.score) + '%<small>similar</small></div>') +
      '<div class="card-body"><div class="name">' + esc(it.name) + '</div><div class="meta">' + esc(nearestColorName(it.hex)) + ' &middot; ' + esc(it.cat) + '</div>' +
      vendorLineHTML(it) + statusRowHTML(it) + cardActions(it) + '</div></article>';
  }).join('') : '<div class="empty">No listings match these filters.</div>';
  wireAddButtons(grid);
}

/* ==========================================================================
   CART + CHECKOUT (customer account required; price comes from the database)
   ========================================================================== */
function addToCart(id, quiet){
  var it = ITEMS.filter(function(i){ return i.id === id; })[0]; if(!it) return;
  if(it.stock === 'out_of_stock'){ toast('Sorry, that one is out of stock.', 'err'); return; }
  state.cart[id] = state.cart[id] || 1;
  renderCartCount(); renderMatch(); renderVendor();
  if(!quiet) toast('Added "' + it.name + '" to your order', 'ok');
}
function cartKeys(){ return Object.keys(state.cart).filter(function(id){ return ITEMS.some(function(i){ return i.id === id; }); }); }
function cartItem(id){ return ITEMS.filter(function(i){ return i.id === id; })[0]; }
function cartTotal(){ return cartKeys().reduce(function(a,id){ return a + cartItem(id).price * state.cart[id]; }, 0); }
function renderCartCount(){ $('cartCount').textContent = cartKeys().reduce(function(a,id){ return a + state.cart[id]; }, 0); }
function isCustomer(){ return !!(state.session && state.profile && state.profile.role === 'customer'); }
function openDrawer(){ renderDrawer(); $('drawer').classList.add('open'); $('drawerBg').classList.add('open'); }
function closeDrawer(){ $('drawer').classList.remove('open'); $('drawerBg').classList.remove('open'); }

function renderDrawer(){
  var body = $('drawerBody'), foot = $('drawerFoot'), step = state.checkoutStep, keys = cartKeys();
  $('drawerTitle').textContent = { cart:'Your Order', auth:'Sign in to order', details:'Your details', done:'Order placed' }[step];
  if(step === 'done'){
    body.innerHTML = '<div class="confirm"><div class="check"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#c9a24b" stroke-width="2.4"><path d="m5 12 5 5 9-10"/></svg></div><h3>Thank you</h3>' +
      '<p>Your order has gone to the shop(s). They will contact you on the phone number you gave to confirm availability. You pay the shop directly on pickup or delivery.</p></div>';
    foot.innerHTML = '<button class="btn btn-gold" id="doneMy">View my orders</button>';
    $('doneMy').onclick = function(){ closeDrawer(); setPortal('shop'); setTab('account'); };
    return;
  }
  if(!keys.length){
    body.innerHTML = '<div class="empty" style="padding:40px 10px">Your order is empty.<br>Add items from Match or Find Vendor.</div>'; foot.innerHTML = ''; return;
  }
  if(step === 'cart'){
    body.innerHTML = keys.map(function(id){
      var it = cartItem(id);
      return '<div class="cart-item">' + thumbHTML(it, 'cart-sw') + '<div style="flex:1;min-width:0"><div class="ci-name">' + esc(it.name) + '</div>' +
        '<div class="ci-meta">' + esc(it.vendor.name) + ' &middot; ' + money(it.price) + ' / ' + esc(it.unit) + '</div>' +
        '<div class="btn-row" style="margin-top:6px;align-items:center"><button class="btn btn-ghost btn-sm qty" data-id="' + id + '" data-d="-1">&minus;</button><b>' + state.cart[id] + '</b>' +
        '<button class="btn btn-ghost btn-sm qty" data-id="' + id + '" data-d="1">+</button><button class="ci-rm" data-id="' + id + '">Remove</button></div></div>' +
        '<div class="price">' + money(it.price * state.cart[id]) + '</div></div>';
    }).join('');
    foot.innerHTML = '<div class="tot"><span class="t-lbl">Total (paid to the shop)</span><span class="t-val">' + money(cartTotal()) + '</span></div><button class="btn btn-gold" id="toCheckout">Continue</button>';
    body.querySelectorAll('.qty').forEach(function(b){ b.onclick = function(){ var id = b.dataset.id; state.cart[id] = Math.max(1, Math.min(99, state.cart[id] + Number(b.dataset.d))); renderDrawer(); renderCartCount(); }; });
    body.querySelectorAll('.ci-rm').forEach(function(b){ b.onclick = function(){ delete state.cart[b.dataset.id]; renderCartCount(); renderDrawer(); renderMatch(); renderVendor(); }; });
    $('toCheckout').onclick = function(){ state.checkoutStep = isCustomer() ? 'details' : 'auth'; renderDrawer(); };
    return;
  }
  if(step === 'auth'){
    if(state.session && !isCustomer()){
      body.innerHTML = '<div class="banner warn">You are signed in with a ' + esc(state.profile ? state.profile.role : '') + ' account. Orders need a customer account.</div><button class="btn btn-ghost" id="soDrawer">Sign out</button>';
      $('soDrawer').onclick = signOut; foot.innerHTML = ''; return;
    }
    body.innerHTML = '<div id="drawerAuth"></div>'; foot.innerHTML = '';
    renderAuth($('drawerAuth'), 'customer', function(){ state.checkoutStep = 'details'; renderDrawer(); });
    return;
  }
  // details
  var p = state.profile || {}, email = state.session && state.session.user ? state.session.user.email : '';
  body.innerHTML = '<div class="field"><label>Your name <span class="req">*</span></label><input id="coName" value="' + esc(p.full_name || '') + '" /></div>' +
    '<div class="field"><label>Phone (the shop will call or WhatsApp you) <span class="req">*</span></label><input id="coPhone" value="' + esc(p.phone || '') + '" placeholder="03xx-xxxxxxx" /></div>' +
    '<div class="field"><label>Email</label><input id="coEmail" value="' + esc(email) + '" /></div>' +
    '<div class="field"><label>Note to the shop (optional)</label><textarea id="coNote" placeholder="Length needed, colour shade, pickup time…"></textarea></div>' +
    '<div class="formerr" id="coErr"></div>' +
    '<div class="note">Items from different shops are sent as separate lines to each shop. Prices are confirmed by our system when you place the order.</div>';
  foot.innerHTML = '<div class="tot"><span class="t-lbl">Total</span><span class="t-val">' + money(cartTotal()) + '</span></div><button class="btn btn-gold" id="placeBtn">Place order</button><button class="link-btn" id="backCart" style="margin-top:10px">&larr; Back to items</button>';
  $('backCart').onclick = function(){ state.checkoutStep = 'cart'; renderDrawer(); };
  $('placeBtn').onclick = placeOrder;
}
async function placeOrder(){
  var name = $('coName').value.trim(), phone = $('coPhone').value.trim(), err = $('coErr');
  err.classList.remove('show');
  if(!name || !phone){ err.textContent = 'Please enter your name and phone number.'; err.classList.add('show'); return; }
  var btn = $('placeBtn'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Placing…';
  try {
    var items = cartKeys().map(function(id){ return { item_id:id, qty:state.cart[id] }; });
    var r = await sb.rpc('place_order', { p_name:name, p_phone:phone, p_email:$('coEmail').value.trim(), p_note:$('coNote').value.trim(), p_items:items });
    if(r.error) throw r.error;
    state.cart = {}; state.checkoutStep = 'done';
    renderCartCount(); renderDrawer(); renderMatch(); renderVendor(); loadMyOrders();
  } catch(e){ err.textContent = errMsg(e); err.classList.add('show'); btn.disabled = false; btn.textContent = 'Place order'; scheduleReload(300); }
}
