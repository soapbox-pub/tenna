/*
 * Stands in for an nsite's service worker while the renderer is proved out.
 *
 * Deliberately written the way a site would write it, against the standard and
 * against nothing of Tenna's: a `push` listener, `event.data.json()`,
 * `event.waitUntil()` and `registration.showNotification()`. If this file needs
 * anything Tenna-shaped to work, the shim underneath it is wrong.
 */
'use strict';

self.addEventListener('install', () => {
  // Nothing to cache; here to prove the lifecycle runs before a push does.
  self.__installed = true;
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  const nostrEvent = event.data.json();
  const who = String(nostrEvent.pubkey || '').slice(0, 8) || 'someone';

  event.waitUntil(
    self.registration.showNotification(`${who} replied`, {
      body: String(nostrEvent.content || '').slice(0, 120),
      tag: String(nostrEvent.id || ''),
    }),
  );
});
