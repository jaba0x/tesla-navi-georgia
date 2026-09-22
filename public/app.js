/* GeoDrive — frontend
 * Map: MapLibre GL + OpenFreeMap vector tiles (OpenStreetMap data)
 * Search + routing go through our Worker (/api/search, /api/route)
 * Road updates come from /updates.json
 */
(() => {
  'use strict';

  const STYLES = {
    day: 'https://tiles.openfreemap.org/styles/liberty',
    night: 'https://tiles.openfreemap.org/styles/dark',
  };
  const TBILISI = [44.7930, 41.7151];
  const UPDATE_COLORS = {
    closure: '#d1242f',
    works: '#fb8500',
    hazard: '#bf8700',
    charger: '#1a7f37',
    info: '#1f6feb',
  };
  const OFF_ROUTE_METERS = 80;
  const REROUTE_COOLDOWN_MS = 15000;
  const STEP_ADVANCE_METERS = 25;

  const $ = (id) => document.getElementById(id);
  const state = {
    theme: localGet('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'day'),
    position: null, // { lon, lat, heading, speed, accuracy }
    follow: true,
    destination: null, // { lon, lat, name }
    route: null, // OSRM route object
    stepIndex: 0,
    lastReroute: 0,
    updates: [],
  };

  // ---------------------------------------------------------------- map
  document.body.classList.toggle('night', state.theme === 'night');

  const map = new maplibregl.Map({
    container: 'map',
    style: STYLES[state.theme],
    center: TBILISI,
    zoom: 12,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

  map.on('style.load', addOverlays);
  map.on('dragstart', () => setFollow(false));

  function addOverlays() {
    if (!map.getSource('route')) {
      map.addSource('route', { type: 'geojson', data: emptyFC() });
      map.addLayer({
        id: 'route-casing', type: 'line', source: 'route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#0b3d91', 'line-width': 11 },
      });
      map.addLayer({
        id: 'route-line', type: 'line', source: 'route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#3b8cff', 'line-width': 7 },
      });
    }
    if (!map.getSource('updates')) {
      map.addSource('updates', { type: 'geojson', data: updatesFC() });
      map.addLayer({
        id: 'updates-halo', type: 'circle', source: 'updates',
        paint: { 'circle-radius': 16, 'circle-color': ['get', 'color'], 'circle-opacity': 0.25 },
      });
      map.addLayer({
        id: 'updates-dot', type: 'circle', source: 'updates',
        paint: {
          'circle-radius': 9, 'circle-color': ['get', 'color'],
          'circle-stroke-color': '#fff', 'circle-stroke-width': 3,
        },
      });
    }
    if (state.route) drawRoute(state.route);
  }

  // Tap on an update marker → details. Tap elsewhere → "Route here".
  map.on('click', (e) => {
    const hits = map.queryRenderedFeatures(e.point, { layers: ['updates-dot', 'updates-halo'] });
    if (hits.length) {
      const u = state.updates.find((x) => x.id === hits[0].properties.id);
      if (u) showUpdatePopup(u);
      return;
    }
    const { lng, lat } = e.lngLat;
    const el = document.createElement('div');
    el.innerHTML = `<div class="popup-title">Dropped pin</div>
      <div class="small muted">${lat.toFixed(5)}, ${lng.toFixed(5)}</div>
      <button class="popup-btn">Route here</button>`;
    const popup = new maplibregl.Popup({ closeButton: true }).setLngLat(e.lngLat).setDOMContent(el).addTo(map);
    el.querySelector('button').onclick = () => {
      popup.remove();
      setDestination({ lon: lng, lat, name: 'Dropped pin' });
    };
  });
  map.on('mouseenter', 'updates-dot', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'updates-dot', () => (map.getCanvas().style.cursor = ''));

  // ---------------------------------------------------------------- GPS
  const meEl = document.createElement('div');
  meEl.className = 'me';
  meEl.innerHTML = '<div class="heading" hidden></div>';
  const meMarker = new maplibregl.Marker({ element: meEl, rotationAlignment: 'map' });

  if ('geolocation' in navigator) {
    navigator.geolocation.watchPosition(onPosition, onPositionError, {
      enableHighAccuracy: true, maximumAge: 2000, timeout: 20000,
    });
  } else {
    toast('Location is not available in this browser');
  }

  function onPosition(p) {
    const first = !state.position;
    const { longitude: lon, latitude: lat, heading, speed, accuracy } = p.coords;
    state.position = { lon, lat, heading, speed, accuracy };

    meMarker.setLngLat([lon, lat]).addTo(map);
    const hasHeading = Number.isFinite(heading) && speed > 1;
    meEl.querySelector('.heading').hidden = !hasHeading;
    if (hasHeading) meMarker.setRotation(heading);

    if (state.follow) {
      map.easeTo({
        center: [lon, lat],
        zoom: first ? 15 : map.getZoom(),
        duration: first ? 0 : 800,
      });
    }
    if (state.route) trackProgress();
  }

  function onPositionError(err) {
    if (err.code === 1) toast('Allow location access to see where you are');
    else toast('Waiting for GPS…');
  }

  function setFollow(on) {
    state.follow = on;
    $('followBtn').classList.toggle('active', on);
    if (on && state.position) map.easeTo({ center: [state.position.lon, state.position.lat], zoom: Math.max(map.getZoom(), 15) });
  }
  $('followBtn').onclick = () => setFollow(!state.follow);
  setFollow(true);

  // ---------------------------------------------------------------- search
  const input = $('searchInput');
  const results = $('searchResults');
  let searchTimer = null;
  let searchSeq = 0;

  input.addEventListener('input', () => {
    $('clearSearch').hidden = !input.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 350);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { clearTimeout(searchTimer); runSearch(); }
    if (e.key === 'Escape') closeSearch();
  });
  $('clearSearch').onclick = () => { input.value = ''; closeSearch(); input.focus(); };

  async function runSearch() {
    const q = input.value.trim();
    if (q.length < 2) { results.hidden = true; return; }
    const seq = ++searchSeq;
    const c = state.position || { lon: map.getCenter().lng, lat: map.getCenter().lat };
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&lat=${c.lat}&lon=${c.lon}&lang=en`);
      const data = await res.json();
      if (seq !== searchSeq) return; // a newer search is in flight
      renderResults(data.features || []);
    } catch {
      toast('Search failed — check your connection');
    }
  }

  function renderResults(features) {
    results.innerHTML = '';
    if (!features.length) {
      results.innerHTML = '<li class="muted">No results</li>';
    }
    for (const f of features) {
      const p = f.properties || {};
      const name = p.name || [p.street, p.housenumber].filter(Boolean).join(' ') || 'Unnamed place';
      const sub = [p.street && p.name ? p.street : null, p.city || p.town || p.village, p.county || p.state]
        .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
      const li = document.createElement('li');
      li.tabIndex = 0;
      li.innerHTML = `<div class="r-name"></div><div class="r-sub"></div>`;
      li.querySelector('.r-name').textContent = name;
      li.querySelector('.r-sub').textContent = sub;
      const [lon, lat] = f.geometry.coordinates;
      li.onclick = () => {
        input.value = name;
        closeSearch(true);
        setDestination({ lon, lat, name });
      };
      results.appendChild(li);
    }
    results.hidden = false;
  }

  function closeSearch(keepText) {
    results.hidden = true;
    if (!keepText) $('clearSearch').hidden = !input.value;
    input.blur();
  }

  // ---------------------------------------------------------------- routing
  const destMarker = new maplibregl.Marker({ color: '#d1242f' });

  async function setDestination(dest) {
    state.destination = dest;
    destMarker.setLngLat([dest.lon, dest.lat]).addTo(map);
    await requestRoute(true);
  }

  async function requestRoute(fitView) {
    const d = state.destination;
    if (!d) return;
    let origin = state.position;
    if (!origin) {
      const c = map.getCenter();
      origin = { lon: c.lng, lat: c.lat };
      toast('No GPS yet — routing from the map center');
    }
    try {
      const res = await fetch(`/api/route?from=${origin.lon},${origin.lat}&to=${d.lon},${d.lat}`);
      const data = await res.json();
      if (!res.ok || data.code !== 'Ok' || !data.routes?.length) {
        toast(data.error || data.message || 'No route found');
        return;
      }
      state.route = data.routes[0];
      state.stepIndex = 0;
      state.lastReroute = Date.now();
      drawRoute(state.route);
      renderRoutePanel();
      if (fitView) {
        setFollow(false);
        fitToRoute(state.route);
      }
    } catch {
      toast('Routing failed — check your connection');
    }
  }

  function drawRoute(route) {
    const src = map.getSource('route');
    if (src) src.setData({ type: 'Feature', geometry: route.geometry, properties: {} });
  }

  function fitToRoute(route) {
    const b = new maplibregl.LngLatBounds();
    route.geometry.coordinates.forEach((c) => b.extend(c));
    const panel = $('routePanel').getBoundingClientRect();
    map.fitBounds(b, { padding: { top: 100, bottom: 60, right: 100, left: innerWidth > 900 ? panel.width + 40 : 40 }, maxZoom: 16 });
  }

  function endRoute() {
    state.route = null;
    state.destination = null;
    destMarker.remove();
    const src = map.getSource('route');
    if (src) src.setData(emptyFC());
    $('routePanel').hidden = true;
    input.value = '';
    $('clearSearch').hidden = true;
  }
  $('endRoute').onclick = endRoute;
  $('stepsToggle').onclick = () => { $('stepsList').hidden = !$('stepsList').hidden; };

  function allSteps() {
    return state.route ? state.route.legs.flatMap((l) => l.steps) : [];
  }

  function renderRoutePanel() {
    const r = state.route;
    const eta = new Date(Date.now() + r.duration * 1000);
    $('routeEta').textContent = eta.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('routeDist').textContent = fmtDist(r.distance);
    $('routeTime').textContent = fmtDuration(r.duration);

    const list = $('stepsList');
    list.innerHTML = '';
    allSteps().forEach((s, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="s-arrow"></span><span class="s-text"></span><span class="s-dist"></span>`;
      li.querySelector('.s-arrow').textContent = arrowFor(s.maneuver);
      li.querySelector('.s-text').textContent = instruction(s);
      li.querySelector('.s-dist').textContent = s.distance ? fmtDist(s.distance) : '';
      li.onclick = () => { setFollow(false); map.easeTo({ center: s.maneuver.location, zoom: 17 }); };
      if (i === state.stepIndex) li.classList.add('current');
      list.appendChild(li);
    });
    updateNextStep();
    $('routePanel').hidden = false;
  }

  function updateNextStep() {
    const steps = allSteps();
    // The "next" maneuver is the one after the step we are currently driving on
    const next = steps[Math.min(state.stepIndex + 1, steps.length - 1)] || steps[0];
    if (!next) return;
    $('nextArrow').textContent = arrowFor(next.maneuver);
    $('nextInstr').textContent = instruction(next);
    const d = state.position
      ? haversine([state.position.lon, state.position.lat], next.maneuver.location)
      : steps[state.stepIndex]?.distance || 0;
    $('nextDist').textContent = fmtDist(d);
    [...$('stepsList').children].forEach((li, i) => li.classList.toggle('current', i === state.stepIndex));
  }

  // Advance through steps and re-route when we leave the line.
  function trackProgress() {
    const pos = [state.position.lon, state.position.lat];
    const steps = allSteps();

    const next = steps[state.stepIndex + 1];
    if (next && haversine(pos, next.maneuver.location) < STEP_ADVANCE_METERS) {
      state.stepIndex++;
      if (steps[state.stepIndex].maneuver.type === 'arrive') {
        toast('You have arrived');
        endRoute();
        return;
      }
    }
    updateNextStep();

    const off = distanceToLine(pos, state.route.geometry.coordinates);
    const accuracy = state.position.accuracy || 0;
    if (off > OFF_ROUTE_METERS + accuracy && Date.now() - state.lastReroute > REROUTE_COOLDOWN_MS) {
      state.lastReroute = Date.now();
      toast('Re-routing…');
      requestRoute(false);
    }
  }

  // ---------------------------------------------------------------- road updates
  async function loadUpdates() {
    try {
      const res = await fetch('/updates.json', { cache: 'no-cache' });
      const data = await res.json();
      state.updates = data.items || [];
      $('updatesMeta').textContent = data.updated
        ? `Last updated ${new Date(data.updated).toLocaleString()}`
        : '';
      renderUpdates();
    } catch {
      $('updatesMeta').textContent = 'Could not load road updates';
    }
  }

  function renderUpdates() {
    const src = map.getSource('updates');
    if (src) src.setData(updatesFC());
    const list = $('updatesList');
    list.innerHTML = '';
    for (const u of state.updates) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="u-dot"></span><div><div class="u-title"></div><div class="u-desc"></div></div>`;
      li.querySelector('.u-dot').style.background = UPDATE_COLORS[u.type] || UPDATE_COLORS.info;
      const title = li.querySelector('.u-title');
      title.textContent = u.title;
      if (u.example) title.insertAdjacentHTML('beforeend', '<span class="badge">SAMPLE</span>');
      li.querySelector('.u-desc').textContent = u.description || '';
      li.onclick = () => {
        setFollow(false);
        map.flyTo({ center: [u.lon, u.lat], zoom: 14 });
        showUpdatePopup(u);
        if (innerWidth < 900) $('updatesPanel').hidden = true;
      };
      list.appendChild(li);
    }
  }

  function showUpdatePopup(u) {
    const el = document.createElement('div');
    el.innerHTML = `<div class="popup-title"></div><div class="p-desc"></div>
      <div class="small muted p-src"></div><button class="popup-btn">Route here</button>`;
    el.querySelector('.popup-title').textContent = u.title + (u.example ? ' (sample)' : '');
    el.querySelector('.p-desc').textContent = u.description || '';
    el.querySelector('.p-src').textContent = [u.source, u.updated && new Date(u.updated).toLocaleDateString()]
      .filter(Boolean).join(' · ');
    const popup = new maplibregl.Popup().setLngLat([u.lon, u.lat]).setDOMContent(el).addTo(map);
    el.querySelector('button').onclick = () => {
      popup.remove();
      setDestination({ lon: u.lon, lat: u.lat, name: u.title });
    };
  }

  function updatesFC() {
    return {
      type: 'FeatureCollection',
      features: state.updates.map((u) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [u.lon, u.lat] },
        properties: { id: u.id, color: UPDATE_COLORS[u.type] || UPDATE_COLORS.info },
      })),
    };
  }

  $('updatesBtn').onclick = () => {
    const p = $('updatesPanel');
    p.hidden = !p.hidden;
    $('updatesBtn').classList.toggle('active', !p.hidden);
  };
  $('closeUpdates').onclick = () => { $('updatesPanel').hidden = true; $('updatesBtn').classList.remove('active'); };

  // ---------------------------------------------------------------- theme
  $('themeBtn').onclick = () => {
    state.theme = state.theme === 'day' ? 'night' : 'day';
    localSet('theme', state.theme);
    document.body.classList.toggle('night', state.theme === 'night');
    map.setStyle(STYLES[state.theme]); // overlays are re-added on style.load
  };

  // ---------------------------------------------------------------- text helpers
  function instruction(step) {
    const m = step.maneuver;
    const road = step.name || step.ref || '';
    const onto = road ? ` onto ${road}` : '';
    const mod = m.modifier || '';
    switch (m.type) {
      case 'depart': return `Head ${compass(m.bearing_after)}${road ? ` on ${road}` : ''}`;
      case 'arrive': return state.destination?.name ? `Arrive at ${state.destination.name}` : 'Arrive at destination';
      case 'turn':
      case 'end of road':
        return mod === 'uturn' ? `Make a U-turn${onto}` : `Turn ${mod}${onto}`;
      case 'continue':
      case 'new name':
        return mod && mod !== 'straight' ? `Keep ${mod}${onto}` : `Continue${road ? ` on ${road}` : ''}`;
      case 'merge': return `Merge ${mod}${onto}`;
      case 'on ramp': return `Take the ramp${mod ? ` on the ${mod}` : ''}${onto}`;
      case 'off ramp': return `Take the exit${mod ? ` on the ${mod}` : ''}${onto}`;
      case 'fork': return `Keep ${mod} at the fork${onto}`;
      case 'roundabout':
      case 'rotary':
      case 'roundabout turn':
        return m.exit ? `At the roundabout, take exit ${m.exit}${onto}` : `Enter the roundabout${onto}`;
      case 'exit roundabout':
      case 'exit rotary':
        return `Exit the roundabout${onto}`;
      default: return `${cap(m.type)} ${mod}${onto}`.trim();
    }
  }

  function arrowFor(m) {
    if (m.type === 'arrive') return '⚑';
    if (m.type.includes('roundabout') || m.type.includes('rotary')) return '↻';
    return ({
      uturn: '⤺', 'sharp left': '↰', left: '↰', 'slight left': '↖',
      straight: '↑', 'slight right': '↗', right: '↱', 'sharp right': '↱',
    })[m.modifier] || '↑';
  }

  function compass(deg) {
    const dirs = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
    return dirs[Math.round(((deg || 0) % 360) / 45) % 8];
  }

  function fmtDist(m) {
    if (m < 1000) return `${Math.round(m / 10) * 10} m`;
    return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
  }
  function fmtDuration(s) {
    const h = Math.floor(s / 3600);
    const min = Math.round((s % 3600) / 60);
    return h ? `${h} h ${min} min` : `${Math.max(min, 1)} min`;
  }
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

  // ---------------------------------------------------------------- geo helpers
  function haversine(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // Shortest distance (m) from point p to a polyline, using a local flat projection.
  function distanceToLine(p, coords) {
    const kx = 111320 * Math.cos(p[1] * Math.PI / 180), ky = 110540;
    let best = Infinity;
    for (let i = 0; i < coords.length - 1; i++) {
      const ax = (coords[i][0] - p[0]) * kx, ay = (coords[i][1] - p[1]) * ky;
      const bx = (coords[i + 1][0] - p[0]) * kx, by = (coords[i + 1][1] - p[1]) * ky;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const cx = ax + t * dx, cy = ay + t * dy;
      best = Math.min(best, Math.hypot(cx, cy));
    }
    return best;
  }

  // ---------------------------------------------------------------- misc
  function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3500);
  }

  function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function localSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

  // Deep link: /?to=lon,lat&name=Place — handy for sending a destination from your phone
  function openDeepLink() {
    const qs = new URLSearchParams(location.search);
    const to = (qs.get('to') || '').split(',').map(Number);
    if (to.length === 2 && to.every(Number.isFinite)) {
      const name = (qs.get('name') || 'Destination').slice(0, 80);
      input.value = name;
      $('clearSearch').hidden = false;
      setDestination({ lon: to[0], lat: to[1], name });
    }
  }

  loadUpdates();
  map.once('load', openDeepLink);
})();
