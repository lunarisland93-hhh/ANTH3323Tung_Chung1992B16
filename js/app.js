let PHOTOS = [];
let CONTEXT = {};          // 照片 id → 背景說明（來源：東涌B16照片_宗教信仰對照表.xlsx）
let map, histLayer, clusterGroup;
let curIdx = -1;
let MARKERS = [];          // 與 PHOTOS 同序，用於選取態
let SITE_LABELS = {};      // 站點 → 地圖標籤
const SITE_GROUPS = {};    // 站點 → 照片索引

// 篩選狀態：空集合 = 不篩（顯示全部）；多選同組為 OR，組間為 AND
const FILTERS = { prec: new Set(), religion: new Set(), village: new Set() };

// 宗教信仰分類（來源：東涌B16照片_宗教信仰對照表.xlsx「宗教信仰／神明」欄）
const RELIGION_ZH = { folk: '民間道教信仰', buddhist: '佛教', catholic: '天主教' };
const RELIGION_OF = {};
(function () {
  const num = (a, b) => { const r = []; for (let k = a; k <= b; k++) r.push('B16P' + String(k).padStart(2, '0')); return r; };
  const cat = {
    folk:     num(1, 12).concat(num(19, 23), ['B16P29'], num(30, 35), ['B16P36']),
    buddhist: num(13, 18).concat(['B16P20']),
    catholic: num(24, 28),
  };
  Object.entries(cat).forEach(([k, ids]) => ids.forEach(id => { RELIGION_OF[id] = k; }));
})();

const PREC_ZH = { 'Exact': '精確', 'Approximate': '約略', 'Village-level': '村落級' };

function isVisibleIdx(i) {
  const p = PHOTOS[i];
  if (FILTERS.prec.size && !FILTERS.prec.has(p.loc_precision)) return false;
  if (FILTERS.religion.size && !FILTERS.religion.has(RELIGION_OF[p.photo_id] || '')) return false;
  if (FILTERS.village.size && !FILTERS.village.has(p.village_name || '')) return false;
  return true;
}

// 1982 地形圖：4 張 TIF 已拼接成一張（無縫）
const HIST_BOUNDS = [[22.246452, 113.861420], [22.300810, 113.970475]];

const SITE_NAMES = {
  'S01': '侯王宮', 'S02': '羅漢寺', 'S03': '東涌區康樂中心',
  'S04': '聖母訪親堂前身', 'S05': '深石村社公',
  'S06': '莫伯祖屋', 'S07': '古堡炮臺分叉路',
};

// 精度 → 標記樣式（同一個綠，用形狀區分，不引入第二個強調色）
function precisionClass(prec) {
  if (prec === 'Exact') return 'dot--exact';
  if (prec === 'Approximate') return 'dot--approx';
  if (prec && prec.includes('Village')) return 'dot--village';
  return 'dot--village';
}

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const isMobile = () => window.matchMedia('(max-width: 900px)').matches;

async function init() {
  try {
    const [res, resCtx] = await Promise.all([
      fetch('./data/photos.json'),
      fetch('./data/site-context.json'),
    ]);
    if (!res.ok) throw new Error('photos.json ' + res.status);
    PHOTOS = await res.json();
    if (resCtx.ok) CONTEXT = await resCtx.json();
  } catch (err) {
    showLoadError();
    return;
  }
  buildSiteList();
  buildFilters();
  initMap();
  bindUI();
  initViewer();
  buildTextSummary();
  applyFilters();

  // 減少動態效果：直接進入內容；已看過開箱則不再重播
  if (reduceMotion || sessionStorage.getItem('tc_intro_seen') === '1') enterMain(false);
}

function showLoadError() {
  const el = document.getElementById('site-list');
  if (el) el.innerHTML = '<p class="load-error">記錄載入失敗，請確認 data/photos.json 與網路連線。</p>';
  const intro = document.getElementById('intro');
  if (intro) intro.style.display = 'none';
  document.getElementById('main').classList.remove('hidden');
}

