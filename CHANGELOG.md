# Changelog

## v0.28.0 — 2026-09-10

### The server can tell you a new version exists

Until now it could not: the version lived in `package.json` and nothing read it at runtime, so the app did
not know what it was, let alone whether anything newer had been published. **Admin → Health** now has a
Version row, and once a day the server asks GitHub whether a newer release is out.

It is a plain read of a public releases page — the same one you could open in a browser. **Nothing about
your server is sent.** GitHub sees an IP address, as it would for anyone loading a public page, and that is
all. Being a version behind is never treated as a fault and will not turn anything amber; an update notice
that cries wolf is one people learn to ignore.

On by default, with a switch in Settings. Off means no request is made at all, and the row says so rather
than quietly claiming you are up to date. If GitHub cannot be reached, it says that too — "up to date" and
"we could not ask" look identical on a page, and only one of them is a reason to relax.

### And, if you want, it can be counted

Nobody can see how many people self-host this. That is the point of self-hosting, and it also means nobody —
including whoever wrote it — knows whether a release reached twenty people or two hundred.

So there is now an **opt-in** install count, **off by default**, as a separate switch. Turn it on and once a
day your server sends this, and nothing else, to uchiyomi.com:

```json
{ "id": "3f2a…", "month": "2026-09", "version": "0.28.0",
  "arch": "arm64", "layout": "aio", "db": "embedded" }
```

The settings page shows you that exact object before you agree to it — not a description of it, the literal
thing, built by the same code that sends it, so the two cannot drift apart.

- **The id changes every month.** It is a hash of a secret that never leaves your server plus the current
  month. Two pings in one month count as one install; two pings in different months cannot be linked to each
  other — not by us, and not by anyone who obtained the data, because the secret is not in it.
- **No library, no titles, no accounts, no address, no hostname.** A test fails the build if a field is ever
  added to that payload, because a field added quietly is a field you were never shown.
- **The collector stores no IP and no clock time**, only the UTC date, and access logging is off for that
  endpoint so there is no side channel that re-identifies a row. Anything unrecognised in a ping is dropped
  rather than stored. Months older than a year are deleted.
- **Turning it off destroys the secret** and asks the collector to forget the current month. Turning it back
  on later makes a new id — it cannot resume the old one, which is the honest behaviour even though it means
  a returning install looks like a new one.
- `GET https://uchiyomi.com/api/hello` shows the running totals, so you can see what your ping became.

The two switches are deliberately separate and point at different servers. If the update check went to a
server this project runs, that server could count installs from its access log whether or not anyone
consented, and "updates on, counting off" would be a setting that did nothing. Keeping them apart is what
makes the off position real, and there is a test that fails if they ever converge.

`UCHIYOMI_PING_URL` repoints the count at your own collector, or disables it outright if set empty.

## v0.27.0 — 2026-09-09

### One Library, and its filters finally organised

Browse was a second Library. `/browse?genre=Horror` ran the same search over the same collection and drew it
in the same grid as `/library?genres=Horror` — the only thing it had of its own was the wall of genre tiles.
So the tab is gone, and the wall's useful half has moved to where you were going to end up anyway.

The Library's own controls had drifted into a pile: three horizontally-scrolling rows of chips, one of them
seven wide, mixing four sort options with a Filters button, an 18+ toggle and a Select toggle — nothing
saying which were sorts and which were filters. Behind the Filters button, the genre list was a flat wall of
**ninety-three unsorted, uncounted, unsearchable words**.

All of it now lives in one panel with labelled sections — **Sort by**, **Library**, **Read state**,
**Status**, **Format**, **Genres**. On a laptop the panel sits down the left of the grid and stays there. On
a phone it opens as a proper sheet: one Filters button instead of a row of seven chips.

What came across from Browse:

- **Genres are counted and ranked**, biggest first, each with a small mosaic of covers from that shelf — the
  part of the old tile wall that made it worth looking at, at a size that suits a list.
- **Formats stay separate from genres.** Manhwa covers 161 of the 2,132 series on the library this was built
  against, so ranked by size it outranks every actual genre while saying nothing about what a book is like.
- **Surprise me**, the random-series button, is now beside the Library title.
- A **search box** over the genres, so ninety-three of them is a list rather than a wall.

Two things fixed on the way past:

- The genre list used to come from an endpoint that returns genres exactly as they are spelled, while the
  filter matches them case-insensitively. That is 100 chips for 93 genres: "Martial arts" and "Martial Arts"
  appeared as two, and either one returned the same series. They are now one.
- Picking a library used to filter the grid while the Filters badge said nothing was filtered, because the
  library tabs were counted as navigation rather than as a filter. Now everything that narrows the shelf
  counts, and `Clear all` clears all of it.

The publication statuses — Ongoing, Completed, Hiatus, Cancelled — were being title-cased in code rather
than translated, so they read in English in all eight languages. They are translated now.

### Large displays have been a column short this whole time

Found while measuring the new layout, and older than it. Five cover grids — library, search (twice),
discover and the admin picker — each ended with a step like `min-[1800px]:grid-cols-10`, and **not one of
them had ever applied**. Tailwind emits that kind of breakpoint before its own named ones, so on a 1920px
display the earlier `2xl` rule came later in the stylesheet and won.

Nothing failed, because a grid one step short of its own source code still looks like a grid. Measured in a
browser at 2560px: seven columns of 314px covers where the class list asked for ten.

The extra breakpoints are now declared properly, and a test refuses any responsive step that a later rule
would override. It found the fifth grid on its first run.

### The last of the MangaRead covers

Different fault from v0.26.3, and this one was doubling the listing.

The listing parser reads the same series link out of three different pieces of markup, and one of the three
patterns dropped the trailing slash from the URL while the other two kept it. On any site that writes the
slash — MangaRead does — the check for "have I already seen this series?" never matched. Every series came
back **twice**: once properly, and once more named after its `alt` text and carrying no cover at all.

Measured against a live MangaRead listing: twelve series parsed as twenty-four. Because a source page keeps
the first 24 results, that also means half of what MangaRead offered on Discover was a copy of the other
half. The proper entries came first and the blank ones after, which is why it looked like a few missing
covers rather than a doubled list.

The three passes now agree on the key. The URL a series is *stored* under is untouched, so nothing already
in a library is affected. This also fixes the reverse case, which nobody had reported: a site writing the
slash on its headings but not its thumbnails loses **every** cover rather than half of them.

It hid for so long because every fixture in the test file wrote URLs without a trailing slash — the one
shape that breaks was the one shape the tests never used. It is now asserted in both directions.

## v0.26.3 — 2026-09-09

### The rest of the grey covers, and why they broke on their own

v0.26.2 fixed the covers that came from the extension engine. The ones that remained — some of a source's
covers working and others not, on the same page — were a different fault with a much more ordinary cause.

Sites that load images lazily put a spacer in the `src` attribute and the real picture in `data-src`. The
code that reads a cover out of that markup was written as one regular expression listing both attributes,
which reads as a preference and is not one: which attribute wins is decided by regex mechanics and by the
order the site happened to write them in. Two different spellings of that expression were in use, in
different parts of the code, and they failed on **opposite** attribute orders.

So a cover was right or wrong depending on nothing but markup order — which is the whole answer to why
covers that worked for months stopped without anything changing here: the site reordered its markup, and the
extraction quietly flipped. It is also why only *some* series were affected rather than all of them.

There is now one place that answers "which attribute holds the picture", and it answers by preference:
`data-src`, then the other lazy attributes, then `srcset`, and `src` only as a last resort. Every engine uses
it. The same fault was present in the code that reads **page images**, where it would have served placeholder
pages rather than placeholder covers — nobody had hit it yet.

### A picture repeated on every card is not a cover

When a listing comes back with the same image on three or more different series, that image is a placeholder
and the covers were not parsed. Rather than show one picture twenty times — which is a confident lie — the
cover is dropped, and the fallbacks that already exist take over: the artwork from AniList for a series in
your library, then its first downloaded page, and otherwise the app's own empty tile.

### Sources are now checked for this, not just for whether they answer

The daily source check already fetched a listing and a series page and looked only at whether they returned
anything. It now also compares them: when the two disagree about the same series' cover, one of the two
parsers is wrong, and that is exactly the fault above — visible without waiting for somebody to notice grey
tiles. It also notices one image repeated across a listing, and a listing that has lost its covers entirely.

Reported in Admin → Health, never as a failure: a source whose covers are wrong still fetches and reads
perfectly well, and marking it broken would turn a cosmetic fault into an outage.

### Security

Two Dependabot advisories, both about zip extraction following symlinks, neither with a published fix.
Assessed rather than ignored: one is a test-only dependency that never reaches a running server, and the
other is used here solely to *build* archives — the vulnerable extraction call is never made, and untrusted
archives are read by a different library entirely. A test now enforces that second claim, so if extraction is
ever added, it fails rather than quietly making the assessment untrue.

## v0.26.2 — 2026-09-09

### Discover's grey covers

Whole rails of Discover showed a grey box with a broken-image icon instead of cover art — every result from
an affected source, permanently. The cause is a fix colliding with a design.

v0.21.0 hardened the cover proxy so it could not be pointed at anything on the local network, because the URL
it fetches is supplied by whoever asks. Separately, the extension engine serves every cover through itself,
so an extension source's cover lives at the engine's own address — which is on the local network. The guard
did exactly what it was written to do, to the app's own engine, and the result was served as a grey
placeholder and then cached under the real cover's key with a one-year lifetime.

The proxy now recognises the one address it is configured to talk to and fetches covers from it, exactly as
the extension-icon route already did. That is a single origin, matched whole — not a rule about private
addresses, which would hand back the capability the original fix removed.

Two more things were wrong in the same place, and both outlived the cause:

- **A failure was cached as though it were the picture.** A cover that could not be fetched wrote its grey
  stand-in under the real cover's key, marked immutable for a year, with nothing able to clear it. One bad
  minute on a source's CDN — or a single hiccup from a name server, which the guard cannot tell apart from a
  blocked address — meant a grey tile until the cache overflowed. Placeholders are no longer stored, and
  expire in a minute.
- **The grey already on your screen would have stayed.** Browsers keep those year-long copies by address, so
  the address changed too, and the server-side entries written under the old scheme are now unreachable.

### The Cloudflare solver says when it is behind, and speaks up when it dies

The solver announces its version and the app printed it and compared it to nothing. Admin → Health now says
when a newer release is out. It is advice, never an alarm: if GitHub is unreachable, rate-limited, or returns
something unfamiliar, the app has no opinion rather than a problem — a health page that can fail because a
third party is having an afternoon is worse than no version check at all.

The bigger gap was that the solver's health was only ever examined when somebody opened the Health tab. A
solver that died at two in the morning stayed dead until it was noticed, while every Cloudflare-protected
source failed and blamed itself — the exact confusion that check exists to clear up. It now runs hourly and
notifies on a change, in both directions, so a recovery is reported too and a long outage does not become
hourly noise.

## v0.26.1 — 2026-09-08

### The background jobs keep up now

Fingerprinting ran **once**, five minutes after the server started, and never again. Nothing else asked for
it either — not a library scan, not the updater sweep, not adding a series from Discover — so every chapter
downloaded after that single pass went unprocessed until the container happened to restart. A server that
simply stays up was the worst case, which is exactly backwards.

The effect was invisible because it looks like nothing: the reader treats an un-fingerprinted page as an
ordinary page, so the feature just quietly stopped applying to anything new. Measured on a real library the
day it shipped: 22 chapters, all added after that morning's boot, still untouched hours later, with 50 to 80
more arriving daily.

Both backfills now re-check every six hours, re-arming after each pass — including a pass that failed, since
a job that stops rescheduling because one batch went wrong is the same bug wearing a different hat. The long
first delay stays: page fingerprinting decodes every page in the library and should not compete with a server
that has just booted.

The same fault was in the older chapter-fingerprint job, which feeds folder rematch. Fixed alongside.

### Marking a page by hand no longer switches the feature off for that chapter

Marking a page as repeated wrote a row that made the chapter look already-processed, so it was dropped from
the queue for good — its other pages were never fingerprinted and the automatic rule never ran there again.
Marking one advert turned detection off for the whole chapter, and it was most likely on a **new** series,
where the backlog is exactly the chapters being opened.

A chapter is now recorded as looked-at only when it has actually been looked at.

### Admin → Tasks shows the backlog

The number of chapters still waiting was calculated, sent to the browser and then discarded, so a job that had
quietly stopped picking up work looked identical to one with nothing left to do. Each task now shows how many
items are outstanding, and the schedule reads honestly instead of claiming the job runs once.

## v0.26.0 — 2026-09-08

### A repeated page folds down instead of disappearing

v0.25.0 removed the pages that are not the story — the credit page, the advert — from the chapter you were
reading. That was the wrong shape, and reading with it for a day made the reason plain: a chapter was quietly
shorter than it really was, a floating chip announced the fact at every chapter start whether you cared or
not, and there was no way to see what was going to be removed before it went.

Now the page stays exactly where it is, drawn as a thin band of itself with a label. You scroll past it in an
instant, or tap it to open it in place and tap **collapse** to fold it away again. The band is a slice of the
real page, so you can see it is the credit page rather than take our word for it — which is the part that was
missing. The floating chip is gone: the notice sits where the page is, which is both harder to miss and
impossible to mistake for a comment about something else.

**Repeated pages** in reader settings now offers *Show all*, *Collapse* (the default) and *Hide*. *Hide* is
the old behaviour for anyone who wants the page gone outright, chip and all. Reading page-by-page rather than
scrolling, *Collapse* still removes — a slide is one whole page wide, so there is no room for a band, and in
that mode an unwanted page costs a swipe rather than a scroll anyway.

### Four bugs that removal had been causing

Putting the page back in the list the reader counts with fixed a set of failures that all had the same root:
while pages were being removed, a position in the chapter and a page number were two different things, and
several places assumed they were the same.

- **Resume and saved Moments landed late.** Opening a Moment saved on page 3 took you to page 4 — one page
  further on for every repeated page earlier in the chapter. Silently, because arriving a page on is
  indistinguishable from having read that far.
- **The chapter divider vanished** when a chapter opened on a credit page, taking the "Up Next" heading with
  it — and because the same marker keeps a chapter's first page unpaired, every double-page spread in that
  chapter was shifted by one.
- **Tapping a dimmed tile in the page grid** scrolled to the top of the entire library instead of to the page
  you tapped.
- **A chapter that was entirely furniture disappeared**, and continuous reading walked from the chapter
  before it to the chapter after with nothing in between.

The reading flow is now built in one place, `web/lib/readerFlow.ts`, where it can be tested — which is why
these were reachable at all. Each has a test that fails when the old behaviour is put back.

## v0.25.2 — 2026-09-08

### Blank slices were being skipped as if they were the same page

The fingerprint asks, sixty-four times, whether a pixel is brighter than the one to its **right**. So the only
variation it can see is variation across a row. The guard meant to refuse featureless pages measured something
subtly different — the brightest and darkest pixel anywhere in the page.

Those come apart on exactly the kind of page a long-strip webtoon is full of. A slice that fades from black at
the top to white at the bottom has the widest possible range, 255, and sails through a guard asking for 8 — while
every left-to-right comparison on it is a tie. All sixty-four answers come back "no", the fingerprint is all
zeros, and *every* such slice in the library carries that same fingerprint. They were being matched to each other
and skipped.

