/* ==========================================================================
   ACCOUNTS — one login form used by all three portals.
   Roles are enforced by the database (profiles.role + RLS). The browser only
   decides which portal to SHOW; it cannot grant itself a role.
   ========================================================================== */
var authSeq = 0;
var ROLE_LABEL = { customer:'customer', vendor:'vendor', admin:'admin' };

async function loadProfile(){
  if(!state.session){ state.profile = null; state.myVendor = null; return; }
  var r = await sb.from('profiles').select('*').eq('id', state.session.user.id).maybeSingle();
  state.profile = r.data || null;
}
async function loadRoleData(){
  var role = state.profile && state.profile.role;
  if(role === 'vendor'){ await loadMyVendor(); await Promise.all([loadMyItems(), loadVendorOrders()]); }
  else if(role === 'customer'){ await loadMyOrders(); }
}
async function onSessionChanged(){
  teardownRealtime();
  await loadProfile(); await loadRoleData(); renderTopAccount(); renderAll();
  setupRealtime();
}

/* ---------- live order notifications (Supabase Realtime) ---------- */
function teardownRealtime(){
  if(state._rt){ try { state._rt.forEach(function(ch){ if(sb.removeChannel) sb.removeChannel(ch); }); } catch(e){} state._rt = null; }
}
function statusLabel(s){
  return ({ 'new':'received', confirmed:'confirmed', ready:'ready for pickup', fulfilled:'fulfilled', cancelled:'cancelled' }[s] || s);
}
function setupRealtime(){
  teardownRealtime();
  if(!sb.channel || !state.session || !state.profile) return;
  var role = state.profile.role, chans = [];
  if(role === 'vendor' && state.myVendor){
    var vid = state.myVendor.id;
    var cv = sb.channel('rt-vendor-' + vid)
      .on('postgres_changes', { event:'INSERT', schema:'public', table:'order_items', filter:'vendor_id=eq.' + vid }, function(){
        loadVendorOrders().then(function(){ if(state.portal === 'vendor') renderVendorPortal(); flashTitle('New order'); toast('New order received', 'ok'); });
      })
      .on('postgres_changes', { event:'UPDATE', schema:'public', table:'order_items', filter:'vendor_id=eq.' + vid }, function(p){
        var s = p && p['new'] && p['new'].status;
        loadVendorOrders().then(function(){ if(state.portal === 'vendor') renderVendorPortal(); if(s === 'cancelled') toast('A customer cancelled an item', 'warn'); });
      })
      .subscribe();
    chans.push(cv);
  } else if(role === 'customer'){
    var cc = sb.channel('rt-cust-' + state.session.user.id)
      .on('postgres_changes', { event:'UPDATE', schema:'public', table:'order_items' }, function(p){
        var s = p && p['new'] && p['new'].status;
        loadMyOrders().then(function(){ if(state.portal === 'shop' && state.tab === 'account') renderShopAccount(); flashTitle('Order update'); toast('Your order is now ' + statusLabel(s) + '.', 'ok'); });
      })
      .subscribe();
    chans.push(cc);
  }
  state._rt = chans;
}
var _titleTimer = null, _baseTitle = (typeof document !== 'undefined' ? document.title : '');
function flashTitle(msg){
  if(typeof document === 'undefined') return;
  if(!_baseTitle) _baseTitle = document.title;
  document.title = '🔔 ' + msg;
  clearTimeout(_titleTimer);
  _titleTimer = setTimeout(function(){ document.title = _baseTitle; }, 6000);
}
function renderTopAccount(){
  var b = $('acctBtn');
  b.hidden = false;
  if(!state.session){ b.textContent = 'Sign in / Sign up'; b.classList.add('signin'); return; }
  b.classList.remove('signin');
  var nm = (state.profile && state.profile.full_name || '').split(' ')[0] || state.session.user.email;
  b.textContent = nm + (state.profile ? ' · ' + state.profile.role : '');
}
async function signOut(){
  teardownRealtime();
  await sb.auth.signOut();
  state.session = null; state.profile = null; state.myVendor = null; state.myItems = []; state.vendorOrders = []; state.myOrders = [];
  state.admin = { vendors:[], items:[], orders:[], stats:null, loaded:false };
  state.checkoutStep = 'cart';
  renderTopAccount(); renderAll(); if($('drawer').classList.contains('open')) renderDrawer();
}

