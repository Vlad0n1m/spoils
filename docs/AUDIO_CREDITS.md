# Audio credits

All recorded sound in `apps/web/public/sfx/` comes from Kenney's audio packs, downloaded from the
official site kenney.nl on 2026-10-05. Every pack page states **License: Creative Commons CC0**
(public domain dedication, http://creativecommons.org/publicdomain/zero/1.0/): free for personal,
educational and commercial use, attribution not required. We credit Kenney anyway.

Everything else the game plays is procedural Web Audio synthesis (`apps/web/src/game/audio/recipes.ts`).

| Pack | Page | Download (zip) | Zip size | License | Used |
|---|---|---|---|---|---|
| Impact Sounds 1.0 | https://kenney.nl/assets/impact-sounds | kenney_impact-sounds.zip | 800,850 B | CC0 | yes |
| Interface Sounds | https://kenney.nl/assets/interface-sounds | kenney_interface-sounds.zip | 834,536 B | CC0 | yes |
| UI Audio | https://kenney.nl/assets/ui-audio | kenney_ui-audio.zip | 411,949 B | CC0 | yes |
| RPG Audio | https://kenney.nl/assets/rpg-audio | kenney_rpg-audio.zip | 964,837 B | CC0 | yes |
| Sci-fi Sounds | https://kenney.nl/assets/sci-fi-sounds | kenney_sci-fi-sounds.zip | 5,875,104 B | CC0 | yes |
| Digital Audio | https://kenney.nl/assets/digital-audio | kenney_digital-audio.zip | 990,367 B | CC0 | auditioned, not used |
| Casino Audio | https://kenney.nl/assets/casino-audio | kenney_casino-audio.zip | 876,839 B | CC0 | auditioned, not used |
| Music Jingles | https://kenney.nl/assets/music-jingles | kenney_music-jingles.zip | 1,239,525 B | CC0 | auditioned, not used |

Kenney has no firearm pack. Gunshots therefore stay synthesized for the crack and get a recorded
body layered under them (Sci-fi Sounds `explosionCrunch_*` / `lowFrequency_explosion_*`, Impact
Sounds `impactMetal_light_*` for the action), mixed at load time in `samples.ts`.

## How the files are made

`apps/web/src/game/audio/build-sfx.sh` (ffmpeg) turns the original `.ogg` files into the shipped
ones: mono 48 kHz, trimmed, pitched / filtered / layered per recipe, leading silence removed,
level set to -16 dB peak 50 ms-window RMS (short-clip stand-in for -16 LUFS short-term) with a
-1 dBFS peak cap, then Opus `.ogg` (40 kbps) and AAC `.m4a` (48 kbps, Safari fallback).
`apps/web/public/sfx/manifest.json` lists every shipped file with its exact Kenney source files.
Only audio files were extracted from the archives; nothing in them was executed.

Total shipped: 81 sounds × 2 formats ≈ 0.75 MB.
