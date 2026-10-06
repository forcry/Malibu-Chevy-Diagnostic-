'use strict';
/* MALIBU // SENTINEL v2 — local situational-awareness dashboard.
   Every service is {status, source, timestamp, data, note}. The UI never knows where data came from.
   status: LIVE | OFFLINE | ERROR | DEMO | STANDBY | PERMISSION REQUIRED | NOT CONFIGURED
   Values are never invented: if a service has no data it shows OFFLINE / NOT CONFIGURED.
   Vehicle access is READ-ONLY by design. Run via: python -m http.server  ->  http://localhost:8000 */

/* ================= CONFIG — the only place to wire sources. NEVER put secrets here. =================
   AIRCRAFT_URL: a small LOCAL proxy you run (holds any API key server-side) answering
     GET ?lat=&lon=&radius_km=  ->  {source:'name', aircraft:[{callsign,type,alt_ft,gs_kt,track,lat,lon,seen_s}]}
     Use any public ADS-B feed whose terms you accept (e.g. a community aggregator or OpenSky).
   MARKET_URL: local proxy answering GET ?symbols=SPY,QQQ -> {source:'name', quotes:[{symbol,price,changePct,state,ts}]} */
const CONFIG = { AIRCRAFT_URL: '', MARKET_URL: '', WATCHLIST: ['SPY', 'QQQ', 'AAPL', 'NVDA', 'MSFT', 'TSLA'], CELESTRAK_GROUP: 'visual' };

const $ = s => document.querySelector(s);
const S = { demo: false, share: false, follow: true, radius: 50, range: 100, layers: { user: 1, aircraft: 1, sats: 1, quakes: 1, weather: 1, alerts: 1 } };
const svc = (source, status = 'STANDBY', data = {}) => ({ status, source, timestamp: null, data, note: '' });
const gps = svc('Browser Geolocation', 'STANDBY', { lat: null, lon: null, alt: null, heading: null, acc: null, speed: null });
const mapS = svc('OpenStreetMap tiles (Leaflet)'), sat = svc('CelesTrak public orbital data + SGP4 (local)', 'STANDBY', { count: null, up: [] });
const quake = svc('USGS Earthquake Hazards Program'), wx = svc('Open-Meteo'), alerts = svc('NOAA / NWS alerts'), space = svc('NOAA SWPC');
const air = svc('External ADS-B proxy', 'NOT CONFIGURED'), mkt = svc('External market-data proxy', 'NOT CONFIGURED');
const veh = svc('ROCCO_PRO (OBD-II)', 'OFFLINE', { speed: null, rpm: null, fuel: null, coolant: null, voltage: null, engine: null, obd: null });
const rf = svc('No SDR connected', 'OFFLINE'), net = svc('Browser Navigator'), bt = svc('Web Bluetooth API', 'STANDBY', { sub: null, obd: false });

/* ---------- helpers ---------- */
const hms = d => new Date(d).toLocaleTimeString('en-GB');
const cls = s => s.replace(/ /g, '_');
const rad = x => x * Math.PI / 180, deg = x => x * 180 / Math.PI;
const km = (a, b) => { const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2; return 12742 * Math.asin(Math.sqrt(h)); };
const brg = (a, b) => (deg(Math.atan2(Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat)), Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon)))) + 360) % 360;
const dir8 = b => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(b / 45) % 8];
const pos = () => gps.data.lat == null ? null : { lat: gps.data.lat, lon: gps.data.lon };
const set = (ds, status, data, note = '') => { ds.status = status; ds.note = note; if (data) { Object.assign(ds.data, data); ds.timestamp = Date.now(); } };
function emit(mod, ev, src, st = 'INFO') {
  const l = $('#log'), r = document.createElement('div');
  r.innerHTML = `<i>${hms(Date.now())}</i> ${mod} · ${ev} <small>[${src}] ${st}</small>`; l.appendChild(r);
  while (l.children.length > 150) l.firstChild.remove(); l.scrollTop = l.scrollHeight;
}
const fail = (ds, mod, e) => { set(ds, navigator.onLine ? 'ERROR' : 'OFFLINE', null, e.message); emit(mod, 'UPDATE FAILED: ' + e.message, ds.source, ds.status); };
async function getJSON(url) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), 15000);
  try { const r = await fetch(url, { signal: c.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); } finally { clearTimeout(t); }
}

