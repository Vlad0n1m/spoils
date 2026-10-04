#!/usr/bin/env bash
# Builds apps/web/public/sfx/*.{ogg,m4a} from Kenney CC0 packs (see docs/AUDIO_CREDITS.md).
#
#   SRC=/path/to/unzipped/kenney ./build-sfx.sh
#
# SRC holds one folder per pack, unzipped as downloaded from kenney.nl:
#   impact-sounds/ interface-sounds/ ui-audio/ rpg-audio/ sci-fi-sounds/
# Only audio files are read; nothing from the archives is executed.
#
# Per output: inputs → mono 48 kHz → the recipe's filter graph (trim / pitch / EQ / layering) →
# leading silence removed → peak-window loudness set to -16 dB RMS (50 ms windows, the short-clip
# stand-in for -16 LUFS short-term), capped at -1 dBFS peak → Opus .ogg + AAC .m4a (Safari).
# The engine re-matches each sample to its procedural counterpart's level at load (samples.ts), so
# the mix table in recipes.ts keeps working either way.
set -euo pipefail
SRC="${SRC:?set SRC to the folder with the unzipped Kenney packs}"
OUT="${OUT:-$(cd "$(dirname "$0")/../../../public" && pwd)/sfx}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"
MAN=()
TARGET_DB=-16
PEAK_DB=-1

I=impact-sounds/Audio
F=interface-sounds/Audio
U=ui-audio/Audio
R=rpg-audio/Audio
S=sci-fi-sounds/Audio

PITCH() { echo "asetrate=48000*$1,aresample=48000"; }

# mk <name> <length s> <graph using [a0] [a1] … ending in [o]> <input>...
mk() {
  local name=$1 len=$2 graph=$3
  shift 3
  local args=() pre="" i=0
  for f in "$@"; do
    args+=(-i "$SRC/$f")
    pre+="[$i:a]aformat=channel_layouts=mono,aresample=48000[a$i];"
    i=$((i + 1))
  done
  local fade_start
  fade_start=$(awk -v l="$len" 'BEGIN { f = l * 0.35; if (f > 0.15) f = 0.15; printf "%.3f", l - f }')
  local fade_d
  fade_d=$(awk -v l="$len" -v s="$fade_start" 'BEGIN { printf "%.3f", l - s }')
  local post="[o]silenceremove=start_periods=1:start_threshold=-50dB,atrim=0:$len,afade=t=out:st=$fade_start:d=$fade_d,highpass=f=30[p]"
  ffmpeg -v error -y "${args[@]}" -filter_complex "$pre$graph;$post" -map "[p]" -ac 1 -ar 48000 -c:a pcm_f32le "$TMP/$name.wav"
  # Loudness: max 50 ms-window RMS and the peak, then one gain that satisfies both targets.
  local st rms pk gain
  st=$(ffmpeg -v info -i "$TMP/$name.wav" -af "astats=measure_overall=RMS_peak+Peak_level:measure_perchannel=none:length=0.05" -f null - 2>&1)
  rms=$(echo "$st" | awk -F': ' '/RMS peak dB/ { v = $2 } END { print v }')
  pk=$(echo "$st" | awk -F': ' '/Peak level dB/ { v = $2 } END { print v }')
  gain=$(awk -v r="$rms" -v p="$pk" -v t="$TARGET_DB" -v c="$PEAK_DB" 'BEGIN { g = t - r; if (p + g > c) g = c - p; printf "%.2f", g }')
  ffmpeg -v error -y -i "$TMP/$name.wav" -af "volume=${gain}dB" -c:a libopus -b:a 40k -vbr on -application audio "$OUT/$name.ogg"
  ffmpeg -v error -y -i "$TMP/$name.wav" -af "volume=${gain}dB" -c:a aac -b:a 48k -movflags +faststart "$OUT/$name.m4a"
  local srcs
  srcs=$(printf '"%s",' "$@")
  MAN+=("    \"$name\": { \"sources\": [${srcs%,}], \"gainDb\": $gain }")
  printf '%-22s rms %6s pk %6s gain %6s  %s\n' "$name" "$rms" "$pk" "$gain" "$*"
}

one() { echo "[a0]anull[o]"; }

