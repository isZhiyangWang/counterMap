/* --------------------------------------------------
   main.js  – 2025-05 Update
   -------------------------------------------------- */

   import L from 'leaflet';
   import 'leaflet/dist/leaflet.css';
   import 'leaflet-toolbar';
   import 'leaflet-distortableimage';
   import './Leaflet.ImageOverlay.Rotated.js';
   
   /* ========== Global  ========== */
   const INTRO_KEY  = 'counterMapIntroDismissed';
   const isTouch    = matchMedia('(pointer: coarse)').matches;
   
   let map;                          // Leaflet instance
   const overlayById  = new Map();   // id → overlay
   const cardById     = new Map();   // id → sidebar card
   let townConnections = [];         // connections
   let initialBounds;                // For "Reset" function
   
   /* ========== Utility Functions ========== */
   const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
   const center = b => [avg(b.map(p => p[0])), avg(b.map(p => p[1]))];
   const mm = b => b.reduce(
     (o, [la, ln]) => ({
       minLat: Math.min(o.minLat, la), maxLat: Math.max(o.maxLat, la),
       minLng: Math.min(o.minLng, ln), maxLng: Math.max(o.maxLng, ln)
     }),
     { minLat: 90, maxLat: -90, minLng: 180, maxLng: -180 }
   );
   const shift = (b, dLa, dLn) => b.map(([la, ln]) => [la + dLa, ln + dLn]);
   const scale = (b, f) => {
     if (f === 1) return b;
     const [cLa, cLn] = center(b);
     return b.map(([la, ln]) => [cLa + (la - cLa) * f, cLn + (ln - cLn) * f]);
   };
   
   const $  = (s, c = document) => c.querySelector(s);
   const $$ = (s, c = document) => [...c.querySelectorAll(s)];
   const el = (tag, cls, html = '') => {
     const e = document.createElement(tag);
     if (cls) e.className = cls;
     e.innerHTML = html;
     return e;
   };
   
   /* ========== Overlay Functions ========== */
   function addOverlayImage(opt) {
     if (!opt.overlayBounds || !opt.overlayImage) return null;
   
     const pts     = opt.overlayBounds;
     const corners = [pts[0], pts[1], pts[3], pts[2]].map(p => L.latLng(p[0], p[1]));
   
     const ov = L.distortableImageOverlay(opt.overlayImage, {
       corners,
       opacity: opt.overlayOpacity ?? 0.5,
       interactive: false
     }).once('load', () => {
       ov._image.style.opacity = (opt.overlayOpacity ?? 0.5).toString();
       ov._image.setAttribute('alt', opt.title);
     });
   
     ov._mapId = opt.id;
     ov._type  = opt.type;
     ov.addTo(map);
     overlayById.set(opt.id, ov);
     return ov;
   }
   
   /* Highlight (via CSS class) */
   function setHighlight(id, on) {
     const ov   = overlayById.get(id);
     const card = cardById.get(id);
     if (!ov || id === 1) return;
   
     ov._image.classList.toggle('highlight--region', on && ov._type === 'region');
     ov._image.classList.toggle('highlight--town',   on && ov._type === 'town');
     card?.classList.toggle('active', on);
   }
   
   /* Expand specified card; collapse others */
   function expandCard(id) {
     cardById.forEach((c, cid) => c.classList.toggle('expanded', cid === id));
   }
   
   /* ========== Intro / Instruction Panel ========== */
   function introPanel() {
     if (localStorage.getItem(INTRO_KEY)) return;
   
     const ctrl = L.control({ position: 'topleft' });
     ctrl.onAdd = () => {
       const d = el('div', 'info-panel-intro', `
         <div class="intro-content">
           <h3>How to use</h3>
           <ol>
             <li>Click a region / town on the <strong>map</strong> or in the <strong>list</strong>.</li>
             <li>Read the preview and hit <em>More&nbsp;info&nbsp;→</em> for full details.</li>
           </ol>
           <p><span class="region-marker"></span> Regions &nbsp; <span class="town-marker"></span> Towns</p>
           <button id="closeIntro" class="close-btn" aria-label="Close introduction">×</button>
         </div>`);
       return d;
     };
     ctrl.addTo(map);
   
     setTimeout(() => {
       $('#closeIntro')?.addEventListener('click', () => {
         $('.info-panel-intro')?.classList.add('hidden');
         localStorage.setItem(INTRO_KEY, '1');
       });
     }, 80);
   }
   
   /* ========== Sidebar / Cards ========== */
   function renderList(items) {
     const list = $('#regionList');
     list.innerHTML = '';
   
     items.forEach(item => {
       const card = el('div', 'region-card');
       card.dataset.id   = item.id;
       card.dataset.type = item.type;
   
       /* Inner HTML */
       card.innerHTML = `
         <h3>${item.title}</h3>
         ${item.description ? `<p class="card-description">${item.description}</p>` : ''}
         <a class="detail-btn" href="${item.detailPage}" aria-label="Open detail page for ${item.title}">
           More&nbsp;info&nbsp;→
         </a>`;
   
       card.style.borderColor = item.type === 'region' ? '#1e90ff' : '#daa520';
       list.appendChild(card);
       cardById.set(item.id, card);
   
       /* Hover highlight (desktop only) */
       if (!isTouch) {
         card.addEventListener('mouseover', () => setHighlight(item.id, true));
         card.addEventListener('mouseout',  () => {
           if (!card.classList.contains('selected')) setHighlight(item.id, false);
         });
       }
   
       /* Click / Touch: highlight + expand (no navigation) */
       card.addEventListener('click', e => {
         /* Keep default navigation when "More info" button is clicked */
         if (e.target.closest('.detail-btn')) return;
   
         setHighlight(item.id, true);
         expandCard(item.id);
         $$('.region-card').forEach(c => c.classList.remove('selected'));
         card.classList.add('selected');
         card.scrollIntoView({ behavior: 'smooth', block: 'center' });
       });
     });
   }
   
   /* ========== Map Click → Sync Cards ========== */
   function mapClicks() {
     map.on('click', e => {
       let idHit = null;
       overlayById.forEach(ov => {
         const b = ov._corners ? L.latLngBounds(ov._corners) : null;
         if (b?.contains(e.latlng)) idHit = ov._mapId;
       });
   
       /* Reset */
       $$('.region-card').forEach(c => {
         c.classList.remove('selected', 'expanded', 'active');
       });
       overlayById.forEach((_, id) => setHighlight(id, false));
   
       if (!idHit) return;
   
       setHighlight(idHit, true);
       expandCard(idHit);
       const card = cardById.get(idHit);
       card?.classList.add('selected');
       card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
     });
   }
   
   /* ========== Initialize Page ========== */
   async function init() {
     const loader = $('#loadingOverlay');
   
     /* 1. Static Leaflet map */
     map = L.map('map', {
       center: [18.5, -72.0],
       zoom: 7,
       minZoom: 6,
       maxZoom: 20,
       zoomControl: false,
       dragging: false,
       scrollWheelZoom: false,
       doubleClickZoom: false,
       boxZoom: false,
       keyboard: false,
       tap: false,
       touchZoom: false
     });
     L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
       { attribution: 'Map data © OpenStreetMap contributors, © CARTO' }).addTo(map);
   
     /* 2. Intro Panel (first visit) */
     introPanel();
   
     /* 3. Load geo-data */
     const data = await (await fetch('/counterMap/data/mapsData.json')).json();
   
     /* — Draw regions first — */
     const regions = {};
     data.maps.filter(m => m.type === 'region').forEach(r => {
       addOverlayImage(r);
       Object.assign(r, mm(r.overlayBounds), { _center: center(r.overlayBounds) });
       regions[r.id] = r;
     });
   
     /* — Then draw towns — */
     for (const t of data.maps.filter(m => m.type === 'town')) {
       const reg = regions[t.regionId];
       if (!reg) continue;
   
       /* Adjust size & move outside region */
       const regSpanLng = reg.maxLng - reg.minLng;
       const tSpanLng   = mm(t.overlayBounds).maxLng - mm(t.overlayBounds).minLng;
       const scaleF     = Math.max(1.8, (regSpanLng * 0.7) / tSpanLng);
       const scaled     = scale(t.overlayBounds, scaleF);
   
       const margin   = 0.06;
       const bbox     = mm(scaled);
       const shiftLng = center(t.overlayBounds)[1] >= reg._center[1]
         ? (reg.maxLng + margin) - bbox.minLng
         : (reg.minLng - margin) - bbox.maxLng;
       const finalBds = shift(scaled, 0, shiftLng);
   
       const ov = addOverlayImage({ ...t, overlayBounds: finalBds, overlayOpacity: t.overlayOpacity ?? 0.7 });
       ov.setZIndex?.(9999);
   
       /* Connection lines and square markers */
       const origC = center(t.overlayBounds);
       const newC  = center(finalBds);
       const line = L.polyline([origC, newC], {
         color: '#0077ff', weight: 3, opacity: 0.7, dashArray: '5,8', className: 'connection-line'
       }).addTo(map);
   
       const mk = (latlng, col) => L.marker(latlng, {
         icon: L.divIcon({
           className: 'connection-marker',
           html: `<div style="width:10px;height:10px;background:${col};border:2px solid #fff;"></div>`,
           iconSize: [10, 10], iconAnchor: [5, 5]
         })
       }).addTo(map);
   
       townConnections.push({
         townId: t.id, line,
         origin: mk(origC, 'rgba(30,144,255,0.6)'),
         dest:   mk(newC,  'rgba(218,165,32,0.6)')
       });
     }
   
     /* 4. Fit map & save initial bounds */
     const allPts = data.maps.flatMap(m => m.overlayBounds.map(([la, ln]) => L.latLng(la, ln)));
     initialBounds = L.latLngBounds(allPts);
     map.fitBounds(initialBounds, { padding: [30, 30], maxZoom: 9 });
   
     /* 5. Reset button */
     const resetBtn = el('button', 'reset-view-btn', '🏠 Reset');
     resetBtn.addEventListener('click', () => map.fitBounds(initialBounds, { padding: [30, 30], maxZoom: 9 }));
     $('.map-column').appendChild(resetBtn);
   
     /* 6. Sidebar + Interactions */
     renderList(data.maps);
     mapClicks();
   
     loader.classList.add('hidden');
   }
   
   window.addEventListener('load', init);