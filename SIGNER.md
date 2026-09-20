# What Tenna signs for

Tenna holds a key. On Android it will use that key on behalf of other
applications — one installed on the same phone, one running somewhere else
entirely, or a site running inside Tenna — so that they never have to hold one
themselves.

Nothing here is new on the Nostr wire. It is existing protocols — NIP-55 for an
app on the phone, NIP-46 for an app that is not, NIP-07 for a site — answered
by the same code and asked about with the same sheet.

## What it can answer for

Any account signed in to Tenna. Where its key actually lives decides how the
answer is got, not whether there is one:

- **A key Tenna holds.** Given to Tenna directly, it is sealed in the app
  process on the first launch after signing in, and signing happens there.
- **A signer app on the phone.** Tenna is a NIP-55 client as well as a NIP-55
  signer, so it asks that app the same way anything else would. Two sheets
  appear rather than one, and that is deliberate: only Tenna's knows which app
  really asked, because the other signer sees the request as coming from Tenna.
  If that signer has been told to remember the question, it answers in the
  background and only Tenna's sheet appears.

  **What comes back from it is checked, not trusted.** A signature only proves
  somebody signed something: it does not say that the account was the one the
  client named, or that the event is the one the sheet displayed. Both are
  compared — pubkey, kind, content and tags — and a mismatch is an error rather
  than an answer. A signer holding several keys that replies as the wrong one
  would otherwise log a client in as a stranger, and the relay AUTH case shows
  why tags count too: the whole meaning of that event is in its challenge.
- **A remote signer.** Not yet. A request for one of these is refused with an
  explanation rather than left to hang.

Two questions never reach a key at all. `get_public_key` and `ping` are about
the account rather than about its key, so they are answered from the list of
who is signed in — which is what lets a client log in to an account held in
another app with nothing on screen.

Forwarding to another signer sometimes needs a window, and a content resolver
query or a relay socket has not got one. Both already have a way to say so:
the resolver returns a null cursor, which NIP-55 defines as "open the intent",
and a request off a relay raises a notification that opens the sheet.

## An app on the phone

Tenna answers the `nostrsigner:` scheme, so any NIP-55 client finds it the
usual way:

```kotlin
val intent = Intent(Intent.ACTION_VIEW, Uri.parse("nostrsigner:"))
context.packageManager.queryIntentActivities(intent, 0)
```

Both halves of NIP-55 are there.

**The intent.** `get_public_key`, `sign_event`, `nip04_encrypt`,
`nip04_decrypt`, `nip44_encrypt`, `nip44_decrypt`, `decrypt_zap_event`. The
answer comes back in `result` and `signature` alike, with `event` for a signed
event, `id` echoed, and `package` on the way out of `get_public_key`. A refusal
is `RESULT_OK` with `rejected` set, which is how a client tells "you may not"
from "I crashed".

A client may put several requests in one window with
`FLAG_ACTIVITY_SINGLE_TOP`; they are asked about one after another and answered
together in a `results` array, alongside the extras for the last of them.

Both dialects are read. A native caller's parameters are intent extras; a web
page's are the URI's query string, told apart by `Browser.EXTRA_APPLICATION_ID`
the way the NIP describes. `callbackUrl`, `returnType` and gzip
(`Signer1` + base64) all work for a page that cannot read an activity result.

**The content resolver**, for a request the user has already answered:

```kotlin
context.contentResolver.query(
  Uri.parse("content://pub.soapbox.tenna.SIGN_EVENT"),
  arrayOf(eventJson, "", loggedInUserPubkey),
  null, null, null,
)
```

Three outcomes, told apart by the shape of the cursor and not by a value in it:

| What comes back | What it means |
| --- | --- |
| a row with `result` | granted — and for `sign_event`, `event` too |
| a row with `rejected` | refused, and refused standing. Stop asking |
| `null` | nobody has decided. Open the intent |

A client that cannot tell the middle case from the last one will reopen the
sheet for something the user has permanently refused, every time it wants it.

## An app somewhere else

Tenna is a NIP-46 signer. Both directions work:

- **The app invites Tenna.** Paste its `nostrconnect://` link into Settings →
  Apps → Authorized apps, or tap one on the phone and Tenna opens that screen
  with it filled in. Nothing is accepted by arriving: any web page can navigate
  to a link like that, and accepting one hands out a standing permission to
  sign, so the screen asks.
- **Tenna invites the app.** The same screen makes a `bunker://` link to paste
  into the app. It works once; whoever quotes its secret first becomes the app
  on the other end.

Methods: `connect`, `get_public_key`, `sign_event`, `ping`, `nip04_encrypt`,
`nip04_decrypt`, `nip44_encrypt`, `nip44_decrypt`, `decrypt_zap_event`,
`switch_relays`, `logout`. Anything else gets an error rather than silence — a
client waiting on an answer it will never get is a client that hangs.

Replies are encrypted the way the request was. There is no negotiation in
NIP-46 and no setting for it: an app that spoke NIP-04 is answered in NIP-04,
because that is the only evidence there is about what it can read.

**Every connection has a key of its own**, made when the connection is made.
The client talks to that key, not to the user's, so it learns the user's pubkey
only by asking — and revoking the connection is throwing the key away, which is
what makes it final.

Listening happens on the relay sockets the app already holds open for site
notifications, so there is no second service and no second notification. The
standing notification says what it is doing.

**Notifications matter here.** A request nobody has approved before has to
reach a person, and with the app closed a notification is the only thing that
can carry it. Tenna asks for the permission when a connection is made. If it is
refused, the connection still does everything it was granted up front, and
anything else is refused out loud rather than left to time out.

## A site inside Tenna

An nsite asks over `window.nostr`, injected into its window — and, since its
service worker has no window to inject into, over `self.nostr` there too.
[NAPP.md](NAPP.md) is the whole of what a site sees.

The worker is the case worth stating here, because it is the one that reaches
this code rather than the web layer. A site woken by a push has no window, no
bridge and nothing on screen, so its calls are answered by the same class that
answers an intent and a relay — against the same grants, which is why they are
kept natively rather than in the browser storage that a worker cannot see.

So a site allowed to decrypt in its window is allowed to decrypt in its
worker, one switch in Settings turns off both, and a call nobody has decided
raises the same notification a remote app's does. The one difference is that a
worker will not wait forever: after ninety seconds the call is refused, the
notification comes down, and the site is told why.

## Being asked

The sheet is the same one whatever asked, over a transparent window so whatever
asked stays on screen underneath — which is the thing a person needs in order
to answer. It names the caller by the string nobody can pick for themselves: an
app's package name, a site's subdomain, or, for an app somewhere else, the
plain fact that it is not on this phone.

"Remember" is offered for anything the platform named. It is **not** offered to
a web page, because every web page reaching a signer looks identical from here,
and a decision made about one would silently answer for the next.

Signing is remembered per event kind. An app allowed to sign a reaction has not
been allowed to sign a note. Everything else — encrypting, decrypting — is one
question, because nothing in the request would make one instance of it
different from another.

Dismissing is a no. Dragging the sheet down, the back gesture, the window going
away: none of them is an approval, and none of them writes a decision down.

## Taking it back

Settings → Apps → Authorized apps lists everything that has been given this
account's key — sites inside Tenna, apps on the phone, and apps elsewhere — in
one list, with what each may do. A switch turns one thing off; revoking drops
the lot. A grant can be taken away there but never given: a permission is
granted in the moment it is asked for, where the user can see what is being
asked.

## What is deliberately missing

- **`sign_psbt` and the NIP-44 v3 draft.** Extensions to NIP-55 that another
  signer added; not in the NIP.
- **`auth_url` challenges.** NIP-46 has them for a signer that needs to send
  the user somewhere to log in. This one is on the phone in their hand.
- **Grants that expire on a timer.** Tenna's answer is allow, deny, or ask.
  A permission that lapses is one the user is asked about again at a moment
  they have no context for, which teaches the habit of approving to make the
  sheet go away.
- **iOS.** NIP-55 is an Android protocol, and nothing on iOS can hold a relay
  socket open the way NIP-46 needs.