/* ---------- 篩選器 ---------- */
function buildFilters() {
  const root = document.getElementById('filters');
  const counts = { prec: {}, religion: {}, village: {} };
  PHOTOS.forEach(p => {
    counts.prec[p.loc_precision] = (counts.prec[p.loc_precision] || 0) + 1;
    const r = RELIGION_OF[p.photo_id];
    if (r) counts.religion[r] = (counts.religion[r] || 0) + 1;
    if (p.village_name) counts.village[p.village_name] = (counts.village[p.village_name] || 0) + 1;
  });
  const defs = [
    { key: 'prec',     name: '位置精度', items: Object.keys(PREC_ZH).filter(k => counts.prec[k]).map(k => [k, PREC_ZH[k], counts.prec[k]]) },
    { key: 'religion', name: '宗教信仰', items: Object.keys(RELIGION_ZH).filter(k => counts.religion[k]).map(k => [k, RELIGION_ZH[k], counts.religion[k]]) },
    { key: 'village',  name: '村落',     items: Object.entries(counts.village).sort((a, b) => b[1] - a[1]).map(([k, c]) => [k, k, c]) },
  ];
  defs.forEach(def => {
    const g = document.createElement('div');
    g.className = 'f-group';
    const nm = document.createElement('span');
    nm.className = 'f-name'; nm.textContent = def.name;
    const chips = document.createElement('div');
    chips.className = 'f-chips';
    def.items.forEach(([val, zh, c]) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'f-chip';
      b.textContent = `${zh} ${c}`;
      b.setAttribute('aria-pressed', 'false');
      b.onclick = () => {
        const s = FILTERS[def.key];
        if (s.has(val)) { s.delete(val); b.setAttribute('aria-pressed', 'false'); }
        else { s.add(val); b.setAttribute('aria-pressed', 'true'); }
        applyFilters();
      };
      chips.appendChild(b);
    });
    g.append(nm, chips);
    root.appendChild(g);
  });
  const clear = document.createElement('button');
  clear.type = 'button'; clear.className = 'f-clear'; clear.textContent = '清除篩選';
  clear.onclick = () => {
    Object.values(FILTERS).forEach(s => s.clear());
    root.querySelectorAll('.f-chip').forEach(b => b.setAttribute('aria-pressed', 'false'));
    applyFilters();
  };
  root.appendChild(clear);
}

function applyFilters() {
  const vis = PHOTOS.map((_, i) => i).filter(isVisibleIdx);

  // 地圖標記：不符篩選的從地圖移除（標記在 cluster 群組內）
  MARKERS.forEach((m, i) => {
    if (!m) return;
    const on = vis.includes(i);
    if (on && !clusterGroup.hasLayer(m)) clusterGroup.addLayer(m);
    if (!on && clusterGroup.hasLayer(m)) clusterGroup.removeLayer(m);
  });

  // 站點列表：隱藏無符合照片的站點，數字改為符合張數
  document.querySelectorAll('.site-item').forEach(e => {
    const sid = e.dataset.site;
    const n = (SITE_GROUPS[sid] || []).filter(isVisibleIdx).length;
    e.classList.toggle('hidden', n === 0);
    const c = e.querySelector('.s-count');
    if (c) c.textContent = n;
  });

  updateSiteLabels();
  document.getElementById('f-status').textContent = `顯示 ${vis.length} / ${PHOTOS.length} 張照片`;
  if (!document.getElementById('view-wall').classList.contains('hidden')) buildWall();

  // 目前選取的照片被篩走 → 回空狀態
  if (curIdx >= 0 && !vis.includes(curIdx)) clearRecord();
}