# ---------------------------------------------------------------- gun bodies (layered on the synth)
# Kenney has no firearm pack: the crack stays procedural, these add a gritty body/tail under it.
mk gun_pistol_1   0.22 "[a0]$(PITCH 1.25),highpass=f=180[b];[a1]$(PITCH 1.1),volume=-9dB[m];[b][m]amix=inputs=2:normalize=0[o]" $S/explosionCrunch_000.ogg $I/impactMetal_light_001.ogg
mk gun_pistol_2   0.22 "[a0]$(PITCH 1.2),highpass=f=180[b];[a1]$(PITCH 1.1),volume=-9dB[m];[b][m]amix=inputs=2:normalize=0[o]" $S/explosionCrunch_002.ogg $I/impactMetal_light_002.ogg
mk gun_rifle_1    0.26 "[a0]$(PITCH 1.12),highpass=f=120[b];[a1]volume=-10dB[m];[b][m]amix=inputs=2:normalize=0[o]" $S/explosionCrunch_002.ogg $I/impactMetal_light_000.ogg
mk gun_rifle_2    0.26 "[a0]$(PITCH 1.08),highpass=f=120[b];[a1]volume=-10dB[m];[b][m]amix=inputs=2:normalize=0[o]" $S/explosionCrunch_003.ogg $I/impactMetal_light_002.ogg
mk gun_smg_1      0.16 "[a0]$(PITCH 1.35),highpass=f=220[o]" $S/explosionCrunch_001.ogg
mk gun_smg_2      0.16 "[a0]$(PITCH 1.3),highpass=f=220[o]" $S/explosionCrunch_000.ogg
mk gun_lmg_1      0.3  "[a0]$(PITCH 1.02),highpass=f=90[b];[a1]$(PITCH 0.9),volume=-10dB[m];[b][m]amix=inputs=2:normalize=0[o]" $S/explosionCrunch_003.ogg $I/impactMetal_light_000.ogg
mk gun_lmg_2      0.3  "[a0]$(PITCH 0.98),highpass=f=90[b];[a1]$(PITCH 0.9),volume=-10dB[m];[b][m]amix=inputs=2:normalize=0[o]" $S/explosionCrunch_004.ogg $I/impactMetal_light_001.ogg
mk gun_revolver_1 0.4  "[a0]$(PITCH 0.95),highpass=f=100[b];[a1]$(PITCH 0.8),volume=-8dB[m];[b][m]amix=inputs=2:normalize=0[o]" $S/explosionCrunch_004.ogg $I/impactMetal_light_003.ogg
mk gun_sniper_1   0.6  "[a0]$(PITCH 0.92),highpass=f=70[b];[a1]volume=-3dB[l];[b][l]amix=inputs=2:normalize=0[o]" $S/explosionCrunch_000.ogg $S/lowFrequency_explosion_001.ogg
mk gun_shotgun_1  0.5  "[a0]$(PITCH 0.85),highpass=f=60[b];[a1]$(PITCH 1.1),volume=-2dB[l];[b][l]amix=inputs=2:normalize=0[o]" $S/explosionCrunch_001.ogg $S/lowFrequency_explosion_000.ogg
mk gun_shotgun_2  0.5  "[a0]$(PITCH 0.82),highpass=f=60[b];[a1]$(PITCH 1.05),volume=-2dB[l];[b][l]amix=inputs=2:normalize=0[o]" $S/explosionCrunch_003.ogg $S/lowFrequency_explosion_001.ogg
mk explosion_1    2.2  "[a0]highpass=f=40[b];[a1]volume=-1dB[l];[b][l]amix=inputs=2:normalize=0[o]" $S/explosionCrunch_004.ogg $S/lowFrequency_explosion_000.ogg
mk explosion_2    2.0  "[a0]$(PITCH 0.9),highpass=f=40[b];[a1]$(PITCH 0.95),volume=-1dB[l];[b][l]amix=inputs=2:normalize=0[o]" $S/explosionCrunch_003.ogg $S/lowFrequency_explosion_000.ogg
mk explosion_far  2.4  "[a0]lowpass=f=900[o]" $S/lowFrequency_explosion_000.ogg

# ---------------------------------------------------------------- weapon handling
mk grenade_pin      0.3  "[a0]$(PITCH 1.35)[o]" $R/metalClick.ogg
mk grenade_bounce_1 0.22 "$(one)" $I/impactMetal_light_000.ogg
mk grenade_bounce_2 0.22 "$(one)" $I/impactMetal_light_001.ogg
mk grenade_bounce_3 0.22 "$(one)" $I/impactMetal_light_002.ogg
mk reload_out       0.28 "[a0]$(PITCH 1.3)[o]" $I/impactPlate_light_001.ogg
mk reload_in        0.3  "$(one)" $R/metalClick.ogg
mk rack             0.26 "$(one)" $R/metalLatch.ogg
mk dry_fire         0.12 "[a0]$(PITCH 1.2)[o]" $U/switch3.ogg
mk weapon_switch_1  0.32 "[a0]lowpass=f=7000[o]" $R/drawKnife2.ogg
mk weapon_switch_2  0.32 "[a0]lowpass=f=7000[o]" $R/drawKnife3.ogg

