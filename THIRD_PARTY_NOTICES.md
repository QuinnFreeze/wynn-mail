# Third-party notices

The application is derived from Quickinbox and retains its original [MIT license](LICENSE.md). That license does not replace the separate licenses, copyright notices, or trademark rights of third-party components and assets. See [UPSTREAM.md](UPSTREAM.md) for the fixed upstream source revision.

## Zero-derived theme assets

The Zero theme contains SVG icons adapted from `Mail-0/Zero` and illustration and attachment-icon assets from that project:

- `src/themes/zero/icons/Icon.svelte` and `names.ts` were generated from Zero's icon catalog, as identified in the generated source header and conversion script.
- `static/themes/zero/empty-state.svg`, `empty-state-light.svg`, and the 11 files under `static/themes/zero/attachment-icons/` match the corresponding upstream Git blobs at Zero revision `843dc54969dd302f6f05ddfdeb2024ae0abf1baa`.
- The Zero theme acknowledges the source project's design and assets; the attribution does not imply affiliation or endorsement.

Copyright (c) 2025 Zero Email. Licensed under the MIT License. The full notice is retained in [licenses/Zero-MIT.txt](licenses/Zero-MIT.txt).

Official sources: [Zero license](https://github.com/Mail-0/Zero/blob/843dc54969dd302f6f05ddfdeb2024ae0abf1baa/LICENSE), [icon catalog](https://github.com/Mail-0/Zero/blob/843dc54969dd302f6f05ddfdeb2024ae0abf1baa/apps/mail/components/icons/icons.tsx), and [public assets](https://github.com/Mail-0/Zero/tree/843dc54969dd302f6f05ddfdeb2024ae0abf1baa/apps/mail/public).

## Remix Icon

This project uses `remixicon` version 4.9.1 for functional interface icons and provider identification. The controlling file shipped with that version is **Remix Icon License v1.0, January 2026**, Copyright (c) 2017–2026 Remix Design. A verbatim copy is included in [licenses/Remix-Icon-License-v1.0.txt](licenses/Remix-Icon-License-v1.0.txt).

The interface uses a generated WOFF subset (`src/lib/assets/remixicon-subset.woff`)
and matching CSS containing the glyphs referenced by this application. Glyph
outlines and code points are unchanged. `scripts/build-icon-subset.py` regenerates
these assets from the installed package; normal builds verify the checked-in
subset and do not require Python. The font and CSS retain the Remix license.

The package's `package.json` reports `Apache-2.0`, but its actual `License` file and the official `v4.9.1` tag contain the custom license above. This project therefore does not represent those assets as Apache-2.0 or MIT.

That license allows icons as components of larger applications, including MIT-licensed applications, subject to its terms. Its restrictions include standalone icon sales, competing icon libraries, and using the icons as a product's logo or brand identity. Third-party brand icons may only represent or link to the corresponding brand and grant no trademark rights. Consult the complete license before reusing icons outside this application's functional interface.

Official source: [Remix Icon v4.9.1 License](https://github.com/Remix-Design/remixicon/blob/v4.9.1/License).

## Geist and Geist Mono fonts

The Zero theme imports `@fontsource-variable/geist` and `@fontsource-variable/geist-mono`, version 5.3.0. The fonts are Copyright 2024 The Geist Project Authors and licensed under **SIL Open Font License 1.1**, independently of the application's MIT license.

The exact copyright and license texts shipped with the two installed packages are retained separately:

- [licenses/Geist-OFL-1.1.txt](licenses/Geist-OFL-1.1.txt)
- [licenses/Geist-Mono-OFL-1.1.txt](licenses/Geist-Mono-OFL-1.1.txt)

Keep these notices with redistributions that include the fonts. The fonts remain under OFL-1.1; do not relicense them as MIT. The license includes conditions for standalone font sales, modified font names, and endorsement.

Official sources: [Geist fonts and OFL](https://github.com/vercel/geist-font/blob/main/OFL.txt), [Fontsource Geist](https://fontsource.org/fonts/geist), and [Fontsource Geist Mono](https://fontsource.org/fonts/geist-mono).

## web-push

The application depends on `web-push` version 3.6.7, Copyright 2015 Marco Castelluccio, under **Mozilla Public License 2.0**. Its original source notice is retained in [licenses/web-push-MPL-2.0-notice.txt](licenses/web-push-MPL-2.0-notice.txt).

Official sources: [web-push v3.6.7 notice](https://github.com/web-push-libs/web-push/blob/v3.6.7/LICENSE), [corresponding source](https://github.com/web-push-libs/web-push/tree/v3.6.7), and [complete MPL-2.0 terms](https://www.mozilla.org/en-US/MPL/2.0/). Preserve the applicable source notices and satisfy MPL requirements when redistributing covered source or executable forms. This attribution does not relicense the dependency as MIT.

## Other dependencies and branding

Dependencies installed from `bun.lock` retain their own licenses. This document is not a claim that the complete dependency tree is MIT. Installed and build-only dependencies retain their declared and controlling license texts, including permissive terms, MPL-2.0 and OFL. The current publication omits the upstream optional translation tool and does not redistribute installed native tooling. Their original package notices apply if those components are redistributed. This source repository excludes installed packages and generated application bundles.

The original Quickinbox logo and generated PWA icons are retained from the MIT-licensed upstream revision identified in [UPSTREAM.md](UPSTREAM.md). Third-party service names, logo graphics, and brand icons elsewhere in the interface identify the relevant integration or file type. Their respective owners retain all trademark rights; no partnership or endorsement is claimed. The software licenses do not grant trademark rights.

When distributing a compiled application, container, package, or other artifact, review the actual included dependencies and carry their required notices and source information into that artifact. The notices in this repository do not replace that distribution-specific review.


## Google sign-in brand asset

`src/lib/components/GoogleMark.svelte` uses the Google G from Google's pre-approved
sign-in SVG bundle: [official assets](https://developers.google.com/static/identity/images/signin-assets.zip),
`Android + Web/SVG/Light/Theme=Light, Show text=No, Shape=Square, Platform=Android+Web.svg`.
The component crops the surrounding button padding, removes nonvisual export
metadata and makes SVG identifiers unique; the G geometry and gradient colors are
retained. The source is also documented in the component.

The account-linking settings use two unmodified 160 × 160 PNGs from the same
official bundle, selected by the application's current light/dark theme:

- `src/lib/assets/google-signin-round.png`:
  `Android + Web/PNG @4x/Light/Theme=Light, Show text=No, Shape=Pill, Platform=Android+Web@4x.png`.
- `src/lib/assets/google-signin-round-dark.png`:
  `Android + Web/PNG @4x/Dark/Theme=Dark, Show text=No, Shape=Pill, Platform=Android+Web@4x.png`.

Each is displayed proportionally with its original round background, border and
padding, avoiding small-size SVG filter rendering and duplicate outer borders.

Google and the Google G are trademarks of Google LLC. This brand asset is **not
relicensed under the application's MIT license**. Use remains subject to Google's
[Sign in with Google branding guidelines](https://developers.google.com/identity/branding-guidelines)
and applicable trademark rights. Its inclusion identifies the optional Google
sign-in integration and does not imply affiliation, sponsorship or endorsement.
