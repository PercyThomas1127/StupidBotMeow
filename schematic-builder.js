const fs = require('fs');
const path = require('path');
const { Schematic } = require('prismarine-schematic');
const { loadLitematic, decodeLitematicBlocks } = require('./litematic-reader');

const SCHEMATICS_DIR = path.join(__dirname, 'schematics');
const SUPPORTED_EXTENSIONS = ['.schem', '.litematic'];

// resolves a user-supplied schematic name to a real file inside
// schematics/, trying each supported extension if the name doesn't already
// have one, and refusing anything that would escape the folder (e.g.
// "../something")
const resolveSchematicPath = (name) => {
    const hasExtension = SUPPORTED_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));
    const candidates = hasExtension ? [name] : SUPPORTED_EXTENSIONS.map((ext) => `${name}${ext}`);
    for (const filename of candidates) {
        const filePath = path.join(SCHEMATICS_DIR, filename);
        if (!filePath.startsWith(SCHEMATICS_DIR + path.sep)) continue;
        if (fs.existsSync(filePath)) return filePath;
    }
    return null;
};

// how often the .schem loading loop below yields to the event loop - see
// the matching constant/comment in litematic-reader.js for why this exists
const YIELD_EVERY_N_BLOCKS = 512;
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

// normalizes both formats to the same shape - { blocks: [{x,y,z,blockName}] }
// in local coordinates - so buildPlan doesn't need to know which one it got
const loadSchematic = async (name) => {
    const filePath = resolveSchematicPath(name);
    if (!filePath) return null;
    if (filePath.toLowerCase().endsWith('.litematic')) {
        const litematic = await loadLitematic(filePath);
        return { blocks: await decodeLitematicBlocks(litematic) };
    }
    const buffer = await fs.promises.readFile(filePath);
    const schematic = await Schematic.read(buffer);
    const blocks = [];
    // prismarine-schematic's forEach does `await cb(block, pos)` per block,
    // but awaiting a plain (non-async) callback's return value is only a
    // microtask boundary, not a real yield to the event loop - network I/O
    // still can't be processed until the whole loop finishes. Making this
    // callback async and periodically doing a real setImmediate-based await
    // forces genuine yields into their loop without needing to touch their
    // code, for the same reason (and with the same live consequence) as the
    // litematic decoder above.
    let processed = 0;
    await schematic.forEach(async (block, pos) => {
        if (++processed % YIELD_EVERY_N_BLOCKS === 0) await yieldToEventLoop();
        if (!block || block.name === 'air') return;
        blocks.push({ x: pos.x, y: pos.y, z: pos.z, blockName: block.name });
    });
    return { blocks };
};

// turns the loaded schematic into a placement plan: schematic-local
// position + anchor, sorted bottom-up (lowest Y first) so blocks are more
// likely to land on something solid instead of floating with nothing
// placed under them yet
const buildPlan = (schematic, anchor) => {
    const plan = schematic.blocks.map((b) => ({
        x: anchor.x + b.x,
        y: anchor.y + b.y,
        z: anchor.z + b.z,
        blockName: b.blockName,
    }));
    plan.sort((a, b) => a.y - b.y);
    return plan;
};

module.exports = { loadSchematic, buildPlan, resolveSchematicPath, SCHEMATICS_DIR };
