# Jujo.SwissTools

A set of small tools for the things paid apps charge you for and you only need
now and then.

Most of these jobs have the same shape. You need one file, once. The options
are a site buried in ads that stamps a watermark on the result, or a
subscription for something you'll open twice a year. This is the third option:
it runs entirely in your browser, nothing is uploaded anywhere, and there is no
account to make.

There is one tool so far. It's finished, not a placeholder, and the rest will
land in the same shell as they're built.

## The QR generator

Every generator can make a working QR code. Almost none of them make one you'd
be willing to put on a package, a menu, or a business card next to the rest of a
brand. That's the gap this fills.

### Nine content types

Link, plain text, Wi-Fi, contact card, email, phone, SMS, calendar event and
location. Each one is encoded properly, which matters more than it sounds: a
Wi-Fi password containing a semicolon, or a surname containing a comma, comes
out correctly escaped instead of quietly producing a code that scans into
garbage. Wi-Fi and contact cards never leave the machine, which is the whole
argument for doing this locally.

### Design controls, all of them visible

Module shape, including a connected style that reads as one continuous form
rather than a grid of dots. Module size within its cell. Separate shapes for the
three finder patterns and their centers, with their own colors if you want them.
Background color, or real transparency with an alpha channel in the PNG. Quiet
zone measured in modules, not guessed.

Every value you can change is shown as a number you can type, not just a slider
you drag.

### A center that takes a logo or text

Upload an SVG, PNG, JPG or WebP, or type two or three letters instead. Both live
in the same slot, so you get one or the other. Either way the app removes the
modules underneath rather than covering them up, and draws a plate so the shape
stays clean when printed.

Type size adapts on the way in. Four modules of height is 38% of a small code
and 12% of a large one, so a fixed default would be wrong most of the time. The
first character you type sizes the text to whatever the current error correction
level can actually carry.

### Captions

A title and a subtitle can sit below the code, as part of the same piece. The
font travels with the file: the exported SVG carries the typeface embedded, so
it opens in Illustrator or InDesign with the type you picked rather than a
substitute.

### It tells you when the code won't scan

This is the part that makes it worth using. The app knows the physical rules of
the format and checks them as you work:

- Contrast between module and background, with the ratio shown.
- Inverted polarity, where the modules end up lighter than the background and
  most readers see nothing at all.
- How much of the code the center covers, weighed against what the current error
  correction level can recover. If a logo or a word needs a stronger level, the
  app raises it and says so instead of doing it quietly.
- Quiet zone against the four modules the specification asks for.
- Whether center text has enough contrast against its own plate. A code can scan
  perfectly and still be broken to look at.

Each warning says what's wrong, what happens because of it, and what to do,
in one line. Every one of them comes with a fix you can apply in a single click,
and that click leaves the piece verified rather than slightly less broken.
Export is blocked while a code genuinely won't scan.

### Export

SVG for anything going to print or into a layout, and PNG at 1×, 2× and 4×. The
preview and the export are produced by the same function, from the same string,
so what's on screen is the file you get. Not a close approximation of it.

## Running it

```bash
npm install
npm run dev
```

Then `npm run check` runs the core self-check: format escaping, render geometry,
and every branch of the scannability rules. `npm run build` produces the
installable PWA.

## How it's put together

Vite, React and TypeScript, with no backend and no network calls at runtime.
Reed–Solomon encoding comes from [`qrcode`](https://github.com/soldair/node-qrcode);
everything drawn on top of the module matrix is in this repository, because no
rendering library gives you custom module shapes, custom finder patterns, a
punched-out center and typeset captions in one vector file without a fight.

Presets, history and your last session are stored in IndexedDB on your own
device. There is nowhere else for them to go.

## Status

Early, and honest about it. The QR generator is complete and used. The shell it
sits in is built to take more tools without each one inventing its own controls.
PDF export isn't there yet; SVG covers the vector case for now.

## License

MIT. See [LICENSE](LICENSE).
