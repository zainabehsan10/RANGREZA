/* ==========================================================================
   ADMIN PORTAL — vendors, listings, orders, AI indexing, evaluation
   Every write goes through an admin_* database function that re-checks the
   caller's role, so a non-admin editing this page gains nothing.
   ========================================================================== */
async function loadAdmin(){
  var A = state.admin;
  var res = await Promise.all([
    sb.from('vendors').select('*, profiles(full_name,phone)').order('created_at', { ascending:false }),
    sb.from('inventory_items').select('id,vendor_id,name,category,price,unit,quantity,stock_status,image_path,dominant_hex,palette,texture,embedding,attrs,is_active,analyzed_by,created_at,vendors(id,shop_name,status)').order('created_at', { ascending:false }),
    sb.from('orders').select('*, order_items(*)').order('created_at', { ascending:false }).limit(200),
    sb.from('profiles').select('id', { count:'exact', head:true }).eq('role', 'customer')
  ]);
  A.vendors = res[0].data || []; A.items = res[1].data || []; A.orders = res[2].data || [];
  A.customers = res[3].count || 0; A.loaded = true;
  var cfg = await sb.from('app_config').select('key,value'); if(cfg.data) cfg.data.forEach(function(r){ CONFIG[r.key] = r.value; });
}
function renderAdminPortal(){
  var host = $('adminHost');
  if(!state.session){
    host.innerHTML = '<div class="authbox-wrap"><div class="pcard authbox"><span class="pill-role a">Admin</span><h2>Rangreza admin</h2><p class="psub">Admin accounts are created by the project owner, not through sign-up.</p><div id="admAuth"></div></div></div>';
    renderAuth($('admAuth'), 'admin', function(){ renderAdminPortal(); }); return;
  }
  if(!state.profile || state.profile.role !== 'admin'){ host.innerHTML = '<div class="authbox-wrap">' + mismatchCard('admin') + '</div>'; wireMismatch(); return; }
  if(!state.admin.loaded){
    host.innerHTML = '<div class="loading-note"><span class="spin"></span> Loading admin data…</div>';
    loadAdmin().then(renderAdminPortal).catch(function(e){ host.innerHTML = '<div class="banner err" style="margin:30px 5vw">' + esc(errMsg(e)) + '</div>'; });
    return;
  }
  var A = state.admin, pend = A.vendors.filter(function(v){ return v.status === 'pending'; }).length;
  var tabs = [['overview','Overview'],['vendors','Vendors' + (pend ? ' <span class="tab-badge">' + pend + '</span>' : '')],['listings','Listings'],['orders','Orders'],['eval','Evaluation']];
  host.innerHTML = '<div class="subtabs"><div class="tabbar-inner">' + tabs.map(function(t){ return '<button class="tab-btn' + (state.atab === t[0] ? ' active' : '') + '" data-tab="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '</div></div>' +
    '<div class="wide-wrap"><div class="who-row"><div class="wtxt">Admin &middot; <strong>' + esc(state.session.user.email) + '</strong></div><div class="btn-row"><button class="btn btn-ghost btn-sm" id="admRefresh">Refresh</button><button class="btn btn-ghost btn-sm" id="soAdm">Sign out</button></div></div><div id="atabBody"></div></div>';
  host.querySelectorAll('.tab-btn').forEach(function(b){ b.onclick = function(){ state.atab = b.dataset.tab; renderAdminPortal(); }; });
  $('soAdm').onclick = signOut;
  $('admRefresh').onclick = function(){ state.admin.loaded = false; renderAdminPortal(); };
  ({ overview:renderAdminOverview, vendors:renderAdminVendors, listings:renderAdminListings, orders:renderAdminOrders, eval:renderEval })[state.atab]();
}
function adminCall(promise, okMsg){
  return promise.then(function(r){ if(r.error){ toast(errMsg(r.error), 'err'); return false; } if(okMsg) toast(okMsg, 'ok'); return true; });
}
function stat(v, l){ return '<div class="stat"><div class="sv">' + v + '</div><div class="sl">' + l + '</div></div>'; }
function renderAdminOverview(){
  var A = state.admin, body = $('atabBody');
  var live = A.items.filter(function(i){ return i.is_active && i.vendors && i.vendors.status === 'approved'; });
  var indexed = A.items.filter(function(i){ return Array.isArray(i.embedding); }).length;
  var lines = []; A.orders.forEach(function(o){ (o.order_items || []).forEach(function(l){ lines.push(l); }); });
  body.innerHTML = '<div class="stat-row">' + stat(A.customers, 'Customers') +
    stat(A.vendors.filter(function(v){ return v.status === 'approved'; }).length, 'Approved vendors') + stat(A.vendors.filter(function(v){ return v.status === 'pending'; }).length, 'Awaiting approval') +
    stat(live.length, 'Live listings') + stat(A.orders.length, 'Orders') + stat(lines.filter(function(l){ return l.status === 'new'; }).length, 'New order lines') + '</div>' +
    '<div class="pcard"><h2>AI indexing</h2><p class="psub">' + indexed + ' of ' + A.items.length + ' listings have a CLIP vector. Items without one are matched on colour and texture only. ' +
    'Run this after vendors add stock. It downloads the vision model into <em>this</em> browser (about 90 MB, once), reads each photo, and saves the result. It also saves the shared label vectors so customers do not need the text model.</p>' +
    '<div class="inline-actions"><button class="btn btn-gold" id="idxRun">Index ' + (A.items.length - indexed) + ' missing listing' + (A.items.length - indexed === 1 ? '' : 's') + '</button>' +
    '<span class="mini" id="idxMsg"></span></div><div class="ai-bar" style="width:100%;height:6px"><i id="idxBar"></i></div></div>' +
    '<div class="note">New admin accounts: create the account on the Shop portal, then run the one-line SQL in SETUP_GUIDE.md step 4. Vendor approval and listing moderation are in the other tabs.</div>';
  $('idxRun').onclick = runIndexing;
}
async function runIndexing(){
  var A = state.admin, btn = $('idxRun'), msg = $('idxMsg'), bar = $('idxBar');
  var todo = A.items.filter(function(i){ return !Array.isArray(i.embedding) && i.image_path; });
  btn.disabled = true;
  try {
    msg.textContent = 'Loading the AI model… this takes a minute the first time.';
    AI.setEnabled(true);
    var ok = await AI.start(); if(!ok) throw new Error('The AI model could not load in this browser. Try desktop Chrome and check your connection.');
    var lp = AI.labelsPayload();
    if(lp && !(CONFIG.clip_labels && CONFIG.clip_labels.sig === lp.sig)){
      var cr = await sb.rpc('admin_set_config', { p_key:'clip_labels', p_value:lp }); if(cr.error) throw cr.error; CONFIG.clip_labels = lp;
    }
    var done = 0, failed = 0;
    for(var i=0;i<todo.length;i++){
      var it = todo[i]; msg.textContent = 'Indexing ' + (i+1) + ' of ' + todo.length + ': ' + it.name;
      try {
        var img = await loadRemoteImage(publicPhotoUrl(it.image_path));
        var emb = await AI.embed(img);
        var r = await sb.rpc('admin_set_item_index', { p_item:it.id, p_embedding:roundVec(emb), p_attrs:AI.describeItem(emb) });
        if(r.error) throw r.error; done++;
      } catch(e){ console.warn('index failed for', it.id, e); failed++; }
      bar.style.width = Math.round((i+1) / todo.length * 100) + '%';
    }
    msg.textContent = 'Done: ' + done + ' indexed' + (failed ? ', ' + failed + ' failed (see console)' : '') + '.';
    toast('Indexing finished', 'ok'); await loadAdmin(); scheduleReload(200);
    setTimeout(renderAdminPortal, 1200);
  } catch(e){ msg.textContent = errMsg(e); btn.disabled = false; }
}
function loadRemoteImage(url){
  return new Promise(function(res, rej){ var img = new Image(); img.crossOrigin = 'anonymous'; img.onload = function(){ res(img); }; img.onerror = function(){ rej(new Error('image load failed')); }; img.src = url; });
}
function renderAdminVendors(){
  var A = state.admin, body = $('atabBody');
  if(!A.vendors.length){ body.innerHTML = '<div class="empty">No vendors have signed up yet.</div>'; return; }
  body.innerHTML = '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Shop</th><th>Owner</th><th>Location</th><th>Listings</th><th>Status</th><th></th></tr></thead><tbody>' +
    A.vendors.map(function(v){
      var n = A.items.filter(function(i){ return i.vendor_id === v.id; }).length, p = v.profiles || {};
      return '<tr><td><b>' + esc(v.shop_name) + '</b><div class="sub">Joined ' + fmtDate(v.created_at) + '</div></td><td>' + esc(p.full_name || '') + '<div class="sub">' + esc(v.phone || p.phone || '') + '</div></td>' +
        '<td>' + esc(displayLocation({ fulfil:v.fulfillment, bazaar:v.bazaar, shopNo:v.shop_number, city:v.city })) + '</td><td>' + n + '</td><td class="st-' + v.status + '"><b>' + v.status + '</b></td>' +
        '<td><div class="btn-row">' + (v.status !== 'approved' ? '<button class="btn btn-ok btn-sm vset" data-id="' + v.id + '" data-s="approved">Approve</button>' : '') +
        (v.status !== 'suspended' ? '<button class="btn btn-ghost btn-sm vset" data-id="' + v.id + '" data-s="suspended">Suspend</button>' : '') + '</div></td></tr>';
    }).join('') + '</tbody></table></div>';
  body.querySelectorAll('.vset').forEach(function(b){ b.onclick = async function(){
    if(await adminCall(sb.rpc('admin_set_vendor_status', { p_vendor:b.dataset.id, p_status:b.dataset.s }), 'Vendor ' + b.dataset.s)){ await loadAdmin(); renderAdminPortal(); scheduleReload(300); }
  }; });
}
function renderAdminListings(){
  var A = state.admin, body = $('atabBody');
  if(!A.items.length){ body.innerHTML = '<div class="empty">No listings yet.</div>'; return; }
  body.innerHTML = '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Item</th><th>Shop</th><th>Price</th><th>Stock</th><th>AI</th><th></th></tr></thead><tbody>' +
    A.items.map(function(i){
      return '<tr><td><b>' + esc(i.name) + '</b><div class="sub">' + esc(i.category) + ' &middot; ' + esc(nearestColorName(i.dominant_hex || '#C9A24B')) + '</div></td><td>' + esc(i.vendors ? i.vendors.shop_name : '') + '<div class="sub st-' + (i.vendors ? i.vendors.status : '') + '">' + (i.vendors ? i.vendors.status : '') + '</div></td>' +
        '<td>' + money(i.price) + '</td><td>' + (STOCK_LABEL[i.stock_status] || '') + ' (' + i.quantity + ')</td><td>' + (Array.isArray(i.embedding) ? 'indexed' : '—') + '</td>' +
        '<td><button class="btn btn-ghost btn-sm iset" data-id="' + i.id + '" data-a="' + (i.is_active ? 0 : 1) + '">' + (i.is_active ? 'Hide' : 'Restore') + '</button></td></tr>';
    }).join('') + '</tbody></table></div>';
  body.querySelectorAll('.iset').forEach(function(b){ b.onclick = async function(){
    if(await adminCall(sb.rpc('admin_set_item_active', { p_item:b.dataset.id, p_active:b.dataset.a === '1' }), 'Listing updated')){ await loadAdmin(); renderAdminPortal(); scheduleReload(300); }
  }; });
}
function renderAdminOrders(){
  var A = state.admin, body = $('atabBody');
  if(!A.orders.length){ body.innerHTML = '<div class="empty">No orders yet.</div>'; return; }
  var vname = {}; A.vendors.forEach(function(v){ vname[v.id] = v.shop_name; });
  body.innerHTML = A.orders.map(function(o){
    return '<div class="ordercard"><div class="oh"><span><b>' + esc(o.buyer_name) + '</b> &middot; ' + esc(o.buyer_phone) + (o.buyer_email ? ' &middot; ' + esc(o.buyer_email) : '') + '</span><span>' + fmtDateTime(o.created_at) + ' &middot; <b>' + money(o.total) + '</b></span></div>' +
      (o.order_items || []).map(function(l){
        return '<div class="ol"><div><div class="oln">' + esc(l.name) + ' &times; ' + l.qty + '</div><div class="olm">' + esc(vname[l.vendor_id] || 'Shop') + ' &middot; ' + money(l.price) + '</div></div><div class="ola">' + orderLineStatus(l.status) +
          '<select class="adm-status" data-id="' + l.id + '">' + ORDER_STATUS.map(function(s){ return '<option' + (s === l.status ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select></div></div>';
      }).join('') + '</div>';
  }).join('');
  body.querySelectorAll('.adm-status').forEach(function(s){ s.onchange = async function(){
    if(await adminCall(sb.rpc('admin_set_order_item_status', { p_id:s.dataset.id, p_status:s.value }), 'Order line updated')){ await loadAdmin(); renderAdminPortal(); }
  }; });
}

/* ==========================================================================
   EVALUATION — the FYP's quantitative result
   --------------------------------------------------------------------------
   For each test fabric the SAME catalogue is ranked by every system below.
   Their top-K lists are pooled (union), you tick which pooled items you judge
   relevant, and Precision@K / Recall@K / NDCG@K are computed per system. This
   is the standard "pooling" method, so every item any system ranked highly has
   been judged. Run it with several fabrics and, ideally, a boutique expert.
   ========================================================================== */
var EVAL_CONFIGS = [
  { id:'colour',  name:'Baseline 1 · Colour only',        w:{ C:1, V:0, F:0, P:0, O:0 } },
  { id:'vision',  name:'Baseline 2 · Vision only (CLIP)', w:{ C:0, V:1, F:0, P:0, O:0 } },
  { id:'hybrid',  name:'Proposed · Hybrid RMS',            w:W_RMS },
  { id:'noC',     name:'Ablation · RMS without colour',    w:{ C:0, V:W_RMS.V, F:W_RMS.F, P:W_RMS.P, O:W_RMS.O } },
  { id:'noV',     name:'Ablation · RMS without visual',    w:{ C:W_RMS.C, V:0, F:W_RMS.F, P:W_RMS.P, O:W_RMS.O } },
  { id:'noF',     name:'Ablation · RMS without fabric',    w:{ C:W_RMS.C, V:W_RMS.V, F:0, P:W_RMS.P, O:W_RMS.O } },
  { id:'noP',     name:'Ablation · RMS without pattern',   w:{ C:W_RMS.C, V:W_RMS.V, F:W_RMS.F, P:0, O:W_RMS.O } },
  { id:'noO',     name:'Ablation · RMS without occasion',  w:{ C:W_RMS.C, V:W_RMS.V, F:W_RMS.F, P:W_RMS.P, O:0 } }
];
var evalK = 5;
function evalCatalogue(){ return ITEMS.filter(function(i){ return i.stock !== 'out_of_stock'; }); }
function evalRank(q, cfg){
  var t0 = (window.performance || Date).now();
  var rows = rankItems(q.fabric, evalCatalogue(), { weights:cfg.w, occasion:q.occasion });
  return { rows:rows, ms:(window.performance || Date).now() - t0 };
}
function evalPool(q){
  var ids = {}, order = [];
  EVAL_CONFIGS.forEach(function(c){ evalRank(q, c).rows.slice(0, evalK).forEach(function(r){ if(!ids[r.item.id]){ ids[r.item.id] = 1; order.push(r.item); } }); });
  return order;
}
function evalMetrics(){
  var qs = state.evalQ.filter(function(q){ return Object.keys(q.rel).filter(function(k){ return q.rel[k]; }).length > 0; });
  return EVAL_CONFIGS.map(function(c){
    var p = 0, r = 0, n = 0, ms = 0;
    qs.forEach(function(q){
      var res = evalRank(q, c), rel = res.rows.slice(0, evalK).map(function(x){ return !!q.rel[x.item.id]; });
      var total = Object.keys(q.rel).filter(function(k){ return q.rel[k]; }).length;
      p += precisionAtK(rel, evalK); r += recallAtK(rel, evalK, total); n += ndcgAtK(rel, evalK, total); ms += res.ms;
    });
    var m = qs.length || 1;
    return { cfg:c, p:p/m, r:r/m, n:n/m, ms:ms/m, count:qs.length };
  });
}
function renderEval(){
  var body = $('atabBody'), cat = evalCatalogue(), withEmb = cat.filter(function(i){ return i.emb; }).length;
  body.innerHTML = '<div class="pcard" style="margin-bottom:18px"><h2>Evaluation</h2><p class="psub">Upload 10+ test fabrics, tick the catalogue items you would genuinely pair with each, and read the comparison table. Judgements live in this browser tab; export before closing.</p>' +
    (withEmb < cat.length ? '<div class="banner warn">' + (cat.length - withEmb) + ' of ' + cat.length + ' catalogue items have no CLIP vector, so the vision signals are weak. Run AI indexing on the Overview tab first.</div>' : '') +
    '<div class="inline-actions"><label class="btn btn-gold" style="cursor:pointer;width:auto">Add test fabrics<input type="file" id="evFiles" accept="image/*" multiple hidden /></label>' +
    '<label class="sortwrap">K <select id="evK"><option>3</option><option>5</option><option>10</option></select></label>' +
    '<button class="btn btn-ghost btn-sm" id="evCsv">Export CSV</button><span class="mini" id="evMsg"></span></div></div>' +
    '<div id="evTable"></div><div id="evList"></div>';
  $('evK').value = String(evalK);
  $('evK').onchange = function(){ evalK = Number($('evK').value); renderEval(); };
  $('evCsv').onclick = exportEvalCsv;
  $('evFiles').onchange = async function(e){
    var files = Array.prototype.slice.call(e.target.files); if(!files.length) return;
    $('evMsg').textContent = 'Analysing ' + files.length + ' photo(s)…';
    var ai = AI.enabled() ? await AI.start() : false;
    for(var i=0;i<files.length;i++){
      try {
        var img = await loadImageFromFile(files[i]), a = analyseImage(img), f = { hex:a.hex, palette:a.palette, tex:a.tex, emb:null };
        if(ai){ f.emb = await AI.embed(img); Object.assign(f, AI.describeFabric(f.emb)); }
        state.evalQ.push({ name:files[i].name, src:img.src, fabric:f, occasion:null, rel:{} });
      } catch(err){ console.warn(err); }
    }
    $('evMsg').textContent = ''; renderEval();
  };
  renderEvalBody();
}
function renderEvalBody(){
  var qs = state.evalQ;
  if(!qs.length){ $('evList').innerHTML = '<div class="empty">No test fabrics yet.</div>'; $('evTable').innerHTML = ''; return; }
  var m = evalMetrics(), best = { p:0, r:0, n:0 };
  m.forEach(function(x){ ['p','r','n'].forEach(function(k){ if(x[k] > best[k]) best[k] = x[k]; }); });
  $('evTable').innerHTML = '<div class="tbl-wrap" style="margin-bottom:22px"><table class="tbl metric-tbl"><thead><tr><th>System</th><th>Precision@' + evalK + '</th><th>Recall@' + evalK + '</th><th>NDCG@' + evalK + '</th><th>Latency</th></tr></thead><tbody>' +
    m.map(function(x){ return '<tr><td>' + esc(x.cfg.name) + '</td><td class="' + (x.p === best.p && x.count ? 'best' : '') + '">' + x.p.toFixed(3) + '</td><td class="' + (x.r === best.r && x.count ? 'best' : '') + '">' + x.r.toFixed(3) + '</td><td class="' + (x.n === best.n && x.count ? 'best' : '') + '">' + x.n.toFixed(3) + '</td><td>' + x.ms.toFixed(1) + ' ms</td></tr>'; }).join('') +
    '</tbody></table></div><div class="mini" style="margin:-10px 0 22px">Averaged over ' + (m[0].count) + ' fabric(s) with at least one relevant item ticked. Latency is ranking time only, on this device.</div>';
  $('evList').innerHTML = qs.map(function(q, qi){
    var pool = evalPool(q);
    return '<div class="eval-q"><h3><img src="' + esc(q.src) + '" alt="" />' + esc(q.name) + '<select class="ev-occ" data-q="' + qi + '" style="margin-left:auto"><option value="">No occasion</option>' + OCCASION_NAMES.map(function(o){ return '<option' + (q.occasion === o ? ' selected' : '') + '>' + o + '</option>'; }).join('') + '</select><button class="btn btn-ghost btn-sm ev-rm" data-q="' + qi + '">Remove</button></h3>' +
      '<div class="eval-pool">' + pool.map(function(it){
        return '<label class="eval-it' + (q.rel[it.id] ? ' rel' : '') + '"><input type="checkbox" class="ev-rel" data-q="' + qi + '" data-i="' + it.id + '"' + (q.rel[it.id] ? ' checked' : '') + ' />' + thumbHTML(it, 'cart-sw').replace('cart-sw', 'cart-sw" style="width:36px;height:36px;flex-shrink:0') +
          '<span class="en">' + esc(it.name) + '<small>' + esc(it.cat) + '</small></span></label>';
      }).join('') + '</div></div>';
  }).join('');
  document.querySelectorAll('.ev-rel').forEach(function(c){ c.onchange = function(){ state.evalQ[c.dataset.q].rel[c.dataset.i] = c.checked; renderEvalBody(); }; });
  document.querySelectorAll('.ev-occ').forEach(function(s){ s.onchange = function(){ state.evalQ[s.dataset.q].occasion = s.value || null; renderEvalBody(); }; });
  document.querySelectorAll('.ev-rm').forEach(function(b){ b.onclick = function(){ state.evalQ.splice(Number(b.dataset.q), 1); renderEvalBody(); }; });
}
function exportEvalCsv(){
  var m = evalMetrics(), lines = ['system,precision@' + evalK + ',recall@' + evalK + ',ndcg@' + evalK + ',latency_ms,fabrics_judged'];
  m.forEach(function(x){ lines.push([x.cfg.name.replace(/,/g, ' '), x.p.toFixed(4), x.r.toFixed(4), x.n.toFixed(4), x.ms.toFixed(2), x.count].join(',')); });
  lines.push(''); lines.push('fabric,occasion,relevant_item_ids');
  state.evalQ.forEach(function(q){ lines.push([q.name.replace(/,/g, ' '), q.occasion || '', Object.keys(q.rel).filter(function(k){ return q.rel[k]; }).join(' ')].join(',')); });
  var blob = new Blob([lines.join('\n')], { type:'text/csv' }), a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'rangreza_evaluation.csv'; document.body.appendChild(a); a.click(); a.remove();
}

/* ==========================================================================
   BOOT
   ========================================================================== */
function showSetupScreen(msg){
  document.body.innerHTML = '<div style="max-width:560px;margin:12vh auto;padding:0 24px;font-family:Jost,sans-serif;color:#3b1228;"><h1 style="font-family:\'Cormorant Garamond\',serif;font-size:36px;margin:0 0 12px">Almost there</h1><p style="color:#9d8787;line-height:1.7">' + msg + '</p></div>';
}
function wireStaticUI(){
  document.querySelectorAll('.portal-btn').forEach(function(b){ b.onclick = function(){ setPortal(b.dataset.portal); }; });
  $('backShop').onclick = function(){ setPortal('shop'); };
  window.addEventListener('hashchange', function(){ var h = location.hash.replace('#',''); if(['shop','vendor','admin'].indexOf(h) >= 0 && h !== state.portal) setPortal(h); });
  document.querySelectorAll('#view-shop .tab-btn').forEach(function(b){ b.onclick = function(){ setTab(b.dataset.tab); }; });
  wireDropzone('dzMatch', 'fileMatch', onMatchFile); wireDropzone('dzVendor', 'fileVendor', onVendorFile);
  $('sortMatch').onchange = function(){ state.match.sort = this.value; renderMatch(); };
  $('cityVendor').onchange = function(){ state.vendor.city = this.value; renderVendor(); };
  $('cartBtn').onclick = function(){ state.checkoutStep = 'cart'; openDrawer(); };
  $('drawerClose').onclick = closeDrawer; $('drawerBg').onclick = closeDrawer;
  $('acctBtn').onclick = function(){
    var r = state.profile && state.profile.role;
    if(r === 'vendor') setPortal('vendor'); else if(r === 'admin') setPortal('admin'); else { setPortal('shop'); setTab('account'); }
  };
  document.addEventListener('keydown', function(e){ if(e.key === 'Escape') closeDrawer(); });
}
function subscribeRealtime(){
  try {
    sb.channel('rz-catalogue')
      .on('postgres_changes', { event:'*', schema:'public', table:'inventory_items' }, function(){ scheduleReload(1200); })
      .on('postgres_changes', { event:'*', schema:'public', table:'vendors' }, function(){ scheduleReload(1200); })
      .subscribe();
    sb.channel('rz-orders')
      .on('postgres_changes', { event:'INSERT', schema:'public', table:'order_items' }, function(){
        if(state.profile && state.profile.role === 'vendor'){ toast('New order received', 'ok'); loadVendorOrders().then(function(){ if(state.portal === 'vendor') renderVendorPortal(); }); }
      })
      .on('postgres_changes', { event:'UPDATE', schema:'public', table:'order_items' }, function(){
        if(isCustomer()) loadMyOrders().then(renderShopAccount);
      })
      .subscribe();
  } catch(e){ console.warn('Realtime unavailable', e); }
}
async function boot(){
  if(!CONFIGURED){
    showSetupScreen('This file needs your Supabase project URL and anon key pasted at the top of its <code>&lt;script&gt;</code> tag. See <b>SETUP_GUIDE.md</b> step 5.'); return;
  }
  if(typeof supabase === 'undefined'){ showSetupScreen('The Supabase library could not load. Check your internet connection and reload.'); return; }
  sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth:{ persistSession:true, autoRefreshToken:true } });
  wireStaticUI(); renderAiStatus(); renderMatchPreview(null); renderVendorPreview(null); renderOccasions();
  var s = await sb.auth.getSession(); state.session = s.data ? s.data.session : null;
  sb.auth.onAuthStateChange(function(evt, session){
    // Never await Supabase calls inside this callback (supabase-js deadlocks); defer instead.
    setTimeout(function(){
      var had = !!state.session; state.session = session;
      if(evt === 'PASSWORD_RECOVERY'){ showRecovery(); }
      if(evt === 'SIGNED_OUT' && had){ state.profile = null; renderTopAccount(); renderAll(); }
      if(evt === 'TOKEN_REFRESHED' || evt === 'USER_UPDATED') return;
    }, 0);
  });
  await loadProfile(); await loadRoleData(); renderTopAccount();
  var h = (location.hash || '').replace('#', '');
  setPortal(['vendor','admin'].indexOf(h) >= 0 ? h : 'shop');
  await loadCatalog(); renderAll(); subscribeRealtime();
}
document.addEventListener('DOMContentLoaded', boot);
window.RANGREZA = { state:state, AI:AI, scoreRMS:scoreRMS, rankItems:rankItems, buildBundle:buildBundle, explain:explain, setPortal:setPortal, setTab:setTab, getItems:function(){ return ITEMS; }, addToCart:addToCart, loadCatalog:loadCatalog };

/* theme toggle */
(function(){
  var btn=document.getElementById('themeBtn'); if(!btn) return;
  function apply(t){ document.documentElement.setAttribute('data-theme',t); btn.textContent=(t==='dark')?'☀':'☾';
    btn.title=(t==='dark')?'Switch to light mode':'Switch to dark mode'; }
  apply(document.documentElement.getAttribute('data-theme')==='dark'?'dark':'light');
  btn.addEventListener('click',function(){ var t=document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark';
    apply(t); try{localStorage.setItem('rz_theme',t);}catch(e){} });
})();

/* remove any injected "Powered by Netlify" badge (incl. shadow roots) */
(function(){
  function hit(n){
    try{
      var t=(n.textContent||'').trim().toLowerCase();
      var h=(n.getAttribute&&(n.getAttribute('href')||''))||'';
      if(t==='powered by netlify') return true;
      if(/netlify\.com/.test(h) && /netlify/.test(t) && t.length<40) return true;
    }catch(e){}
    return false;
  }
  function scan(root){
    if(!root||!root.querySelectorAll) return;
    root.querySelectorAll('*').forEach(function(n){
      if(hit(n)){ var el=n; try{ if(el.tagName!=='A'&&el.closest){ var a2=el.closest('a'); if(a2&&hit(a2)) el=a2; } }catch(e){} try{ el.remove(); }catch(e){ el.style.display='none'; } }
      if(n.shadowRoot) scan(n.shadowRoot);
    });
  }
  function kill(){ try{ scan(document); }catch(e){} }
  if(typeof document!=='undefined'){
    kill();
    try{ new MutationObserver(kill).observe(document.documentElement,{childList:true,subtree:true}); }catch(e){}
    [500,1500,3500,6000].forEach(function(ms){ setTimeout(kill,ms); });
  }
})();
