/* GeoDrive — frontend
 * Map: MapLibre GL + OpenFreeMap vector tiles (OpenStreetMap data)
 * Search, routing and elevation go through our Worker (/api/*)
 * Road updates come from /updates.json
 */
(() => {
  'use strict';

  const N = window.GeoNav;

  // Older car screens (for example a 2018 Model 3) only have WebGL 1. boot.js loads the
  // older map library for them; here we also drop the heavy parts: terrain, hill shading,
  // 3D buildings and the 60 fps camera. Everything else — search, routing, guidance — is the same.
  const LITE = window.GEODRIVE_GL === 1;
  const CAMERA_MS = LITE ? 100 : 0; // how often the camera may be redrawn

  const STYLES = {
    day: 'https://tiles.openfreemap.org/styles/liberty',
    night: 'https://tiles.openfreemap.org/styles/dark',
  };
  const TBILISI = [44.7930, 41.7151];
  const DEM_TILES = '/api/dem/{z}/{x}/{y}.png';
  const UPDATE_COLORS = {
    closure: '#d1242f', works: '#fb8500', hazard: '#bf8700',
    charger: '#1a7f37', info: '#1f6feb',
  };

  const NAV_PITCH = 58;
  const CAR_OFFSET = 0.18; // how far below the middle of the screen the car sits
  const OFF_ROUTE_METERS = 45;
  const ACCURACY_SLACK_MAX = 25;   // car GPS can claim 200 m of error; don't believe all of it
  const OFF_ROUTE_FIXES = 2;       // fixes in a row before we accept that we left the route
  const BACKSTEP_METERS = 25;      // smaller than this and it's jitter, not a correction
  const STEP_PASSED_METERS = 10;   // hold the instruction until the turn is behind us
  const REROUTE_COOLDOWN_MS = 12000;
  const ARRIVE_METERS = 25;
  const SPEAK_AT = [800, 200, 45]; // metres before a turn

  const $ = (id) => document.getElementById(id);
  const state = {
    theme: localGet('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'day'),
    view3d: LITE ? localGet('view3d') === 'on' : localGet('view3d') !== 'off',
    voice: localGet('voice') !== 'off',
    position: null,     // { lon, lat, heading, speed, accuracy }
    follow: true,
    destination: null,  // { lon, lat, name }
    nav: null,          // prepared route (see GeoNav.prepare)
    navigating: false,  // false while previewing a route, true after Start
    progress: null,     // { traveled, stepIndex, toNext, remaining, eta }
    lastReroute: 0,
    offRouteFixes: 0,
    spoken: new Set(),
    updates: [],
    sim: null,
  };

  // ---------------------------------------------------------------- map
  document.body.classList.toggle('night', state.theme === 'night');

  let map;
  try {
    map = new maplibregl.Map({
      container: 'map',
      style: STYLES[state.theme],
      center: TBILISI,
      zoom: 12,
      pitch: state.view3d ? 45 : 0,
      maxPitch: 75,
      attributionControl: { compact: true },
    });
  } catch (err) {
    if (window.geodriveFail) window.geodriveFail('The map could not start on this screen', String(err && err.message || err));
    return;
  }
  map.on('error', (e) => {
    const message = (e && e.error && e.error.message) || '';
    // Tile hiccups are normal; a WebGL or style failure means nothing will draw
    if (/webgl|context|style/i.test(message) && window.geodriveFail) {
      window.geodriveFail('The map could not draw on this screen', message);
    }
  });
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
  map.on('style.load', () => { window.geodriveMapReady = true; addOverlays(); });
  map.on('dragstart', () => setFollow(false));

  function addOverlays() {
    add3D();
    addRouteLayers();
    addUpdateLayers();
    if (state.nav) drawRoute();
  }

  function addRouteLayers() {
    if (map.getSource('route')) return;
    map.addSource('route-done', { type: 'geojson', data: emptyFC() });
    map.addSource('route', { type: 'geojson', data: emptyFC() });
    map.addSource('maneuvers', { type: 'geojson', data: emptyFC() });

    // The part already driven, dimmed
    map.addLayer({
      id: 'route-done', type: 'line', source: 'route-done',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#6b7683', 'line-width': lineWidth(9), 'line-opacity': 0.55 },
    });
    // The road ahead
    map.addLayer({
      id: 'route-casing', type: 'line', source: 'route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#0b3d91', 'line-width': lineWidth(14) },
    });
    map.addLayer({
      id: 'route-line', type: 'line', source: 'route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#3b8cff', 'line-width': lineWidth(9) },
    });
    // Direction arrows riding along the line
    map.addLayer({
      id: 'route-arrows', type: 'symbol', source: 'route',
      layout: {
        'symbol-placement': 'line', 'symbol-spacing': 110,
        'text-field': '▶', 'text-size': 15, 'text-keep-upright': false,
        'text-allow-overlap': true, 'text-rotation-alignment': 'map',
      },
      paint: { 'text-color': '#eaf2ff', 'text-halo-color': '#0b3d91', 'text-halo-width': 1 },
    });
    // A dot at every turn
    map.addLayer({
      id: 'maneuver-dots', type: 'circle', source: 'maneuvers',
      minzoom: 12,
      paint: {
        'circle-radius': 5, 'circle-color': '#fff',
        'circle-stroke-color': '#0b3d91', 'circle-stroke-width': 3,
      },
    });
  }

  // Thicker lines as you zoom in, so the route reads well both on an overview and up close
  function lineWidth(base) {
    return ['interpolate', ['linear'], ['zoom'], 8, base * 0.45, 14, base * 0.8, 18, base * 1.4];
  }

  function addUpdateLayers() {
    if (map.getSource('updates')) return;
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

  // ---------------------------------------------------------------- 3D view
  function add3D() {
    if (LITE) { // no terrain, shading or buildings on a low-power screen
      $('view3dBtn').classList.toggle('active', state.view3d);
      map.easeTo({ pitch: state.view3d ? 45 : 0, duration: 500 });
      return;
    }
    if (!map.getSource('dem')) {
      map.addSource('dem', {
        type: 'raster-dem', tiles: [DEM_TILES], tileSize: 256, maxzoom: 14,
        encoding: 'terrarium', attribution: 'Elevation: Mapzen / AWS Open Data',
      });
    }
    // A second copy of the same tiles: MapLibre renders better when terrain
    // and hill shading don't share one source
    if (!map.getSource('dem-shade')) {
      map.addSource('dem-shade', {
        type: 'raster-dem', tiles: [DEM_TILES], tileSize: 256, maxzoom: 14, encoding: 'terrarium',
      });
    }
    if (!map.getLayer('hills')) {
      const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol');
      map.addLayer({
        id: 'hills', type: 'hillshade', source: 'dem-shade',
        layout: { visibility: state.view3d ? 'visible' : 'none' },
        paint: {
          'hillshade-exaggeration': 0.45,
          'hillshade-shadow-color': state.theme === 'night' ? '#05070a' : '#4a4332',
        },
      }, firstSymbol && firstSymbol.id);
    }
    // The dark style has no 3D buildings of its own — add them
    if (!map.getLayer('building-3d') && map.getSource('openmaptiles')) {
      map.addLayer({
        id: 'building-3d', type: 'fill-extrusion', source: 'openmaptiles',
        'source-layer': 'building', minzoom: 14,
        layout: { visibility: state.view3d ? 'visible' : 'none' },
        paint: {
          'fill-extrusion-base': ['get', 'render_min_height'],
          'fill-extrusion-height': ['get', 'render_height'],
          'fill-extrusion-color': state.theme === 'night' ? '#2b323a' : 'hsl(35,8%,85%)',
          'fill-extrusion-opacity': 0.85,
        },
      });
    }
    setSky();
    apply3D();
  }

  function setSky() {
    if (!map.setSky) return;
    map.setSky(state.theme === 'night'
      // fog stays near the horizon: blended into the ground it greys out the road ahead
      ? { 'sky-color': '#0b1220', 'horizon-color': '#1b2735', 'fog-color': '#1b1f24', 'fog-ground-blend': 0, 'horizon-fog-blend': 0.2, 'sky-horizon-blend': 0.7 }
      : { 'sky-color': '#7ab6ef', 'horizon-color': '#d6e8fa', 'fog-color': '#eaf1f8', 'fog-ground-blend': 0, 'horizon-fog-blend': 0.25, 'sky-horizon-blend': 0.7 });
  }

  function apply3D() {
    if (LITE) {
      $('view3dBtn').classList.toggle('active', state.view3d);
      map.easeTo({ pitch: state.view3d ? 45 : 0, bearing: state.view3d ? map.getBearing() : 0, duration: 600 });
      return;
    }
    if (!map.getSource('dem')) return;
    for (const id of ['hills', 'building-3d']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', state.view3d ? 'visible' : 'none');
    }
    if (state.view3d) {
      updateTerrain();
      if (map.getPitch() < 20) map.easeTo({ pitch: state.nav ? NAV_PITCH : 45, duration: 700 });
    } else {
      map.setTerrain(null);
      map.easeTo({ pitch: 0, bearing: 0, duration: 700 });
    }
    $('view3dBtn').classList.toggle('active', state.view3d);
  }

  // Raised terrain only makes sense from a distance. Close up, with the camera
  // tilted just above the road, the hill the car is standing on fills the screen —
  // so below this zoom the ground goes flat and the hill shading carries the relief.
  const TERRAIN_MAX_ZOOM = 15.2;
  function updateTerrain() {
    const want = state.view3d && map.getZoom() < TERRAIN_MAX_ZOOM;
    const has = Boolean(map.getTerrain());
    if (want === has) return;
    // no exaggeration: with a tilted camera, exaggerated hills swallow the view
    map.setTerrain(want ? { source: 'dem', exaggeration: 1 } : null);
  }
  map.on('zoomend', updateTerrain);

  $('view3dBtn').onclick = () => {
    state.view3d = !state.view3d;
    localSet('view3d', state.view3d ? 'on' : 'off');
    apply3D();
    toast(state.view3d ? '3D view on' : '3D view off');
  };

  // ---------------------------------------------------------------- position
  const meEl = document.createElement('div');
  meEl.className = 'me';
  meEl.innerHTML = '<div class="me-dot"></div><div class="me-arrow"></div>';
  const meMarker = new maplibregl.Marker({
    element: meEl, rotationAlignment: 'map', pitchAlignment: 'map',
  });
  const destMarker = new maplibregl.Marker({ color: '#d1242f' });

  if ('geolocation' in navigator) {
    navigator.geolocation.watchPosition(
      (p) => applyPosition({
        lon: p.coords.longitude, lat: p.coords.latitude,
        heading: p.coords.heading, speed: p.coords.speed, accuracy: p.coords.accuracy,
      }),
      onPositionError,
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
    );
  } else {
    toast('Location is not available in this browser');
  }

  function applyPosition(pos) {
    const first = !state.position;
    state.position = pos;

    const progress = state.nav && state.navigating ? trackProgress() : null;
    // While driving a route, ride the road line instead of the raw GPS dot
    const shown = progress && progress.snapped ? progress.snapped : [pos.lon, pos.lat];

    if (!meMarker._map) meMarker.setLngLat(shown).addTo(map);
    meEl.classList.toggle('moving', drivingBearing() !== null);
    if (first) cameraFollow(true);
  }

  function onPositionError(err) {
    if (err.code === 1) toast('Allow location access to see where you are');
    else toast('Waiting for GPS…');
  }

  // Where the car is pointing: GPS heading while moving, otherwise along the route
  function drivingBearing() {
    const p = state.position;
    if (!p) return null;
    if (Number.isFinite(p.heading) && p.speed > 1.5) return p.heading;
    if (state.nav && state.progress) {
      const a = N.pointAt(state.nav, state.progress.traveled);
      const b = N.pointAt(state.nav, state.progress.traveled + 40);
      if (N.haversine(a, b) > 5) return N.bearing(a, b);
    }
    return null;
  }

  function setFollow(on) {
    state.follow = on;
    $('followBtn').classList.toggle('active', on);
    if (on) cameraFollow(true);
  }
  $('followBtn').onclick = () => setFollow(!state.follow);
  setFollow(true);

  // ---------------------------------------------------------------- camera
  // A chase camera, redrawn every frame and easing toward its target, so the map
  // glides and turns the way a car navigation screen does instead of stepping
  // once per GPS fix.
  const cam = { lon: null, lat: null, bearing: 0, zoom: 15, pitch: 0 };
  const car = { lon: null, lat: null, bearing: 0 };

  // Zoom like a car navigation app: close in for turns, wider at speed.
  function navZoom() {
    const speed = state.position?.speed || 0;
    const toNext = state.progress ? state.progress.toNext : Infinity;
    if (toNext < 150) return 18;
    if (toNext < 400) return 17.3;
    if (speed > 25) return 15.6;   // ~90 km/h
    if (speed > 14) return 16.3;   // ~50 km/h
    return 16.8;
  }

  // How far ahead of the car to aim, so the car sits in the lower part of the
  // screen and most of the view is the road to come.
  function lookAhead(zoom) {
    return Math.min(260, 40 * 2 ** (18 - zoom));
  }

  function cameraTarget() {
    const pos = state.position;
    if (!pos) return null;
    const here = state.progress?.snapped || [pos.lon, pos.lat];
    const bearing = drivingBearing();
    const navigating = Boolean(state.nav && state.navigating && state.progress);
    const zoom = navigating ? navZoom() : Math.max(map.getZoom(), 15);

    let center = here;
    if (navigating && bearing !== null) {
      center = N.pointAt(state.nav, state.progress.traveled + lookAhead(zoom));
    }
    return {
      lon: center[0], lat: center[1],
      bearing: bearing === null ? cam.bearing : bearing,
      zoom,
      pitch: state.view3d ? (navigating ? NAV_PITCH : Math.max(map.getPitch(), 45)) : 0,
      car: here,
      carBearing: bearing,
    };
  }

  function angleDelta(from, to) {
    return ((to - from + 540) % 360) - 180;
  }

  let lastFrame = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (CAMERA_MS && now - lastFrame < CAMERA_MS) return;
    lastFrame = now || 0;
    const target = cameraTarget();
    if (!target) return;

    // The car marker glides too, so it stays put on screen between GPS fixes
    if (car.lon === null) Object.assign(car, { lon: target.car[0], lat: target.car[1], bearing: target.carBearing ?? 0 });
    const k = LITE ? 0.5 : 0.25;
    car.lon += (target.car[0] - car.lon) * k;
    car.lat += (target.car[1] - car.lat) * k;
    if (target.carBearing !== null) car.bearing += angleDelta(car.bearing, target.carBearing) * 0.2;
    meMarker.setLngLat([car.lon, car.lat]);
    if (target.carBearing !== null) meMarker.setRotation(car.bearing);

    if (!state.follow) return;
    if (cam.lon === null) Object.assign(cam, { lon: target.lon, lat: target.lat, bearing: target.bearing, zoom: target.zoom, pitch: target.pitch });

    const ease = LITE ? 2.5 : 1;
    cam.lon += (target.lon - cam.lon) * 0.12 * ease;
    cam.lat += (target.lat - cam.lat) * 0.12 * ease;
    cam.bearing += angleDelta(cam.bearing, target.bearing) * 0.08 * ease;
    cam.zoom += (target.zoom - cam.zoom) * 0.05 * ease;
    cam.pitch += (target.pitch - cam.pitch) * 0.08 * ease;

    // flat ground close up, raised terrain from a distance (with a little hysteresis)
    const hasTerrain = !LITE && Boolean(map.getTerrain());
    if (LITE) { /* no terrain here */ }
    else if (state.view3d && cam.zoom >= TERRAIN_MAX_ZOOM && hasTerrain) map.setTerrain(null);
    else if (state.view3d && cam.zoom < TERRAIN_MAX_ZOOM - 0.3 && !hasTerrain) {
      map.setTerrain({ source: 'dem', exaggeration: 1 });
    }

    map.jumpTo({ center: [cam.lon, cam.lat], bearing: cam.bearing, zoom: cam.zoom, pitch: cam.pitch });
  }
  requestAnimationFrame(frame);

  // Jump straight to the car — used when follow mode is switched back on
  function cameraFollow(instant) {
    if (!state.follow || !state.position) return;
    const target = cameraTarget();
    if (!target) return;
    if (instant || cam.lon === null) {
      Object.assign(cam, { lon: target.lon, lat: target.lat, bearing: target.bearing, zoom: target.zoom, pitch: target.pitch });
      Object.assign(car, { lon: target.car[0], lat: target.car[1], bearing: target.carBearing ?? 0 });
      map.jumpTo({ center: [cam.lon, cam.lat], bearing: cam.bearing, zoom: cam.zoom, pitch: cam.pitch });
    }
  }

  // ---------------------------------------------------------------- routing
  async function setDestination(dest) {
    state.destination = dest;
    destMarker.setLngLat([dest.lon, dest.lat]).addTo(map);
    await requestRoute(true);
  }

  async function requestRoute(preview) {
    const d = state.destination;
    if (!d) return;
    let origin = state.position;
    if (!origin) {
      const c = map.getCenter();
      origin = { lon: c.lng, lat: c.lat };
      toast('No GPS yet — routing from the map center');
    }
    // Which way the car is pointing, so a re-route starts down the road we are
    // actually on instead of opening with a U-turn across the carriageway.
    // Only a real GPS heading counts; the route-derived one still points along
    // the route we have just left.
    const p = state.position;
    const heading = p && Number.isFinite(p.heading) && p.speed > 2 ? Math.round(p.heading) : null;

    try {
      let q = `from=${origin.lon},${origin.lat}&to=${d.lon},${d.lat}`;
      if (!preview && heading !== null) q += `&bearing=${(heading % 360 + 360) % 360}`;
      const res = await fetch(`/api/route?${q}`);
      const data = await res.json();
      if (!res.ok || data.code !== 'Ok' || !data.routes?.length) {
        toast(data.error || data.message || 'No route found');
        return;
      }
      startNavigation(data.routes[0], preview);
    } catch {
      toast('Routing failed — check your connection');
    }
  }

  function startNavigation(route, preview) {
    state.nav = N.prepare(route);
    state.progress = null;
    state.spoken.clear();
    state.offRouteFixes = 0;
    state.lastReroute = Date.now();

    drawRoute();
    renderSteps();
    if (state.navigating && state.position) trackProgress();
    updateBanner();

    const panel = $('routePanel');
    panel.hidden = false;

    if (preview) {
      // Show the whole trip and wait for Start, the way a navigation app does
      state.navigating = false;
      panel.classList.remove('collapsed');
      panel.classList.add('preview');
      setFollow(false);
      fitToRoute();
    } else {
      panel.classList.remove('preview');
      cameraFollow(false);
    }
  }

  /** Begin guidance: swoop down to the car, then hand over to the driving camera. */
  function beginGuidance() {
    if (!state.nav) return;
    state.navigating = true;
    const panel = $('routePanel');
    panel.classList.remove('preview');
    panel.classList.add('collapsed');

    if (state.position) trackProgress();
    updateBanner();
    const first = state.nav.steps[1] || state.nav.steps[0];
    if (first) speak(N.instruction(first, state.destination && state.destination.name));

    // Fly from the whole-trip overview down into the driving view
    state.follow = false;
    $('followBtn').classList.add('active');
    const target = cameraTarget();
    if (!target) { setFollow(true); return; }

    map.flyTo({
      center: [target.lon, target.lat],
      zoom: target.zoom,
      bearing: target.bearing,
      pitch: target.pitch,
      duration: LITE ? 900 : 1900,
      curve: 1.5,   // dip out and back in, like a camera swooping down
      essential: true,
    });
    map.once('moveend', () => {
      // Hand the camera to the follow loop exactly where the flight ended
      Object.assign(cam, {
        lon: map.getCenter().lng, lat: map.getCenter().lat,
        bearing: map.getBearing(), zoom: map.getZoom(), pitch: map.getPitch(),
      });
      state.follow = true;
    });
  }

  $('startNav').onclick = beginGuidance;
  $('cancelNav').onclick = () => endNavigation(false);

  function drawRoute() {
    const nav = state.nav;
    const traveled = state.progress?.traveled || 0;
    map.getSource('route')?.setData(N.slice(nav, traveled, nav.total));
    map.getSource('route-done')?.setData(traveled > 10 ? N.slice(nav, 0, traveled) : emptyFC());
    map.getSource('maneuvers')?.setData({
      type: 'FeatureCollection',
      features: nav.steps.slice(1, -1).map((s) => ({
        type: 'Feature', properties: {},
        geometry: { type: 'Point', coordinates: s.maneuver.location },
      })),
    });
  }

  function fitToRoute() {
    const b = new maplibregl.LngLatBounds();
    state.nav.coords.forEach((c) => b.extend(c));
    const panel = $('routePanel').getBoundingClientRect();
    map.fitBounds(b, {
      padding: { top: 100, bottom: 60, right: 100, left: innerWidth > 900 ? panel.width + 40 : 40 },
      maxZoom: 16, pitch: 0, bearing: 0,
    });
  }

  function endNavigation(arrived) {
    state.nav = null;
    state.navigating = false;
    $('routePanel').classList.remove('preview');
    state.progress = null;
    state.offRouteFixes = 0;
    state.destination = null;
    stopSim();
    destMarker.remove();
    map.getSource('route')?.setData(emptyFC());
    map.getSource('route-done')?.setData(emptyFC());
    map.getSource('maneuvers')?.setData(emptyFC());
    $('routePanel').hidden = true;
    $('searchInput').value = '';
    $('clearSearch').hidden = true;
    if (arrived) speak('You have arrived at your destination');
  }
  // Tap the turn bar to show or hide the trip details
  $('navSummary').onclick = () => {
    const panel = $('routePanel');
    panel.classList.toggle('collapsed');
    if (panel.classList.contains('collapsed')) $('stepsList').hidden = true;
  };
  $('endRoute').onclick = () => endNavigation(false);
  $('stepsToggle').onclick = () => { $('stepsList').hidden = !$('stepsList').hidden; };

  /** Follow the route: how far along we are, which turn is next, when to re-route. */
  function trackProgress() {
    const nav = state.nav;
    const pos = [state.position.lon, state.position.lat];
    const prev = state.progress;
    const match = N.project(pos, nav.coords, nav.cum, prev ? prev.index : 0);

    // Too far from the line? Ask for a new route.
    // A car's browser often reports accuracy in the hundreds of metres, and
    // adding all of that to the threshold meant leaving the route never
    // registered at all, so the old line stayed on screen the whole way.
    const slack = Math.min(state.position.accuracy || 0, ACCURACY_SLACK_MAX);
    if (match.distance > OFF_ROUTE_METERS + slack) {
      state.offRouteFixes++;
      if (state.offRouteFixes >= OFF_ROUTE_FIXES &&
          Date.now() - state.lastReroute > REROUTE_COOLDOWN_MS) {
        state.lastReroute = Date.now();
        state.offRouteFixes = 0;
        toast('Re-routing…');
        speak('Re-routing');
        requestRoute(false);
      }
      return state.progress;
    }
    state.offRouteFixes = 0;

    // Move forward freely, backward only on a confident match. Pinning this to
    // the highest value ever seen meant a single bad snap advanced the guidance
    // for good, and it then called out turns from further down the route.
    let traveled = match.offset;
    if (prev && traveled < prev.traveled) {
      const back = prev.traveled - traveled;
      if (back < BACKSTEP_METERS || match.distance > 25) traveled = prev.traveled;
    }

    // Worked out from scratch each time so it can come back down after a
    // correction, and held until the turn is actually behind us
    let stepIndex = 0;
    while (stepIndex + 1 < nav.steps.length &&
           nav.offsets[stepIndex + 1] + STEP_PASSED_METERS <= traveled) stepIndex++;

    const toNext = Math.max(0, (nav.offsets[stepIndex + 1] ?? nav.total) - traveled);
    const remaining = Math.max(0, nav.total - traveled);
    const share = nav.total ? remaining / nav.total : 0;

    state.progress = {
      traveled, stepIndex, toNext, remaining,
      index: match.index,
      snapped: match.point,
      seconds: nav.duration * share,
    };

    if (remaining < ARRIVE_METERS) {
      toast('You have arrived');
      endNavigation(true);
      return null;
    }

    updateBanner();
    drawRoute();
    maybeSpeak();
    return state.progress;
  }

  // ---------------------------------------------------------------- nav UI
  function updateBanner() {
    const nav = state.nav;
    if (!nav) return;
    const p = state.progress;
    const i = p ? p.stepIndex : 0;
    const next = nav.steps[i + 1] || nav.steps[i];
    const after = nav.steps[i + 2];
    const destName = state.destination?.name;

    $('nextArrow').innerHTML = N.arrow(next.maneuver);
    $('nextInstr').textContent = N.instruction(next, destName);
    $('nextDist').textContent = N.fmtDist(p ? p.toNext : nav.offsets[1] ?? 0);

    const thenRow = $('thenRow');
    if (after) {
      $('thenArrow').innerHTML = N.arrow(after.maneuver);
      $('thenInstr').textContent = N.instruction(after, destName);
      thenRow.hidden = false;
    } else {
      thenRow.hidden = true;
    }

    const seconds = p ? p.seconds : nav.duration;
    const remaining = p ? p.remaining : nav.total;
    $('routeEta').textContent = new Date(Date.now() + seconds * 1000)
      .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('routeDist').textContent = N.fmtDist(remaining);
    $('routeTime').textContent = N.fmtDuration(seconds);
    $('routeBar').style.width = `${nav.total ? (1 - remaining / nav.total) * 100 : 0}%`;

    [...$('stepsList').children].forEach((li, idx) => li.classList.toggle('current', idx === i));
  }

  function renderSteps() {
    const list = $('stepsList');
    list.innerHTML = '';
    state.nav.steps.forEach((s, i) => {
      const li = document.createElement('li');
      li.innerHTML = '<span class="s-arrow"></span><span class="s-text"></span><span class="s-dist"></span>';
      li.querySelector('.s-arrow').innerHTML = N.arrow(s.maneuver);
      li.querySelector('.s-text').textContent = N.instruction(s, state.destination?.name);
      li.querySelector('.s-dist').textContent = s.distance ? N.fmtDist(s.distance) : '';
      li.onclick = () => { setFollow(false); map.easeTo({ center: s.maneuver.location, zoom: 17 }); };
      if (i === (state.progress?.stepIndex ?? 0)) li.classList.add('current');
      list.appendChild(li);
    });
  }

  // ---------------------------------------------------------------- voice
  function speak(text) {
    if (!state.voice || !('speechSynthesis' in window)) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.rate = 1.05;
      speechSynthesis.speak(u);
    } catch { /* no voice on this device */ }
  }

  function maybeSpeak() {
    const { stepIndex, toNext } = state.progress;
    const next = state.nav.steps[stepIndex + 1];
    if (!next) return;
    const stepLength = state.nav.offsets[stepIndex + 1] - state.nav.offsets[stepIndex];
    for (const mark of SPEAK_AT) {
      if (mark > stepLength) continue;          // too close together to announce
      if (toNext > mark) continue;
      const key = `${stepIndex}:${mark}`;
      if (state.spoken.has(key)) continue;
      state.spoken.add(key);
      speak(N.spoken(next, mark, state.destination?.name));
      break;
    }
  }

  $('voiceBtn').onclick = () => {
    state.voice = !state.voice;
    localSet('voice', state.voice ? 'on' : 'off');
    $('voiceBtn').classList.toggle('active', state.voice);
    $('voiceBtn').textContent = state.voice ? '🔊' : '🔇';
    if (state.voice) speak('Voice guidance on');
    else speechSynthesis?.cancel();
  };
  $('voiceBtn').classList.toggle('active', state.voice);
  $('voiceBtn').textContent = state.voice ? '🔊' : '🔇';

  // ---------------------------------------------------------------- map taps
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
      <button class="popup-btn">Drive here</button>`;
    const popup = new maplibregl.Popup({ closeButton: true }).setLngLat(e.lngLat).setDOMContent(el).addTo(map);
    el.querySelector('button').onclick = () => {
      popup.remove();
      setDestination({ lon: lng, lat, name: 'Dropped pin' });
    };
  });
  map.on('mouseenter', 'updates-dot', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'updates-dot', () => (map.getCanvas().style.cursor = ''));

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

  // "41.7151, 44.7930" — coordinates pasted straight in (Google's order: lat, lon)
  const COORDS = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,;]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

  /** A pasted map link or a pair of coordinates becomes a destination directly. */
  async function useAsDestination(text) {
    const coords = text.match(COORDS);
    if (coords) {
      const lat = Number(coords[1]);
      const lon = Number(coords[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        closeSearch(true);
        await setDestination({ lon, lat, name: `${lat.toFixed(5)}, ${lon.toFixed(5)}` });
        return true;
      }
    }

    if (!/^https?:\/\//i.test(text)) return false;

    results.hidden = true;
    toast('Opening the shared link…');
    try {
      const res = await fetch(`/api/resolve?url=${encodeURIComponent(text)}`);
      const data = await res.json();
      if (!res.ok || !Number.isFinite(data.lat)) {
        toast(data.error || 'No location found in that link');
        return true;
      }
      const name = data.name || 'Shared place';
      input.value = name;
      $('clearSearch').hidden = false;
      closeSearch(true);
      await setDestination({ lon: data.lon, lat: data.lat, name });
    } catch {
      toast('Could not open that link');
    }
    return true;
  }

  input.addEventListener('paste', (e) => {
    const text = (e.clipboardData && e.clipboardData.getData('text') || '').trim();
    if (text && (COORDS.test(text) || /^https?:\/\//i.test(text))) {
      e.preventDefault();
      input.value = text;
      $('clearSearch').hidden = false;
      useAsDestination(text);
    }
  });

  async function runSearch() {
    const q = input.value.trim();
    if (q.length < 2) { results.hidden = true; return; }
    if (await useAsDestination(q)) return;
    const seq = ++searchSeq;
    const c = state.position || { lon: map.getCenter().lng, lat: map.getCenter().lat };
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&lat=${c.lat}&lon=${c.lon}&lang=en`);
      const data = await res.json();
      if (seq !== searchSeq) return;
      renderResults(data.features || []);
    } catch {
      toast('Search failed — check your connection');
    }
  }

  function renderResults(features) {
    results.innerHTML = '';
    if (!features.length) results.innerHTML = '<li class="muted">No results</li>';
    for (const f of features) {
      const p = f.properties || {};
      const name = p.name || [p.street, p.housenumber].filter(Boolean).join(' ') || 'Unnamed place';
      const sub = [p.street && p.name ? p.street : null, p.city || p.town || p.village, p.county || p.state]
        .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
      const li = document.createElement('li');
      li.tabIndex = 0;
      li.innerHTML = '<div class="r-name"></div><div class="r-sub"></div>';
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

  // ---------------------------------------------------------------- road updates
  async function loadUpdates() {
    try {
      const res = await fetch('/updates.json', { cache: 'no-cache' });
      const data = await res.json();
      state.updates = data.items || [];
      $('updatesMeta').textContent = data.updated
        ? `Last updated ${new Date(data.updated).toLocaleString()}` : '';
      renderUpdates();
    } catch {
      $('updatesMeta').textContent = 'Could not load road updates';
    }
  }

  function renderUpdates() {
    map.getSource('updates')?.setData(updatesFC());
    const list = $('updatesList');
    list.innerHTML = '';
    for (const u of state.updates) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="u-dot"></span><div><div class="u-title"></div><div class="u-desc"></div></div>';
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
      <div class="small muted p-src"></div><button class="popup-btn">Drive here</button>`;
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
  $('closeUpdates').onclick = () => {
    $('updatesPanel').hidden = true;
    $('updatesBtn').classList.remove('active');
  };

  // ---------------------------------------------------------------- send from phone
  // The car shows a short code. The phone posts a place under that code at
  // /send, and the car picks it up on its next check.
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  function carCode() {
    let code = localGet('carCode');
    if (!code || code.length !== 4) {
      code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
      localSet('carCode', code);
    }
    return code;
  }

  function showPairing() {
    const code = carCode();
    $('pairCode').textContent = code;
    // A QR of the phone page, so you can just point a camera at the car screen
    const img = $('pairQr');
    if (window.qrcode && img) {
      try {
        const qr = window.qrcode(0, 'M');
        qr.addData(`${location.origin}/send`);
        qr.make();
        img.src = qr.createDataURL(6, 8);
        img.hidden = false;
      } catch {
        img.hidden = true;
      }
    }
  }

  async function checkInbox() {
    try {
      const res = await fetch(`/api/inbox?code=${carCode()}`, { cache: 'no-store' });
      const data = await res.json();
      if (data.enabled === false) {
        $('phoneStatus').textContent = 'Sending from a phone is not switched on yet.';
        return;
      }
      if (data.place) {
        const place = data.place;
        $('phonePanel').hidden = true;
        $('phoneBtn').classList.remove('active');
        $('searchInput').value = place.name;
        $('clearSearch').hidden = false;
        toast(`From your phone: ${place.name}`);
        setDestination({ lon: place.lon, lat: place.lat, name: place.name });
      }
    } catch { /* offline — try again on the next tick */ }
  }

  $('phoneBtn').onclick = () => {
    const panel = $('phonePanel');
    panel.hidden = !panel.hidden;
    $('phoneBtn').classList.toggle('active', !panel.hidden);
    if (!panel.hidden) showPairing();
  };
  $('closePhone').onclick = () => {
    $('phonePanel').hidden = true;
    $('phoneBtn').classList.remove('active');
  };

  // Check regularly, but not while the browser tab is in the background
  setInterval(() => { if (!document.hidden) checkInbox(); }, 7000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkInbox(); });
  checkInbox();

  // ---------------------------------------------------------------- theme
  $('themeBtn').onclick = () => {
    state.theme = state.theme === 'day' ? 'night' : 'day';
    localSet('theme', state.theme);
    document.body.classList.toggle('night', state.theme === 'night');
    map.setStyle(STYLES[state.theme]); // overlays are re-added on style.load
  };

  // ---------------------------------------------------------------- demo drive
  // /?sim=1 drives the route by itself — useful for testing without GPS,
  // and for showing someone what navigation looks like.
  function startSim() {
    stopSim();
    // ?miss=1 drives straight past the first turn, so off-route detection and
    // re-routing can be tried from a desk rather than from the driver's seat
    const missAt = Number(new URLSearchParams(location.search).get('miss')) || 0;
    let navRef = null, metres = 0, strayed = 0, missedAlready = false;
    const speed = 17; // m/s, about 60 km/h

    state.sim = setInterval(() => {
      const nav = state.nav;
      if (!nav) return stopSim();
      if (navRef !== nav) { navRef = nav; metres = 0; strayed = 0; } // a re-route landed

      const missOffset = missAt && !missedAlready ? nav.offsets[missAt] : null;
      if (missOffset != null && metres >= missOffset) {
        strayed += speed;
        if (strayed > 400) missedAlready = true;
        const from = N.pointAt(nav, Math.max(0, missOffset - 40));
        const at = N.pointAt(nav, missOffset);
        const brg = (N.bearing(from, at) * Math.PI) / 180;
        const here = [
          at[0] + (strayed * Math.sin(brg)) / (111320 * Math.cos((at[1] * Math.PI) / 180)),
          at[1] + (strayed * Math.cos(brg)) / 110540,
        ];
        applyPosition({
          lon: here[0], lat: here[1],
          heading: N.bearing(at, here), speed, accuracy: 5,
        });
        return;
      }

      metres = Math.min(metres + speed, nav.total);
      const here = N.pointAt(nav, metres);
      const ahead = N.pointAt(nav, metres + 25);
      applyPosition({
        lon: here[0], lat: here[1],
        heading: N.bearing(here, ahead), speed, accuracy: 5,
      });
    }, 1000);
  }

  function stopSim() {
    if (state.sim) clearInterval(state.sim);
    state.sim = null;
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

  // Deep link: /?to=lon,lat&name=Place[&sim=1]
  function openDeepLink() {
    const qs = new URLSearchParams(location.search);
    const to = (qs.get('to') || '').split(',').map(Number);
    if (to.length === 2 && to.every(Number.isFinite)) {
      const name = (qs.get('name') || 'Destination').slice(0, 80);
      input.value = name;
      $('clearSearch').hidden = false;
      setDestination({ lon: to[0], lat: to[1], name }).then(() => {
        if (qs.get('sim') === '1' && state.nav) { beginGuidance(); startSim(); }
      });
    }
  }

  if (LITE) {
    setTimeout(() => toast('Simple mode: this screen gets the lighter map'), 1500);
  }

  loadUpdates();
  // 'style.load', not 'load': with 3D terrain switched on, 'load' never fires
  map.once('style.load', openDeepLink);

  // Handy for debugging from the browser console
  window.geodrive = { map, state, startSim, stopSim, checkInbox, beginGuidance };
})();
