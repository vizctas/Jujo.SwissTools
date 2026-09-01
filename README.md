# Jujo.SwissTools

A set of small tools for the things paid apps charge you for and you only need
now and then.

Most of these jobs have the same shape. You need one file, once. The options are
a site buried in ads that stamps a watermark on the result, or a subscription for
something you'll open twice a year. This is the third option: it runs on your own
machine, nothing is uploaded to anyone's server, and there is no account to make.

Four tools so far. All finished, not placeholders, and they share one shell:
`Ctrl/Cmd+K` opens a single searchable list holding every tool, every saved
preset and every recent file. Adding a tool means writing one module that
declares its own panel and its own commands; the shell doesn't know what any of
them do.

## QR generator

Every generator can make a working QR code. Almost none of them make one you'd be
willing to put on a package, a menu, or a business card next to the rest of a
brand. That's the gap this fills.

**Nine content types.** Link, plain text, Wi-Fi, contact card, email, phone, SMS,
calendar event and location. Each one is encoded properly, which matters more than
it sounds: a Wi-Fi password containing a semicolon, or a surname containing a
comma, comes out correctly escaped instead of quietly producing a code that scans
into garbage.

**Design controls, all of them visible.** Module shape, including a connected
style that reads as one continuous form rather than a grid of dots. Separate
shapes and colors for the three finder patterns. Background color, or real
transparency with an alpha channel in the PNG. Quiet zone measured in modules.
Every value you can change is shown as a number you can type, not just a slider
you drag.

**A center that takes a logo or text.** Upload an image, or type two or three
letters instead. Both live in the same slot. The app removes the modules
underneath rather than covering them, and text sizes itself on the way in to
whatever the current error correction level can carry, because four modules of
height is 38% of a small code and 12% of a large one.

**Captions.** A title and subtitle can sit below the code as part of the same
piece, with the typeface embedded in the exported SVG so it opens in Illustrator
with the type you picked rather than a substitute.

**It tells you when the code won't scan.** Contrast between module and background.
Inverted polarity, where the modules end up lighter than the background and most
readers see nothing. How much of the code the center covers, weighed against what
the error correction level can recover. Quiet zone against the four modules the
specification asks for. Each warning states the problem, the consequence and the
action, and carries a fix that lands the piece in a verified state in one click.
Export is blocked while a code genuinely won't scan.

**Export.** SVG for print and layout, PNG at 1×, 2× and 4×. The preview and the
export come from the same function and the same string, so what's on screen is
the file you get.

## APK installer

Push an APK to every connected Android device at once, over USB or over the
network.

A browser can't talk to `adb` on its own, so this tool talks through a small
local bridge instead: a dependency-free Node process that drives the `adb` you
already have installed. Running `npm run dev` starts it automatically alongside
the dev server and hands it a pairing token over the same origin, so there's
nothing to copy or paste. Outside of development — or to run it standalone — start
it yourself:

```bash
node bridge/server.mjs
```

Started this way it also serves the built app, so `node bridge/server.mjs` after
`npm run build` is a complete, one-process way to run the whole thing. Either way
the bridge binds to `127.0.0.1` only and refuses any origin that isn't your own
machine, gating every request behind a token. That isn't excessive: a local server
that installs APKs onto connected phones is exactly what a hostile page would want
to reach, and WebSocket and simple requests don't always go through CORS. Pass
`--strict-token` to fall back to a token you paste by hand, useful on a shared
machine.

**It remembers your devices.** Every device the bridge has seen — serial, model,
Android version, the address for the ones on Wi-Fi — is kept in a small SQLite
file in your home directory. Known network devices that aren't currently
connected still show up, greyed out, and the bridge quietly retries `adb connect`
against them every 20 seconds so a device that was on Wi-Fi yesterday reappears on
its own instead of asking you to type the IP again. Wireless debugging can also be
paired for the first time from the panel, `adb pair` included.

**It reads the APK before sending it.** The ZIP and the binary AndroidManifest are
parsed in the browser, so the package name, version, minimum SDK and native
architectures are known before a single byte moves. Spending two minutes
uploading 200 MB to have `adb` answer `INSTALL_FAILED_NO_MATCHING_ABIS` is
exactly the error worth preventing.

**Per-device checks.** Minimum SDK against the device's Android version. Native
architectures against the device's ABIs. Free space against what the install
needs. The version already installed, so a downgrade is flagged before it wipes
the app's data. Unauthorized and offline devices explain what to do about it.
Devices that can't take the build are blocked from selection rather than allowed
to fail later.

**Parallel installs with honest progress.** Select several devices and each gets
its own bar, its own phase and its own result. Upload progress is real, measured
from the browser. Transfer progress is shown only when `adb` actually reports a
percentage; when it doesn't, the bar goes indeterminate instead of inventing a
number that climbs on its own.

**Failures come back translated.** `adb` output is matched against the known
failure modes and turned into a sentence that says what happened and what to do,
with the flag that fixes it offered as a one-click retry. The raw output stays
one disclosure away for when the translation isn't enough.

**A small library.** The last twelve APKs you loaded are kept on your device so
you can reinstall without hunting for the file again. Quota is checked before
writing, and the binary is stored before the index entry, so a full disk leaves an
invisible orphan rather than a list entry that points at nothing.

