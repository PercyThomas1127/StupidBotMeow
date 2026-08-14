const { loadLitematic } = require('litematic-parser');

const TWO_64 = 1n << 64n;
const toUnsigned64 = (n) => (n < 0n ? n + TWO_64 : n);

const bitsNeeded = (paletteSize) => {
    let bits = 1;
    while ((1 << bits) < paletteSize) bits++;
    return Math.max(2, bits);
};

// Litematica packs one palette index per block into a flat array of 64-bit
// longs, `bitsPerEntry` bits at a time with no per-long padding (entries can
// straddle two longs) - the same scheme Minecraft itself uses for chunk
// section palettes. Verified against a real .litematic file: the decoded
// non-air count exactly matched the file's own recorded TotalBlocks metadata.
const bitArrayGet = (longArray, bitsPerEntry, index) => {
    const bpe = BigInt(bitsPerEntry);
    const maxVal = (1n << bpe) - 1n;
    const startOffset = BigInt(index) * bpe;
    const startArrIndex = Number(startOffset >> 6n);
    const endArrIndex = Number((startOffset + bpe - 1n) >> 6n);
    const startBitOffset = startOffset & 0x3Fn;
    let val = toUnsigned64(longArray[startArrIndex]) >> startBitOffset;
    if (startArrIndex !== endArrIndex) {
        val |= toUnsigned64(longArray[endArrIndex]) << (64n - startBitOffset);
    }
    return Number(val & maxVal);
};

const minOf = (arr, select) => arr.reduce((min, item) => Math.min(min, select(item)), Infinity);

// flattens every region's blocks into one list of {x,y,z,blockName}, in
// local coordinates normalized so the schematic's own minimum corner is
// (0,0,0) - matches how prismarine-schematic's .schem coordinates work, so
// the rest of the builder doesn't need to know which format it came from.
// A region's Size components can be negative (Litematica's convention for
// "this region extends backwards from Position"), which is why each axis is
// walked with abs(size) and signed back in before normalizing.
const decodeLitematicBlocks = (litematic) => {
    const raw = [];
    for (const region of Object.values(litematic.Regions)) {
        const { x: sizeX, y: sizeY, z: sizeZ } = region.Size;
        const absX = Math.abs(sizeX), absY = Math.abs(sizeY), absZ = Math.abs(sizeZ);
        const bitsPerEntry = bitsNeeded(region.BlockStatePalette.length);
        for (let y = 0; y < absY; y++) {
            for (let z = 0; z < absZ; z++) {
                for (let x = 0; x < absX; x++) {
                    const index = y * absX * absZ + z * absX + x;
                    const paletteIndex = bitArrayGet(region.BlockStates, bitsPerEntry, index);
                    const block = region.BlockStatePalette[paletteIndex];
                    if (!block || block.Name === 'minecraft:air') continue;
                    raw.push({
                        x: region.Position.x + (sizeX >= 0 ? x : -x),
                        y: region.Position.y + (sizeY >= 0 ? y : -y),
                        z: region.Position.z + (sizeZ >= 0 ? z : -z),
                        blockName: block.Name.replace(/^minecraft:/, ''),
                    });
                }
            }
        }
    }
    if (!raw.length) return raw;
    const minX = minOf(raw, (b) => b.x);
    const minY = minOf(raw, (b) => b.y);
    const minZ = minOf(raw, (b) => b.z);
    return raw.map((b) => ({ x: b.x - minX, y: b.y - minY, z: b.z - minZ, blockName: b.blockName }));
};

module.exports = { loadLitematic, decodeLitematicBlocks };