/* ================= SERVICES (each independent; one failing never affects another) ================= */
/* gpsService — real browser geolocation. Stored in memory only. */
let lastGpsLog = 0, lastWx = null;
function gpsService() {
  if (!navigator.geolocation) return set(gps, 'OFFLINE', null, 'geolocation unsupported');
  set(gps, 'PERMISSION REQUIRED');
  navigator.geolocation.watchPosition(p => {
    const c = p.coords, first = gps.data.lat == null;
    set(gps, 'LIVE', { lat: c.latitude, lon: c.longitude, alt: c.altitude, heading: c.heading, acc: c.accuracy, speed: c.speed });
    if (first || Date.now() - lastGpsLog > 30000) { emit('GPS', first ? 'FIRST FIX' : 'POSITION UPDATED', gps.source, 'LIVE'); lastGpsLog = Date.now(); }
    if (first) { satCalc(); mapDraw(true); weatherService(); aircraftService(); }
  }, e => { set(gps, e.code === 1 ? 'PERMISSION REQUIRED' : 'OFFLINE', null, e.message); emit('GPS', e.code === 1 ? 'PERMISSION DENIED/REQUIRED' : 'UNAVAILABLE', gps.source, gps.status); },
  { enableHighAccuracy: true, maximumAge: 5000 });
}

/* satelliteService — public GP data from CelesTrak, SGP4 via satellite.js. Observer location never leaves the device.
   CelesTrak asks clients to fetch no more than once per ~2 h; this refreshes every 2 h. */
let recs = [];
async function satService() {
  if (!window.satellite || !satellite.json2satrec) return set(sat, 'ERROR', null, 'SGP4 library (satellite.js) not loaded');
  try {
    const j = await getJSON(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${CONFIG.CELESTRAK_GROUP}&FORMAT=json`);
    recs = j.map(o => ({ name: o.OBJECT_NAME, norad: o.NORAD_CAT_ID, rec: satellite.json2satrec(o) }));
    set(sat, 'LIVE', { count: recs.length }); emit('SATELLITES', `CATALOG UPDATED (${recs.length})`, 'CelesTrak', 'LIVE'); satCalc();
  } catch (e) { fail(sat, 'SATELLITES', e); }
}
function satCalc() {
  const p = pos(); if (!p || !recs.length) return;
  try {
    const now = new Date(), g = satellite.gstime(now), obs = { latitude: rad(p.lat), longitude: rad(p.lon), height: (gps.data.alt || 0) / 1000 }, up = [];
    for (const s of recs) {
      const pv = satellite.propagate(s.rec, now); if (!pv.position) continue;
      const la = satellite.ecfToLookAngles(obs, satellite.eciToEcf(pv.position, g)), el = deg(la.elevation);
      if (el > 0) { const geo = satellite.eciToGeodetic(pv.position, g); up.push({ name: s.name, norad: s.norad, el, az: deg(la.azimuth), alt: geo.height, lat: satellite.degreesLat(geo.latitude), lon: satellite.degreesLong(geo.longitude) }); }
    }
    sat.data.up = up.sort((a, b) => b.el - a.el);
  } catch (e) { set(sat, 'ERROR', null, 'SGP4: ' + e.message); }
}

/* earthquakeService — global USGS feed; filtering by distance is done locally (no location sent). */
async function quakeService() {
  try {
    const j = await getJSON('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_week.geojson');
    set(quake, 'LIVE', { feed: j.features.map(f => ({ mag: f.properties.mag, place: f.properties.place, time: f.properties.time, url: f.properties.url, depth: f.geometry.coordinates[2], lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] })) });
    emit('GEOHAZARD', 'USGS FEED UPDATED', quake.source, 'LIVE');
  } catch (e) { fail(quake, 'GEOHAZARD', e); }
}

/* spaceService — NOAA SWPC scales (no location involved). */
async function spaceService() {
  try { const c = (await getJSON('https://services.swpc.noaa.gov/products/noaa-scales.json'))['0'];
    set(space, 'LIVE', { G: c.G.Scale, S: c.S.Scale, R: c.R.Scale }); emit('SPACE WX', 'SWPC SCALES UPDATED', space.source, 'LIVE');
  } catch (e) { fail(space, 'SPACE WX', e); }
}

/* weatherService — needs a (coarsened, ~1 km) location sent to Open-Meteo and NWS, so it only runs when LOCATION SHARING is ON. */
const WMO = { 0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 80: 'Showers', 81: 'Showers', 82: 'Violent showers', 95: 'Thunderstorm', 96: 'Thunderstorm w/ hail', 99: 'Thunderstorm w/ hail' };
async function weatherService() {
  const p = pos();
  if (!p || !S.share) { const n = !S.share ? 'LOCATION SHARING OFF' : 'needs GPS'; set(wx, 'OFFLINE', null, n); set(alerts, 'OFFLINE', null, n); return; }
  const la = p.lat.toFixed(2), lo = p.lon.toFixed(2);
  emit('WEATHER', 'REQUEST — coarse location sent to api.open-meteo.com', wx.source, 'INFO');
  try { const c = (await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,visibility&temperature_unit=fahrenheit&wind_speed_unit=mph`)).current;
    set(wx, 'LIVE', { temp: c.temperature_2m, hum: c.relative_humidity_2m, code: c.weather_code, wind: c.wind_speed_10m, wdir: c.wind_direction_10m, vis: c.visibility }); emit('WEATHER', 'DATA UPDATED', wx.source, 'LIVE');
  } catch (e) { fail(wx, 'WEATHER', e); }
  emit('ALERTS', 'REQUEST — coarse location sent to api.weather.gov', alerts.source, 'INFO');
  try { const j = await getJSON(`https://api.weather.gov/alerts/active?point=${la},${lo}`);
    set(alerts, 'LIVE', { list: j.features.map(f => ({ ev: f.properties.event, sev: f.properties.severity, head: f.properties.headline, url: f.properties.id || f.id })) }); emit('ALERTS', `NWS ALERTS UPDATED (${j.features.length})`, alerts.source, 'LIVE');
  } catch (e) { fail(alerts, 'ALERTS', e); }
}

