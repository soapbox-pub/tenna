/*
 * Handing a site's service worker the port it talks to Tenna over.
 *
 * Runs at document start in every window Tenna opens at a site's origin, and
 * exists for one reason: a MessagePort arrives at a frame, and a frame is the
 * only thing that can give one to a service worker. Nothing native can reach
 * into a worker, and the worker cannot reach out for itself — so a document
 * has to carry it across, even though the document has no use for it at all.
 *
 * Three moments, and they are the three ways a worker can find itself without
 * one:
 *
 *   - this window's worker is ready, which is the ordinary case;
 *   - the worker changed, because a new one activated;
 *   - the worker rang for one, because Chromium stopped it and started it
 *     again and the new instance came up with an empty global. That ring goes
 *     to the host rather than to here — see NappPort — and comes back as the
 *     same message the other two ask for.
 *
 * The site's own code shares this window and can call any of it. That costs
 * nothing: what arrives is a port for this site's worker and no other, and the
 * host answers nothing on one until the worker has shown the token only the
 * worker has. See NappPort.
 */
(function () {
  'use strict';

  var host = window[%%NAPP_HOST_OBJECT%%];
  if (!host || !navigator.serviceWorker) return;

  /** Ask the host to mint one and post it here. */
  function ask() {
    try {
      // The shape everything on this channel takes. Answered natively rather
      // than forwarded to Tenna's own web layer; see NsiteWebViewPlugin.
      host.postMessage(JSON.stringify({ id: 0, method: 'napp.port' }));
    } catch (e) {}
  }

  /** Carry one across to the worker, where it is of some use. */
  function hand(port) {
    navigator.serviceWorker.ready
      .then(function (registration) {
        if (!registration.active) return;
        registration.active.postMessage({ __napp: 'port' }, [port]);
      })
      .catch(function () {});
  }

  // From the host. `postWebMessage` lands on the window, carrying the port.
  window.addEventListener('message', function (event) {
    if (!event.ports || !event.ports.length) return;

    var message;
    try {
      message = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    if (!message || message.type !== 'napp.port') return;

    hand(event.ports[0]);
  });

  navigator.serviceWorker.addEventListener('controllerchange', ask);
  navigator.serviceWorker.ready.then(ask).catch(function () {});
})();