function fieldHTML(id, label, attrs, req){
  return '<div class="field"><label for="' + id + '">' + label + (req ? ' <span class="req">*</span>' : '') + '</label><input id="' + id + '" ' + (attrs || '') + ' /></div>';
}
function renderAuth(host, role, onDone){
  var u = 'a' + (++authSeq) + '_', signupOK = role !== 'admin';
  var shopFields = role === 'vendor'
    ? '<div class="note" style="margin:4px 0 14px">Your shop appears to customers after our team approves it. You can add stock straight away.</div>' +
      fieldHTML(u+'shop', 'Shop name', 'placeholder="e.g. Rania Trims &amp; Laces"', true) +
      '<div class="r2">' + fieldHTML(u+'bazaar', 'Bazaar / market', 'placeholder="Raja Bazaar"') + fieldHTML(u+'shopno', 'Shop / stall no.', 'placeholder="Stall 8"') + '</div>' +
      '<div class="r2">' + fieldHTML(u+'city', 'City', 'placeholder="Rawalpindi"', true) + '<div class="field"><label for="' + u + 'ful">Sells</label><select id="' + u + 'ful"><option value="pickup">In-store pickup</option><option value="online">Ships online</option><option value="both">Both</option></select></div></div>' +
      fieldHTML(u+'addr', 'Street address (for directions)', 'placeholder="Optional"')
    : '';
  host.innerHTML =
    (signupOK ? '<div class="authtabs"><button class="authtab active" data-m="in">Sign in</button><button class="authtab" data-m="up">Create account</button></div>' : '') +
    '<div class="authpane active" data-pane="in">' +
      fieldHTML(u+'em', 'Email', 'type="email" autocomplete="email"', true) + fieldHTML(u+'pw', 'Password', 'type="password" autocomplete="current-password"', true) +
      '<button class="btn btn-gold" id="' + u + 'go">Sign in</button><div class="formerr" id="' + u + 'err"></div>' +
      '<div style="margin-top:12px"><button class="link-btn" id="' + u + 'forgot">Forgot password?</button></div></div>' +
    (signupOK ? '<div class="authpane" data-pane="up">' +
      fieldHTML(u+'name', 'Your full name', 'autocomplete="name"', true) + fieldHTML(u+'phone', 'Phone', 'type="tel" placeholder="03xx-xxxxxxx"', true) + shopFields +
      fieldHTML(u+'em2', 'Email', 'type="email" autocomplete="email"', true) + fieldHTML(u+'pw2', 'Password (8+ characters)', 'type="password" autocomplete="new-password"', true) +
      '<button class="btn btn-gold" id="' + u + 'su">Create ' + ROLE_LABEL[role] + ' account</button><div class="formerr" id="' + u + 'err2"></div></div>' : '');
  var q = function(id){ return host.querySelector('#' + u + id); };
  host.querySelectorAll('.authtab').forEach(function(t){ t.onclick = function(){
    host.querySelectorAll('.authtab').forEach(function(x){ x.classList.toggle('active', x === t); });
    host.querySelectorAll('.authpane').forEach(function(p){ p.classList.toggle('active', p.dataset.pane === t.dataset.m); });
  }; });
  function fail(id, m){ var e = q(id); e.textContent = m; e.classList.add('show'); }
  function wait(btn, on, label){ btn.disabled = on; btn.innerHTML = on ? '<span class="spin"></span> Please wait…' : label; }

  q('go').onclick = async function(){
    var btn = q('go'); q('err').classList.remove('show');
    var email = q('em').value.trim(), pw = q('pw').value;
    if(!email || !pw){ fail('err', 'Enter your email and password.'); return; }
    wait(btn, true);
    try {
      var r = await sb.auth.signInWithPassword({ email:email, password:pw });
      if(r.error) throw r.error;
      state.session = r.data.session; await loadProfile();
      if(!state.profile || state.profile.role !== role){
        var found = state.profile ? state.profile.role : 'unknown';
        await sb.auth.signOut(); state.session = null; state.profile = null;
        throw new Error('This email belongs to a ' + found + ' account, not a ' + role + ' account. Use the ' + (found === 'customer' ? 'Shop' : found === 'vendor' ? 'Vendor Portal' : 'Admin') + ' portal, or a different email.');
      }
      await onSessionChanged(); if(onDone) onDone();
    } catch(e){ fail('err', /Invalid login/i.test(errMsg(e)) ? 'Wrong email or password.' : errMsg(e)); wait(btn, false, 'Sign in'); }
  };
  q('forgot').onclick = async function(){
    var email = q('em').value.trim();
    if(!email){ fail('err', 'Type your email above first, then tap Forgot password.'); return; }
    var r = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    if(r.error) fail('err', errMsg(r.error)); else { var e = q('err'); e.textContent = 'If that email has an account, a reset link is on its way.'; e.classList.add('show'); e.style.color = 'var(--ok)'; }
  };
  if(!signupOK) return;
  q('su').onclick = async function(){
    var btn = q('su'); q('err2').classList.remove('show');
    var d = { name:q('name').value.trim(), phone:q('phone').value.trim(), email:q('em2').value.trim(), pw:q('pw2').value };
    if(!d.name || !d.phone || !d.email){ fail('err2', 'Please fill in every field marked *.'); return; }
    if(d.pw.length < 8){ fail('err2', 'Password must be at least 8 characters.'); return; }
    var shop = null;
    if(role === 'vendor'){
      shop = { shop_name:q('shop').value.trim(), bazaar:q('bazaar').value.trim(), shop_number:q('shopno').value.trim(), city:q('city').value.trim(),
               address:q('addr').value.trim(), fulfillment:q('ful').value, phone:d.phone };
      if(!shop.shop_name || !shop.city){ fail('err2', 'Shop name and city are required.'); return; }
    }
    wait(btn, true);
    try {
      var r = await sb.auth.signUp({ email:d.email, password:d.pw, options:{ data:{ full_name:d.name, phone:d.phone, role:role } } });
      if(r.error) throw r.error;
      if(!r.data.session){
        var e = q('err2'); e.textContent = 'Account created. Check your email and confirm your address, then sign in.'; e.classList.add('show'); e.style.color = 'var(--ok)';
        wait(btn, false, 'Create ' + ROLE_LABEL[role] + ' account'); return;
      }
      state.session = r.data.session; await loadProfile();
      if(shop){
        shop.user_id = state.session.user.id;
        var ins = await sb.from('vendors').insert(shop);
        if(ins.error) toast('Account created, but the shop details did not save: ' + ins.error.message + '. You can complete them in the portal.', 'err');
      }
      await onSessionChanged(); toast('Welcome to Rangreza, ' + d.name.split(' ')[0] + '!', 'ok'); if(onDone) onDone();
    } catch(e){ fail('err2', errMsg(e)); wait(btn, false, 'Create ' + ROLE_LABEL[role] + ' account'); }
  };
}
function mismatchCard(role){
  var have = state.profile ? state.profile.role : 'another';
  return '<div class="pcard authbox"><span class="pill-role ' + (have === 'vendor' ? 'v' : have === 'admin' ? 'a' : '') + '">' + have + ' account</span><h2>You are signed in as a ' + have + '</h2>' +
    '<p class="psub">This area is for ' + role + ' accounts. Each portal has its own account. Sign out to use a different one.</p><button class="btn btn-ghost so-mis">Sign out</button></div>';
}
function wireMismatch(){ document.querySelectorAll('.so-mis').forEach(function(b){ b.onclick = signOut; }); }