This was not theoretical. On a real 42,000-chapter library the all-zero fingerprint alone was hiding 100 pages,
and in one series 59 of the 166 skipped pages were this. The guard now measures what the fingerprint actually
reads, and a page with no left-to-right variation is refused, as was always intended.

Fixing the guard is not enough by itself, because fingerprints already recorded were written by the old one and
the background job never revisits a chapter it has seen. So the same rule is applied where the matching happens:
a fingerprint in which almost every comparison was a tie is no longer accepted as evidence that two pages are the
same page. That takes effect immediately, without re-reading anything.

Some genuinely repeated near-blank separators stop being skipped as a result. They are blank slices, so this
shows up as a sliver of nothing rather than a missing panel — and fewer skips is the direction this feature is
meant to be wrong in.

## v0.25.1 — 2026-09-08

### The page-hash job could never finish

Found by watching v0.25.0 run against a real library, which is the only place it shows.

The job picks its next batch by asking for chapters that have no page fingerprints yet, and it writes a row
per page. A chapter that yields *no* pages — an unreadable archive, an empty one, a file that has since been
moved — therefore wrote nothing, and so was still "not looked at yet" when the next batch was chosen. Working
chapters get their rows and drop out; broken ones accumulate. The moment they are all that is left, the loop
has nothing to exhaust and spins on them, at full CPU, forever.

One such chapter in a library is enough, which on any library of real size is close to a certainty.

A chapter that produced nothing now records that it was looked at, so it drops out of the queue like any
other. That mark is inert everywhere else: it carries no fingerprint, so it can never match another page, and
it is never offered to the reader as a page to skip.

### A chapter is never mostly skipped

The same first real run turned up the failure this feature is least allowed to have. Across seven thousand
fingerprinted chapters the average chapter had 1.4 pages of furniture and under 6% of all pages were
flagged — but a few hundred chapters wanted to skip a third or more of themselves, and the worst wanted 68
pages out of 88.

Those are duplicate and phantom chapters, where the same file is filed under several chapter numbers. Every
page then genuinely does recur across chapters, so the arithmetic is right and the conclusion is nonsense.
Nothing inside the rule can tell that case apart, so the chapter's own shape is the check: if more than a
third of a chapter is about to be skipped, the automatic decision is thrown away and the chapter reads
exactly as it always did. Fewer skips, which is the direction this feature is always wrong in.

A page you marked by hand is never subject to that cap. It is the one input that is not arithmetic, and the
entire point of it is that it outranks the rule.

## v0.25.0 — 2026-09-08

### The pages that are not the story

Every chapter of a scanlated series opens with the same credit page. Some carry an advert, or a "read the
rest at…" splash. You swipe past them, chapter after chapter, and they are the single most repetitive thing
about reading here. No manga reader does anything about this — the closest thing in any adjacent product is
Jellyfin skipping a TV intro.

Uchiyomi now finds them and skips them, and the way it decides is deliberately dull. A credit page is *the
same image in every chapter of that series*, so a page whose fingerprint turns up in three or more chapters
is furniture. That is arithmetic, not a guess about what a page looks like: story pages are not the same
picture twice. Three chapters and not two, because two chapters sharing a title card is a coincidence, and
two is the commonest state of a part-downloaded series.

It only ever compares chapters within one series, even though the same group's credit page across *different*
series would be stronger evidence still. Flagging across series means a page could be hidden in a book whose
chapters nobody ever compared, and missing a few skips is a far better failure than that.

Nothing is ever hidden without saying so. A skipped page leaves a quiet chip — *skipped 1 repeated page —
show* — that puts it back with one tap, and the page grid still lists every page, dimmed and labelled, so the
chapter you see is never secretly shorter than the chapter you have. You can mark a page as junk by hand, or
rescue one it got wrong; either decision is permanent and outranks the arithmetic in both directions, which
is what makes skipping safe to leave on by default. It is a switch in reader settings if you would rather it
did not. Pages are fingerprinted by a background job, alongside the other library jobs in Admin → Tasks.

One honest limit: a chapter you downloaded *before* its pages were fingerprinted keeps the flags it was saved
with, until you download it again.

### Things this app claimed that were not true

Four of them, found by reading our own documentation against our own code.

Push notifications are listed as a feature; they need a pair of keys that only the developer setup script
ever generated, so on a normal install the button was not missing-with-a-reason, it was simply absent. The
server now generates and keeps those keys on first boot, exactly as it already did for its signing secret.

`docs/CONFIGURATION.md` said `.env.example` was the authoritative list of settings. Twenty-one of twenty-three
were not in it, including the ones most worth touching on a small server — how many series a sweep may check,
the free-space floor, how long a Cloudflare-protected source is allowed. They are all there now, with their
real defaults.

The v0.6.0 changelog announced that renaming a folder no longer loses your series. That code ships switched
off and appeared in no example file. It is documented now, off by default, with its `report` mode explained.

And a badge added yesterday, showing which series you have downloaded, went stale the moment you downloaded
another — the function that refreshes it had no callers. Mine, from the day before.

### Thanks