/* aircraftService — see CONFIG. Sends coarse location to YOUR proxy only when sharing is ON. */
async function aircraftService() {
  if (!CONFIG.AIRCRAFT_URL) return set(air, 'NOT CONFIGURED', null, 'set CONFIG.AIRCRAFT_URL');
  const p = pos(); if (!p || !S.share) return set(air, 'OFFLINE', null, !S.share ? 'LOCATION SHARING OFF' : 'needs GPS');
  try { emit('AIRCRAFT', 'REQUEST — coarse location sent to configured proxy', CONFIG.AIRCRAFT_URL, 'INFO');
    const j = await getJSON(`${CONFIG.AIRCRAFT_URL}?lat=${p.lat.toFixed(2)}&lon=${p.lon.toFixed(2)}&radius_km=${S.radius}`);
    air.source = j.source || CONFIG.AIRCRAFT_URL; set(air, 'LIVE', { list: j.aircraft.map(a => ({ ...a, d: km(p, a), b: brg(p, a) })) }); emit('AIRCRAFT', 'DATA UPDATED', air.source, 'LIVE');
  } catch (e) { fail(air, 'AIRCRAFT', e); }
}

/* marketService — see CONFIG. No prices are ever generated. */
async function marketService() {
  if (!CONFIG.MARKET_URL) return set(mkt, 'NOT CONFIGURED', null, 'set CONFIG.MARKET_URL');
  try { const j = await getJSON(`${CONFIG.MARKET_URL}?symbols=${CONFIG.WATCHLIST.join(',')}`);
    mkt.source = j.source || CONFIG.MARKET_URL; set(mkt, 'LIVE', { quotes: j.quotes }); emit('MARKET', 'QUOTES UPDATED', mkt.source, 'LIVE');
  } catch (e) { fail(mkt, 'MARKET', e); }
}

/* vehicleService — CONNECT REAL OBD HERE (read-only PIDs). Call set(veh,'LIVE',{speed,rpm,fuel,coolant,voltage,engine:'RUNNING',obd:'CONNECTED'}).
   rfService — CONNECT SDR HERE: set(rf,'LIVE',{bins:Float32Array dBm, f0:MHz, f1:MHz}). Receive-only. */
function pollNet() { const c = navigator.connection || {}; set(net, navigator.onLine ? 'LIVE' : 'OFFLINE', { iface: c.type || c.effectiveType || null, rtt: c.rtt ?? null }); }
async function startBT() {
  try { const a = navigator.bluetooth && await navigator.bluetooth.getAvailability(); set(bt, a ? 'LIVE' : 'OFFLINE', { sub: a ? 'ONLINE' : 'OFFLINE' }); }
  catch { set(bt, 'OFFLINE', { sub: 'OFFLINE' }); }
}

