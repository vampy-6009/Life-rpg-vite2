# App Icon — Integration Guide

## What's here

A complete Android adaptive-icon resource set, generated from a custom
sword/level-up SVG design in this app's own palette (no external image
used — see the note on the uploaded image below).

```
android-icon-resources/
├── mipmap-anydpi-v26/
│   ├── ic_launcher.xml          (adaptive icon descriptor, API 26+)
│   └── ic_launcher_round.xml    (round variant, same layers)
├── mipmap-{m,h,xh,xxh,xxxh}dpi/
│   ├── ic_launcher.png          (flat fallback for API <26)
│   └── ic_launcher_round.png    (same, round launchers)
└── drawable-{m,h,xh,xxh,xxxh}dpi/
    ├── ic_launcher_background.png
    └── ic_launcher_foreground.png
```

## Where it goes

Copy the entire contents of `android-icon-resources/` into your generated
Android project's `android/app/src/main/res/` folder, merging with (and
overwriting) Capacitor's default-generated icon files there:

```bash
cp -r android-icon-resources/* android/app/src/main/res/
```

Do this **after** `npx cap add android` has already generated the default
`res/` folder — copying before that would just get wiped when `cap add`
runs.

## On the uploaded circular badge image

I didn't use the ornate metal-badge image you uploaded as the actual
icon. Two real reasons: I don't know its license/rights, and — separate
from that — it's not usable as an app icon in practice regardless of
rights, since dense circular text-badge art like that becomes unreadable
noise once scaled down to a 48px launcher icon (which is the same
problem the *first* version of my own sword design ran into, before the
redesign below fixed it).

## One real design iteration worth knowing about

My first sword design (thin lines, tall proportions, separate chevron
strokes) rendered fine at 512px but tested illegible at actual launcher
size — at 48px it was just a colored smudge, and the adaptive
foreground layer (which gets scaled down further into Android's ~66dp
safe zone) was worse. I caught this by actually rendering it — this
sandbox has no SVG preview, so I built a rasterization path via
`wkhtmltoimage` specifically to check — and rebuilt the design with
bolder, shorter, wider shapes that hold up at real icon sizes. The
current SVGs in `icon-source/` reflect the corrected version; nothing
from the original thin design shipped in the final icon set.

## Verifying the render yourself

The `icon-source/rendered/` folder includes the actual PNG output at
every size, if you want to eyeball them directly before copying anything
into the Android project. `ic_launcher_legacy_mdpi.png` (48×48) is the
most important one to check — that's the smallest, highest-risk size.

## What I could not verify

I don't have Android Studio or an emulator in this sandbox, so I
couldn't confirm how these actually look once Android composites the
background+foreground layers and applies its own mask shapes (circle,
squircle, teardrop — different launchers use different masks). The
background/foreground split follows Android's documented adaptive-icon
safe-zone spec, and the rendered PNGs I did check look correct, but the
final on-device composite is worth a glance after your next build.
