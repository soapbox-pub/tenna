# What Tenna signs for

Tenna holds a key. On Android it will use that key on behalf of other
applications — one installed on the same phone, or one running somewhere else
entirely — so that they never have to hold one themselves.

Nothing here is new on the Nostr wire. It is two existing protocols, NIP-55
for an app on the phone and NIP-46 for an app that is not, answered by the same
code and asked about with the same sheet.

## What it can answer for

Only an account whose key Tenna itself holds. That means any account signed
in on Android, where a key given to Tenna is sealed in the app process on the
first launch after signing in. An account signed in through a browser
extension, a remote signer, or another signer app on the phone keeps its key
somewhere else, and Tenna will say so rather than pretend: a request for one of
those is refused with an explanation, not passed along.

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

## Being asked

The sheet is the same one a site inside Tenna gets, over a transparent window
so whatever asked stays on screen underneath — which is the thing a person
needs in order to answer. It names the caller by the string nobody can pick for
themselves: an app's package name, or, for an app somewhere else, the plain
fact that it is not on this phone.

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