/* ================= DEMO MODE (global; default OFF) ================= */
let demoTimer = null, demoEv = null, tt = 0;
function setDemo(on) {
  S.demo = on; $('#demobanner').hidden = !on; $('#demoBtn').textContent = 'DEMO MODE: ' + (on ? 'ON' : 'OFF'); $('#demoBtn').classList.toggle('on', on);
  clearInterval(demoTimer); clearInterval(demoEv);
  if (on) {
    demoTimer = setInterval(() => { tt += .05; const s = 45 + 40 * Math.sin(tt);
      set(veh, 'DEMO', { speed: s, rpm: 900 + s * 28, fuel: 62, coolant: 195, voltage: 14.1, engine: 'RUNNING', obd: 'SIMULATED' }); set(rf, 'DEMO', {}); }, 250);
    demoEv = setInterval(() => emit('DEMO', 'SIMULATED EVENT', 'demo generator', 'DEMO'), 20000);
  } else { Object.keys(veh.data).forEach(k => veh.data[k] = null); set(veh, 'OFFLINE'); set(rf, 'OFFLINE'); }
  emit('SYSTEM', 'DEMO MODE ' + (on ? 'ENABLED — simulated data labelled DEMO' : 'DISABLED'), 'user', on ? 'DEMO' : 'INFO');
}

/* ================= RENDER ================= */
const B = (ds, pre = '') => `<span class="b ${cls(ds.status)}">${pre}${ds.status}</span><small class="upd">${ds.timestamp ? 'UPDATED ' + hms(ds.timestamp) : 'NO DATA YET'}${ds.note ? ' · ' + ds.note : ''}</small>`;
const live = ds => ds.status === 'LIVE' || ds.status === 'DEMO';
const V = (ds, x, d = 0, u = '') => x != null && !Number.isNaN(x)
  ? `<b class="${live(ds) ? '' : 'old'}">${typeof x === 'number' ? x.toFixed(d) : x}${u}</b>`
  : `<b class="na">${live(ds) ? 'N/A' : ds.status === 'NOT CONFIGURED' ? 'NOT CONFIGURED' : 'OFFLINE'}</b>`;
const it = (l, v) => `<div class="it"><small>${l}</small>${v}</div>`;
const row = (a, b) => `<div class="row"><div>${a}</div><small>${b}</small></div>`;
const quakes = () => { const p = pos(); return !quake.data.feed || !p ? null : quake.data.feed.map(q => ({ ...q, d: km(p, q), b: brg(p, q) })).filter(q => q.d <= S.range).sort((a, b) => b.time - a.time); };