function clearRecord() {
  curIdx = -1;
  document.getElementById('photo-card').classList.add('hidden');
  document.getElementById('photo-empty').classList.remove('hidden');
  MARKERS.forEach(m => {
    if (!m) return;
    const el = m.getElement();
    if (el) el.classList.remove('marker-sel');
  });
  document.querySelectorAll('.site-item').forEach(e => {
    e.classList.remove('active');
    e.removeAttribute('aria-current');
  });
}

/* ---------- 分頁切換：地圖 / 照片牆 / 背景說明 ---------- */
function showView(v) {
  ['map', 'wall', 'text'].forEach(name => {
    document.getElementById('view-' + name).classList.toggle('hidden', name !== v);
  });
  document.querySelectorAll('.view-tab').forEach(t => {
    const on = t.dataset.view === v;
    t.classList.toggle('active', on);
    if (on) t.setAttribute('aria-current', 'true'); else t.removeAttribute('aria-current');
  });
  if (isMobile()) window.scrollTo(0, 0);   // 換分頁回到頁頂
  if (v === 'map') setTimeout(() => map.invalidateSize(), 60);
  if (v === 'wall') buildWall();
}

function jumpToPhoto(idx) {
  showView('map');
  const m = MARKERS[idx];
  if (m && clusterGroup.hasLayer(m)) {
    clusterGroup.zoomToShowLayer(m, () => showPhoto(idx));
  } else {
    showPhoto(idx);
  }
}

/* ---------- 照片牆 ---------- */
function buildWall() {
  const grid = document.getElementById('wall-grid');
  grid.innerHTML = '';
  const vis = PHOTOS.map((_, i) => i).filter(isVisibleIdx);
  vis.forEach(i => {
    const p = PHOTOS[i];
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'wall-item';
    b.innerHTML =
      `<img src="${p.image_path}" alt="${p.alt_text_zh}" loading="lazy">` +
      `<span class="wall-cap"><span class="wall-id">${p.photo_id}</span>` +
      `<span class="wall-sub">${p.subject_zh || p.place_name || ''}</span></span>`;
    b.onclick = () => jumpToPhoto(i);
    grid.appendChild(b);
  });
  document.getElementById('wall-status').textContent = `顯示 ${vis.length} / ${PHOTOS.length} 張照片`;
}

/* ---------- 背景說明匯總（依《東涌B16照片_宗教信仰對照表》分組） ---------- */
function buildTextSummary() {
  const root = document.getElementById('text-body');
  root.innerHTML = '';

  const intro = document.createElement('p');
  intro.className = 'text-intro';
  intro.textContent = '以下背景說明按照片編號順序匯總，逐字取自《東涌B16照片_宗教信仰對照表》「簡介（中文）」欄；點照片編號可回到地圖查看該筆記錄。';
  root.appendChild(intro);

  // 連續且文字相同的照片合為一組
  const groups = [];
  PHOTOS.forEach((p, i) => {
    const t = CONTEXT[p.photo_id];
    const last = groups[groups.length - 1];
    if (t && last && last.text === t) last.idxs.push(i);
    else groups.push({ text: t, idxs: [i] });
  });

  groups.forEach(g => {
    const first = PHOTOS[g.idxs[0]];
    const div = document.createElement('article');
    div.className = 't-entry';

    const head = document.createElement('div');
    head.className = 't-head';
    const title = document.createElement('h3');
    title.className = 't-title';
    title.textContent = SITE_NAMES[first.site_id] || first.site_id;
    const range = g.idxs.length === 1
      ? PHOTOS[g.idxs[0]].photo_id
      : `${first.photo_id} – ${PHOTOS[g.idxs[g.idxs.length - 1]].photo_id}`;
    const sub = document.createElement('span');
    sub.className = 't-range';
    sub.textContent = `${range}（${g.idxs.length} 張）`;
    head.append(title, sub);
    div.appendChild(head);

    const ids = document.createElement('div');
    ids.className = 't-ids';
    g.idxs.forEach(i => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 't-id';
      b.textContent = PHOTOS[i].photo_id;
      b.onclick = () => jumpToPhoto(i);
      ids.appendChild(b);
    });
    div.appendChild(ids);

    if (g.text) {
      const txt = document.createElement('p');
      txt.className = 't-text';
      txt.innerHTML = g.text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/\n+/g, '<br><br>');
      div.appendChild(txt);
    }
    root.appendChild(div);
  });

  const src = document.createElement('p');
  src.className = 't-source';
  src.textContent = '資料參考來源：TAM, Siu Mi Maria (Editor) ; CHIAO, Chien (Editor). / Ethnographic Study of Family and Religion in Tung Chung Valley: Investigation Report. China, Hong Kong : Dept. of Anthropology, The Chinese University of Hong Kong, 1993. 146 p.';
  root.appendChild(src);
}