function showRecovery(){
  $('drawerTitle').textContent = 'Set a new password';
  $('drawerBody').innerHTML = fieldHTML('npw', 'New password (8+ characters)', 'type="password" autocomplete="new-password"', true) + '<div class="formerr" id="npwErr"></div>';
  $('drawerFoot').innerHTML = '<button class="btn btn-gold" id="npwGo">Save password</button>';
  $('npwGo').onclick = async function(){
    var pw = $('npw').value; if(pw.length < 8){ $('npwErr').textContent = 'At least 8 characters.'; $('npwErr').classList.add('show'); return; }
    var r = await sb.auth.updateUser({ password:pw });
    if(r.error){ $('npwErr').textContent = errMsg(r.error); $('npwErr').classList.add('show'); return; }
    closeDrawer(); toast('Password updated. You are signed in.', 'ok');
  };
  $('drawer').classList.add('open'); $('drawerBg').classList.add('open');
}

/* ==========================================================================
   NAVIGATION
   ========================================================================== */
function setPortal(p){
  state.portal = p;
  document.querySelectorAll('.portal-btn').forEach(function(b){ b.classList.toggle('active', b.dataset.portal === p); });
  ['shop','vendor','admin'].forEach(function(n){ $('view-' + n).classList.toggle('active', n === p); });
  $('cartBtn').style.display = p === 'shop' ? '' : 'none';
  $('backShop').hidden = (p === 'shop');
  if(!state.session) $('acctBtn').hidden = (p !== 'shop');
  try { history.replaceState(null, '', '#' + p); } catch(e){}
  if(p === 'vendor') renderVendorPortal();
  if(p === 'admin') renderAdminPortal();
  if(p === 'shop') renderShopAccount();
}
function setTab(t){
  state.tab = t;
  document.querySelectorAll('#view-shop .tab-btn').forEach(function(b){ b.classList.toggle('active', b.dataset.tab === t); });
  document.querySelectorAll('#view-shop .panel').forEach(function(p){ p.classList.toggle('active', p.dataset.panel === t); });
  if(t === 'account') renderShopAccount();
}
function renderAll(){
  renderMatch(); renderVendor(); renderCartCount();
  if(state.portal === 'vendor') renderVendorPortal();
  if(state.portal === 'admin') renderAdminPortal();
  renderShopAccount();
}