function render() {
  if (gps.status === 'LIVE' && Date.now() - gps.timestamp > 60000) set(gps, 'OFFLINE', null, 'no update >60 s (showing last known)');
  const G = gps.data, V0 = veh.data, p = pos();
  for (const [id, ds, pre] of [['veh', veh], ['gps', gps, 'GPS: '], ['sat', sat], ['quake', quake], ['wx', wx], ['air', air], ['mkt', mkt], ['rf', rf], ['net', net], ['bt', bt]]) $('#b_' + id).innerHTML = B(ds, pre);
  $('#b_pub').innerHTML = B(alerts);
  $('#spd').textContent = V0.speed == null ? '—' : Math.round(V0.speed);
  $('#arc').style.strokeDasharray = `${415 * Math.min((V0.speed || 0) / 140, 1)} 553`;
  $('#gpsspd').textContent = gps.status === 'LIVE' && G.speed != null ? `GPS SPEED ${(G.speed * 2.237).toFixed(0)} MPH · LIVE` : '';
  $('#tele').innerHTML = [['RPM', V(veh, V0.rpm)], ['FUEL', V(veh, V0.fuel, 0, '%')], ['COOLANT', V(veh, V0.coolant, 0, '°F')], ['BATTERY', V(veh, V0.voltage, 1, ' V')], ['ENGINE', V(veh, V0.engine)], ['OBD', V(veh, V0.obd)]].map(a => it(...a)).join('');
  $('#geo').innerHTML = [['LATITUDE', V(gps, G.lat, 5, '°')], ['LONGITUDE', V(gps, G.lon, 5, '°')], ['ACCURACY', V(gps, G.acc, 0, ' m')], ['ALTITUDE', V(gps, G.alt, 0, ' m')], ['HEADING', V(gps, G.heading, 0, '°')],
    ['SPEED', V(gps, G.speed == null ? null : G.speed * 2.237, 0, ' mph')], ['MOVEMENT', V(gps, G.speed == null ? null : G.speed > .8 ? 'MOVING' : 'STATIONARY')], ['LOCAL TIME', `<b>${hms(Date.now())}</b>`]].map(a => it(...a)).join('');
  const up = sat.data.up || [];
  $('#satlist').innerHTML = row(`<b>${sat.data.count ?? '—'} TRACKED</b> · ${p ? up.length + ' ABOVE HORIZON (calculated)' : 'ABOVE HORIZON: needs GPS'}`, sat.timestamp ? 'catalog ' + hms(sat.timestamp) : 'no catalog') +
    up.slice(0, 6).map(s => row(`<b>${s.name}</b> · NORAD ${s.norad}`, `EL ${s.el.toFixed(0)}° AZ ${s.az.toFixed(0)}° · ~${s.alt.toFixed(0)} km`)).join('');
  const q = quakes();
  $('#eq').innerHTML = !quake.data.feed ? row('NO DATA', quake.status) : !p ? row('NEEDS GPS to filter by distance', `${quake.data.feed.length} events worldwide (7 d)`) :
    (q.length ? q.slice(0, 6).map(e => row(`<b>M${(e.mag ?? 0).toFixed(1)}</b> · ${e.d.toFixed(0)} km ${dir8(e.b)} · depth ${e.depth.toFixed(0)} km<br>${e.place}`, `${new Date(e.time).toLocaleString('en-GB')} · <a target="_blank" rel="noopener noreferrer" href="${e.url}">USGS</a>`)).join('') : row('NO RECENT EVENTS', `within ${S.range} km · last 7 days`));
  const W = wx.data;
  $('#wx').innerHTML = [['TEMP', V(wx, W.temp, 0, '°F')], ['CONDITIONS', V(wx, W.code == null ? null : WMO[W.code] || 'Code ' + W.code)], ['WIND', V(wx, W.wind, 0, ' mph ' + (W.wdir != null ? dir8(W.wdir) : ''))],
    ['HUMIDITY', V(wx, W.hum, 0, '%')], ['VISIBILITY', V(wx, W.vis == null ? null : W.vis / 1609, 1, ' mi')], ['SOURCE', `<b style="font-size:11px">${wx.source}</b>`]].map(a => it(...a)).join('');
  const al = alerts.data.list, sp = space.data;
  $('#pub').innerHTML = (al ? (al.length ? al.map(a => row(`<b>${a.ev}</b> · ${a.sev}<br>${a.head}`, 'NOAA / NWS')).join('') : row('NO ACTIVE NWS ALERTS', alerts.source)) : row('ALERTS: ' + alerts.status, alerts.note || alerts.source)) +
    row(sp.G == null ? 'SPACE WEATHER: ' + space.status : `SPACE WEATHER · Geomagnetic G${sp.G} · Radiation S${sp.S} · Radio R${sp.R}`, 'NOAA SWPC' + (space.timestamp ? ' · ' + hms(space.timestamp) : ''));
  $('#air').innerHTML = air.status === 'NOT CONFIGURED' ? row('AIRCRAFT SENSOR: NOT CONFIGURED', 'see CONFIG.AIRCRAFT_URL') : !air.data.list ? row('AIRCRAFT DATA: ' + air.status, air.note) :
    (air.data.list.length ? air.data.list.slice(0, 8).map(a => row(`<b>${a.callsign || 'N/A'}</b> ${a.type || ''} · ${a.alt_ft ?? 'N/A'} ft · ${a.gs_kt ?? 'N/A'} kt · hdg ${a.track ?? 'N/A'}°`, `${a.d.toFixed(0)} km ${dir8(a.b)} · ${a.seen_s ?? '?'} s ago`)).join('') + row('', 'SOURCE: ' + air.source) : row('NO AIRCRAFT REPORTED', air.source));
  $('#mkt').innerHTML = !mkt.data.quotes ? row(mkt.status === 'NOT CONFIGURED' ? 'MARKET DATA: OFFLINE (NOT CONFIGURED)' : 'MARKET DATA: ' + mkt.status, mkt.note || 'see CONFIG.MARKET_URL') :
    mkt.data.quotes.map(x => row(`<b>${x.symbol}</b> ${x.price}`, `${x.changePct >= 0 ? '▲' : '▼'} ${x.changePct}% · ${x.state || ''} · ${x.ts ? hms(x.ts) : ''}`)).join('') + row('', 'SOURCE: ' + mkt.source);
  $('#net').innerHTML = [['CONNECTION', `<b>${net.status === 'LIVE' ? 'ONLINE' : 'OFFLINE'}</b>`], ['INTERFACE', V(net, net.data.iface)], ['LOCAL IP', '<b class="na">OFFLINE</b>'], ['LATENCY', V(net, net.data.rtt, 0, ' ms est.')]].map(a => it(...a)).join('');
  $('#bt').innerHTML = it('SUBSYSTEM', V(bt, bt.data.sub)) + it('KNOWN DEVICES', '<b class="na">N/A</b>') + it('OBD ADAPTER', `<b class="${bt.data.obd ? '' : 'na'}">${bt.data.obd ? 'DETECTED' : 'NOT DETECTED'}</b>`);
  const rows = [['GPS', gps], ['MAP', mapS], ['SATELLITES', sat], ['EARTHQUAKES', quake], ['WEATHER', wx], ['ALERTS', alerts], ['SPACE WX', space], ['AIRCRAFT', air], ['MARKET', mkt], ['OBD', veh], ['RF', rf], ['NETWORK', net], ['BLUETOOTH', bt]];
  $('#src').innerHTML = rows.map(([n, d]) => row(`<span class="${cls(d.status)}"><span class="dot"></span>${n}</span> ${d.status} · ${d.source}`, d.timestamp ? 'UPDATED ' + hms(d.timestamp) : '—')).join('');
  if (!$('#awr').hidden) $('#legend').innerHTML = [['USER', gps], ['AIRCRAFT', air], ['SATELLITES', sat], ['EARTHQUAKES', quake], ['WEATHER', wx], ['ALERTS', alerts]].map(([n, d]) => row(`${n}: ${d.status}`, d.source)).join('');
}

