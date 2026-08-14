const fs = require('fs');
const path = require('path');
const { Schematic } = require('prismarine-schematic');

const SCHEMATICS_DIR = path.join(__dirname, 'schematics');

// resolves a user-supplied schematic name to a real file inside
// schematics/, appending .schem if missing and refusing anything that
// would escape the folder (e.g. "../something")
const resolveSchematicPath = (name) => {
    const filename = name.toLowerCase().endsWith('.schem') ? name : `${name}.schem`;
    const filePath = path.join(SCHEMATICS_DIR, filename);
    if (!filePath.startsWith(SCHEMATICS_DIR + path.sep)) return null;
    return fs.existsSync(filePath) ? filePath : null;
};

const loadSchematic = async (name) => {
    const filePath = resolveSchematicPath(name);
    if (!filePath) return null;
    const buffer = await fs.promises.readFile(filePath);
    return Schematic.read(buffer);
};

// flattens the schematic into a placement plan: one entry per non-air
// block, in world coordinates (schematic-local position + anchor), sorted
// bottom-up (lowest Y first) so blocks are more likely to land on
// something solid instead of floating with nothing placed under them yet
const buildPlan = (schematic, anchor) => {
    const plan = [];
    schematic.forEach((block, pos) => {
        if (!block || block.name === 'air') return;
        plan.push({
            x: anchor.x + pos.x,
            y: anchor.y + pos.y,
            z: anchor.z + pos.z,
            blockName: block.name,
        });
    });
    plan.sort((a, b) => a.y - b.y);
    return plan;
};

module.exports = { loadSchematic, buildPlan, resolveSchematicPath, SCHEMATICS_DIR };