/* ---------- 站點列表 ---------- */
function buildSiteList() {
  const el = document.getElementById('site-list');
  el.innerHTML = '';
  PHOTOS.forEach((p, i) => {
    (SITE_GROUPS[p.site_id] = SITE_GROUPS[p.site_id] || []).push(i);
  });
  Object.keys(SITE_GROUPS).sort().forEach(sid => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'site-item';
    b.dataset.site = sid;
    b.innerHTML =
      `<img class="site-thumb" src="assets/icons/${sid}.png" alt="">` +
      `<span class="s-name">${SITE_NAMES[sid] || sid}</span>` +
      `<span class="s-count">${SITE_GROUPS[sid].length}</span>`;
    b.onclick = () => {
      const vis = SITE_GROUPS[sid].filter(isVisibleIdx);
      selectSite(sid, vis.length ? vis[0] : SITE_GROUPS[sid][0]);
    };
    el.appendChild(b);
  });
}

function selectSite(sid, idx) {
  document.querySelectorAll('.site-item').forEach(e => {
    const on = e.dataset.site === sid;
    e.classList.toggle('active', on);
    if (on) e.setAttribute('aria-current', 'true'); else e.removeAttribute('aria-current');
  });
  // 若照片點目前聚在 cluster 內：自動放大並散開（spiderfy）到該照片
  const m = MARKERS[idx];
  if (m && clusterGroup.hasLayer(m)) {
    clusterGroup.zoomToShowLayer(m, () => showPhoto(idx));
  } else {
    showPhoto(idx);
  }
}

/* ---------- 地圖 ---------- */
function updateSiteLabels() {
  const z = map.getZoom();
  Object.entries(SITE_LABELS).forEach(([sid, l]) => {
    const show = z <= 15 && (SITE_GROUPS[sid] || []).some(isVisibleIdx);
    if (show) l.addTo(map); else map.removeLayer(l);
  });
}

function getDotIcon(prec) {
  return L.divIcon({
    className: 'photo-dot',
    html: `<span class="marker-wrap"><i class="dot ${precisionClass(prec)}"></i></span>`,
    iconSize: [15, 15], iconAnchor: [7.5, 7.5]
  });
}