/* ================= MAP (Leaflet + OpenStreetMap, no API key) ================= */
let M, L_ = {}, fitted = false;
function mapInit() {
  if (!window.L) return set(mapS, 'OFFLINE', null, 'Leaflet not loaded (offline?)');
  M = L.map('lmap').setView([39, -98], 4);
  const tl = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(M);
  tl.on('load', () => set(mapS, 'LIVE', {})); tl.on('tileerror', () => set(mapS, 'ERROR', null, 'tiles unavailable'));
  for (const k of ['radius', 'user', 'quakes', 'sats', 'aircraft', 'weather']) L_[k] = L.layerGroup().addTo(M);
  M.on('dragstart', () => { S.follow = false; syncUI(); });
}
function mapDraw(force) {
  const p = pos(); if (!M || !p || ($('#awr').hidden && !force)) return;
  Object.values(L_).forEach(l => l.clearLayers());
  const ll = [p.lat, p.lon], warn = S.layers.alerts && (alerts.data.list || []).length;
  L.circle(ll, { radius: S.radius * 1000, color: warn ? '#c4636a' : '#3b82f6', weight: 1, dashArray: '4', fill: false }).addTo(L_.radius);
  if (S.layers.user) {
    L.circle(ll, { radius: gps.data.acc || 0, color: '#37c8e0', weight: 1, fillOpacity: .12 }).addTo(L_.user);
    L.marker(ll, { icon: L.divIcon({ className: 'veh', html: `<div style="transform:rotate(${gps.data.heading || 0}deg)">▲</div>`, iconSize: [24, 24] }) }).addTo(L_.user).bindTooltip('YOU · GPS ' + gps.status);
  }
  if (S.layers.quakes) (quakes() || []).filter(q => q.d <= S.radius).forEach(q => L.circleMarker([q.lat, q.lon], { radius: 3 + (q.mag || 0) * 2, color: '#e0b341', weight: 1 }).addTo(L_.quakes).bindTooltip(`M${(q.mag || 0).toFixed(1)} ${q.place} (USGS)`));
  if (S.layers.sats) (sat.data.up || []).slice(0, 12).forEach(s => L.circleMarker([s.lat, s.lon], { radius: 3, color: '#3b82f6' }).addTo(L_.sats).bindTooltip(`${s.name} — calculated sub-satellite point (CelesTrak/SGP4)`));
  if (S.layers.aircraft) (air.data.list || []).filter(a => a.d <= S.radius).forEach(a => L.circleMarker([a.lat, a.lon], { radius: 4, color: '#34d399' }).addTo(L_.aircraft).bindTooltip(`${a.callsign || 'N/A'} (${air.source})`));
  if (S.layers.weather && wx.data.temp != null) L.marker([p.lat + .01, p.lon], { icon: L.divIcon({ className: 'veh', html: `<small>${Math.round(wx.data.temp)}°F</small>`, iconSize: [40, 20] }) }).addTo(L_.weather).bindTooltip('Open-Meteo');
  if (!fitted) { M.fitBounds(L.circle(ll, { radius: S.radius * 1000 }).getBounds()); fitted = true; } else if (S.follow) M.panTo(ll, { animate: false });
}

