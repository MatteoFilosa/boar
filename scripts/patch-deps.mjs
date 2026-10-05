// Fixes to dependencies, applied after every npm install (postinstall).
// Each fix replaces an exact piece of code: when an update changes that code
// the install stops here, so the fix is checked again instead of silently lost.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const fixes = [
  {
    // Some apps (phone and chat app exports) write a wrong level in the avcC
    // header, e.g. 0x04 instead of 0x28 for level 4.0. Mediabunny builds the
    // codec string from that header, Chromium refuses "avc1.640004" and the
    // video is imported as sound only. The SPS that follows holds the real
    // profile, constraint flags and level: use it when the header level is not
    // a valid level_idc.
    name: 'mediabunny: AVC codec string from the SPS when the avcC level is invalid',
    file: 'node_modules/mediabunny/dist/modules/src/codec.js',
    marker: 'BOAR_AVC_LEVEL_FIX',
    find: `        if (avcCodecInfo) {
            const bytes = new Uint8Array([
                avcCodecInfo.avcProfileIndication,
                avcCodecInfo.profileCompatibility,
                avcCodecInfo.avcLevelIndication,
            ]);
            return \`avc\${trackInfo.avcType}.\${bytesToHexString(bytes)}\`;
        }
        if (!codecDescription || codecDescription.byteLength < 4) {
            throw new TypeError('AVC decoder description is not provided or is not at least 4 bytes long.');
        }
        return \`avc\${trackInfo.avcType}.\${bytesToHexString(codecDescription.subarray(1, 4))}\`;`,
    replace: `        // BOAR_AVC_LEVEL_FIX (scripts/patch-deps.mjs): a wrong level in the avcC header is taken from the SPS.
        const validLevels = [9, 10, 11, 12, 13, 20, 21, 22, 30, 31, 32, 40, 41, 42, 50, 51, 52, 60, 61, 62];
        const fromSps = (header, sps) => !validLevels.includes(header[2]) && sps && sps.length >= 4 && (sps[0] & 0x1f) === 7 && validLevels.includes(sps[3])
            ? sps.subarray(1, 4)
            : header;
        if (avcCodecInfo) {
            const bytes = new Uint8Array([
                avcCodecInfo.avcProfileIndication,
                avcCodecInfo.profileCompatibility,
                avcCodecInfo.avcLevelIndication,
            ]);
            return \`avc\${trackInfo.avcType}.\${bytesToHexString(fromSps(bytes, avcCodecInfo.sequenceParameterSets?.[0]))}\`;
        }
        if (!codecDescription || codecDescription.byteLength < 4) {
            throw new TypeError('AVC decoder description is not provided or is not at least 4 bytes long.');
        }
        // avcC: version, profile, compatibility, level, length size, SPS count, SPS length (2 bytes), SPS.
        const spsLength = codecDescription.byteLength >= 8 ? (codecDescription[6] << 8) | codecDescription[7] : 0;
        const sps = spsLength > 0 && codecDescription.byteLength >= 8 + spsLength ? codecDescription.subarray(8, 8 + spsLength) : undefined;
        return \`avc\${trackInfo.avcType}.\${bytesToHexString(fromSps(codecDescription.subarray(1, 4), sps))}\`;`
  }
]

let failed = false
for (const fix of fixes) {
  const path = join(root, fix.file)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    console.error(`[patch-deps] ${fix.name}: ${fix.file} not found`)
    failed = true
    continue
  }
  if (text.includes(fix.marker)) continue
  if (!text.includes(fix.find)) {
    console.error(`[patch-deps] ${fix.name}: the code to fix changed in this version, check the fix again`)
    failed = true
    continue
  }
  writeFileSync(path, text.replace(fix.find, fix.replace))
  console.log(`[patch-deps] ${fix.name}`)
}
if (failed) process.exit(1)