/* ==========================================================================
   SHOP — My Account & Orders (customer)
   ========================================================================== */
async function loadMyOrders(){
  if(!isCustomer()) return;
  var r = await sb.from('orders').select('*, order_items(*)').order('created_at', { ascending:false });
  if(!r.error) state.myOrders = r.data || [];
}
function orderLineStatus(s){ return '<span class="ostatus os-' + s + '">' + s + '</span>'; }
function renderShopAccount(){
  var host = $('shopAccount'); if(!host) return;
  if(!state.session){
    host.innerHTML = '<div class="pcard authbox"><span class="pill-role">Customer</span><h2>Your Rangreza account</h2><p class="psub">Create a free account to place orders and track them. Browsing and matching never need one.</p><div id="custAuth"></div></div>';
    renderAuth($('custAuth'), 'customer', function(){ renderShopAccount(); }); return;
  }
  if(!isCustomer()){ host.innerHTML = mismatchCard('customer'); wireMismatch(); return; }
  var p = state.profile;
  host.innerHTML = '<div class="pcard"><div class="who-row"><div class="wtxt">Signed in as <strong>' + esc(state.session.user.email) + '</strong></div><button class="btn btn-ghost btn-sm" id="soCust">Sign out</button></div>' +
    '<div class="r2">' + fieldHTML('prName', 'Name', 'value="' + esc(p.full_name) + '"') + fieldHTML('prPhone', 'Phone', 'value="' + esc(p.phone || '') + '"') + '</div>' +
    '<button class="btn btn-ghost btn-sm" id="prSave">Save details</button></div>' +
    '<div class="pcard"><h2>My orders</h2><p class="psub">Each shop confirms its own items.</p><div id="myOrdersList"></div></div>';
  $('soCust').onclick = signOut;
  $('prSave').onclick = async function(){
    var r = await sb.from('profiles').update({ full_name:$('prName').value.trim(), phone:$('prPhone').value.trim() }).eq('id', state.session.user.id);
    if(r.error) toast(errMsg(r.error), 'err'); else { await loadProfile(); renderTopAccount(); toast('Saved', 'ok'); }
  };
  var list = $('myOrdersList');
  if(!state.myOrders.length){ list.innerHTML = '<div class="empty" style="padding:30px 0">No orders yet. Find something you love and add it to your order.</div>'; return; }
  list.innerHTML = state.myOrders.map(function(o){
    return '<div class="ordercard"><div class="oh"><span><b>' + fmtDateTime(o.created_at) + '</b> &middot; Order ' + esc(o.id.slice(0, 8)) + '</span><span><b>' + money(o.total) + '</b></span></div>' +
      (o.order_items || []).map(function(l){
        return '<div class="ol"><div><div class="oln">' + esc(l.name) + ' &times; ' + l.qty + '</div><div class="olm">' + money(l.price) + ' / ' + esc(l.unit || 'unit') + '</div></div>' +
          '<div class="ola">' + orderLineStatus(l.status) + (l.status === 'new' ? '<button class="btn btn-ghost btn-sm cancel-line" data-id="' + l.id + '">Cancel</button>' : '') + '</div></div>';
      }).join('') + '</div>';
  }).join('');
  list.querySelectorAll('.cancel-line').forEach(function(b){ b.onclick = async function(){
    b.disabled = true; var r = await sb.rpc('customer_cancel_order_item', { p_id:b.dataset.id });
    if(r.error){ toast(errMsg(r.error), 'err'); b.disabled = false; return; }
    await loadMyOrders(); renderShopAccount(); toast('Item cancelled', 'ok');
  }; });
}

/* ==========================================================================
   VENDOR PORTAL
   ========================================================================== */