## Media capturer

Listen to a connected Android device's `logcat` and catch the video URLs it plays,
with enough sense to know what it caught before downloading a byte of it.

This shares the same bridge as the APK installer, so it needs nothing extra
running. Pick a device and a listening profile, hit listen, and play something —
matching URLs show up on their own. A few built-in profiles cover common cases
(any mp4/m3u8/mpd link, an unfiltered feed for when you need to see everything),
and custom ones — a pre-filter plus an optional regex with a capture group — are
saved to the bridge's own database, so they're there next time.

**Every hit is probed, not just extracted.** A logcat line ending in `.mp4` is
often a lie: many of those URLs actually serve an HLS playlist, and saving that
under a `.mp4` extension produces a few-kilobyte file no player opens. Every URL
that's caught gets a real HTTP probe the moment it appears — its true content is
read, a master playlist is parsed for its quality variants, and you get to choose
a resolution before anything downloads.

**Downloads that match what they actually are.** A direct file streams straight to
disk with real resumption. HLS and DASH get remuxed to `.mp4` by `ffmpeg` without
re-encoding, which is the only sane way to stitch segments; without `ffmpeg`
present the tool says so upfront rather than producing a broken file. What gets
saved is verified afterward — size and magic bytes checked — so a playlist that
snuck through never gets filed away as video by mistake.

**A capture history**, independent of the in-page list, kept in the same SQLite
file as the device memory: what was downloaded, from where, how big, how long. The
save folder is one click away from the panel at any time.

## Background removal

Cut the background out of one image or a whole batch of them, right on your own
machine.

The model runs in the browser via [Transformers.js](https://github.com/huggingface/transformers.js)
with WebGPU when it's available, so the images never leave your device — the only
thing that gets downloaded is the model's weights, once, cached by the browser
afterward. A choice of four models is offered, each labeled with its actual
license: portrait matting, a general-purpose model that handles arbitrary objects,
a featherweight one for quick selfies, and a strong one that's licensed
non-commercial — worth knowing before it ends up in client work.

**Built for a batch, not one photo at a time.** Drop as many images as you like;
each one queues, runs, and previews independently while the rest keep going.
Inference happens in a Web Worker, so a stack of twenty photos never freezes the
tab, and the queue can be cancelled mid-run.

**Editing the cut costs nothing.** The worker hands back only the alpha mask, not
a finished image — recomposing it with a different background color, edge
feather, or threshold is instant canvas work, because the expensive part, running
the model, already happened and doesn't happen again just because a slider moved.
Feathering and the threshold shift are applied to the mask itself, so they smooth
the edge without smearing the underlying color.

**Export to PNG or WebP**, transparent or against a flat color, optionally trimmed
to the subject's bounding box. Hold a thumbnail down to flash back to the original
— a cutout is judged by its edge, and the edge doesn't show in a preview with
nothing to compare it to.

## Running it

```bash
npm install
npm run dev
```

`npm run check` runs the core self-check: format escaping, render geometry, and
every branch of the scannability rules. `npm run build` produces the installable
PWA. The bridge that backs the APK installer and the media capturer is a separate
process (see above) — nothing else needs installing for it, though the media
capturer wants `ffmpeg` on your `PATH` to handle segmented streams.

## How it's put together

Vite, React and TypeScript. No backend of its own, and no network calls from the
web app itself except to the local bridge when the APK installer or media
capturer is open, and to Hugging Face once to fetch a background-removal model.

Reed–Solomon encoding comes from [`qrcode`](https://github.com/soldair/node-qrcode);
everything drawn on top of the module matrix is here, because no rendering
library gives you custom module shapes, custom finder patterns, a punched-out
center and typeset captions in one vector file without a fight. APK and ZIP
parsing use the browser's own `DecompressionStream`.

The bridge is Node with zero runtime dependencies: `node:sqlite` for the device
and capture memory, Server-Sent Events and plain POST instead of WebSocket, and
`adb`/`ffmpeg` driven as child processes. It's a separate program from the web
app on purpose — during development a Vite plugin launches it and hands it a
token over the same origin; built for production, it serves the compiled app
itself, so the whole thing runs from one command.

Each tool is a module under `src/tools/` that declares its own state provider, its
own three screen zones and its own palette commands. The shell in `src/App.tsx`
and the palette in `src/components/CommandPalette.tsx` contain no reference to any
particular tool. The APK installer and media capturer share one bridge client and
device list under `src/bridge/`, so opening either doesn't open a second
connection to the same process.

Presets, QR history, saved APKs and cached background-removal models live in
IndexedDB and the browser's cache on your own device. Device memory and capture
history live in the bridge's own SQLite file in your home directory.

## Status

Early, and honest about it. All four tools are complete and in use. PDF export
from the QR generator isn't there yet; SVG covers the vector case. The APK
installer handles single APKs, not app bundles or split APKs, and says so when you
hand it one. The media capturer won't touch an encrypted HLS stream — it says so
and stops rather than attempting to work around DRM. The background-removal tool
downloads real model weights on first use per model (from a few megabytes to a
few hundred), which needs a real connection the first time even though nothing
after that does.

## License

MIT. See [LICENSE](LICENSE).