function initMap() {
  map = L.map('map').setView([22.278, 113.933], 13);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors', maxZoom: 18
  }).addTo(map);

  // 1982 地形圖（已拼接，無縫）
  histLayer = L.imageOverlay(
    'assets/maps/tung-chung-1982-stitch.jpg',
    HIST_BOUNDS, { opacity: 0.45 }
  ).addTo(map);

  // 每張照片一個標記（形狀表示定位精度）；同站照片以 cluster 聚合，
  // 放大後散開（spiderfy）成各自可點的照片點
  clusterGroup = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 45,
    spiderfyOnMaxZoom: true,
    spiderLegPolylineOptions: { weight: 1.5, color: '#38332E', opacity: .45 },
    iconCreateFunction: c => {
      const n = c.getChildCount();
      const size = n < 10 ? 30 : n < 20 ? 36 : 42;
      return L.divIcon({
        html: `<span class="cluster-n">${n}</span>`,
        className: 'marker-cluster',
        iconSize: [size, size]
      });
    }
  });
  PHOTOS.forEach((p, i) => {
    if (!p.mapped) return;
    const m = L.marker([p.lat, p.lon], { icon: getDotIcon(p.loc_precision) });
    m.on('click', () => showPhoto(i));
    clusterGroup.addLayer(m);
    MARKERS[i] = m;
  });
  map.addLayer(clusterGroup);

  // 站點標籤（zoom out 時顯示；受篩選影響）
  Object.keys(SITE_GROUPS).forEach(sid => {
    const idxs = SITE_GROUPS[sid].filter(i => PHOTOS[i].mapped);
    if (!idxs.length) return;
    const p = PHOTOS[idxs[0]];
    const label = L.marker([p.lat, p.lon], {
      icon: L.divIcon({
        className: 'site-label',
        html: `<span class="site-tag">${SITE_NAMES[sid] || sid}</span>`,
        iconSize: [104, 24], iconAnchor: [52, 30]
      }),
      interactive: false
    });
    SITE_LABELS[sid] = label;
  });

  map.on('zoomend', updateSiteLabels);
  updateSiteLabels();

  const bounds = L.latLngBounds(PHOTOS.filter(p => p.mapped).map(p => [p.lat, p.lon]));
  map.fitBounds(bounds, { padding: [50, 50] });
}

/* ---------- 記錄（圖冊條目） ---------- */
function showPhoto(idx) {
  curIdx = idx;
  const p = PHOTOS[idx];
  document.getElementById('photo-empty').classList.add('hidden');
  document.getElementById('photo-card').classList.remove('hidden');
  document.getElementById('p-img').src = p.image_path;
  document.getElementById('p-img').alt = p.alt_text_zh;
  document.getElementById('p-id').textContent = p.photo_id;
  document.getElementById('p-pos').textContent = `${idx + 1} / ${PHOTOS.length}`;
  document.getElementById('p-subject').textContent = p.subject_zh || p.original_note || '';
  document.getElementById('p-place').textContent = p.place_name || '';
  document.getElementById('p-note').textContent = p.original_note || '';
  document.getElementById('p-neg').textContent = p.negative_no || '—';
  document.getElementById('p-date').textContent = p.date_display || '—';
  document.getElementById('p-photog').textContent = p.photographer || '—';
  document.getElementById('p-prec').textContent = p.loc_precision || '—';
  document.getElementById('p-village').textContent = p.village_name || '—';
  document.getElementById('p-coord').textContent =
    (p.lat != null && p.lon != null) ? `${p.lat}, ${p.lon}` : '—';

  // 背景說明（來自宗教信仰對照表；原表為「/」的照片不顯示此區塊）
  const moreBtn = document.getElementById('p-more');
  const moreInfo = document.getElementById('p-more-info');
  const ctxText = CONTEXT[p.photo_id];
  if (ctxText) {
    moreBtn.classList.remove('hidden');
    document.getElementById('p-context').innerHTML =
      ctxText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n+/g, '<br><br>');
  } else {
    moreBtn.classList.add('hidden');
  }
  moreInfo.classList.add('hidden');

  // 選取態：地圖標記放大
  MARKERS.forEach((m, i) => {
    if (!m) return;
    const el = m.getElement();
    if (el) el.classList.toggle('marker-sel', i === idx);
  });

  // 站點列表同步
  document.querySelectorAll('.site-item').forEach(e => {
    const on = e.dataset.site === p.site_id;
    e.classList.toggle('active', on);
    if (on) e.setAttribute('aria-current', 'true'); else e.removeAttribute('aria-current');
  });

  // 一次性淡入回饋
  const card = document.getElementById('photo-card');
  if (!reduceMotion) {
    card.classList.remove('fresh');
    void card.offsetWidth;
    card.classList.add('fresh');
  }

  // 手機版：選取後帶到記錄區
  if (isMobile()) {
    document.getElementById('photo-card').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  }
}