# ---------------------------------------------------------------- impacts
mk hit_flesh_1  0.25 "$(one)" $I/impactPunch_medium_000.ogg
mk hit_flesh_2  0.25 "$(one)" $I/impactPunch_medium_001.ogg
mk hit_flesh_3  0.25 "$(one)" $I/impactPunch_medium_003.ogg
mk hit_armor_1  0.32 "$(one)" $I/impactPlate_medium_000.ogg
mk hit_armor_2  0.32 "$(one)" $I/impactPlate_medium_001.ogg
mk hit_armor_3  0.32 "$(one)" $I/impactPlate_medium_002.ogg
mk hit_wall_1   0.25 "$(one)" $I/impactMining_000.ogg
mk hit_wall_2   0.25 "$(one)" $I/impactMining_001.ogg
mk hit_wall_3   0.25 "$(one)" $I/impactMining_002.ogg
mk body_fall_1  0.45 "$(one)" $I/impactSoft_heavy_000.ogg
mk body_fall_2  0.45 "$(one)" $I/impactSoft_heavy_001.ogg
mk body_fall_3  0.45 "$(one)" $I/impactSoft_heavy_002.ogg
mk hitmarker    0.06 "[a0]highpass=f=1500[o]" $F/tick_002.ogg
mk kill_confirm 0.3  "$(one)" $F/confirmation_001.ogg

# ---------------------------------------------------------------- footsteps (by terrain)
for n in 0 1 2 3 4; do
  mk step_grass_$((n + 1))    0.3  "$(one)" $I/footstep_grass_00$n.ogg
  mk step_concrete_$((n + 1)) 0.16 "$(one)" $I/footstep_concrete_00$n.ogg
  mk step_wood_$((n + 1))     0.22 "$(one)" $I/footstep_wood_00$n.ogg
  mk step_dirt_$((n + 1))     0.25 "$(one)" $R/footstep0$n.ogg
done
# Asphalt: the concrete takes a little lower and duller.
for n in 0 2 4; do
  mk step_asphalt_$((n / 2 + 1)) 0.16 "[a0]$(PITCH 0.9),lowpass=f=5000[o]" $I/footstep_concrete_00$n.ogg
done

# ---------------------------------------------------------------- interaction
mk roll           0.45 "[a0]highpass=f=120[o]" $R/clothBelt2.ogg
mk search_1       0.5  "$(one)" $R/cloth1.ogg
mk search_2       0.45 "$(one)" $R/cloth2.ogg
mk search_3       0.45 "$(one)" $R/cloth3.ogg
mk heal_bandage   0.42 "$(one)" $R/cloth4.ogg
mk heal_medkit    0.6  "[a1]adelay=180[d];[a0][d]amix=inputs=2:normalize=0[o]" $R/bookOpen.ogg $R/handleSmallLeather2.ogg
mk chest_open       0.55 "[a1]volume=-4dB[k];[a0][k]amix=inputs=2:normalize=0[o]" $R/creak3.ogg $I/impactWood_light_000.ogg
mk chest_open_metal 0.5  "[a1]adelay=90,volume=-3dB[k];[a0][k]amix=inputs=2:normalize=0[o]" $R/metalLatch.ogg $I/impactMetal_light_004.ogg
mk chest_open_safe  0.9  "[a1]adelay=160[c];[a2]$(PITCH 0.8),adelay=260,volume=-4dB[k];[a0][c][k]amix=inputs=3:normalize=0[o]" $R/metalClick.ogg $R/metalLatch.ogg $R/creak2.ogg
mk item_pickup    0.32 "$(one)" $R/handleSmallLeather.ogg
mk item_drop      0.4  "$(one)" $R/dropLeather.ogg
mk extract_start   0.4  "$(one)" $F/maximize_006.ogg
mk extract_success 0.55 "$(one)" $F/confirmation_002.ogg

# ---------------------------------------------------------------- UI
mk ui_click_1 0.09 "$(one)" $U/click1.ogg
mk ui_click_2 0.09 "$(one)" $U/click3.ogg
mk ui_hover   0.06 "$(one)" $U/rollover2.ogg
mk ui_coin    0.34 "$(one)" $R/handleCoins2.ogg
mk ui_error   0.16 "$(one)" $F/error_002.ogg
mk ui_equip   0.19 "$(one)" $F/drop_002.ogg

{
  echo '{'
  echo '  "license": "CC0 1.0 (Kenney, kenney.nl) - see docs/AUDIO_CREDITS.md",'
  echo '  "formats": ["ogg", "m4a"],'
  echo '  "files": {'
  last=$((${#MAN[@]} - 1))
  for i in "${!MAN[@]}"; do
    if [ "$i" -lt "$last" ]; then echo "${MAN[$i]},"; else echo "${MAN[$i]}"; fi
  done
  echo '  }'
  echo '}'
} > "$OUT/manifest.json"

du -ch "$OUT"/*.ogg | tail -1
du -ch "$OUT"/*.m4a | tail -1
