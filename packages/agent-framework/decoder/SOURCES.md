# decoder/ — third-party sources (IMAGES-V1 I1; OSS posture decision #77: integrate pinned upstream, with provenance)

This is the ONLY package in Kapelle with native code. The org runtime never imports it; it runs as a separate process
(`decode.mjs`, bytes in / one header line + JPEG out) — on the org host as the socket-activated, sandboxed
`kapelle-image-decode@.service` (deploy/systemd). Owner approval: 2026-10-19 (Director relay: "sharp/libvips dependency YES").

| Package | Version (exact, package-lock.json) | License | Role |
|---|---|---|---|
| sharp (https://github.com/lovell/sharp) | 0.35.5 (`sha512-Ywn4OnzGukp7CDMrp08RQ50YKmuwG47brZgIVPTvBaaAfQlRlygrRqSrxdCiL9M+LlzLBiJ68IR1QqvzHyjC7g==`) | Apache-2.0 | Node bindings: decode, orient, sRGB, flatten, resize, JPEG encode, metadata strip |
| @img/sharp-libvips-<platform> (https://github.com/lovell/sharp-libvips) | 1.3.4 (linux-x64: `1.3.4 sha512-GJ//SSXbnwSDes02umB3nDJLFcQzw8a18V8fyhqr6tV515tOEMdImjjxj1AoafMRz56F3PHgftnj1QEKSU1zkw==`) | LGPL-3.0-or-later | Prebuilt libvips 8.18.7 + codecs, dynamically loaded by sharp |
| @img/sharp-<platform> | 0.35.5 | Apache-2.0 | Platform binding |
| @img/sharp-wasm32 | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later AND MIT | WASM fallback (optional dependency; unused on linux-x64/darwin-arm64) |
| @img/colour | 1.1.0 | MIT | colour conversion (sharp dependency) |
| @emnapi/runtime | 1.11.3 | MIT | N-API shim (optional dependency) |
| detect-libc | 2.1.2 | Apache-2.0 | glibc/musl detection |
| semver | 7.8.5 | ISC | version checks |
| tslib | 2.8.1 | 0BSD | runtime helpers |

package-lock.json sha256: `e7a45e9e61ef43db02cbbedfdcf3e578e2296a42830e04beb1f621881676f6b4` (lockfileVersion 3; records every platform's optional binary with its integrity).

## libvips build (LGPL)
The prebuilt libvips (sharp-libvips 1.3.4) bundles: vips 8.18.7, mozjpeg 0826579, png 1.6.58, webp 1.6.0, lcms 2.19.1, exif 0.6.26,
zlib-ng 2.3.3, glib 2.90.0, and loaders/codecs the decoder never unblocks (aom, heif, tiff, gif/cgif, rsvg/cairo/pango, uhdr ...).
LGPL compliance: libvips is used unmodified, as a separately distributed shared library loaded at run time; its source and
build recipe are https://github.com/lovell/sharp-libvips (tag v1.3.4) and https://github.com/libvips/libvips (v8.18.7). The
licence texts ship inside node_modules/@img/sharp-libvips-*/ (README + versions.json) and are kept with any release copy.
(The design table said "LGPL-2.1-or-later" for libvips' source; the prebuilt binary sharp ships is LGPL-3.0-or-later.)

## Loader allowlist (defence in depth)
`decode.mjs` blocks every libvips loader and unblocks only VipsForeignLoad{Jpeg,Png,Spng,Webp}Buffer: SVG, GIF, TIFF, HEIF/AVIF,
PDF, magick and every other loader in the bundle cannot run, whatever the bytes claim. The runtime also checks the magic bytes
against the declared type before the decoder sees them, and the decoder checks the loader's format against its own sniff.

## Install (Ops decision, Oct 19: a PREBUILT tree in the release bundle; no npm egress on the host)
Built on the Mac per release from this lockfile (which verifies every integrity line):
`npm_config_cache=<temp dir> npm ci --omit=dev --no-audit --no-fund --os=linux --cpu=x64 --libc=glibc` in a copy of decoder/,
then prune the linuxmusl packages (npm ignores --libc for musl). The tree ships in the release bundle (manifest + SHA256SUMS)
at /opt/kapelle/releases/<c8>/decoder/; enable `kapelle-image-decode@<org>.socket`. Without that socket the org still starts;
image uploads refuse (image_decoder_unavailable) and Ops status says so.
