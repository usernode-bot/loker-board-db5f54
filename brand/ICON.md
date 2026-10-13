# Job Board brand icons

The app's mark: a **briefcase pinned to a notice board**. One flat glyph, no
text, drawn in the Homeroom brand framework's icon style (one bold mark on a
rounded square). The platform rounds the tile's corners, so the PNGs are
full-bleed squares.

## Files

| File | Size | Use |
| --- | --- | --- |
| `icon.svg` | 1024×1024 | Source for the app icon |
| `icon.png` | 1024×1024 | The app icon, set as `icon.image` in `dapp.json` |
| `featured-light.svg` / `.png` | 1200×800 | Featured illustration on a cream background |
| `featured-dark.svg` / `.png` | 1200×800 | The same illustration on black |

**Not wired up yet:** Homeroom has no field for a featured icon in the
directory, so the featured files are only committed here. Showing them on the
app's directory page is a follow-up.

## Colours

Only Homeroom brand-framework palette colours are used:

| Hex | Where |
| --- | --- |
| `#000000` Black | Tile, briefcase, pin outline, placeholder bars, dark background |
| `#FFEE6F` Yellow | Notice (the tile's mark) |
| `#FFFEEA` Cream | Pin head, light background |
| `#A9CF97` Green | Left side notice on the featured illustration |
| `#3090E1` Blue | Right side notice on the featured illustration |

## Redrawing

Edit the SVG, then render:

```sh
rsvg-convert -w 1024 -h 1024 brand/icon.svg -o brand/icon.png
rsvg-convert -w 1200 -h 800 brand/featured-light.svg -o brand/featured-light.png
rsvg-convert -w 1200 -h 800 brand/featured-dark.svg -o brand/featured-dark.png
```

Keep `icon.png` under 256 KB (the platform's icon-image limit) and keep
`"emoji": "💼"` in `dapp.json` as the fallback if the image ever fails to load.
