/*
 * Tenna's download reader, run in a site's page.
 *
 * A site's window is not a browser, so when the site asks for a file to be
 * saved there is nowhere for it to go until the user says where — and the
 * bytes are somewhere only the page can reach. Almost every download a web app
 * makes is a `blob:` URL it built itself, which exists in the renderer and
 * nowhere else; the rest are its own files, served by Tenna but from behind
 * the origin's own service worker. Neither can be fetched from native code, so
 * this is injected to fetch it from inside and hand it out a piece at a time.
 *
 * The host writes each piece and answers before the next is sent. That
 * back-pressure is the whole reason this is a loop and not one message: a
 * multi-hundred-megabyte export posted in one go would sit in a queue on the
 * native side, in base64, waiting on a disk that is slower than the renderer.
 * Reading through the response's stream rather than into one buffer is the
 * same economy on this side.
 *
 * Nothing here is trusted, and nothing needs to be. What arrives is bytes the
 * site chose to give, going into a file the user chose to make — the same
 * bargain a browser's download is. The site can read this script and could lie
 * about its own blob, which costs it nothing it could not have had by putting
 * different bytes in the blob to begin with.
 */
(function () {
  'use strict';

  var host = window.tennaDownloadHost;
  if (!host) return;

  var TOKEN = %%TENNA_DOWNLOAD_TOKEN%%;
  var SOURCE = %%TENNA_DOWNLOAD_URL%%;

  /* Large enough that an ordinary file is a handful of messages, small enough
     that the base64 of one is not a string worth worrying about. */
  var PIECE = 512 * 1024;

  /* `String.fromCharCode.apply` takes its bytes as arguments, and a big enough
     slice overflows the stack rather than returning. */
  var ARGUMENT_LIMIT = 8192;

  var waiting = null;

  host.onmessage = function (event) {
    var resolve = waiting;
    waiting = null;
    if (resolve) resolve(event.data);
  };

  function send(message) {
    message.token = TOKEN;
    host.postMessage(JSON.stringify(message));
  }

  /* Post, and wait to be told it landed before posting again. */
  function offer(message) {
    return new Promise(function (resolve) {
      waiting = resolve;
      send(message);
    });
  }

  function base64(bytes) {
    var text = '';
    for (var at = 0; at < bytes.length; at += ARGUMENT_LIMIT) {
      text += String.fromCharCode.apply(
        null,
        bytes.subarray(at, Math.min(at + ARGUMENT_LIMIT, bytes.length))
      );
    }
    return btoa(text);
  }

  /*
   * Hand over one run of bytes, in pieces.
   *
   * Resolves false the moment the host stops wanting them — it has closed the
   * file, or the window has gone — so that everything above unwinds rather
   * than pouring into nothing.
   */
  function pour(bytes) {
    var at = 0;

    function next() {
      if (at >= bytes.length) return Promise.resolve(true);

      var piece = bytes.subarray(at, Math.min(at + PIECE, bytes.length));
      at += piece.length;

      return offer({ data: base64(piece) }).then(function (reply) {
        return reply === 'ok' ? next() : false;
      });
    }

    return next();
  }

  function drain(response) {
    /* A WebView too old for a stream body still has the whole-buffer read,
       which costs the renderer a copy of the file and works. */
    if (!response.body || !response.body.getReader) {
      return response.arrayBuffer().then(function (buffer) {
        return pour(new Uint8Array(buffer));
      });
    }

    var reader = response.body.getReader();

    function next() {
      return reader.read().then(function (step) {
        if (step.done) return true;
        return pour(step.value).then(function (poured) {
          if (!poured) {
            reader.cancel();
            return false;
          }
          return next();
        });
      });
    }

    return next();
  }

  fetch(SOURCE)
    .then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return drain(response);
    })
    .then(function (poured) {
      if (poured) send({ done: true });
    })
    .catch(function (error) {
      send({ error: String(error) });
    });
})();