/* ================= CANVAS: sky plot + RF ================= */
const [sx, sw, sh] = (c => [c.getContext('2d'), c.width, c.height])($('#sat'));
const [px, pw, ph] = (c => [c.getContext('2d'), c.width, c.height])($('#spec')), wc = $('#wf'), wx2 = wc.getContext('2d');
function drawSky() {
  sx.clearRect(0, 0, sw, sh); const cx = sw / 2, cy = sh / 2, R = sh / 2 - 12; sx.strokeStyle = '#2a3441'; sx.fillStyle = '#7d8b9b'; sx.font = '10px system-ui';
  [1, .66, .33].forEach(f => { sx.beginPath(); sx.arc(cx, cy, R * f, 0, 7); sx.stroke(); }); sx.fillText('N', cx - 3, cy - R - 2); sx.fillText('E', cx + R + 2, cy + 3);
  if (!pos() || !recs.length) { sx.fillText(!pos() ? 'SKY PLOT: NEEDS GPS' : 'SATELLITE DATA: ' + sat.status, cx - 60, cy); return; }
  (sat.data.up || []).slice(0, 15).forEach(s => { const r = R * (1 - s.el / 90), x = cx + r * Math.sin(rad(s.az)), y = cy - r * Math.cos(rad(s.az));
    sx.fillStyle = '#37c8e0'; sx.beginPath(); sx.arc(x, y, 3.5, 0, 7); sx.fill(); sx.fillStyle = '#7d8b9b'; sx.fillText(s.name.slice(0, 14), x + 6, y + 3); });
}
const NB = 256, F0 = 400, F1 = 500, peaks = [[.2, 14], [.47, 22], [.71, 9]]; let rt = 0;
function drawRF() { // DEMO ONLY: synthetic. A real SDR replaces rf.data.bins.
  px.clearRect(0, 0, pw, ph); px.fillStyle = '#7d8b9b'; px.font = '12px system-ui';
  if (!S.demo && !live(rf)) { px.fillText('RF SENSOR: OFFLINE — NO SDR CONNECTED', 14, ph / 2); return; }
  rt += .03; const b = rf.data.bins || Array.from({ length: NB }, (_, i) => { let d = -100 + Math.random() * 6; for (const [c, a] of peaks) d += a * 2.2 * Math.exp(-(((i / NB) - c - Math.sin(rt + c * 9) * .003) ** 2) / 2e-5); return d; });
  px.strokeStyle = '#37c8e0'; px.beginPath(); b.forEach((d, i) => { const x = i / NB * pw, y = ph - (d + 105) / 60 * ph; i ? px.lineTo(x, y) : px.moveTo(x, y); }); px.stroke();
  px.fillText(S.demo ? 'RF SENSOR: DEMO / NO SDR CONNECTED' : 'RF SENSOR', 8, 14);
  b.forEach((d, i) => { if (d > -80 && d >= b[i - 1] && d >= b[i + 1]) { px.fillStyle = '#34d399'; px.fillRect(i / NB * pw - 2, ph - (d + 105) / 60 * ph - 7, 4, 4); } });
  wx2.drawImage(wc, 0, 1); b.forEach((d, i) => { wx2.fillStyle = `hsl(205 90% ${Math.max(4, Math.min(65, (d + 100) * 1.6 + 6))}%)`; wx2.fillRect(i / NB * wc.width, 0, wc.width / NB + 1, 1); });
}