async function loadMyVendor(){
  var r = await sb.from('vendors').select('*').eq('user_id', state.session.user.id).maybeSingle();
  state.myVendor = r.data || null;
}
async function loadMyItems(){
  if(!state.myVendor) { state.myItems = []; return; }
  var r = await sb.from('inventory_items').select('*').eq('vendor_id', state.myVendor.id).order('created_at', { ascending:false });
  if(!r.error) state.myItems = r.data || [];
}
async function loadVendorOrders(){
  if(!state.myVendor){ state.vendorOrders = []; return; }
  var r = await sb.from('order_items').select('*, orders(id,buyer_name,buyer_phone,buyer_email,note,created_at)').order('created_at', { ascending:false });
  if(!r.error) state.vendorOrders = r.data || [];
}
function vendorStatusBanner(v){
  if(v.status === 'pending') return '<div class="banner warn"><b>Awaiting approval.</b> Our team is reviewing your shop. You can add stock now; customers will see everything as soon as you are approved.</div>';
  if(v.status === 'suspended') return '<div class="banner err"><b>Your shop is suspended.</b> Customers cannot see your listings. Please contact Rangreza support.</div>';
  return '';
}
function shopFormHTML(v, prefix){
  v = v || {};
  return fieldHTML(prefix+'shop', 'Shop name', 'value="' + esc(v.shop_name || '') + '"', true) +
    '<div class="r2">' + fieldHTML(prefix+'bazaar', 'Bazaar / market', 'value="' + esc(v.bazaar || '') + '"') + fieldHTML(prefix+'shopno', 'Shop / stall no.', 'value="' + esc(v.shop_number || '') + '"') + '</div>' +
    '<div class="r2">' + fieldHTML(prefix+'city', 'City', 'value="' + esc(v.city || '') + '"', true) +
    '<div class="field"><label for="' + prefix + 'ful">Sells</label><select id="' + prefix + 'ful">' + [['pickup','In-store pickup'],['online','Ships online'],['both','Both']].map(function(o){ return '<option value="' + o[0] + '"' + ((v.fulfillment || 'pickup') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></div></div>' +
    fieldHTML(prefix+'addr', 'Street address', 'value="' + esc(v.address || '') + '"') + fieldHTML(prefix+'phone', 'Shop phone', 'value="' + esc(v.phone || '') + '"');
}
function readShopForm(p){
  return { shop_name:$(p+'shop').value.trim(), bazaar:$(p+'bazaar').value.trim(), shop_number:$(p+'shopno').value.trim(), city:$(p+'city').value.trim(),
           address:$(p+'addr').value.trim(), fulfillment:$(p+'ful').value, phone:$(p+'phone').value.trim() };
}
function renderVendorPortal(){
  var host = $('vendorHost');
  if(!state.session){
    host.innerHTML = '<div class="authbox-wrap"><div class="pcard authbox"><span class="pill-role v">Vendor Portal</span><h2>Sell your embellishments</h2><p class="psub">List your laces, gota, tassels and more. Customers find you by photo.</p><div id="vendAuth"></div></div></div>';
    renderAuth($('vendAuth'), 'vendor', function(){ renderVendorPortal(); }); return;
  }
  if(!state.profile || state.profile.role !== 'vendor'){ host.innerHTML = '<div class="authbox-wrap">' + mismatchCard('vendor') + '</div>'; wireMismatch(); return; }
  if(!state.myVendor){
    host.innerHTML = '<div class="authbox-wrap"><div class="pcard authbox"><span class="pill-role v">Vendor Portal</span><h2>Set up your shop</h2><p class="psub">One last step before you can list stock.</p>' + shopFormHTML(null, 'ns_') +
      '<button class="btn btn-gold" id="nsSave">Create my shop</button><div class="formerr" id="nsErr"></div></div></div>';
    $('nsSave').onclick = async function(){
      var d = readShopForm('ns_'); d.user_id = state.session.user.id;
      if(!d.shop_name || !d.city){ $('nsErr').textContent = 'Shop name and city are required.'; $('nsErr').classList.add('show'); return; }
      var r = await sb.from('vendors').insert(d);
      if(r.error){ $('nsErr').textContent = errMsg(r.error); $('nsErr').classList.add('show'); return; }
      await loadMyVendor(); renderVendorPortal();
    }; return;
  }
  var v = state.myVendor, newCount = state.vendorOrders.filter(function(l){ return l.status === 'new'; }).length;
  host.innerHTML = '<div class="subtabs"><div class="tabbar-inner">' +
    '<button class="tab-btn' + (state.vtab === 'stock' ? ' active' : '') + '" data-tab="stock">My Stock</button>' +
    '<button class="tab-btn' + (state.vtab === 'orders' ? ' active' : '') + '" data-tab="orders">Orders' + (newCount ? ' <span class="tab-badge">' + newCount + '</span>' : '') + '</button>' +
    '<button class="tab-btn' + (state.vtab === 'shop' ? ' active' : '') + '" data-tab="shop">Shop Profile</button></div></div>' +
    '<div class="wide-wrap"><div class="who-row"><div class="wtxt"><strong>' + esc(v.shop_name) + '</strong> &middot; ' + esc(state.session.user.email) + '</div><button class="btn btn-ghost btn-sm" id="soVend">Sign out</button></div>' +
    vendorStatusBanner(v) + '<div id="vtabBody"></div></div>';
  $('soVend').onclick = signOut;
  host.querySelectorAll('.tab-btn').forEach(function(b){ b.onclick = function(){ state.vtab = b.dataset.tab; renderVendorPortal(); }; });
  if(state.vtab === 'stock') renderVendorStock();
  else if(state.vtab === 'orders') renderVendorOrders();
  else renderVendorShop();
}

/* ---- My Stock ---- */
function renderVendorStock(){
  var body = $('vtabBody');
  body.innerHTML = '<div class="portal-wrap" style="padding:0"><div><div class="pcard"><h2>Add an item</h2><p class="psub">Take a clear, close-up photo. We read its colour and texture automatically.</p>' +
    '<div class="dropzone vdz" id="dzAdd"><input type="file" id="fileAdd" accept="image/*" /><div class="dz-title" id="addDzTitle">Drop or tap to add a photo</div><div class="dz-sub">Required</div></div>' +
    '<div class="preview" id="previewAdd" hidden></div><div style="height:16px"></div>' +
    fieldHTML('itName', 'Item name', 'placeholder="e.g. Antique Gold Dabka Border"', true) +
    '<div class="r2"><div class="field"><label for="itCat">Category <span class="req">*</span></label><select id="itCat">' + VENDOR_CATS.map(function(c){ return '<option>' + c + '</option>'; }).join('') + '</select></div>' +
    '<div class="field"><label for="itUnit">Sold per</label><select id="itUnit"><option>yard</option><option>metre</option><option>piece</option><option>dozen</option><option>set</option></select></div></div>' +
    '<div class="r3">' + fieldHTML('itPrice', 'Price (PKR)', 'type="number" min="0" inputmode="decimal"', true) + fieldHTML('itQty', 'Quantity', 'type="number" min="0" inputmode="numeric" value="10"', true) +
    '<div class="field"><label for="itStock">Status</label><select id="itStock"><option value="">Auto</option>' + ITEM_STOCK_OPTS.map(function(o){ return '<option value="' + o[0] + '">' + o[1] + '</option>'; }).join('') + '</select></div></div>' +
    '<button class="btn btn-ok" id="itAdd">Add to my catalogue</button><div class="formerr" id="itErr"></div></div></div>' +
    '<div><div class="pcard"><div class="inv-head"><h2>My catalogue</h2><span class="mini" id="invCount"></span></div><div id="invList"></div></div></div></div>';
  wireDropzone('dzAdd', 'fileAdd', onAddFile);
  $('itAdd').onclick = addItem;
  renderInventoryList();
}
async function onAddFile(file){
  try {
    var img = await loadImageFromFile(file), a = analyseImage(img);
    state.add = { hex:a.hex, palette:a.palette, tex:a.tex, imgEl:img, file:file, busy:false };
    var h = $('previewAdd'); h.hidden = false;
    h.innerHTML = previewHTML('Detected colour', img.src, a.hex, a.palette, 'clearAdd');
    $('clearAdd').onclick = function(){ state.add = { hex:null, palette:null, tex:null, imgEl:null, file:null, busy:false }; h.hidden = true; };
  } catch(e){ toast(errMsg(e), 'err'); }
}
function itemErr(m){ var e = $('itErr'); e.textContent = m; e.classList.add('show'); }
async function addItem(){
  var A = state.add, btn = $('itAdd'); $('itErr').classList.remove('show');
  var name = $('itName').value.trim(), price = $('itPrice').value, qty = parseInt($('itQty').value, 10);
  if(!A.file) return itemErr('Please add a photo first.');
  if(!name) return itemErr('Give the item a name.');
  if(price === '' || Number(price) < 0) return itemErr('Enter a price.');
  if(isNaN(qty) || qty < 0) return itemErr('Enter the quantity you have.');
  if(A.file.size > 8 * 1024 * 1024) return itemErr('That photo is over 8 MB. Please use a smaller one.');
  if(A.busy) return; A.busy = true; btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Uploading…';
  try {
    var ext = (A.file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'jpg';
    var path = state.session.user.id + '/' + (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now())) + '.' + ext;
    var up = await sb.storage.from('vendor-photos').upload(path, A.file, { contentType: A.file.type, upsert:false });
    if(up.error) throw new Error('Photo upload failed: ' + up.error.message);
    var row = { vendor_id: state.myVendor.id, name:name, category:$('itCat').value, price:Number(price), unit:$('itUnit').value, quantity:qty,
                stock_status: $('itStock').value || deriveStock(qty), image_path:path, dominant_hex:A.hex, palette:A.palette,
                texture: Array.from(A.tex || []), analyzed_by:'client' };
    // If the AI model happens to be loaded in this browser, index the item right away; otherwise an admin indexes it.
    if(AI.ready()){ try { var emb = await AI.embed(A.imgEl); row.embedding = roundVec(emb); row.attrs = AI.describeItem(emb); } catch(e){} }
    var ins = await sb.from('inventory_items').insert(row).select().single();
    if(ins.error) throw new Error('Could not save the item: ' + ins.error.message);
    state.myItems.unshift(ins.data);
    state.add = { hex:null, palette:null, tex:null, imgEl:null, file:null, busy:false };
    renderVendorStock(); toast('"' + name + '" added', 'ok');
    // Server-side re-analysis (fire and forget — the client result above is already live).
    sb.auth.getSession().then(function(s){
      var tok = s.data && s.data.session ? s.data.session.access_token : null; if(!tok) return;
      fetch(SUPABASE_URL + '/functions/v1/analyze-image', { method:'POST', headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer ' + tok },
        body: JSON.stringify({ item_id: ins.data.id, image_path: path }) })
        .catch(function(){}).finally(function(){ loadMyItems().then(function(){ if(state.vtab === 'stock' && state.portal === 'vendor') renderInventoryList(); }); });
    });
  } catch(e){ itemErr(errMsg(e)); A.busy = false; btn.disabled = false; btn.textContent = 'Add to my catalogue'; }
}
var editingItem = null;
function renderInventoryList(){
  var list = $('invList'); if(!list) return;
  $('invCount').textContent = state.myItems.length + ' item' + (state.myItems.length === 1 ? '' : 's');
  if(!state.myItems.length){ list.innerHTML = '<div class="empty" style="padding:34px 0">No items yet. Add your first one on the left.</div>'; return; }
  list.innerHTML = state.myItems.map(function(r){
    var it = rowToItem(r);
    if(editingItem === r.id){
      return '<div class="inv-row" style="grid-template-columns:52px minmax(0,1fr)">' + thumbHTML(it, 'inv-thumb') + '<div><div class="inv-name">' + esc(it.name) + '</div>' +
        '<div class="r3" style="margin-top:8px"><input id="ePrice" type="number" min="0" value="' + it.price + '" aria-label="Price" /><input id="eQty" type="number" min="0" value="' + it.qty + '" aria-label="Quantity" />' +
        '<select id="eStock">' + ITEM_STOCK_OPTS.map(function(o){ return '<option value="' + o[0] + '"' + (o[0] === it.stock ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></div>' +
        '<div class="btn-row" style="margin-top:8px"><button class="btn btn-ok btn-sm" id="eSave" data-id="' + r.id + '">Save</button><button class="btn btn-ghost btn-sm" id="eCancel">Cancel</button></div></div></div>';
    }
    return '<div class="inv-row">' + thumbHTML(it, 'inv-thumb') + '<div style="min-width:0"><div class="inv-name">' + esc(it.name) + '</div>' +
      '<div class="inv-meta"><span class="dotc" style="background:' + it.hex + '"></span>' + esc(nearestColorName(it.hex)) + ' &middot; ' + esc(it.cat) + ' &middot; ' + money(it.price) + ' / ' + esc(it.unit) + ' &middot; qty ' + it.qty + '</div>' +
      '<span class="pill-d pd-' + it.stock + '">' + STOCK_LABEL[it.stock] + '</span>' + (it.active ? '' : ' <span class="pill-d pd-out_of_stock">Hidden</span>') +
      (it.emb ? ' <span class="pill-d pd-in_stock">AI indexed</span>' : '') + '</div>' +
      '<div class="btn-row"><button class="btn btn-ghost btn-sm edit-item" data-id="' + r.id + '">Edit</button><button class="btn btn-ghost btn-sm toggle-item" data-id="' + r.id + '" data-on="' + (it.active ? 1 : 0) + '">' + (it.active ? 'Hide' : 'Show') + '</button></div></div>';
  }).join('');
  list.querySelectorAll('.edit-item').forEach(function(b){ b.onclick = function(){ editingItem = b.dataset.id; renderInventoryList(); }; });
  list.querySelectorAll('.toggle-item').forEach(function(b){ b.onclick = async function(){
    var r = await sb.from('inventory_items').update({ is_active: b.dataset.on !== '1' }).eq('id', b.dataset.id);
    if(r.error) return toast(errMsg(r.error), 'err');
    await loadMyItems(); renderInventoryList(); scheduleReload(300);
  }; });
  if($('eCancel')){ $('eCancel').onclick = function(){ editingItem = null; renderInventoryList(); };
    $('eSave').onclick = async function(){
      var q = parseInt($('eQty').value, 10), p = Number($('ePrice').value);
      if(isNaN(q) || q < 0 || isNaN(p) || p < 0) return toast('Enter a valid price and quantity.', 'err');
      var r = await sb.from('inventory_items').update({ price:p, quantity:q, stock_status:$('eStock').value }).eq('id', $('eSave').dataset.id);
      if(r.error) return toast(errMsg(r.error), 'err');
      editingItem = null; await loadMyItems(); renderInventoryList(); scheduleReload(300); toast('Updated', 'ok');
    }; }
}

/* ---- Orders (vendor) ---- */
function groupOrders(lines){
  var m = {}, out = [];
  lines.forEach(function(l){ var o = l.orders || { id:l.order_id }; if(!m[o.id]){ m[o.id] = { o:o, lines:[] }; out.push(m[o.id]); } m[o.id].lines.push(l); });
  return out;
}
function renderVendorOrders(){
  var body = $('vtabBody'), groups = groupOrders(state.vendorOrders);
  if(!groups.length){ body.innerHTML = '<div class="pcard"><h2>Orders</h2><div class="empty" style="padding:40px 0">No orders yet. New ones appear here instantly and you will see a notice.</div></div>'; return; }
  body.innerHTML = '<div class="pcard" style="margin-bottom:16px"><h2>Orders</h2><p class="psub">Call or WhatsApp the customer to confirm, then update each line.</p></div>' + groups.map(function(g){
    var o = g.o, sum = g.lines.reduce(function(a,l){ return a + l.price * l.qty; }, 0);
    return '<div class="ordercard"><div class="oh"><span><b>' + esc(o.buyer_name || 'Customer') + '</b> &middot; <a style="color:var(--gold-light)" href="tel:' + esc(o.buyer_phone || '') + '">' + esc(o.buyer_phone || '') + '</a>' + (o.buyer_email ? ' &middot; ' + esc(o.buyer_email) : '') + '</span><span>' + (o.created_at ? fmtDateTime(o.created_at) : '') + ' &middot; <b>' + money(sum) + '</b></span></div>' +
      (o.note ? '<div class="note" style="margin:10px 0 0">' + esc(o.note) + '</div>' : '') +
      g.lines.map(function(l){
        return '<div class="ol"><div><div class="oln">' + esc(l.name) + ' &times; ' + l.qty + '</div><div class="olm">' + money(l.price) + ' / ' + esc(l.unit || 'unit') + '</div></div>' +
          '<div class="ola">' + orderLineStatus(l.status) + '<select class="line-status" data-id="' + l.id + '" aria-label="Update status">' + ORDER_STATUS.map(function(s){ return '<option' + (s === l.status ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select></div></div>';
      }).join('') + '</div>';
  }).join('');
  body.querySelectorAll('.line-status').forEach(function(s){ s.onchange = async function(){
    var r = await sb.from('order_items').update({ status:s.value }).eq('id', s.dataset.id);
    if(r.error){ toast(errMsg(r.error), 'err'); return; }
    await loadVendorOrders(); renderVendorPortal(); toast('Order updated', 'ok');
  }; });
}

/* ---- Shop profile ---- */
function renderVendorShop(){
  $('vtabBody').innerHTML = '<div class="pcard" style="max-width:560px"><h2>Shop profile</h2><p class="psub">Customers see this on every listing and use it for directions.</p>' + shopFormHTML(state.myVendor, 'sp_') +
    '<button class="btn btn-ok" id="spSave">Save changes</button><div class="formerr" id="spErr"></div></div>';
  $('spSave').onclick = async function(){
    var d = readShopForm('sp_'); if(!d.shop_name || !d.city){ $('spErr').textContent = 'Shop name and city are required.'; $('spErr').classList.add('show'); return; }
    var r = await sb.from('vendors').update(d).eq('id', state.myVendor.id);
    if(r.error){ $('spErr').textContent = errMsg(r.error); $('spErr').classList.add('show'); return; }
    await loadMyVendor(); renderVendorPortal(); scheduleReload(300); toast('Shop profile saved', 'ok');
  };
}