[@hawwwwwk](https://github.com/hawwwwwk) again, for [#32](https://github.com/AngeloSha/uchiyomi/pull/32):
`docs/INSTALL.md` still described a database container that has not existed since v0.18.0. Second time he has
caught stale install docs.

## v0.24.0 — 2026-09-07

### The app opens on a plane

Launching the installed app in airplane mode showed the sign-in screen, with the chapters you had downloaded
for exactly this sitting on the device, unreachable. Tapping a chapter *inside* an already-running app has
worked since v0.20.0; a cold start never has, and the code said so — the browser tests carried a note calling
it out of scope, and v0.20.0's own changelog admitted it.

Two things were being thrown away. The session check could not tell "the server rejected you" from "there is
no server to ask": both came back as a plain no, and a plain no means sign in. And the signed-in account was
remembered only in memory, while every downloaded chapter is filed under whose it is — so even past the
sign-in screen the reader would have found nothing, which is a worse failure, because it reads as though the
downloads are gone.

Now a device that had a session keeps it when the server is simply unreachable, and opens on your Downloads
with a banner naming the account. The reader works exactly as it does in a tunnel today. Everything needing
the server is dimmed rather than hidden, because there is nothing behind it until you reconnect — and the
moment you do, it checks in, clears the banner and sends up whatever you read.

The part that took the most care is the part nobody sees. This is a multi-user app and household devices get
shared, so: signing out ends it immediately — the next offline launch asks for a password and lists nothing,
though the files stay on disk and become readable again when that account signs back in. If the server ever
answers that the session is gone, the device signs itself out. The grace expires exactly when the login
itself would have, which the server now tells the app rather than the app assuming. And nothing new is
stored that could serve as a credential: the record says who you were, not how to prove it.

Right-to-left manga also read its double-page spreads in the wrong order offline. The downloaded chapter had
carried the reading direction all along; the reader threw it away and left a comment saying the information
was not available, one field from where it was.

### A README the size of its category

504 lines and 4,797 words, against a median of 132 and 743 across Komga, Kavita, Mihon, Stump, Suwayomi and
Audiobookshelf. The install section alone was longer than five of those six READMEs in their entirety, and
44 lines of it warned about upgrade problems from v0.9.0 and earlier — fourteen releases ago, and already
written down in this file.

It is 141 lines now. Almost nothing was deleted: the platform-by-platform install moved to `docs/INSTALL.md`,
the environment variables to `docs/CONFIGURATION.md`, and the comparison against other readers to
`docs/COMPARISON.md`, where a table making dated claims about five moving projects is less likely to be the
second thing a visitor reads.

## v0.23.0 — 2026-09-07

### Three gradients start rendering what they were written to render

Tailwind v3's opacity scale is multiples of five. `via-ink-950/88`, `to-ink-950/62` and
`via-ink-950/72` are not, so all three matched nothing and were dropped without a warning — the sign-in
screen, the profile header and Wrapped have always drawn a lighter scrim than their code asked for. Tailwind
v4 accepts any integer and would have started honouring them, which on the sign-in screen turns the cover
collage to mud. They are removed rather than adopted: a dependency upgrade is not the moment to restyle a
screen, and making it darker is a decision someone should make on purpose. It is the same shape as the
fog-200 bug this project already keeps a test for — a value that simply produces nothing.

### Tailwind 4

The config file is gone; the theme is an `@theme` block in the stylesheet. Everything carried over, and the
parts that could not be translated were rebuilt: the accent colour, which is themeable at runtime and had no
v4 equivalent for its opacity placeholder; the font variables, which would have become self-referential and
dropped the app to the browser's default typeface; and the placeholder colour, which v4 stopped providing, so
every empty input on this black background would have read as filled. Four utilities changed meaning rather
than name and were rewritten to keep what they meant.

Two visible changes are kept on purpose. Hover styles no longer apply on touch devices, which is what a
phone should do — no more state stuck on a card after a tap. And the wrapper the language switcher uses is
finally invisible to layout; the folder it lives in was never scanned before.

### An empty digest fails the build instead of half-publishing

The release pipeline recorded whatever digest the build step produced, and that action only sets one when
there is image metadata. An empty value went into the artifact the merge job trusts, and the merge matrix
does not stop on a failed sibling — the exact route to a version tag over one architecture instead of two,
which has happened twice. It now fails the build leg. The two publishing actions moved a major version each
at the same time, checked against their source rather than their release notes.

### Smaller things that were already built

A saved page can be un-saved from Moments, which is where you go to look at saved pages; the API for it had
existed since the first commit with no button anywhere. Wrapped draws the weekday breakdown it was already
computing — it knew your busiest day and never showed the week behind it. And the README mentions Moments
and the Reading Studio, which shipped three versions ago without ever being written down.

## v0.22.0 — 2026-09-07

### Next 16 and TypeScript 7, which had to arrive together

TypeScript 7 is the compiler rewritten in Go, and it removes options rather than deprecating them:
`baseUrl` is gone, and so is the classic `node10` module resolution that `"moduleResolution": "Node"`
selected. The backend now says `node16` for both `module` and `moduleResolution`, which still emits
CommonJS -- the shipped `dist/` has the same shape it always had -- and only changes which algorithm finds
a package.

The frontend could not take TypeScript 7 on its own. On Next 15 the compiler resolved `@/*` perfectly well
and the bundler then could not, failing every import of `@/lib/*`; Next 16 resolves it. So the two upgrades
were never separable, and both workspaces moved at once rather than leaving one on a compiler the other
cannot build with.

Offline reading was the thing worth checking, because Next 16 changed how a route is prefetched: Next 15
fetched one payload per route, and 16 fetches a tree and a page segment, with the route's own query string
attached. With the network cut entirely, a downloaded chapter still opens, still decodes its pages out of
IndexedDB, still has both chapter arrows live, and still never falls through to the sign-in page or shows a
raw payload as text.

### A dependency round

undici 6 to 8 and `@node-rs/argon2` 1.8.3 to 2.2.0 on the backend, plus three GitHub Actions. argon2 is a
native module and a password hash is not a thing to be casual about, so the check that mattered was not
that it builds: a hash generated by 1.8.3 was verified under 2.2.0 on both musl and glibc, with the wrong
password still refused on both. Nobody has to change their password.

### The browser suite names what failed

A console error used to be reported with the page it happened on and nothing else, while the failing
resource's URL sat unused in the same event -- which is a bad position to debug from, and was exactly the
position Next 16 left us in. It now prints the resource, and when a run is already red it prints the type of
every request that failed. Requests that fail while the suite is deliberately holding the browser offline
are listed but no longer counted as faults: cutting the network and then reporting that a network request
failed was the harness marking its own test setup as a defect.

## v0.21.0 — 2026-09-07

### The cover proxy stops fetching whatever it is told to

`/img/sources/cover` took a URL and fetched it. It checked the scheme and nothing else, and any signed-in
account — or anything holding an OPDS token — could point it at the server's own network: the database, the
extension engine, the solver, the LAN, a cloud metadata endpoint. It was not even blind about it, because a
failure handed back the upstream status code, which turns the route into a working port scanner, and
anything the image pipeline could decode came back as a picture.

It now refuses anything that is not a public address, resolves the hostname before trusting it, re-checks
every redirect hop rather than letting one bounce it somewhere private, and answers a flat 502 instead of
reporting what it found. A blocked URL is served the same placeholder as any other unusable cover, so there
is no difference to measure.

Two-factor recovery codes were 40 bits, stored unsalted; each one bypasses 2FA on its own. They are 80 bits
now. Image authorisation moved to cover the whole `/img/` prefix, because it lived inside one plugin and any
future plugin serving image bytes would silently have had none. And the HTML stripping that cleans scraped
titles now runs to a fixed point, so a tag cannot survive by being split in half.

### Titles that are not in English can be added again

MangaDex asked only for English chapters, so a series scanlated solely into Spanish or Portuguese reported
zero chapters and could not be added at all — indistinguishable from a dead series. English is still
preferred; when there is none, it now falls back through a fixed language order, one language at a time, so
the chapter list stays coherent rather than mixing languages arbitrarily.

### Node 24, and a dependency sweep

The runtime moves to Node 24 LTS across all three images, CI, and both workspaces at once. Node 26 was
offered but does not become LTS until late October, and shipping a self-hosted product on a Current release
is the wrong trade. zod 4, framer-motion 13, sharp 0.35.4, nginx 1.31 and five GitHub Actions majors all
landed with them.

### Unraid instructions that work

Adding a template repository URL has not worked since Unraid 6.10 removed the field, and the file behind it
has not been read at all since 7.3 — so the documented steps sent people to a box that no longer exists.
The template file now gets copied onto the server instead, which is what Unraid actually reads. Found by
[@hawwwwwk](https://github.com/hawwwwwk).

### Also

`:latest` is now gated on the tag not being a prerelease. It was gated on every image publishing
successfully, but nothing stopped a release candidate from claiming it.

## v0.20.0 — 2026-09-06

### Moments: the pages you saved, as the pages you saved

The bookmark star in the reader has always written to an API that keeps the series, chapter, page and a note
for up to five hundred saved pages, and nothing anywhere rendered that list. You could save a page and never
find it again. `/moments` shows each one as the actual panel, grouped by series, and a note can finally be
attached to a page or to a series. There are four ways in — the top bar, your profile, the series page and
the command palette — and deliberately not a seventh item in the bottom nav, which at 390px would leave
55px per item for German and Russian to clip.

A complete notes API had been sitting unused since the first commit: four routes, a table, an index and a
foreign key, with no frontend reference anywhere. Giving it a screen is what revealed that two of those
routes had no visibility check at all — see below.

### The unread badge counts what is unread

Every cover badge in the app showed the total number of chapters in the series and never moved, however much
you had read. The per-user figure was being computed correctly the whole time and thrown away. Fixed on the
server rather than in the card, because `booksUnreadCount` is a Komga-shaped field that OPDS clients read
too. Extracting that logic also closed a gap nobody had noticed: your favourites rail and the contents of a
collection were returning series with no per-user state at all.

### A reader that pairs, retries and lets you move

A landscape double-page spread — already two pages wide — was pinned beside a portrait page and squeezed to
half width, and because it filled one slot instead of two, every pair after it in the chapter was off by one.
Wide pages, and the page before them, now get a slide of their own.

Reader pages were plain images with no error handling, so a single failed request left a broken glyph until
you reloaded the whole chapter; they now retry once and then offer a button. The chapter list was a dropdown
marked desktop-only, which meant that on a phone the only way through a series was one chapter at a time —
it is a sheet at every width now, and it opens where you already are. The page counter opens a thumbnail
grid of the chapter.

### The Reading Studio, and a Wrapped you can look back through

The profile's Reading tab held four settings cards and no reading. It now has a calendar heatmap, a pace
line and a weekday breakdown, over 90, 180 or 365 days. `/wrapped` gained a year picker: it had always
accepted `?year=`, and both callers hardcoded the current one, so every past year was computed on request
and unreachable.

`/api/wrapped` was bucketing years in the database's timezone and months and weekdays in the server's, while
`/api/stats` next door used UTC. The two endpoints disagreed with each other, and a chapter finished on New
Year's Eve counted in the wrong year for every reader west of UTC. Both are UTC now, and the new range
predicate can use the index where the old one scanned every event an account had ever recorded. "Top genres"
also meant "the genres of your top five series", each counted once whether you read three chapters of it or
three hundred; it is twenty series now, weighted by how much you actually read.

### Covers that tint their own card, and how far behind you are

Each card sets one custom property from its cover's dominant colour, and the existing glow and border tokens
read it, so a card lifts off the page in its own artwork's colour and every surface that does not set it is
unchanged. The series page can finally tell you a source has chapters you do not, from a number the updater
has been computing on a schedule for months and showing to nobody. Five rules keep a slow or unreachable
source from ever reading as alarming, and it is never red.

### Offline reading that works offline

Downloaded chapters opened at page one and announced that you had finished the series after every single
one, because both the resume page and the chapter list came from calls that cannot succeed offline. Progress
is now recorded alongside the download, the chapter list falls back to what you actually hold, and an unknown
list is no longer treated as an ending.

Underneath that, tapping a downloaded chapter with no network did not open the reader at all: the service
worker had no rule for the per-route payload Next fetches on every navigation, so the request went to the
network, failed, and the tab ended up showing that payload as raw text. It is cached per route now, and
navigations no longer all overwrite a single cache entry with whichever page was loaded last. A cold start
with no network still asks you to sign in — that needs the session, which needs the network.

### Fixed while we were in there

`GET /api/notes` and `POST /api/notes` had no visibility check of any kind: they answered for, and wrote
against, any series id at all — including one that had been deleted, one in a library your account has no
grant for, and one above your age cap. The listing also joined any book id stored on a note, so a note could
borrow the title of a chapter in a series you cannot see. Both are closed, and the note length cap now
applies on edit as well as on create, where it was previously bypassable by posting a short note and editing
it.

Saving a bookmark could erase a note written on it, because the star sends no note and the write treated
"absent" and "cleared" as the same thing.

## v0.19.0 — 2026-09-04

### Releases that build on the machine they run on

Every arm64 image used to be cross-built under emulation on an amd64 machine, and that broke four of the
last five releases the same way: the native-module builds hung until the timeout or died on an illegal
instruction, and re-running the failed half was the standing fix. Each architecture is now built on a
machine of that architecture and the two are merged into one image afterwards. The version tag exists only
once both halves do, and `latest` moves only once every image has both, so a half-built release cannot
reach anyone through either.

Every published image now carries a signed statement of which workflow built it from which commit, and a
software bill of materials. `gh attestation verify oci://ghcr.io/angelosha/uchiyomi:v0.19.0 --owner AngeloSha`
checks it.

### Watched dependencies, scanned code

Dependabot watches the two npm trees, the workflow actions and the base images of all three Dockerfiles,
weekly and grouped, so the eighteen-minute test run happens once per ecosystem per week rather than thirty
times. CodeQL scans the TypeScript on every push and weekly; findings land in the repository's Security tab.

### Unraid and Umbrel

An Unraid Community Applications template (`deploy/unraid/uchiyomi.xml`) and an Umbrel app
(`deploy/umbrel/uchiyomi/`), both the one-container layout with the database inside, which is what both
stores expect and what v0.18.0 made possible. Honesty note: the Umbrel manifest is written to Umbrel's
published format and tested for shape, but has not yet been run on umbrelOS itself; its store submission is
a pull request to Umbrel's app repository, and it pins the image by digest, which is filled in once this
release exists.

## v0.18.0 — 2026-09-04

### One container, database included

Leave `DATABASE_URL` unset and the container runs its own Postgres: initialised on first start in the
`uchiyomi_data` volume, listening on a unix socket only -- nothing outside the container can reach it and
there is no password to manage -- and started before the app so the app never races it. That one variable
is the whole switch. Set it, as every install before this release has, and none of it runs; the container
behaves exactly as it did.

`deploy/docker-compose.yml`, the file the install instructions curl, is now that one container plus the
optional solver and extension engine. The layout with a Postgres container beside the app is still shipped
as `deploy/docker-compose.external-db.yml` and is still supported; `docs/MIGRATING.md` has the move in both
directions, which is a dump and a restore over the socket. App stores expect a one-container app, and this
is what makes the Unraid and Umbrel manifests in the next release possible at all.

The container is now a supervisor for exactly two processes and knows which one is the database. On
`docker stop` the app finishes what it is writing and then Postgres stops cleanly (the compose file gives it
a 40 s grace period, because Docker's default ten would kill a checkpoint). If Postgres dies underneath the
app, the app is stopped so the container exits and `restart: unless-stopped` brings both back in order,
which is the opposite of what an init system's restart-the-service semantics would do to a database. A data
directory from a different Postgres major is refused up front, with the upgrade path named, rather than
crash-looping on an error nobody should have to decode. Docker's own healthcheck asks Postgres too when it
is inside, and the admin overview says which layout this is in one word.

The browser end-to-end suite now drives both layouts on every commit, and the entrypoint itself is driven
as a script with fake Postgres binaries that record their arguments. That harness caught two mistakes before
they shipped: the socket directory was never created when the container runs as a non-root `user:`, and the
app was launched through a shell function in the background -- which puts it in a subshell, so the signal
sent on `docker stop` would have stopped the subshell and left the app running with its database gone.

## v0.17.0 — 2026-09-04

### The API has a reference now, and it cannot fall behind

Every route the app has -- all 184 of them -- is described in one OpenAPI file, and the app serves it at
**`/api/docs`**: a browsable reference with "try it out", authenticated with the same token you would use
from a script. Each operation says what it does, what it takes, what it answers and how it is gated, and the
security schemes match the three ways in: a session or API token, the image cookie, the OPDS password.

The point is not the file but the test behind it. A hand-written reference goes stale the day someone adds
a route and forgets it; this one is checked against the routes the server actually registers, in both
directions, every time the suite runs, and so is the route list in `docs/api.md` -- which turned out to be
one short, with nothing to say so. The served version number must match the package too, so a release
cannot ship a reference claiming to be an older API.

## v0.16.0 — 2026-09-03

### An OPDS reader can read page by page, and filter what it sees

Until now an OPDS reader could do one thing with a chapter: download the whole CBZ. Panels, Chunky and
KOReader all stream pages over OPDS-PSE when a feed offers it -- the reader fetches page one, then page
two, and a long chapter starts in a second instead of after a download -- so every chapter entry now
carries the stream link: a page template, the page count, and where *this* reader last stopped, taken from
its own reading progress. Without a width the original page comes back, from the same cache the web reader
uses; ask for a width and you get a JPEG no wider than that. A reader that does not know the extension sees
nothing different and keeps downloading.

The series feeds carry facets: sort, library, genre and status, each with how many of your series it would
leave, marked when in force, and combinable. Search is now the same feed as the listing, so it pages and
filters too, where before it stopped at sixty hits with no way past them. Counts come from the same gated
source as the listing, and a library is only offered as a filter when you can see more than one -- a count
is a disclosure, and "Library (1)" would have said a hidden one exists.

Every `<updated>` in the catalogue was the moment of the request. A reader that checks for changes saw the
whole library change on every fetch. A series now carries its newest chapter's time, a chapter its own, and
a feed the newest of its entries.

### 18+ libraries in a reader, if that reader is the one you want them in

The web app has a reveal button for 18+ libraries; an OPDS reader has no button, so it always got them
hidden, with no way to ask. The choice now lives on the OPDS credential itself -- **Profile → External
readers → Include 18+ libraries in this reader** -- off by default, and per credential rather than per
account, because the phone in a pocket and the e-reader on the shelf are different audiences for the same
person. Your age limit, if you have one, applies whatever the switch says; that is a permission, and this is
not.

### Two things found on the way

**The chapter list of a series answered 500, and had since v0.8.0.** The query behind
`/opds/series/:id` reused the parameter list of the lookup above it, so Postgres was handed a value it could
never type and refused the whole statement. It shipped that way on 2026-08-23 and has been in every release
since; nobody on this install had opened a chapter list in a reader, which is the only reason it stayed
quiet. It works now, and the test drives it over HTTP against a real archive.

**Paging links were escaped twice.** A reader paging past sixty series was sent `&amp;amp;page=1`, decoded
that to a query key named `amp;page`, and started again from page one. Links are now built raw and escaped
exactly once, where they are written.

## v0.15.1 — 2026-09-03

### A source behind Cloudflare gets the time its challenge takes

Every wait in the app was one number regardless of how a source answers. A plain site answers in a second;
a site behind Cloudflare answers only after the solver has driven a real browser through a challenge, which
for the source that carries most of this library takes about a minute. The nightly sweep gave a listing 20
seconds and lost 15 of that source's series to it, every sweep. The fill scan gave a search 45 seconds and
lost the same source at exactly the moment it mattered. A minute-long challenge against a 20-second wait is a
structural loss, not a flaky site.

Sources that need the solver now get a budget that fits it (`SOLVER_BUDGET_MS`, 90 seconds) for listings,
searches and the add path; everything else keeps the short waits it had.

### Chapters that keep failing identically are left alone

Over three sweeps the same seventeen chapters failed three times each with the same page counts (94 of 95,
151 of 176), nothing that had failed twice ever landed, and together they cost 26 of every 150 download
attempts, every sweep, indefinitely. After three failed tries (`CHAPTER_RETRY_CAP`) the sweep now leaves a
chapter alone and says how many it skipped. The health page shows them with their counts, "find missing
chapters" on the series still fetches them on purpose, and the moment one lands its record clears itself.

### One series got its source back

*The Avenger's Reincarnation Eldmia Ega* had been frozen since its extension was removed on 20 August. It is
now pointed at Mangakakalot, which lists it under "Eldmia Ega, the Reincarnated Avenger", and picked up two
of its four newer chapters straight away.

## v0.15.0 — 2026-09-03

### Extensions now actually update themselves

Uchiyomi has had an automatic extension updater since v0.11. On the install it was written for it had, as far
as can be told, never updated a single extension.

The reason is one missing call. Suwayomi does not poll its repositories; it recalculates "an update is
available" only when it is told to re-read them. Uchiyomi asked for that in exactly three places, all of them
buttons in Admin. The nightly job that installed updates was not one of them. So every night it read a
catalogue whose freshness depended on somebody having pressed **Refresh**, found nothing marked as updatable,
and reported a clean run. Fifteen extensions installed, zero flagged, while the repository behind them
published roughly every fifteen hours.

Extension updates are now their own scheduled task, running every 6 hours, and the first thing it does is
re-read the repositories. It appears in **Admin → Server → Tasks** with its last run, its result and a **Run
now** button, and it can be switched off in Settings, in which case it still tells you what is waiting.

**Update all** had the same bug and is fixed the same way: it refreshes before it updates, so it can no
longer tell you everything is up to date by consulting a catalogue from three weeks ago.

While fixing that, four related things that were invisible:

- **A repository that cannot be read is no longer silence.** An unreachable repository and a genuinely
  up-to-date library produced identical output. A failed refresh is now a named outcome, shown in the panel
  and pushed once — not once per check, because an engine that is down stays down.
- **Your repository list survives the engine's volume.** It was stored only inside the extension engine, in
  the volume people delete when it misbehaves, and it was not in the nightly backup. Uchiyomi now keeps its
  own copy, adopts whatever the engine has on first run, and puts the list back — along with the extensions
  you had installed — if that volume is wiped. It cannot restore which series came from which extension;
  nothing outside the engine ever knew those ids.
- **Abandoned extensions are named.** An installed extension no repository offers any more keeps working and
  will never update again. It is now reported. It is never uninstalled: that would orphan every series routed
  through it.
- **Updates wait for the chapter updater.** Swapping an extension out while a library sweep is using it
  breaks that sweep's downloads. The check now defers, and says that it did.

An extension you remove in the engine's own interface stays removed. The check reports it and leaves it alone.

## v0.14.4 — 2026-09-03

### The extension engine can no longer download into its own volume, and says when it is down

Three compose files describe the same optional extension engine, and they had drifted. The development file
set `AUTO_DOWNLOAD_CHAPTERS: "false"` and explained in a comment that the engine "must never write into" the
library. `deploy/docker-compose.yml` -- the file the README tells you to download -- set only the timezone.

So an install done the documented way ran an engine that would download chapters into its own Docker volume
the first time a series from an extension source was followed: a second copy of the library that nothing
manages, prunes, backs up, or shows you. Both deploy files now carry the setting, and a test compares all
three so they cannot drift again.

The engine also had no healthcheck in any file, so a wedged JVM was indistinguishable from a healthy one in
`docker ps` and the only symptom was the app timing out. It has one now. It is written with bash rather than
curl because the image ships no curl, wget or nc, and it treats 401 as alive -- an engine with authentication
switched on is up, not broken.

Deliberately no `depends_on`: the service is optional and the compose file tells you how to remove it, and a
`depends_on` pointing at a removed service makes `docker compose up` fail outright.

Also:

- `.env.example` documents the `SUWAYOMI_*` variables. The extensions guide told you to edit `.env`, and the
  example file it referred to had never mentioned them.
- The comment above the extensions API said Uchiyomi "never fetches or installs extension APKs itself" and
  that installing was a link out to the engine's own interface. That stopped being true the day the catalogue
  was written, ninety lines below it.

## v0.14.3 — 2026-09-03

### "Find missing chapters" stops calling sources broken for waiting their turn

With many sources installed, the scan asked all of them at once. The Cloudflare solver runs four at a time,
so most of the queue spent its entire 45 second budget waiting for a slot and was then reported as "could
not be reached". In one real scan, 16 of 21 candidates were sources that never got a turn.

Three changes:

- A search's clock starts when it starts, not while it waits. The scan now holds a solver slot before the
  timer runs, so a source is only "unreachable" if it actually failed to answer.
- Sources are asked in a sensible order: the series' own source, then sources in its language, then sources
  that publish in several languages, and only then sources pinned to another language.
- The scan stops asking once enough sources have the title (three, `SCAN_ENOUGH`). Sources it did not get to
  are listed as "not asked", which is what they are, rather than as broken or as not having it.

Nothing about which sources are installed or enabled changed; only how the scan uses them.

## v0.14.2 — 2026-09-03

### Small things that were quietly wrong

Each of these was known and written down a week ago. None was the biggest thing at the time, and all of
them are the kind of defect that produces no error and no log line.

- **A stale tab could rewind your place.** The server refuses a progress write older than the one it has,
  but only when the write carries a timestamp. The offline queue always sent one; the live path never did,
  so every live ping was accepted unconditionally, and a desktop tab left open on chapter 3 could still
  rewind the phone that had read to chapter 9. The live write now carries its clock.
- **Two definitions of "gap".** The health page and "find missing chapters" each computed missing chapters
  their own way, and on a series that starts at chapter 0 and jumps to 93 they disagreed: health said no
  gaps, the dialog offered to fetch 92. Both green in their own tests. There is one definition now, the
  dialog's, and the health page uses it.
- **Chapters were written less carefully than the thumbnail cache.** A chapter file was written straight
  onto its final name, and the "already downloaded" check is a bare look for that name, so a container
  restarted mid-download could leave a half-chapter that was then skipped forever. The cache already wrote
  to a temporary name and renamed on success; the library now does too, and abandoned temporaries are
  swept on boot. The nightly database dump gets the same treatment, so a backup interrupted halfway does not
  masquerade as a completed one.
- **The safe backend is now the default.** `LIBRARY_BACKEND` had to be exactly `owned` for the permission
  model to apply; unset or misspelled, the code fell back to the legacy mode whose model is "the other
  server enforces it", which on this backend means no restriction at all, on the path that serves page
  images and OPDS downloads. Every compose file sets the variable, which is exactly why nobody noticed. Only
  an explicit `komga` selects the legacy mode now.
- **Deploys no longer starve the nightly sweep.** The first sweep after boot waited a full interval, so
  every deploy pushed it out by six hours; on a day with three releases the library did not update at all,
  measured. The time of the last completed sweep is now kept, and a restart schedules whatever remains of
  the interval, with a ten-minute floor.
- **Stopping the server stops the sweep at a chapter boundary.** There was no signal handler at all: a
  restart mid-sweep killed it mid-chapter, the job card kept polling a run that no longer existed, and
  nothing recorded that it had been interrupted rather than finished. The sweep now ends between chapters
  on SIGTERM and reports `stopped: shutdown`.

## v0.14.1 — 2026-09-03

### The fill dialog stops recommending sources that have never worked

"Find missing chapters" checked one thing before offering a source: whether its cooldown had lapsed. Not its
record. So a source could be offered as a clean option while sitting in a nineteen-deep failure streak, or
having never once completed a download here. WeebCentral had refused every image byte since June, and
because listing chapters still worked it rendered as a confident "Fetch 12 chapters" button.

Hiding those sources would have been the obvious fix, and it would have been wrong: a streak is cleared only
by a successful download, which is the very thing hiding it prevents. So the dialog now shows the record
under the button instead: "Recently unreliable · refused us 3 times in a row · never completed a download
here". The decision stays with the person, with the facts in front of them.

### Series that can never update are now said out loud

When an extension is removed, the series that came from it keep reading fine and quietly stop updating
forever. The nightly sweep counted them as "unrouted" and threw the count away; their health row, if any,
said fine because nothing had ever been asked. One series had been frozen that way for twelve days.

The health page now lists them, with the fix: re-add the extension, or point the series at a source that
carries it.

### Removing an extension no longer leaves its health rows behind

Uninstalling deleted the sources but not their health rows, which had accumulated a dozen orphans, three of
them recording 404s from the evening their extensions were pulled. They are now removed with the extension,
except for a source that still has series, whose row is the only record those series ever had a home.

## v0.14.0 — 2026-09-02

### The nightly sweep stopped sabotaging itself

Last night's sweep reported `ok=61, blocked=164`. One chapter came up 25 images short, and those 25 had
arrived as HTTP 200 with nothing in them, which turned out to be the one kind of page failure that set no
status at all. The blame code fell through to its harshest default, a 30-minute cooldown, on the source
that carries 192 of your 226 series. Every later series on that source was skipped for the night. Nothing
was logged.

Four things changed, each measured before it was written:

- **An empty body is not a refusal.** A CDN answering 200 with nothing behind it now reads as "not serving",
  the 5-minute tier, and only when more than half the chapter is missing. Half the chapter arriving as real
  images proves the CDN is up and the holes are per-image.
- **The sweep has a budget**, 150 attempts by default (`UPDATER_SWEEP_MAX`). That fits inside the six-hour
  interval and drains the backlog the moved-domain fix uncovered in about three weeks, instead of hitting it
  as hard as possible every night. Chapters already on disk cost nothing against it.
- **Sources take turns.** One queue per source, visited round-robin, least-recently-checked first. A source
  that goes into a cooldown parks its own queue and nobody else's, and whatever a sweep leaves unvisited goes
  first next time instead of never. Under the old order the 54 series furthest behind sorted last.
- **The disk has a floor**, 10 GiB by default (`MIN_FREE_GB`). Nothing checked free space before; the first
  sign would have been a half-written chapter.

The sweep's log line now says how many series it visited and whether the budget or the disk stopped it.

### Failures are written down

A chapter that would not download was a bumped counter. "12 chapters could not be saved" was the whole
record: which series, which chapter, which source and why existed nowhere, and the next sweep tried the
same ones again. Every failure now logs one line naming all four, and is kept per chapter with how many
times it has been tried. The health page lists them by source, and the entry disappears the moment the
chapter lands.

The admin overview also says how far behind the library is, from what each source said the last time it
was asked. Until now that number could not be known without asking every source again.

## v0.13.2 — 2026-09-02

### Sidebar covers were being counted as chapter pages

Chapter pages are read out of the reader block on the page. When that block did not match, the code fell
back to scanning the *whole* document, and these sites carry a sidebar of other series. Measured on one
chapter: 96 "pages", the last of which was the cover of a completely unrelated title.

That is not cosmetic. The number of page URLs is what a chapter is measured against, so junk entries make a
chapter that fetched every real page still look short. A short chapter is refused, and a big enough
shortfall is reported as the *source* failing. A parsing slip was being charged to the site, and then the
site was put in a cooldown for it.

Covers are now never counted, and a chapter's pages are taken from the one directory they all share, so a
handful of sidebar images cannot survive even when the block match fails.

### We were crashing the Cloudflare solver ourselves

Looking for missing chapters searches every source you have. It did that all at once, and the solver drives
real browsers, so a dozen simultaneous challenges made it log "Task queue depth is 4" and then
"Error starting Chrome". A crashed solve arrives looking exactly like the site refusing us, so the fan-out
was manufacturing source failures out of nothing.

Solves are now capped at four at a time (`SOLVER_CONCURRENCY`).

### A source that could not be reached said nothing at all

If a search threw or timed out, the source was dropped from the results silently, which looks identical to
"that source does not have this title". Aqua Manga holds 192 of the 224 series here, and it was being
dropped from *every* scan because its Cloudflare challenge takes about 63 seconds against a 20 second
budget. Nothing anywhere said so.

Sources that could not be asked are now listed with the reason, and the budget was raised to 45 seconds so
a source waiting its turn behind the new solver cap is not counted as broken.

## v0.13.1 — 2026-09-02

### Downloads stopped going too fast and then blaming the site

"Act Like a Boss Monster, Mr. Swallow!" would not fill its missing chapters, 34 to 92, from any source. Six
attempts over three days put zero chapters into that gap. The sites were not the problem. We were.

A chapter here is 110 to 130 images. The pause that existed was between *chapters*, not between images, so
each chapter went out as a burst of a hundred-odd requests back to back, two chapters at a time. Measured at
the moment it broke: about two images a second, sustained for minutes. Both sites eventually said "slow
down" (HTTP 429), which is a fair thing for them to say. We were not banned: at a third of a request per
second the same hosts served us normally minutes later.

What happened next is the part that was mine. A 429 arrives with the remedy attached, namely how long to
wait. That instruction was only honoured if at least one image had already arrived. When the very first
image was refused, the whole wait-and-retry step was skipped, so the chapter was written off as
"0 of 115 pages" 1.28 seconds after a single request, the source was put in a cooldown, and because a
cooldown ends the entire run, the other 58 chapters were abandoned untried. Every attempt died inside
chapter 34.

The nightly sweep then compounded it. It was the one place that did not stop when a source refused, so it
asked for four more chapters that were never going to arrive, and each refusal lengthened the cooldown:
15 minutes, then 30, 45, 60, 75. A single burst locked the source for over an hour, which is why trying
again by hand did not work either.

Three changes:

- A quarter of a second between images. A 120-page chapter takes about 30 seconds longer. A cooldown took
  75 minutes.
- A 429 is now waited out and the chapter resumes where it stopped, up to three times, going slower after
  each one. A source still refusing after that is genuinely refusing, and is treated exactly as before.
- The nightly sweep stops at the first refusal, which is what both other callers already did.

One more thing worth knowing: trying "a different source" was less different than it looked. Mangakakalot
and Natomanga run the same engine here and serve their images from the same CDN, so five of the six
attempts were effectively the same site.

### The Cloudflare cookie that was never kept

Before fetching a chapter's images we ask the solver for a clearance cookie by loading the image host's
front page. An image CDN has no front page: it answers 403, the solver reports that as a block, and the
cookie was thrown away with it. Nothing was ever cached, so this repeated for every single chapter, and
every image was then fetched with no cookie at all, on exactly the hosts that were refusing us.

It now falls back to the image address we are about to fetch, which does exist and so can be solved, and
remembers a host that cannot be solved rather than asking again on every chapter.

## v0.13.0 — 2026-09-01

### Series kept asking a site that had moved

"Mr Devourer, Please Act Like a Final Boss" would not download anything new, and nor would most of the
library. Aqua Manga moved from aquareader.net to aquareader.org, the address was updated here, which is the
right thing to do, and it changed nothing. A series stores the full address it was added with, one per
series, so the 176 Aqua series added before the move went on asking the old host.

What hid it is the shape of the failure. The old host still answers. It just answers with a "page not found"
page rather than an error, so the fetch succeeded, the chapter list came back empty, and an empty chapter
list looks exactly like a series with nothing new. Every surface reported healthy, including the health
checks. All 176 series on the old address had gone a fortnight with no new file; of the 16 already on the new
one, 12 had not.

Now a stored address pointing at a host the site no longer uses is pointed at the current one as it is read.
Changing a site's address in settings is you saying it moved, and that now applies to series already in the
library rather than only to new ones. The series that was listing 0 chapters lists 142.

### Extensions say when they are out of date, and say when they cannot update

A failed extension update was invisible here. The nightly check tried, the attempt threw, and the error was
discarded on the spot: nothing logged, nothing shown, and no difference between "this failed" and "there was
nothing to do". The only trace was a stack trace in the extension server's own log, which is not somewhere
anyone looks.

- The extensions panel now says how many installed extensions are out of date, with an Update all button
  beside it. The per-extension Update button is unchanged.
- A failed update is reported with a reason in plain words. "HTTP error 404" becomes "the repository no
  longer offers that version to download", which is the repository's problem rather than yours.
- Admins are notified when an update fails, and both outcomes are written to the audit log.

Update all runs the same code the nightly check runs, rather than a second copy of it that could drift.

## v0.12.2 — 2026-09-01

### Asking a site to slow down, instead of ignoring it

v0.12.1 stopped a lost page from blaming the whole site, and it worked. Retrying the fill straight afterwards
got further and then stopped again, this time for a real reason: Mangakakalot asked us to slow down and we
kept asking anyway.

A chapter here is around a hundred images, fetched one after another with no pause between them. The pause
that exists is between *chapters*, not between pages. So three chapters in a row is a few hundred rapid
requests, and the site starts refusing. What made it worse is that the refusal changed nothing: the loop
carried on and asked for the remaining ninety-odd pages too, collected ninety-odd more refusals, and turned
a pause into a chapter that had lost most of itself.

Now, when a site says slow down, we stop asking, wait for as long as it asked for, and pick up the pages we
missed. In the ordinary case the chapter simply completes a few seconds later instead of failing.

If a site is still refusing after that wait, the run stops and says so, which is the same as before and is
the right thing: at that point it is not a blip, it is a no.

## v0.12.1 — 2026-09-01

### One missing page stopped blaming the whole site

You pressed "find missing chapters" and it fetched 3 of 92. That was my fault, not the sites'.

A chapter that comes back short is refused, because writing an incomplete one leaves a file that is then
skipped forever. That part was right. What was wrong is what happened next: it also marked the whole source
as failing and put it in a cooldown, no matter how small the shortfall. Two of your sources were sitting in
one over **98 of 101 pages** and **109 of 110**. Since every download run stops when a source starts
refusing, your 92-chapter fill stopped at the first chapter that lost a single image.

It was costing more than that one button. Across the last four nightly updates the library gained 26 chapters
and lost 40, with seven or eight series skipped each night for sources that were not really broken.

Three changes:

* **Pages that fail are asked for a second time.** Almost every one of these is a single image on a busy
  server that answers fine a moment later. One extra request, instead of losing the chapter and the day.
* **A shortfall is only the site's fault when it is a real one.** Losing a page or two out of a hundred is
  now recorded against that chapter and nothing else. Losing a fifth of a chapter, or being told no outright,
  still counts against the source exactly as before.
* **One bad chapter no longer ends the whole run.** It is skipped, counted and reported, and the rest of the
  run carries on.

The two sources have been let out of their cooldown, so the chapters you were waiting for can arrive.

## v0.12.0 — 2026-08-31

### Find missing chapters

A new button on every series page. It asks every source you have whether it carries this series, works out
which of your missing chapters it could supply, shows you what it found, and fetches only after you say yes.

v0.11.3 fixed the usual reason a series is short, and for most of them the nightly update now repairs itself.
This is for the rest: a series whose own source genuinely never had the early chapters, where the only way to
complete it is to take them from somewhere else.

**It asks before it fetches, and that is the whole point.** A chapter is stored under its number, so a chapter
taken from the wrong series lands exactly where the right one belongs, looks correct in every list, and is
only discovered by opening it. So the dialog shows you which source, what the series is called *there* (often
something quite different: yours is listed elsewhere as "Mr Devourer, Please Act Like a Final Boss"), how many
of your existing chapters line up, and how many it would add. Nothing is downloaded until you press a button
that repeats all of that back to you.

Sources it checked and rejected are listed too, with the reason, because "this one has it but numbers its
chapters differently" is worth seeing.

It will not offer:

* a source whose numbering does not line up with yours, which is what catches a series that restarts counting
  each season, and most cases of the wrong series entirely
* chapters before the beginning or after the end of what you have, since those are not gaps, they are simply
  where you have got to
* a hole where the two sides do not agree on the chapters either side of it
* anything at all on a series with fewer than three chapters, because there is not enough there to tell one
  series from another

If a source has it under a name too different to find, there is a box to search under that name instead.

Progress appears in the same downloads panel as everything else, and it keeps going if you close the dialog.

## v0.11.3 — 2026-08-31

### Series from Mangakakalot and Natomanga were arriving two-thirds empty

Someone opened a series and found chapter 93 was the first one in it. It was not that series: it was every
series from those two sites.

Both run on the same reader engine here, and the way it read a chapter list was to fetch the series page and
take the links out of it. That page only ever shows the newest fifty chapters, and it says so nowhere. There
is no "next page" to click, no "load more", no "showing 50 of 145". It is simply a list that stops. So every
series added from those two sites arrived with only its most recent fifty chapters, and the nightly update
could never repair it, because it kept asking the same page and kept getting the same fifty.

On this library that was **7 of the 10 series** from those sources, about **528 chapters** missing. The worst
was down to 8 chapters out of 76.

The page does name where the rest live: there is a proper chapter-list feed behind it, which the site's own
front end uses. The engine now reads that instead, following it to the end rather than stopping at the first
fifty, and falls back to reading the page the old way for the older sites that do not offer it.

Two of the affected series, before and after:

```
Act Like a Boss Monster, Mr. Swallow!    51  ->  145 chapters
Return of the War God                    57  ->  176 chapters
```

The missing chapters will fill in over the coming nights, oldest first.

**A second thing came free.** That feed also carries each chapter's real release date, which these two sites
never gave us any other way. New chapters from them will be properly dated instead of undated, so "released
3 months ago" on the series page starts being true for them.

## v0.11.2 — 2026-08-31

### Fixes "Loading chapter..." never finishing

A regression introduced by v0.11.1 the same day, and the reason to be sorry rather than pleased about it.

v0.11.1 moved the offline store to a new version so that downloaded chapters could belong to an account.
A browser will not change a database's version while anything else still has it open, and the service worker
had it open: it opened the store to send queued reading and never closed it again, on any path out. So the
upgrade waited for a worker that was never going to let go, the page waited for the upgrade, and the reader
waited for the page. Because the reader checks for a downloaded copy before it asks the server, that wait
happened before anything could be drawn, and every chapter showed "Loading chapter..." for good.

Three things changed, because any one of them alone leaves the door open:

* The service worker now closes the store on every path out, and steps aside immediately if a page needs to
  change the version while it is working.
* The page no longer waits indefinitely for a store it cannot open. If something is holding the old version,
  it gives up at once and reads online instead, and tries again next time rather than giving up for good.
* A store that cannot be opened now means "nothing is downloaded" rather than an error, so a cache that is
  unavailable can never stop you reading.

If you are stuck right now, closing every tab of the app and opening it again clears it, because that
releases the connection that is holding the upgrade.

This is squarely the same failure the previous two releases were spent on: something that could not answer,
where nothing was built to notice. The v0.11.0 work gave the reader a failure state, and a failure state does
not help when the answer never arrives at all. There is now a test that squats on the old version and asserts
the reader still gets an answer; with the shipped code it hangs until the runner is killed.

## v0.11.1 — 2026-08-30

### Two ways one account could reach another account's things

Both found by auditing the running instance rather than the code, and both are the same shape as the
sign-out fix in v0.11.0: something that is correct for one person and wrong the moment a device is shared.

**Downloaded chapters had no owner.** Offline chapters were stored under the chapter's id alone, with no
record of who downloaded them, and signing out did not remove them. The reader checks that store before it
asks the server, which means for anything downloaded the store IS the permission check. So on a shared
tablet or PC, one person could download chapters, sign out, and the next person to sign in could open them
by opening those chapters, with the age limit and the library permissions never consulted.

Everything downloaded is now filed under the account that downloaded it, and is simply not there for anyone
else. Signing back in brings your own downloads back, so this is scoping rather than deletion.

The same applied more quietly to reading that had not yet reached the server: a queue left behind by one
person would have been filed against whoever signed in next, taking their streak and leaderboard position
with it. Queued reading now waits for the person who did the reading.

**One thing to expect on this upgrade:** chapters downloaded before today are removed, because nothing about
them records who saved them and there is no honest way to assign an owner after the fact. They can be
downloaded again. Reading progress is untouched, including anything still queued.

**An internal detail was readable by any signed-in account.** One source-status route answered with the raw
health record, including the last error text, which names internal addresses and ports. The public route
fifteen lines above it goes out of its way not to publish that, and says so in a comment. The leaking one
was a duplicate of a properly restricted admin route that the admin page has always used instead, and
nothing else ever called it, so it is gone rather than merely restricted.

## v0.11.0 — 2026-08-30

### Twelve things that were failing without telling you

This release came out of auditing a running instance rather than reading the code, and everything in it has
the same shape: the app said nothing was wrong, and something was being lost anyway. They are listed roughly
by what they cost.

**Getting signed out at random.** One browser is one cookie jar, but it runs several refresh timers over it:
every open tab has its own, and so does the offline worker. Two tabs left open collided every twelve minutes,
and the one that lost the race deleted the login the winner had just written. Both tabs, and the whole
device, were signed out. On a family server that means someone locked out until an adult resets their
password. A login that was rotated a moment ago is now recognised for what it is. Signing out, or being
signed out by an admin, still takes effect instantly.

**Reading that vanished after a trip.** Chapters finished offline queue up and send when you reconnect. That
queue counted every failure the same way and deleted the entry on the fifth attempt, so a bad connection was
treated exactly like a corrupted record. Finish twenty chapters on a plane, land somewhere with a flaky
captive portal, and the lot was silently discarded: progress, streaks and Continue Reading all rewound. Only a
genuine, permanent rejection can discard something you read now.

**One person's library showing up for the next.** On a shared tablet, the stored copies of pages like your
home screen, history and stats were never cleared when you signed out, and one network hiccup was enough for
the next person to be shown them, including titles their age limit is meant to hide. Signing in or out now
clears them. The same store also had no size limit and grew forever, which on an iPhone eventually pushes out
your downloaded chapters.

**Restrictions that lifted themselves.** If the database stumbled while checking which libraries an account
may see, the answer came back as "all of them, with no age limit". That check now fails safe.

**Key art you should not have been able to see.** Every image route checks whether you may see the series.
One did not.

**Chapters filed under the wrong series.** Finishing a chapter let the app tell the server which series it
belonged to. After merging two duplicate entries, a phone that had been offline could file its reading under
the version that no longer exists, where it counted for nothing and quietly disappeared from Continue
Reading. The server works this out for itself now.

**A bookmark that jumped backwards.** A queued page from six hours ago could overwrite where you had since
read to on another device. Events now carry the time they happened, and the most recent one wins. Turning back
a page still works exactly as before.

**Nightly updates that could stop entirely.** Six different ways for the update sweep to fail all reported
"+0 chapters", which is also what a perfectly quiet night reports. Every source could have been broken for
weeks and the admin page would have looked fine. It now says which sources did not answer, and one hung site
no longer holds up the whole sweep.

**A black screen in the reader.** A damaged file, a library that is not mounted, or a chapter someone else
deleted all produced either a black screen with no explanation or, part-way through a series, the "You
finished" card. There is now a message saying which it is, and a Try again button.

**Deleting a member left no trace.** It is the most destructive thing the admin page can do, removing
someone's entire reading history, and it was the only action that recorded nothing. It now records what was
removed and who removed it.

**Backups that reported clean when they were not.** The backup already knew when it had failed to capture the
config folder, and knew when it could not measure itself, and then threw both facts away before anyone could
see them.

**Two things quietly filling the disk.** Half-written image files that the cleanup could not see, so it
reported the cache under its limit while the folder was over it; and failed offline downloads leaving page
data behind that nothing could reach, including "clear all downloads".

Nine new test files came with these, and every fix was checked by putting the original bug back and confirming
the test noticed.

## v0.10.2 — 2026-08-30

### The Add button stops being where you wait

v0.10.1 moved the downloading out from behind the button, and measuring the result showed the button still
took twenty-three seconds to answer. The reason turned out to be worse than slowness.

Opening the add window asks the site for the series and its chapter list, which is how it can tell you "120
chapters". Pressing Add then asked the site for exactly the same two things all over again, a few seconds
later, and asked for them one after the other rather than together. On a site behind a bot check, each of
those questions costs a real browser challenge, so opening the window and pressing Add paid for four of them
to learn two facts.

Both now share one answer, fetched once and remembered for a minute and a half. In the ordinary case —
open, glance, press Add — the button does no network work at all before replying.

The window's own opening pause is unchanged, because that part is the site's own cost rather than ours.

## v0.10.1 — 2026-08-29

### Adding a series tells you straight away

Pressing Add left the button saying "Working…" for up to a minute, and the only way to learn that it had in
fact started was to close the dialog and find it further down the Discover page. On one install that wait
was measured at fifteen, forty-eight and fifty-nine seconds.

The reason is that the request downloaded the whole first chapter before it answered. It no longer does.
Everything that decides what to tell you still happens first, so you are still told immediately if the title
is already in your library, if you have it from another source, or if there is nothing to download. Only the
fetching happens afterwards, which is what the app was already doing for every chapter after the first.

**Downloads now follow you.** A small indicator appears wherever you are while anything is downloading,
showing what it is and how far along, and it opens to a list. Previously progress lived in one strip on
Discover, below the hero and hidden behind the add window itself, so navigating away meant losing sight of
it entirely.

**A download that fails now says why.** It names the source and how far it got, instead of the same single
sentence for every possible cause, and it stays until you dismiss it. Finished downloads now clear
themselves after a few minutes; before this they were never removed at all and simply accumulated.

Two smaller things this fixes. An add that took longer than two minutes used to report "Add failed" while
succeeding perfectly well in the background. And pressing Escape, or clicking outside the window, while an
add was in flight closed it and left you with no confirmation at all.

## v0.10.0 — 2026-08-28

### Discover shows you where things come from, and lets you choose

The row of source names above the wall was information and nothing else: which sources were asked, and how
each one answered. It is now the place you steer from.

**Sources show their own icons.** Extension sources have always sent one; the app fetched it and threw it
away. Sites you added yourself now show their own favicon, and anything without a usable icon gets a
lettered tile in a colour of its own rather than a blank square.

**Tap a source to see only its titles**, and tap again to go back to all of them. This is instant and
changes nothing about what is loading: every source carries on filling in behind the filter, so there is no
waiting and nothing to lose by trying it.

**Newest or Popular**, for the whole wall. This is each source's *own* ranking rather than anything this
server works out — most sites already publish a popularity listing beside their recently-updated one, and
extensions have always offered both. Sources that cannot offer one step aside while Popular is chosen.
Switching between the two is instant the second time, because neither view discards the other's work.

## v0.9.12 — 2026-08-28

### The rest of the missing covers

v0.9.11 fixed two ways a listing could go wrong and left a third in place. Sites of one family were still
returning a wall where half the entries had no artwork.

A listing page carries more than its listing: alongside it sit "popular" and "recommended" panels, and those
links look enough like results to be mistaken for them. They also appear near the top of the page, so they
were taking places from real entries — and since those panels show no thumbnails, the places they took came
out blank. The listing itself is now read on its own, and the panels beside it are left alone. Sites that
lay their pages out differently are unaffected.

Measured against a live listing: twenty-four titles, twenty-four covers, where before thirteen of the
twenty-four had none.

## v0.9.11 — 2026-08-28

### Covers come back, and chapters stop pretending to be series

Two separate faults, both visible on the Discover wall as cards that were wrong rather than missing, so
nothing anywhere reported a problem.

**Half of some walls were not series at all.** A listing page shows each title alongside its newest
chapters, and both live at similar addresses. The reader was treating those chapter links as if they were
series, so a wall of twenty-four could be twelve real titles and twelve entries called "Chapter 2" or
"Chapter 156" — each with no cover, because a chapter page has none to show. This arrived in v0.9.8 and is
now gone: only a link to a series itself is accepted.

**Some sites returned every title with no artwork.** Sites built on the same engine do not agree on how they
mark up a thumbnail, and only one of the conventions was recognised. A site using the other returned a full
wall of blank cards. Both are now read, along with a third arrangement some themes use.

Fixing that surfaced a third fault underneath. Where a site provides a placeholder image and the real cover
separately — which is how a page avoids loading every picture at once — which of the two was picked came
down to the order the site happened to write them in, rather than to any preference. Sometimes the
placeholder won, and a card showed a grey square. The real cover is now chosen deliberately.

Also worth stating, since it looks like a bug and is not: a listing showing fifteen cards for six series is
correct. A title appears once for each of its recent chapters, and collapsing those into one result is the
right answer.

## v0.9.10 — 2026-08-28

### A slow source is no longer treated as a broken one

Discover gives each source a few seconds to return its newest page. When that ran out, the source was
recorded as having failed, and a failing source is put aside for five to thirty minutes — during which it is
not asked at all. So a source that was merely slower than the time allowed was punished by having taken away
from it the only thing that could have shown it working, and the punishment grew each time.

That is not a hypothetical. On the install this was found on, the largest source — holding 190 of 215 series
— answered perfectly well in about eleven and a half seconds, against a budget of eight. It disappeared from
Discover for a day while every health check, which allows itself far longer, kept correctly reporting it
healthy. The two were never measuring the same thing.

Running out of our own patience is now recorded as its own fact. It cannot escalate, and it cannot make a
slow source look like a blocked one. A single slow answer costs the source nothing at all. Only once it is
clearly a pattern does the source get a short, fixed pause — enough that browsing does not spend the whole
budget on the same source over and over, never enough to hide it — and it is ranked below sources that
answer in time rather than removed. A page that arrives in time clears the record.

A source in that state now says so plainly, and names the setting to change and the number it keeps
exceeding, instead of reporting an unexplained failure.

Sites that genuinely refuse us are unaffected: those still back off hard, because asking a refusing site
again soon costs something and gains nothing.

## v0.9.9 — 2026-08-28

### The source check no longer cries wolf

The first real run of the daily check reported the healthiest source on a live install as blocked. It was
working: 190 series, answering normally.

The check asks each site directly, on purpose, without the Cloudflare solver in the way, because that is
what separates "the site is down" from "the solver is broken". But a site behind Cloudflare answers a
request like that with a refusal every single time. That is the challenge page, not a verdict, and it was
being read as one.

Two corrections. A source that just demonstrated it can search, list chapters and serve pages is now
reported as working, whatever a bare request to its homepage made of it. And a refusal to such a request is
no longer treated as evidence for sources that reach their site through the solver, since for those it is
simply the expected answer.

The check also gets longer to work with. A source behind the solver makes several requests in sequence, each
taking a few seconds, and the old budget was tight enough that a healthy source could run out of time
mid-check, which then became the wrong conclusion rather than no conclusion.

## v0.9.8 — 2026-08-27

### Sources are now checked for you

A source that dies quietly stays dead. It answers with an empty page, throws no error, records nothing, and
goes on reporting itself healthy. One install ran six weeks that way: its main site, holding 189 of 215
series, had its domain quietly repurposed into an unrelated website, and the only symptom was that some dots
on Discover looked wrong.

There is now a daily check. It asks each site directly, exercises the source end to end, and writes down
what it finds. Two things it fixes by itself, because both have exactly one correct answer and both can be
verified before committing to them:

- **A site that has moved** is followed to its new address, but only after the new address proves it can
  still search, list chapters and serve pages. If it cannot, the change is rolled back. This matters more
  than it sounds: on the install this was built for, one dead site redirected to a chat community and
  another to a page serving "404 Not Found" with a success code. Both would have looked like moves.
- **Extensions with an update available** are updated.

Everything else is reported rather than acted on: a site refusing the server, a listing that has changed
shape, a host that has gone. Those need a judgement call, and disabling a source over what turns out to be a
two-hour outage is worse than leaving it be. Admins get a notification when something needs them, and
Admin, Sources, Providers has a **Check all now** button that runs the identical sweep on demand.

### Two sources repaired

Manganato-engine sites had stopped listing anything. The path the engine asked for, `/genre-all`, now
answers successfully with a page containing no series at all, which is exactly the silent failure above. It
now asks for the current listing path and keeps the old one as a fallback for sites that still serve it.

## v0.9.7 — 2026-08-27

### The trending hero shows the slides it has

v0.9.6 took the hero from five titles to ten and then hid the fact. Its position dots are drawn as a sliding
window, capped so that a long carousel cannot push the row off the side of a phone, and that cap was applied
at every screen size. The row therefore looked identical whether it held five slides or ten.

The overflow it guards against was only ever a phone problem. The window now follows the space available:
every dot on a desktop, the compact window on a phone.

## v0.9.6 — 2026-08-27

### Failing sources now say what is wrong, and what to do about it

Discover showed a dot beside each source: green when it came back with covers, grey when it did not. Grey
turned out to mean four unrelated things, and the two worth knowing about were invisible.

A source serving out a cooldown is never asked at all, so it returns an empty list and looks exactly like a
healthy source with nothing new. And an empty answer was recorded nowhere: a Cloudflare check served as an
ordinary page, or a site that had changed its layout, produced no error, so nothing was ever written down.
A source could be broken for weeks while looking merely quiet.

Both are now visible. An empty answer is counted without being treated as a failure, which matters: several
sites answer a failed check with an empty page rather than an error, and treating that as success would wipe
a cooldown that was recorded for good reason. A source that keeps answering with nothing is marked as such,
sorted below the ones that work, and says so on Discover with an estimate of when it will be tried again.

Admin, Sources, Providers gains a **Test** button. It goes and looks at the site right now, deliberately
without the Cloudflare solver in the way, then exercises the source end to end and reports which step failed.
That distinction is the whole point: a site that answers this server directly while the solver is failing is
a solver problem, not a site problem, and those two were indistinguishable before.

The reason is written in plain language with a suggested fix, rather than as the raw recorded error. Five
different faults used to record the single word "timeout".

Custom sites can finally have their address changed. Previously the only options were add and delete, and
deleting loses the link to every series that came from that source, so following a site to a new domain
meant orphaning your library.

### The Cloudflare solver stops failing silently

Chrome cannot run in Docker's default 64 MB of shared memory. It was crashing mid-check, and the app
faithfully reported that as the *sites* blocking us. The solver also leaks memory, reaching 2.5 GB after two
months here, and a bloated one fails in that same misleading way.

It now gets the memory it needs, a cap so a leak restarts it instead of degrading it, and a health check, so
"running" and "working" stop being the same thing. The health page carries it as its own line and points at
it directly when several sources fail at once and all of them blame it.

Also fixed: the health page's count of how many series depend on a source, which compared a display name to
an id and so always reported zero.

### More on the Discover hero

The trending hero rotates through ten titles instead of five, a little quicker, and preloads the next one.

Raising the number alone would have done nothing on a large library. The hero only used titles with wide
banner art, and of forty trending titles only sixteen have any; on a 215-series library just seven survived
the filter for things you do not already own. It now fills the remaining slots from titles with ordinary
cover art, which it already knew how to display.

## v0.9.5 — 2026-08-27

### Discover no longer stalls, and the language chips are gone

Switching language before the wall had finished loading left covers stuck loading, sometimes for the rest of
the session. That was a bug, not slowness.

Each source on the wall reports back when it settles. The report fires on a change, and a source that
appeared under both the old and the new language never changed: it kept its place, kept its cached answer,
and so never reported again — while the page had just forgotten it. The wall was then permanently waiting on
a source that had already answered, which is why the loading tiles never resolved, the progress bar stuck,
and scrolling for more stopped working.

Two things made it worse. Switching could fire ten requests at once instead of four. And nothing was
cancelled, so every abandoned request still cost the server its full eight-second budget — and a request that
times out puts that source on a cooldown for the next five to thirty minutes. Clicking impatiently actively
made the wall emptier.

**The language chips are removed.** They were the trigger, and the thing they were solving is better solved
by ranking: healthy sources first, then the ones your library actually came from. The source chips above the
wall are the filter now, and they still show which sources are being asked and how each one answered.

The causes are fixed separately from the trigger, since the same failure would return the moment anything
else restarted the wall. Requests are now cancelled when abandoned, so changing your mind no longer costs a
source its availability for half an hour.

Also fixed: with the add dialog open on the hero, every source that finished loading refired a search across
every source — a fan-out with a 25-second timeout each, over and over, while the wall filled in behind it.

### A sharper sign-in wall on high-DPI screens

The cover wall behind the sign-in screen looked soft on a 2K display. A screen at that pixel ratio asks for
5120 pixels of image and was handed 2560, then stretched them. There is a larger twin now, and the page picks
it only on screens that can use it — an ordinary display still takes the small one.

## v0.9.4 — 2026-08-26

### A wall of covers behind the sign-in screen

The login screen sat on a single piece of key art. It now sits behind a tilted grid of cover tiles, which is
what a manga library should look like before you have signed into it.

The tiles are cut from the art Uchiyomi already ships — the twelve genre backdrops plus the login, splash,
wrapped, hero and section pieces — at several crop positions each, because at wall scale a different crop of
one image reads as a different book. Seventeen sources give fifty-nine tiles. `scripts/login-wall.py`
composes them and is seeded, so it rebuilds the same wall every time.

**It is deliberately not your library.** The sign-in screen is pre-authentication, so anything on it is
visible to anyone who can reach your server. Feeding it real covers would serve titles and art straight past
per-library access, per-user age caps and the 18+ hide, and the service worker would then keep those covers
in a cache that survives signing out on a shared device. The wall is generated art, and the sign-in screen
still requests no images from your library at all.

Also fixed: the backdrop's entrance animation ignored `prefers-reduced-motion`. The CSS rule that handles
this everywhere else cannot reach a JavaScript animation, so that screen never honoured the setting.

## v0.9.3 — 2026-08-25

### The dependency tree answers for itself

Turning on GitHub's vulnerability alerts surfaced **49 findings** across the two lockfiles, four of them
critical. This release clears them.

**The ones that were real.** The API ran `fast-jwt` 4 — the library that verifies every login token — which
has since accumulated three critical advisories (auth bypass via an empty HMAC secret with async key
resolvers, cache confusion that can return one token's claims for another, and an algorithm-confusion fix
bypass). None of the three is reachable with Uchiyomi's configuration, which uses a static HS256 secret and
no RSA — but "not reachable today" is not an argument for keeping a known-broken verifier under the auth
system. Alongside it: `@fastify/static` (route-guard bypass via path traversal — it serves the web app in
the single container), `fastify` itself (a Content-Type parsing quirk that bypasses body validation),
`sharp` (inherited libvips CVEs — it processes untrusted images downloaded from sources), and `adm-zip`
(a crafted ZIP forcing a 4 GB allocation — it opens CBZs fetched from sources).

All of those fixes live on the far side of a framework major, so the whole family moved together:
**Fastify 4 → 5** with `@fastify/jwt` 10 (carrying `fast-jwt` 6.3), `@fastify/static` 10, and new majors of
compress, helmet, cors, cookie and rate-limit; plus `sharp` 0.35 and `adm-zip` 0.6. The entire 476-test
suite, the mounted-route wiring tests and the browser end-to-end pass unchanged on the new major — and
tokens signed by the old verifier still verify under the new one (and vice versa), so **nobody is signed
out by upgrading**, or by rolling back.

**The ones that were theoretical.** Thirty findings pointed at Next.js. The web app is a **static export**:
there is no Next server, no middleware, no Server Actions and no image optimizer running anywhere in
production, so none of those advisories was reachable. They are cleared anyway — **Next 14 → 15, React
18 → 19** — because an install page full of open advisories makes a reader do the reachability analysis
themselves. Next also vendors its own old copy of `postcss`; an override pins the patched one everywhere.

One finding remains open by necessity: `extract-zip`, a development-only dependency of the browser-test
harness, has no patched release to move to. It never ships in any image.


### The repo now runs what it ships

Cloning the repo and running `docker compose up -d` gave you the deprecated two-container split, while every
document told you the install is one container. `scripts/setup.sh` did the same, and the README offered it as
a normal alternative to the browser setup step without saying which layout it started.

`docker compose up -d` now builds **`yomi-app`** from `Dockerfile.aio` — the same single container the
released image ships and the only layout the end-to-end tests drive. The split is still there and still
buildable from source, because its images are still published on every release; it moved behind a profile:

```bash
docker compose --profile split up -d     # yomi-bff + yomi-web, on SPLIT_WEB_PORT (8081)
```

It gets its own port on purpose: the profile adds services rather than replacing them, so both would
otherwise fight over the same one.

`setup.sh` follows, and gained a guard — it refuses to run in a checkout whose `docker-compose.override.yml`
manages a service it does not, so it can no longer rebuild and restart a server's live install from the
working tree. It also chowns volumes to the configured `PUID`/`PGID` instead of a hardcoded 10002, which was
already wrong for anyone running as the owner of their library.

**`WEB_PORT` is 8080 everywhere now.** It was 3000 in the development stack and 8080 in the shipped one, and
`.env.example` hard-set the development values while `docs/USAGE.md` tells you to copy that file to point
`LIBRARY_PATH` at your library — so following the docs moved the app off the port the same page had just
told you to open, and left `PUBLIC_ORIGIN` pointing somewhere else again. Both are now commented out in
`.env.example`, so the compose default wins unless you deliberately change them.

## v0.9.2 — 2026-08-25

### The single container could not back itself up, and said nothing

**If you run the all-in-one image, your backups have been empty since v0.9.0.** `Dockerfile.aio` never
installed the Postgres client, so `pg_dump` was not in the image. `bff/Dockerfile` installs it and always
has, with a comment saying it is there for the backup task; the line was simply never carried across when
the single-container image was written.

Nothing about it was visible. The task wrote a 20-byte empty archive into a directory that looks like a
backup, logged nothing at all, and left `backup_last_result` untouched — so the admin Tasks panel kept
reporting the last run that *had* worked. On an install migrated from the split layout, that was a real
backup written by the old containers, which is about the most convincing way to be told everything is fine.

Three things changed, because the missing package was only the first of them:

- The runtime installs `postgresql16-client`, exactly as the split image does.
- **A failed dump is now recorded as a failure.** The Tasks panel shows the error, and the manual
  Backup button no longer discards it. A run that fails also deletes its own directory, so rotation cannot
  count empty archives as backups and push the last good one out of retention.
- `pg_dump` missing by name gets a message that says so, instead of an ENOENT.

The dump helper also resolved too early: an empty pipe closes cleanly and gzip still emits its header, so
"the file finished writing" was treated as "the dump succeeded". It now requires the process to have exited
0 as well.

`bff/test/aioParity.test.ts` — which exists for exactly this, "the split image did something and the single
one quietly stopped" — now holds all of it. Worth saying that the first version of that guard did not work:
both Dockerfiles *explain* why the client is installed, so searching the file matched the comment that
survives deleting the instruction. It reads only what Docker executes now.

**Check your own install:** `docker exec <container> pg_dump --version`. No output means every backup you
have taken since v0.9.0 is empty. Compare the sizes in your backup directory — a real dump is megabytes, a
broken one is 20 bytes.

### Reading progress for a chapter that no longer resolves

`PUT /api/books/:id/progress` answered **500** when it could not look the chapter up. The route fell back to
a placeholder series id, and migration `0004` had since given `read_progress` a foreign key to `lib_series` —
so that fallback could only ever violate the constraint.

The client that reaches it is the offline outbox replaying a queued page for a series deleted or merged in
the meantime. A 500 is retried forever; a **404** lets the queue drop the entry, which is what it now gets.

### One container is the install now

The docs used to present two layouts as equals, which meant three published images and a reader having to
pick before they knew anything. The single container is now the only one the instructions describe, and the
default filename went with it: `deploy/docker-compose.yml` is the single container, and the two-container
split moved to `deploy/docker-compose.split.yml`.

**The split is deprecated, not removed.** Both images are still built and still published on every release.
Nothing about a running install has stopped working, and there is no deadline. Unpublishing them while
leaving the packages in place would be the worst of both worlds: `docker compose pull` would keep succeeding
and silently freeze people on the last release with nothing to tell them, which is exactly the trap the old
`koryomi-*` packages caused.

**There is now a migration guide**, which there never was: `docs/MIGRATING.md`. Both layouts use the same
named volumes and the same Postgres image, so moving is four commands and no data is copied or converted.
The one step that is easy to miss is repointing a reverse proxy, because nothing errors: it was aimed at
`uchiyomi-web:80`, and that container no longer exists.

The CasaOS manifest ships the single container too, so its store tile stops naming a container that would
not exist. And the screenshot rig, the proxy helper and the container names in the backup-and-restore
instructions all follow the same layout the reader is being told to run.

## v0.9.1 — 2026-08-25

### The single container compresses again

Moving the web tier into the API process quietly dropped the one thing nginx was doing that nobody thinks of
as an application concern: it gzipped CSS, JS, JSON, SVG and the manifest, and because `application/json` was
in that list, every API response too. The all-in-one image had no compression plugin at all.

Measured against a real install: a cold load went from **261 KB of JS and CSS to 736 KB**. Nothing breaks, it
just gets slower, and only noticeably off your own network. Fixed with `@fastify/compress`, which also offers
brotli, which nginx never had here at all.

It also sends `Vary: Accept-Encoding`, which nginx did **not**: it ran `gzip on` with no `gzip_vary`, so a
shared cache in front of it could hand a gzipped body to a client that never asked for one. That is a real
hazard closed, not merely parity restored.

### A healthcheck that means liveness

`/healthz` runs `SELECT 1`, which is the right answer for "should traffic be sent here" and the wrong one for
a container healthcheck: the single container pointed at it, so one database blip marked the whole app
unhealthy. In the split layout nginx answered `/healthz` itself and stayed up through an outage, still
serving the shell so the app could render an error rather than the browser showing connection refused.

There is now a `/livez` that answers unconditionally, and the container healthcheck uses it. `/healthz` is
unchanged and still the readiness probe.

### Also

The repository root had no `.dockerignore`, and `Dockerfile.aio` builds from the root, so `COPY web/ ./` and
`COPY bff/ ./` copied the host's `node_modules` straight over the ones `npm ci` had just installed one layer
earlier, native modules included. Continuous integration never saw it, because a fresh checkout has none. Local
builds dragged around 790 MB of context and could produce a wrong build from a stale tree.

## v0.9.0 — 2026-08-24

### Libraries you can actually build

A library is now **a folder, plus any series you file into it by hand**, and there is a way to pick that
folder: browse your library root at any depth, or type the path. Before, the only option was a list of
suggestions computed from the top level of the root — which on most installs holds the source names the
downloader wrote, so the only folders offered were the ones not to pick, and the one you wanted could not be
reached at all.

**Libraries may sit inside one another.** With `Manga` and `Manga/Seinen` both declared, the most specific
one wins. Removing the inner one hands its series back to `Manga`, not to the default library.

**An age rating on the library**, inherited by everything in it, so marking a shelf 18+ is one action rather
than two hundred. A single title can still be rated differently from its own page. Unrated stays visible to
everyone.

**Access from the library's side**: each row lists who can open it. Worth knowing, because it is the one way
to lock someone out by accident — a member with no limits set can open every library, including ones added
later, so granting them one changes nothing and unticking them is what narrows them to an explicit list.

**File a series by hand** from its own page, or select several on the Library page and use **Move to
library**. A series filed by hand stays put across rescans, across creating a library whose path contains it,
and across re-pathing that library. Set it back to **Automatic** to hand it to the folder rule again.

**A library's path can be edited** instead of only its name, and the Library page grows a row of tabs once
you have more than one.

No files move, nothing is deleted, and no reading progress changes. An install with one library behaves
exactly as before.

### Age ratings, so a household can include children

Mark a series with a minimum age and cap what a member's account may open. Ratings come from ComicInfo's
`AgeRating` during a scan and can be set or corrected on any series page.

**Series with no rating stay visible.** Almost nothing in a real library carries one, so hiding unrated
content would empty an account the first time you set a limit. Setting a rating opts one title *in* to being
filtered; it never opts the rest of your library out. An install with no ratings and no limits behaves
exactly as before.

### MyAnimeList and Kitsu

Alongside AniList, and you can connect more than one at a time — each syncs independently, with its own
errors and its own progress, so one service being down cannot stop another.

### Nine languages, and right-to-left

English, Spanish, French, German, Portuguese (Brazil), Russian, Japanese, Chinese and Arabic, chosen under
**Profile → Language** and remembered across your devices. Arabic mirrors the whole layout, not just the text.

Everything except English is machine-assisted and says so, in that language. Each is one JSON file with
English strings as the keys, so a correction is a one-line pull request and a missing entry falls back to
English rather than showing a placeholder.

### Bookmark a page

A star in the reader marks where you are, with a per-series list. Bookmarks are kept when a series is
hidden, the same way reading progress is: a bookmark records having read something, not where the bytes are.

### OPDS links expire

They never did. One token per account, valid forever unless you happened to regenerate it — and it is the
one credential that lives in a reader app on a phone and gets forgotten. They now last a year, the profile
page shows when one was last used, and you can revoke it.

**Existing links are not cut off.** They get a year from now, not from when they were issued.

### PDF and image EPUB

Both are read now, and both are treated as what they are: an ordered run of page images in a container, the
same as a CBZ. A PDF's pages are rendered at reading resolution, so it behaves exactly like any other
chapter -- thumbnails, the reader, offline downloads and OPDS all work without knowing the difference.

EPUB pages come out in **spine order** rather than filename order, because manga bought from a store names
its image files by an internal id that sorts wrong.

**A text ebook is still not a chapter**, and that now falls out rather than being a rule: a reflowable novel
has no images in its spine, so it yields no pages and the scanner skips it. Dropping one into your library
does nothing instead of adding something that opens to a blank screen. Uchiyomi is a manga reader, not an
ebook library, and Kavita is the better answer if you want one.

### One container

`deploy/docker-compose.aio.yml` runs Uchiyomi as a single container: the API serves the web app itself
instead of a second nginx doing it. It is now the install the README leads with.
*(That file is simply `deploy/docker-compose.yml` since 2026-08-25 — see the Unreleased section.)*

Measured against the split layout on the same host: **238 MB instead of 385 MB**, **33 MiB of memory instead
of 41**, one less network hop on every API call, and no redirect at all on deep links -- nginx answered
`/library` with a 301 and this answers it with the page. nginx serves a static file about 0.9 ms faster,
which is the only thing it wins.

**Nothing breaks if you are already running the split layout.** It is still built, still published, still
documented, and `deploy/docker-compose.yml` is unchanged. The single-container build is additive: the same
API image serves the web app only when `WEB_ROOT` points at it.

> **Correction, 2026-08-25.** Two thirds of that paragraph still hold and one no longer does. The split
> layout is still built and still published, and nothing about a running install has stopped working. It is
> no longer *documented as an equal option*: the docs now lead with the single container, and the file moved
> from `deploy/docker-compose.yml` to `deploy/docker-compose.split.yml` so the default name belongs to the
> layout the instructions actually describe. If you already downloaded the old file it keeps working — it
> pulls images by name, not by filename. See `docs/MIGRATING.md` when you want to move.

### Discover, rebuilt

The page that adds new series was a search box on black with a ragged grid hanging off it. Production
disagreed with that design: in 48 hours there were 32 requests for "what's new on this source" and **zero**
searches. So the wall of what your sources just published is the page now, led by a full-bleed hero built
from the AniList key art the endpoint had been returning since it shipped and the page was rendering as a
144px thumbnail. Forty-five sources across thirty languages collapse to one remembered language chip. Search
survives as a field, with a way back out that it never had.

**It is also much faster.** `GET /api/sources/latest` was the only endpoint of its kind with no time limit of
its own: it inherited the adapter's, which is 30 seconds for an extension source and 95 for a site behind
FlareSolverr. The worst measured call took **63 seconds**. It is now capped at 8 seconds (`SOURCE_LATEST_TIMEOUT_MS`),
cached for ten minutes per source and page, and concurrent requests for the same page collapse into one
outbound fetch instead of six. A source that times out is recorded against its health, so it earns a cooldown
and stops being asked first. The six sources fetched are now ranked by what your library actually came from,
rather than alphabetically, which had been putting sources with no series behind them ahead of the one that
supplied 80% of the collection.

The horizontal rails have **a visible scrollbar and arrows**. They had neither, and smooth scrolling eats a
vertical wheel over a horizontal strip, so on a desktop mouse there was no way to move them at all.

### Adult sources, and who may open Discover

Two account settings that existed only in name now hold:

**A member whose age limit is below 18 cannot reach a source its extension declares adult.** It is absent
from their source list, and the server refuses it by id. The app is a static export, so hiding it in the UI
would have left the JSON one guessed URL away. This is not an edge case on a real install: on the one this
was written against, 36 of 44 enabled sources are adult. Sources that declare nothing (the built-in engines, source
packs, custom sites) count as not adult, the same way an unrated series stays visible.

**A member who may not add series no longer sees Discover.** `canDownload` was enforced on exactly one route,
the final POST, so a denied account could browse every source, search them and read full series detail, and
only met a wall on the last button. Every route behind the page refuses now, and the tab is gone.

### An 18+ library stays off the shelf

Marking a library 18+ already capped who could open it. It now also decides what turns up unasked: such a
library is left out of the home rails, the library grid, search, browse-by-genre, collections, updates,
history, bookmarks and the OPDS feeds, and its tab is gone from the Library page. A **Show 18+** button beside
the sorts brings it back for as long as the browser is open, and hides it again by itself. The button appears
only for accounts that actually have such a library, and never for one whose own age limit is below 18.
Admins are not exempt, because this is about a tidy screen rather than about permission.

**It is not an access control**, and the distinction is the whole design. A link, a bookmark, an
offline-downloaded chapter, next-and-previous and reading progress all keep working while the library is
hidden. The alternative was tempting and wrong: the service worker flushes reading progress with the app
closed, an image tag carries no session, and an OPDS reader has no button to press, so folding this into the
access rule would have silently lost people's place in whatever they were reading.

Two long-standing gaps closed along the way. The library list had no notion of age limits at all, so a member
capped at 13 was shown the name of the 18+ shelf and a tab that could only ever be empty. And reading history
had no visibility rule whatsoever, so it kept listing the titles of series that had been deleted, merged away
or moved into a library that member no longer holds.

### Also

MangaDex asks its API for English and nothing else, but declared no language, so it joined all thirty
language groups: choosing Japanese filled a third of the wall with English MangaDex rows. It declares English
now. The language chips also count **sites** rather than rows, so one site installed once per language stops
presenting itself as thirty separate choices.

Editing a series' metadata failed with "Could not save" for **every** field, not just the age rating that
made it noticeable: the statement asked for seven values and was given six, so Postgres refused it. Queries
now fail loudly at the call site when their placeholders and parameters disagree, which is how this was
found and how the next one will be.

The comparison table gained the two rows where something else does more: **reflowable EPUB**, which Kavita
reads and this deliberately does not, and **Kobo device sync**, which Komga has and this has no answer for.
An unlisted gap is worse than a listed one.

## v0.8.1 — 2026-08-23

**Upgrade if you are on v0.8.0.** Its library page listed nothing.

### The library, search and browse pages were empty

v0.8.0 made the view context the first argument of every backend method, so that a call site which forgets
it fails to compile. One call site was cast to `any` and kept the old argument order, which is the one thing
that turns that guarantee off. The arguments shifted by one, the page offset landed past the end of the
library, and the result came back empty while the total count stayed correct.

Nothing was lost and nothing needs re-scanning: the rows were always there, the query simply asked for a
page beyond them. The library, search and browse pages and the command palette all read from that one
endpoint, so all four listed nothing.

### Offline downloads, which had never worked

Downloading a chapter to read offline asks the server for a manifest first, and that route talked to Komga's
HTTP API rather than to your own library. There is no Komga in a self-hosted install, so it answered "not
found" for every chapter, from the first release onwards. It now reads your library, and refuses a series
the viewer is not allowed to see.

### Two of the three OPDS feeds

`/opds` offers "recently updated", "A–Z" and "recently added". The first and third sorted by columns the
v0.8.0 rewrite stopped selecting, so both answered a server error for everyone, admins included, and the
broken one was listed first. Only A–Z worked.

### Deep links on any port other than 80

nginx listens on port 80 inside the container, and built its own redirects from that, so visiting
`http://localhost:8080/library` was redirected to `http://localhost/library/` with the port dropped. 8080 is
the documented default. Moving around the app never noticed, because that happens in the browser, but a
bookmark, a shared link or a reload on any path landed nowhere. Redirects are now relative.

### Renaming a folder had no button

v0.8.0 added the ability to rename a series' folder on disk, documented it, and shipped no way to reach it
outside of `curl`. There is now a **Rename folder** action on the series page for admins, which shows the
server's own refusal when a folder cannot be moved, since that message names the fix.

### Also

A malformed request body returned 500 with the whole validation error, schema field names included, rather
than 400. The handler meant to prevent that was registered after the routes it was meant to cover, so it had
never applied to any of them; internal error messages were reaching clients the same way.

## v0.8.0 — 2026-08-23

**Read this one before upgrading.** The library mount changed, and a security fix closed three ways to read a
series you were not meant to see.

### Three ways to read a hidden series, closed

All three predate this release, and all three needed nothing but an id.

`/img/lib/books/:id/page/:n` resolved a file path from a book id with no join to the series at all, so a book
id alone returned **raw page bytes off disk**, including for a series that had been deleted. The OPDS
download resolved the same way. The image server verified your token and then discarded who you were, so no
image route could filter by anything. And the chapter query never referenced the series table, so a chapter
inherited no series-level rule and next/previous walked the rest of it.

The visibility rule now lives in exactly one place instead of the twenty-three hand-written copies it had
spread into, and three tests hold that line: one fails if a twenty-fourth appears, one fails if a call site
invents an all-seeing viewer, and one requires every image and OPDS route to state how it is gated.

### Several libraries, and who can see them

Split your collection into separate libraries, then choose per member which ones they can open. Libraries are
**declared, not guessed**: the obvious rule, "each top-level folder is a library", would have renamed a lot of
existing installs into libraries named after their download sources.

Nothing changes on upgrade. Everything starts in one library, no reading progress moves, and an account with
no restriction set keeps seeing everything, including libraries created later.

### It can now rename folders and delete files, if you let it

Uchiyomi can rename a series' folder and delete its chapter files. **It cannot do either unless you run it as
the user who owns your library**, which is opt-in:

```
PUID=1000    # id -u
PGID=1000    # id -g
```

Leave both unset and nothing changes: the app runs as its own uid, your library is effectively read-only, and
the startup log says so plainly along with the exact command to change it.

`PUID=1000` is the common case and works: the app does not renumber its own user, so it will not collide with
the uid the base image already uses.

Deleting a series' files requires hiding the series first, so the reversible step always happens before the
irreversible one, and it keeps every chapter row and everyone's reading progress. Renaming refuses outright
unless every folder the series occupies is writable: renaming only half of a series that spans your library
and your downloads folder would split it in two on the next scan.

### Upgrading

```bash
docker compose pull
docker compose up -d
```

**The library mount is no longer `:ro`.** That alone grants nothing, because the app still runs as a uid that
cannot write your files, but if you relied on the read-only flag as a guarantee, add it back:

```yaml
      - ${LIBRARY_PATH:-./library}:/library:ro
```

**The container now starts as root and immediately drops privileges** to its own uid (or `PUID`). Previously
it never ran as root at all. That is the cost of being able to run as the owner of your library; the
alternative was asking you to hand your media collection over to uid 10002. The app itself never runs as
root, and `PUID=0` is refused.

One thing worth being straight about: restricting someone's library access applies immediately on the server,
but images and chapters they already viewed or downloaded may stay in their own browser's offline storage
until they clear it. The server cannot reach into a device it does not control.

## v0.7.0 — 2026-08-22

**Library management.** The honest caveat in the README used to open by conceding that Komga and Kavita were
further along here. This release is that gap, measured and closed.

### Any folder layout

The scanner read exactly two directories below your library root, so a series had to be at
`<group>/<series>/<chapter>`. Anything else was invisible: no error, no log line, just an app that started
fine and showed nothing. A folder is now a series when it directly contains chapters, at any depth, so
`One Piece/Chapter 1.cbz`, `Manga/One Piece/…` and `Comics/Manga/Author/One Piece/…` are all read without
rearranging anything.

Existing libraries are untouched. This was verified against a copy of a real 210-series, 40,506-chapter
install: zero series rows and zero chapter rows changed. Set `LIBRARY_MAX_DEPTH=2` to reproduce the old
behaviour exactly; the default is 6.

### Metadata you edit stays edited

Only title and summary could be edited. Author, publication status and genres were read from ComicInfo and
silently rewritten by every scan, and scans happen constantly. All of them are now editable and survive a
rescan, and because genres drive Browse and the recommendation rails, editing one steers those too.

Chapters can be corrected as well. Numbers are parsed from filenames by taking the first number found, so
`Vol 2 Ch 5.cbz` was chapter 2: it sorted between 1 and 3, and 2 is what a tracker was told. Numbers and
titles now have a per-chapter override.

### Filters that actually filter

The library had one filter, genre, and every other filter silently returned the entire library rather than
erroring. Read state, publication status, author and multi-genre now work, filters live in the URL so the
back button works and a view can be shared, and a filter the query cannot express says so instead of quietly
widening. The "Most chapters" sort is now "Most unread" and sorts by your real unread count.

### Bulk actions

Select several series on the Library page and mark them read or unread, favourite them, or file them into a
collection. Marking a backlog read deliberately does not write reading events, so it cannot inflate streaks,
the household leaderboard or Wrapped.

### Your tracker can no longer be walked backwards

AniList accepts a lower progress and rewrites the entry, with no undo. Anything that reduced your highest
completed chapter would quietly send the smaller number: merging two series, marking a batch unread, or
correcting a chapter number. Progress is now monotonic per series, and lowering it takes a deliberate resync
from the series page. This closed a hazard that already existed before any of the above.

### Also

The admin Art tab was broken in v0.6.0 by a query with its `WHERE` below its `ORDER BY`; fixed in v0.6.1 and
now covered by a test. Next and previous chapter compared numbers alone, so two chapters sharing a number
made "next" arbitrary and could return the chapter you were already reading.

### Upgrading

```bash
docker compose pull
docker compose up -d
```

The schema gains three tables and three columns on first boot, all additive. Nothing existing is rewritten,
and no scan re-mints anything.

## v0.6.1 — 2026-08-22

Two fixes for things a new install hits immediately.

**The admin Art tab was broken in v0.6.0.** The art overview query shipped with its `WHERE` written below
its `ORDER BY`, which Postgres rejects, so the endpoint returned a 500 and the whole Art Review gallery was
dead. It slipped out because the query lived inside a route handler and nothing in the test suite ever ran
it; it now lives in `lib/seriesArt` with a test that fails if the clause order is ever broken again.

**The documented library layout was wrong.** The README and USAGE told you to lay your library out as
`<series>/<chapter>`, but the scanner reads `<group>/<series>/<chapter>` — two levels below the library
root. Following the documentation gave you an app that started perfectly and showed an empty library, with
nothing to explain why. The docs now describe the layout the scanner actually reads, and the troubleshooting
section names this as the usual cause of an empty library.

So: `Manga/One Piece/Chapter 1.cbz` is found. `One Piece/Chapter 1.cbz` on its own is not. If your
collection is laid out the second way, wrapping it in a single folder is enough. A future release will read
any depth.

Nothing in this release changes the database.

## v0.6.0 — 2026-08-22

**Your library stops being a list of folders and starts being a list of series.** Until now a series was
whatever a folder was called, and its identity was derived from the path. Rename the folder, move it to
another disk, or let a source rename it for you, and Uchiyomi saw a brand new series: a second copy in the
library, an empty progress bar, and the one you had actually been reading stranded under a name that no
longer existed.

### Series management

- **Delete a series.** It hides rather than erases. Chapters, favourites, ratings, notes and above all your
  reading history stay attached to something real, so it is undoable and nothing silently rewrites your
  stats. A hidden series stays hidden across a rescan instead of reappearing under a new id.
- **Restore one**, exactly as it was.
- **Merge two into one**, for when the same series arrived twice from different sources. Everything the
  absorbed series held moves across, including every chapter and every progress row. Chapters that look
  like duplicates are deliberately **kept, not de-duplicated**: dropping one means folding two progress rows
  into one, and getting that wrong marks chapters unread and then syncs that outward to your AniList account,
  where it cannot be undone. Duplicate chapter numbers are untidy; lost reading progress is not recoverable.
- **Stop following a series**, or check one for new chapters on demand rather than waiting for the sweep.

### The library recognises files that moved

Chapters now carry a **content fingerprint** taken from the archive's index rather than its path, so a
renamed or relocated folder is matched back to the series it belongs to instead of being imported as a
stranger. Library ids are minted rather than derived from the path, which is what made the old behaviour
inevitable. Existing libraries are fingerprinted in the background, a slice at a time.

### Continue Reading offers the next chapter

Finishing a chapter used to remove the series from Continue Reading, and nothing put the next one in front
of you: you had to remember what you were reading and go find it, which is the one job that rail has. It now
shows the chapter you are part-way through, or the next one you have not read. A series you have finished
entirely still drops out. The rail also stopped being capped at 20, which was hiding most of a heavy
reader's list.

Also in the reader: **the manga name at the top is now a link to its series.** It was plain text, and the
back arrow beside it returns you to wherever you opened the chapter from, so from the home rail there was no
route to the series at all short of searching for it by name.

### Images stop waiting on things they already have

Covers were cached for five minutes, so most cover requests were round trips that returned a byte-identical
image. They are cached for a day now, which is safe because every way the art can change already busts the
url. Chapter thumbnails opened each archive twice, once to list it and once to read one page. Hero art warmed
one frame at a time. The disk cache walked every file every ten minutes to conclude it had nothing to do, and
its "least recently used" eviction sorted by *write* time, which a read never updates, so the first time it
filled it would have discarded the covers you look at daily and kept last night's page images.

### Your data now has referential integrity

Postgres enforces 14 foreign keys that were previously enforced by hope. Rows that already pointed at nothing
are copied into an `orphan_refs` table **before** being removed, so anything reclaimed is one `UPDATE` from
coming back rather than a restore from last night's dump.

`read_progress` deliberately does **not** cascade when a chapter is deleted. Nothing deletes chapters today,
but a cascade would have turned any future cleanup into silent, unrecoverable loss of reading history, so it
fails loudly instead and makes whoever writes that cleanup decide what should happen.

### Upgrading from v0.5.1

This release **migrates your database on first boot**, and the migration is one way. It adds columns and
foreign keys, and it moves rows that reference series or chapters which no longer exist into `orphan_refs`.
On the instance this was developed against that was 199 rows, none of them reading progress.

It is applied automatically and is safe to run, but it is the first release to change existing data rather
than only add to it, so taking a dump first is the cautious move:

```bash
docker compose exec -T uchiyomi-db pg_dump -U yomi yomi > uchiyomi-before-0.6.0.sql
docker compose pull
docker compose up -d
```

That dump contains password hashes and API tokens. Delete it once the upgrade looks right.

As always, `docker compose up -d` alone does **not** fetch a newer image. Without the `pull` you stay on the
version you already have.

## v0.5.1 — 2026-08-21

**A fresh install could not write two of its own volumes.** If you installed from
`deploy/docker-compose.yml`, this one matters and the upgrade note below is not optional.

The runtime image created and gave ownership of `/cache` and `/backups` to the app user, but not `/config`
or `/library-dl`. Docker seeds a new named volume from the image directory it covers, so a directory the
image never creates arrives owned by root — and Uchiyomi runs as an unprivileged user. Three things failed
because of it, and none of them said why:

- **every chapter download failed**, so "it also fetches new chapters" did not work at all on a first install
- **adding a site by URL returned a bare error**, because that writes `/config/sites.json`
- **the generated JWT secret could not be saved**, so a new one was made on each boot — which signed
  *everybody* out on every restart

The setup script had always fixed this itself, but it only runs if you clone the repo, which is explicitly
not the documented way to install. All four directories are now created and owned correctly in the image.

### If you installed before this release

A new image cannot fix a volume you already have: Docker never re-seeds one that exists. Do this once.

```bash
docker compose down
docker volume ls | grep uchiyomi        # confirm the names — they are prefixed by your folder
docker run --rm -v uchiyomi_config:/a -v uchiyomi_downloads:/b alpine chown -R 10002:10002 /a /b
docker compose pull
docker compose up -d
```

**On CasaOS**, the app directories are host bind mounts, which never inherit ownership from an image, so
this is a permanent requirement rather than a one-off:
`sudo chown -R 10002:10002 /DATA/AppData/uchiyomi`.

### Updating, in general

`docker compose up -d` on its own does **not** fetch a newer image — Docker reuses the `:latest` it already
has. Run `docker compose pull` first. This was never written down before, which means anyone who installed
earlier and tried to update has been sitting on their original version without knowing.

### Also

`JWT_SECRET` can now actually be set in `.env`; the install compose named it but never passed it through, so
setting it did nothing. `LIBRARY_BACKEND` had the same problem and is now a real setting rather than a
hardcoded value. And a pass over the documentation removed a set of claims that were simply untrue: an API
example that could never have worked, a 2FA recovery route that does not exist, a Node version the test suite
cannot run on, and a sources project that was never published. The route reference now matches the code
exactly — 142 documented, 142 real.

## v0.5.0 — 2026-08-20

The release that closes the gap with Mihon and Suwayomi, and one that finally shows the product.

**Mihon / Tachiyomi extensions.** Browse roughly 1,400 extensions from inside the admin panel and add one with
a click. They run on a bundled Suwayomi engine that starts with the stack and configures itself; installing an
extension switches its sources on straight away, so it is searchable from Discover immediately. Uchiyomi keeps
owning the library, reader, downloads and updates. It hosts nothing and ships no repository URL: you point it at
a repository you trust. The engine is a JVM and sits around 800 MB of RAM; set `SUWAYOMI_URL=` empty to turn the
whole feature off. See [docs/extensions.md](docs/extensions.md).

**Single sign-on.** Optional OIDC against Authentik, Authelia, Keycloak or anything else that speaks OpenID
Connect, with optional group-to-admin mapping. Strictly additional: local accounts, 2FA, lockout and session
revocation are untouched, so a provider outage cannot lock you out of your own server.

**AniList sync.** Connect your account once and finishing a chapter updates your list on its own. Progress is
the highest chapter you have *finished*, so re-reading an old one never rewinds your list, and AniList being
slow or down can never delay a page turn.

**Library health.** A new admin tab that audits the library: chapter gaps, chapters that downloaded as one or
two images, duplicate series, impossible chapter numbers, and failing sources. Each check reports what it cannot
see as well as what it found.

**Scoped API tokens.** Long-lived, revocable tokens with read / write / admin scopes, listed beside your active
sessions. An admin's token still needs the admin scope before it can touch the admin API. There is an API
reference now too, at [docs/api.md](docs/api.md).

**Also**

- Reader settings follow your account instead of the device you set them on.
- A pull-based install (`deploy/docker-compose.yml`) and a CasaOS app manifest.
- Screenshots are now generated by a committed rig (`scripts/shots/`), so they stop rotting.
- Fixed: pages served from URLs without a file extension were stored with the wrong one, which made a chapter
  download perfectly, contain every image, and read as **zero pages**. Nothing errored.
- Fixed: `migrate()` now takes an advisory lock, so two processes starting at once cannot collide.

**Nothing to migrate.** New tables and columns are created on boot. With `SUWAYOMI_URL` unset, nothing about an
existing install changes.

## v0.4.0 — 2026-08-19

**Koryomi is now Uchiyomi.**

The old name didn't work in Japanese: romanized, "Koryomi" reads as こ-りょ-み (ko-**ryo**-mi), because `ryo`
is a single mora りょ — so the よみ of 読み ("reading") never survived. That broke the link to Tachiyomi
(立ち読み) and Suwayomi that the name was meant to signal, and left the 読 mark claiming something the name
didn't say.

**Uchiyomi** (うちよみ, 内読み) keeps よみ intact and follows the convention the ecosystem already uses:
Tachiyomi is standing-reading, Suwayomi is sitting-reading, **Uchiyomi is reading at home** — which is what a
self-hosted reader is. The logo evolves to match: the same faceted 読, now sheltered under a roof.

### Nothing to migrate
Only the product name changed. `yomi` is the shared root of both names, so every stateful identifier is
untouched — the database and its volumes, the offline IndexedDB, auth cookies, saved reader preferences, OPDS
entry ids, and container names. **Existing installs upgrade in place: nobody is logged out, no reading
progress resets, no downloaded chapter is orphaned.**

### If you pull images
Images now publish to **`ghcr.io/angelosha/uchiyomi-bff`** and **`ghcr.io/angelosha/uchiyomi-web`**. GHCR does
not redirect renamed packages, so the old `koryomi-*` images stay published and keep working — update your
compose file when convenient. ~~The GitHub repo moved to `AngeloSha/uchiyomi`; the old URL redirects.~~ The
repo move is still true; the promise about the images is not.

> **Correction (2026-08-21): the `koryomi-*` packages have been deleted, and `docker pull` of them now fails.**
> Keeping them published turned out to be worse than removing them: releases only ever publish `uchiyomi-*`,
> so `koryomi-*:latest` sat frozen at v0.3.0 while still reading as "latest" to anyone running it. Point your
> compose file at `ghcr.io/angelosha/uchiyomi-bff` and `ghcr.io/angelosha/uchiyomi-web`.

## v0.3.0 — 2026-08-19

Groundwork release: don't lose your data, don't ship broken reading, and don't retype your library.

### Backups
- Nightly backup of the database and your config, rotated automatically (14 runs by default) and restorable
  with plain `psql` — no matching tool versions needed. Runs at a configurable hour, shows up in
  **Admin → Tasks** with its last run and size, and has a **Run now** button.
- Point `BACKUP_PATH` at a host directory — ideally on a different physical disk, so a dead drive doesn't
  take the backups with it. Downloaded chapters and the image cache are deliberately excluded: both are
  large and reproducible.
- Restore instructions in [docs/USAGE.md](docs/USAGE.md#11-backups--restore).

### Import
- Bring a library over from **Mihon / Tachiyomi** (`.tachibk` backup) or a **public MangaDex list**. Titles
  are parsed and shown for review first, with anything already in your library filtered out, before any
  importing starts. Pasting a plain list still works.
- Private MangaDex follows are not supported: they need an account login, which Uchiyomi doesn't ask for.

### Fixes
- **Downloads are now paced.** Every add previously spawned its own uncapped background download loop, so a
  large import meant hundreds of simultaneous downloads against a handful of sites — a good way to get your
  server blocked. All downloads now share a per-source concurrency limit and a politeness gap.
- Chapter dates: `"Chapter 12"` was being accepted as a date (December 2001) and could be stamped as a
  release date. Date parsing now requires text that actually looks like a date.

### Under the hood
- A test suite (30 tests) covering the logic that has actually broken before: the phantom-chapter guard,
  date parsing, volume vs chapter labelling, chapter ordering, hero art fitting, backup parsing, download
  pacing, and the reading-progress rules (run against a real Postgres, since they live in SQL). CI runs it
  on every pull request — previously a green build only proved the code compiled.
- Lockfiles added, so builds are reproducible.

## v0.2.1 — 2026-08-19

- Volume-based libraries read correctly: archives named as tomes (`Tome 01.cbr`, `Berserk T41`, `v01`) now
  label as **Vol. N** instead of Ch. N, and a mostly-volume series reports "N volumes". Chapter markers still
  win, so a release-version suffix like `Ch. 5 v2` stays a chapter.

## v0.2.0 — 2026-08-09

The "cinematic + convenient" release.

### Art & visuals
- Real banner art for the home hero: sharp, aspect-aware variants per device (`wide`/`tall` frames) —
  art close to the frame's shape is smart-cropped full-bleed; mismatched shapes render whole over an
  ambient blur of themselves. Pre-warmed server-side and preloaded client-side, so the hero loads instantly.
- Banner/cover backfill across the whole library from **AniList** (including banners from a manga's anime
  adaptation), **Kitsu** wide covers, and **MangaDex** high-res covers — plus an admin **Art Review** picker
  with per-series candidates.
- Hi-res cover pipeline (`?w=` variants) for detail posters and hero thumbs.

### Reader
- **Up Next**: finishing a series shows a card with related-series suggestions (both reading modes).
- **Double-page spreads** in paged mode — chapter covers solo, pairs after, RTL-aware for manga.
- **Page-preview scrubber**: dragging the progress slider shows a live thumbnail of the target page.
- Chapter dividers labeled "Up Next · {chapter}".

### Home & series
- Cinematic series page: title-over-art hero with author, status, chapter count, "Updated X ago", and
  rating badges; "More like this" rail; "Because you read {title}" rails on Home.
- Chapter release dates surfaced throughout (Updates feed sorts by them).

### Convenience
- **Ctrl+K command palette**: instant series search, quick actions, recents; live results in the top bar.
- **Collections**: create/reorder reading lists with accent colors; add from any series page; Home rail.
- **Reading history** timeline page.
- **Mark as read** (chapter / previous / whole series) and **bulk offline-download delete** (per series or all).

### Accuracy & robustness
- Chapter completions now record reliably (fast-scrolling past a last page used to miss them — this starved
  streaks and the leaderboard). Completion is retroactive on chapter-crossing, immediate on the last page,
  and server-enforced as a safety net. Re-reading a chapter no longer un-reads it.
- Offline reading progress syncs in the background; push subscriptions self-heal after browser rotation;
  the updater's first run respects the configured interval.

### Sources
- Madara engine: falls back to the manga page when a site's ajax chapter endpoint serves junk (fixes
  ManhuaPlus updates), on top of the earlier cross-title widget scoping fix.

## v0.1.0 — 2026-07-02

Initial public release.