/* ================= UI WIRING ================= */
const OSINT = { 'Maps': [['OpenStreetMap', 'https://www.openstreetmap.org'], ['USGS National Map', 'https://apps.nationalmap.gov/viewer/']], 'Satellite imagery': [['NASA Worldview', 'https://worldview.earthdata.nasa.gov'], ['Copernicus Browser', 'https://browser.dataspace.copernicus.eu']],
  'Weather': [['National Weather Service', 'https://www.weather.gov'], ['Windy', 'https://www.windy.com']], 'Aviation': [['FAA NAS Status', 'https://nasstatus.faa.gov'], ['OpenSky Network', 'https://opensky-network.org']],
  'Maritime': [['NOAA Charts', 'https://charts.noaa.gov'], ['MarineTraffic', 'https://www.marinetraffic.com']], 'Public infrastructure': [['HIFLD Open Data', 'https://hifld-geoplatform.hub.arcgis.com'], ['OpenInfraMap', 'https://openinframap.org']],
  'Emergency / public info': [['FEMA', 'https://www.fema.gov'], ['Ready.gov', 'https://www.ready.gov'], ['NWS Alerts', 'https://alerts.weather.gov']], 'Astronomy': [['Heavens-Above', 'https://www.heavens-above.com'], ['CelesTrak', 'https://celestrak.org']],
  'Cybersecurity': [['CISA KEV', 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog'], ['NVD', 'https://nvd.nist.gov'], ['MITRE ATT&CK', 'https://attack.mitre.org']] };
$('#osint').innerHTML = Object.entries(OSINT).map(([c, ls]) => `<details><summary>${c.toUpperCase()}</summary><div>` + ls.map(([n, u]) => `<a class="l" target="_blank" rel="noopener noreferrer" href="${u}">${n}<span>${new URL(u).host}</span></a>`).join('') + '</div></details>').join('');
$('#ctl').innerHTML = Object.keys(S.layers).map(k => `<label class="chk"><input type="checkbox" data-l="${k}" checked> ${k.toUpperCase()}</label>`).join('') +
  '<span class="seg">' + [10, 25, 50, 100].map(r => `<button data-r="${r}">${r} km</button>`).join('') + '<button id="follow">FOLLOW GPS: ON</button></span>';
$('#eqctl').innerHTML = [10, 50, 100, 500].map(r => `<button data-q="${r}">${r} km</button>`).join('');
function syncUI() {
  $('#follow').textContent = 'FOLLOW GPS: ' + (S.follow ? 'ON' : 'OFF'); $('#follow').classList.toggle('on', S.follow);
  document.querySelectorAll('[data-r]').forEach(b => b.classList.toggle('on', +b.dataset.r === S.radius));
  document.querySelectorAll('[data-q]').forEach(b => b.classList.toggle('on', +b.dataset.q === S.range));
  $('#shareBtn').textContent = 'LOCATION SHARING: ' + (S.share ? 'ON' : 'OFF'); $('#shareBtn').classList.toggle('on', S.share);
  $('#awsrc').textContent = 'radius ' + S.radius + ' km';
}
document.addEventListener('click', e => { const d = e.target.dataset || {};
  if (d.r) { S.radius = +d.r; mapDraw(true); aircraftService(); } if (d.q) S.range = +d.q;
  if (e.target.id === 'follow') { S.follow = !S.follow; mapDraw(true); } syncUI(); });
$('#ctl').addEventListener('change', e => { if (e.target.dataset.l) { S.layers[e.target.dataset.l] = e.target.checked ? 1 : 0; mapDraw(true); } });
$('#demoBtn').onclick = () => setDemo(!S.demo);
$('#shareBtn').onclick = () => { S.share = !S.share; syncUI();
  emit('PRIVACY', S.share ? 'LOCATION SHARING ON — coarse (~1 km) coordinates will be sent to open-meteo.com, api.weather.gov' + (CONFIG.AIRCRAFT_URL ? ' and your aircraft proxy' : '') : 'LOCATION SHARING OFF — no location leaves the device', 'user', S.share ? 'WARN' : 'INFO');
  weatherService(); aircraftService(); };
const tab = a => { $('#con').hidden = a; $('#awr').hidden = !a; $('#tabC').classList.toggle('on', !a); $('#tabA').classList.toggle('on', a); if (a && M) setTimeout(() => { M.invalidateSize(); mapDraw(true); }, 50); };
$('#tabC').onclick = () => tab(false); $('#tabA').onclick = () => tab(true);

const steps = [['SYSTEM INITIALIZED', () => {}], ['VEHICLE PROFILE LOADED: 2024 CHEVROLET MALIBU', () => {}], ['GPS SERVICE START', gpsService], ['MAP SERVICE START', mapInit],
  ['SATELLITE CATALOG REQUEST (CelesTrak)', satService], ['USGS FEED REQUEST', quakeService], ['SPACE WEATHER REQUEST (NOAA SWPC)', spaceService], ['WEATHER/ALERTS: AWAITING GPS + LOCATION SHARING', weatherService],
  ['AIRCRAFT SENSOR CHECK', aircraftService], ['MARKET DATA CHECK', marketService], ['NETWORK STATUS CHECK', pollNet], ['BLUETOOTH SUBSYSTEM CHECK', startBT], ['OBD INTERFACE OFFLINE — NO ADAPTER', () => {}], ['RF SENSOR OFFLINE — NO SDR', () => {}]];
let i = 0; (function boot() {
  if (i < steps.length) { $('#bootlog').textContent += '> ' + steps[i][0] + '\n'; emit('SYSTEM', steps[i][0], 'local', 'INFO'); try { steps[i][1](); } catch (e) { emit('SYSTEM', 'MODULE ERROR ' + e.message, 'local', 'ERROR'); } i++; return setTimeout(boot, 220); }
  setTimeout(() => $('#boot').classList.add('off'), 400);
})();
syncUI();
setInterval(render, 1000); setInterval(() => { satCalc(); mapDraw(); drawSky(); }, 3000); setInterval(drawRF, 150); setInterval(pollNet, 5000);
setInterval(quakeService, 900000); setInterval(spaceService, 900000); setInterval(satService, 7200000);
setInterval(() => { weatherService(); marketService(); }, 600000); setInterval(aircraftService, 15000);
addEventListener('online', () => emit('NETWORK', 'ONLINE', net.source, 'LIVE')); addEventListener('offline', () => emit('NETWORK', 'OFFLINE', net.source, 'OFFLINE'));
