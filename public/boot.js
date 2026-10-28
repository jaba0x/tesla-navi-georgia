/* GeoDrive — loader
 * Car browsers vary a lot. MapLibre 5 needs WebGL 2; older screens (for example a
 * 2018 Model 3) only have WebGL 1, where MapLibre 4 still works. Pick one, load it,
 * then load the app. Any failure is shown on screen instead of leaving a blank map.
 */
(function () {
  'use strict';

  // Served from this site (public/vendor) rather than a CDN: one connection fewer
  // on a slow network, and the service worker can keep it on the device
  var LIB = '/vendor/maplibre-gl-';
  var MODERN = '5.24.0';
  var LEGACY = '4.7.1';

  function hasWebGL(type) {
    try {
      var c = document.createElement('canvas');
      var ctx = c.getContext(type) || (type === 'webgl' ? c.getContext('experimental-webgl') : null);
      return !!ctx;
    } catch (e) {
      return false;
    }
  }

  // ?gl1 forces the older map library, for testing that path on a modern browser
  var forceLegacy = /(\?|&)gl1(=|&|$)/.test(location.search);

  function fail(message, detail) {
    // Once the map has drawn, later hiccups are not worth a full-screen panel
    if (window.geodriveMapReady) return;
    var box = document.getElementById('bootError');
    if (!box) return;
    box.hidden = false;
    document.getElementById('bootErrorText').textContent = message;
    document.getElementById('bootErrorDetail').textContent = detail || '';
  }

  window.geodriveFail = fail;

  // Name this site in the on-screen hints, whichever domain it is served from
  var hostSpots = document.querySelectorAll('.site-host');
  for (var i = 0; i < hostSpots.length; i++) hostSpots[i].textContent = location.host;

  window.addEventListener('error', function (e) {
    // Browsers report cross-origin script problems as a bare "Script error." with no
    // detail; those are usually harmless, so don't alarm the driver over them
    if (!e || !e.message || e.message.indexOf('Script error') === 0) return;
    fail('Something went wrong on this screen',
      e.message + ' — ' + String(e.filename || '').split('/').pop() + ':' + (e.lineno || ''));
  });

  var webgl2 = hasWebGL('webgl2');
  var webgl1 = hasWebGL('webgl');
  // ?gl1 pretends this is an old screen, so the whole fallback path can be tested
  window.GEODRIVE_GL = (webgl2 && !forceLegacy) ? 2 : (webgl1 ? 1 : 0);

  if (!webgl2 && !webgl1) {
    fail('This browser cannot draw maps', 'No WebGL support. Open ' + location.host + '/check.html to see the details.');
    return;
  }

  var version = webgl2 && !forceLegacy ? MODERN : LEGACY;

  var css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = LIB + version + '/maplibre-gl.css';
  document.head.appendChild(css);

  function load(src, onDone) {
    var s = document.createElement('script');
    s.crossOrigin = 'anonymous'; // so real errors arrive with a message, not "Script error."
    s.src = src;
    s.onload = onDone;
    s.onerror = function () { fail('Could not load the map library', src); };
    document.head.appendChild(s);
  }

  load(LIB + version + '/maplibre-gl.js', function () {
    if (!window.maplibregl) return fail('The map library did not start', version);
    load('/nav.js', function () { load('/app.js'); });
  });

  // Keep the app, the map library and the map already seen on this device
  // (sw.js), so the next start doesn't wait on a slow connection. Registered once
  // the page has loaded, so it doesn't compete with the first start.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () { /* the app works without it */ });
    });
  }
})();