/* ---------- 放大鏡與原圖檢視 ---------- */
function initViewer() {
  const wrap = document.getElementById('p-photo-wrap');
  const img = document.getElementById('p-img');
  const lens = document.getElementById('lens');
  const btn = document.getElementById('p-zoom');
  const lb = document.getElementById('lightbox');
  const lbImg = document.getElementById('lightbox-img');
  if (!wrap || !img || !lens || !btn || !lb) return;

  const ZOOM = 2.4;
  let lensOn = false;

  function moveLens(e) {
    const r = img.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (x < 0 || y < 0 || x > r.width || y > r.height) { lens.style.opacity = 0; return; }
    const d = lens.offsetWidth;
    lens.style.left = (e.clientX - d / 2) + 'px';
    lens.style.top = (e.clientY - d / 2) + 'px';
    lens.style.backgroundImage = `url("${img.currentSrc || img.src}")`;
    lens.style.backgroundSize = `${r.width * ZOOM}px ${r.height * ZOOM}px`;
    lens.style.backgroundPosition = `${-(x * ZOOM - d / 2)}px ${-(y * ZOOM - d / 2)}px`;
    lens.style.opacity = 1;
  }

  btn.addEventListener('click', () => {
    lensOn = !lensOn;
    btn.classList.toggle('on', lensOn);
    btn.setAttribute('aria-pressed', String(lensOn));
    btn.title = lensOn ? '關閉放大鏡' : '放大鏡';
    lens.hidden = !lensOn;
    if (!lensOn) lens.style.opacity = 0;
  });
  wrap.addEventListener('mousemove', (e) => { if (lensOn) moveLens(e); });
  wrap.addEventListener('mouseleave', () => { lens.style.opacity = 0; });

  // 點按照片：原圖檢視（觸控裝置的主要放大方式）
  img.addEventListener('click', () => {
    lbImg.src = img.currentSrc || img.src;
    lbImg.alt = img.alt;
    lb.hidden = false;
  });
  lb.addEventListener('click', () => { lb.hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !lb.hidden) lb.hidden = true;
  });
}

/* ---------- 互動 ---------- */
function bindUI() {
  const prev = () => { for (let i = curIdx - 1; i >= 0; i--) if (isVisibleIdx(i)) return showPhoto(i); };
  const next = () => { for (let i = curIdx + 1; i < PHOTOS.length; i++) if (isVisibleIdx(i)) return showPhoto(i); };
  document.getElementById('p-prev').onclick = prev;
  document.getElementById('p-next').onclick = next;
  document.getElementById('p-more').onclick = () =>
    document.getElementById('p-more-info').classList.toggle('hidden');

  const slider = document.getElementById('opacity');
  const val = document.getElementById('opacity-val');
  slider.oninput = (e) => {
    histLayer.setOpacity(e.target.value / 100);
    val.textContent = `${e.target.value}%`;
  };

  document.getElementById('open-btn').onclick = () => openBox();
  document.getElementById('skip-btn').onclick = () => enterMain(false);

  document.querySelectorAll('.view-tab').forEach(t => {
    t.onclick = () => showView(t.dataset.view);
  });
}

function openBox() {
  const box = document.getElementById('kraft-box');
  box.classList.add('opened');
  sessionStorage.setItem('tc_intro_seen', '1');
  const wait = reduceMotion ? 0 : 1000;
  setTimeout(() => enterMain(true), wait);
}

function enterMain() {
  const main = document.getElementById('main');
  document.getElementById('intro').style.display = 'none';
  main.classList.remove('hidden');
  sessionStorage.setItem('tc_intro_seen', '1');

  if (reduceMotion) {
    main.classList.add('is-in');
  } else {
    main.classList.add('enter');
    requestAnimationFrame(() => requestAnimationFrame(() => main.classList.add('is-in')));
  }
  setTimeout(() => map.invalidateSize(), 220);
}

init();
