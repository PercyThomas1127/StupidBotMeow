const mineflayer = require ('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const fs = require('fs');
const path = require('path');
const chatGameSolver = require('./chatgame-solver');
const schematicBuilder = require('./schematic-builder');

const logPath = path.join(__dirname, 'errors.txt');
const log = (label, detail) => {
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${label} ${JSON.stringify(detail)}\n`);
};

const OPERATORS = ['VOlcarona_Alt', 'SpeedStrafe04', 'AustrichMC'];
const isFromOperator = (message) => OPERATORS.some(name => message.includes(name));

// mineflayer logs this whenever a map_chunk packet fails to parse into a
// usable column (real data loss - blockAt/pathfinding/building near that
// chunk can be wrong) - it's not cosmetic, but it's noisy, so we silence the
// console spam here rather than passing createBot's blanket hideErrors flag
// (which would also swallow unrelated, more important warnings/errors)
const originalConsoleWarn = console.warn.bind(console);
console.warn = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('Ignoring block entities as chunk failed to load')) return;
    originalConsoleWarn(...args);
};

// protodef (minecraft-protocol's packet decoder) logs this whenever a
// packet's declared field list doesn't consume the whole buffer - traced
// this to entity_teleport specifically at protocol 774 (1.21.11): the real
// wire packet now carries extra fields (velocity + float yaw/pitch) that
// minecraft-data's definition for this version doesn't know about yet, so
// it stops early and warns about the leftover bytes on every single
// occurrence. The fields we actually use (entity position) decode fine
// either way since they come before the point where the definition falls
// behind - only the unused trailing fields (yaw/pitch/onGround) come out
// garbled - so this is safe to silence rather than fix with a hand-rebuilt
// packet definition that could introduce a subtler bug if wrong.
const originalConsoleLog = console.log.bind(console);
console.log = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('Chunk size is') && args[0].includes('was read')) return;
    originalConsoleLog(...args);
};

// server to connect to - stored in server-config.json so the control panel
// can change it before a launch without editing code
const SERVER_CONFIG_PATH = path.join(__dirname, 'server-config.json');
const DEFAULT_SERVER_CONFIG = { host: 'play.skeletonmc.com', port: 25565, username: 'MeowMeowNya', version: null, hubNpcName: null };
const loadServerConfig = () => {
    try {
        return { ...DEFAULT_SERVER_CONFIG, ...JSON.parse(fs.readFileSync(SERVER_CONFIG_PATH, 'utf8')) };
    } catch {
        return DEFAULT_SERVER_CONFIG;
    }
};
// hosts with known per-version bugs get a hardcoded fallback so they keep
// working even if server-config.json doesn't pin a version explicitly -
// play.skeletonmc.com's actual backend is 1.21.11, but that version has
// broken item-component parsing and forces signed chat there, so it's
// pinned to the older 1.16.5 protocol to dodge both bugs
const KNOWN_HOST_VERSION_OVERRIDES = { 'play.skeletonmc.com': '1.16.5' };
// hubNpcName: some networks (e.g. ggsmp.net) require right-clicking a lobby
// NPC after login to actually enter the main server - optional, only acted
// on when the current server-config.json sets it.
// version: leave unset (or blank in the control panel) to have mineflayer
// gather this itself - passing `false` makes minecraft-protocol ping the
// server first and auto-detect its protocol version before connecting
// (this is what fixed ggsmp.net's "chunk failed to load" spam, which was
// caused by being pinned to a version that didn't match its real backend).
// Only override this per-server if that server's real version turns out to
// have its own bugs, the way play.skeletonmc.com does.
const { host: HOST, port: PORT, username: USERNAME, version: CONFIGURED_VERSION, hubNpcName: HUB_NPC_NAME } = loadServerConfig();
const VERSION = CONFIGURED_VERSION || KNOWN_HOST_VERSION_OVERRIDES[HOST] || false;

// tracks which host+username combos we've already registered, so a fresh
// server (or a different account on a known server) gets /register instead
// of /login on its first join, while known combos keep using /login
const REGISTERED_HOSTS_PATH = path.join(__dirname, 'registered-hosts.json');
const registeredHosts = new Set(
    fs.existsSync(REGISTERED_HOSTS_PATH)
        ? JSON.parse(fs.readFileSync(REGISTERED_HOSTS_PATH, 'utf8'))
        : []
);
const hostAccountKey = (host, username) => `${host}:${username}`;
const markHostRegistered = (host, username) => {
    registeredHosts.add(hostAccountKey(host, username));
    fs.writeFileSync(REGISTERED_HOSTS_PATH, JSON.stringify([...registeredHosts].sort(), null, 2) + '\n');
};

// Chat Games are multi-line broadcast puzzles (header, blank lines, equations,
// etc.) sent as a burst of separate chat messages. Buffer every message from
// the "CHAT GAMES" header onward, and once the burst goes quiet for a bit,
// flush the whole block to chatgames.txt - but only if we haven't already
// logged that exact block before, so repeats of the same puzzle aren't logged.
const CHAT_GAMES_PATH = path.join(__dirname, 'chatgames.txt');
const CHAT_GAMES_FLUSH_DELAY_MS = 900;
const CHAT_GAMES_SEPARATOR = '\n---\n';

const loggedChatGames = new Set(
    fs.existsSync(CHAT_GAMES_PATH)
        ? fs.readFileSync(CHAT_GAMES_PATH, 'utf8').split(CHAT_GAMES_SEPARATOR).map(s => s.trim()).filter(Boolean)
        : []
);

let chatGameBuffer = null;
let chatGameFlushTimer = null;
let currentBot = null; // set in connect(); flushChatGame lives outside connect() but needs to chat
// disabled by default: the account was banned ("afk farming chat games") for
// this exact behavior - re-enable manually via "Meow, enable chat games."
// or the control panel once you're ready to risk it again
let chatGamesEnabled = false;

// the "CHAT GAMES" header is reused for the round's result/winner
// announcement too (e.g. "20s have passed! ... The correct answer was...",
// or "X was the fastest to fill `Word` ... and got a prize!") - that's not
// the game itself, so don't log it, just harvest any word it reveals
const RESULT_ANNOUNCEMENT_MARKERS = ['have passed!', 'is now over!', 'correct answer was', 'and got a prize!'];
const isResultAnnouncement = (block) => RESULT_ANNOUNCEMENT_MARKERS.some(marker => block.includes(marker));

const flushChatGame = () => {
    const buffer = chatGameBuffer;
    chatGameBuffer = null;
    if (!buffer || buffer.length === 0) return;
    const block = buffer.join('\n').trim();
    if (!block || loggedChatGames.has(block)) return;
    loggedChatGames.add(block);

    if (isResultAnnouncement(block)) {
        chatGameSolver.learnFromAnnouncement(block);
        return;
    }

    const answer = chatGameSolver.solve(block);
    if (answer != null && currentBot) {
        currentBot.chat(answer);
    } else {
        fs.appendFileSync(CHAT_GAMES_PATH, block + CHAT_GAMES_SEPARATOR);
    }
};

const recordChatGameLine = (message) => {
    if (!chatGamesEnabled) return;
    if (message.includes('CHAT GAMES')) {
        chatGameBuffer = [message];
    } else if (chatGameBuffer) {
        chatGameBuffer.push(message);
    } else {
        return;
    }
    if (chatGameFlushTimer) clearTimeout(chatGameFlushTimer);
    chatGameFlushTimer = setTimeout(flushChatGame, CHAT_GAMES_FLUSH_DELAY_MS);
};

const RECONNECT_DELAY_MS = 5000;
const QUICK_FAILURE_THRESHOLD_MS = 10000;
const STALE_SESSION_RECONNECT_DELAY_MS = 40000;
const MAX_RECONNECT_DELAY_MS = 10 * 60 * 1000;
let reconnecting = false;
// ggsmp.net's "internal error"/instant kicks tend to come in bursts, which
// looks like the network rate-limiting or flagging accounts that reconnect
// too often in a short window - backing off harder on each consecutive
// quick kick (instead of always retrying at the same fixed pace) avoids
// digging that hole deeper. Resets once a connection survives past the
// quick-failure threshold, so a single flaky kick doesn't permanently slow
// down future reconnects.
let consecutiveQuickFailures = 0;

const scheduleReconnect = (reason, delay) => {
    if (reconnecting) return;
    reconnecting = true;
    console.log('RECONNECTING in', delay, 'ms due to', reason);
    log('RECONNECTING', reason);
    setTimeout(() => {
        reconnecting = false;
        connect();
    }, delay);
};

function connect() {
    const connectStartedAt = Date.now();
    const disconnectDelay = () => {
        const wasQuickFailure = Date.now() - connectStartedAt < QUICK_FAILURE_THRESHOLD_MS;
        if (!wasQuickFailure) {
            consecutiveQuickFailures = 0;
            return RECONNECT_DELAY_MS;
        }
        consecutiveQuickFailures++;
        const delay = STALE_SESSION_RECONNECT_DELAY_MS * Math.pow(2, consecutiveQuickFailures - 1);
        return Math.min(delay, MAX_RECONNECT_DELAY_MS);
    };

    const bot = mineflayer.createBot({
        host: HOST,
        port: PORT,
        username: USERNAME,
        version: VERSION,
    });
    currentBot = bot
    bot.loadPlugin(pathfinder)

    let totemModeActive = false
    let attackHostilesEnabled = false
    let attackHostilesInterval = null

    const EQUIP_RETRY_DELAY_MS = 1500
    const EQUIP_MAX_ATTEMPTS = 3
    const SWAP_TO_OFFHAND_STATUS = 6
    const DROP_ITEM_STACK_STATUS = 3

    // location is meaningless for these action types per vanilla, but some
    // anti-cheat plugins validate it against the player's actual position for
    // every player-action packet regardless of type - use our real feet
    // position instead of a dummy (0,0,0) in case that's why they're ignored
    const feetPosition = () => {
        const pos = bot.entity.position
        return { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }
    }

    // drops the currently held item stack via the vanilla "Q" action - unlike
    // bot.tossStack(), this needs no window-click transaction (see EQUIP_ERROR/
    // ARMOR_EQUIP_ERROR: this server never acknowledges those)
    const dropHeldItemStack = () => {
        log('DROP_ITEM', { held: bot.heldItem && bot.heldItem.name })
        bot._client.write('block_dig', {
            status: DROP_ITEM_STACK_STATUS,
            location: feetPosition(),
            face: 0
        })
    }

    // swaps the currently held item with whatever's in the offhand (vanilla
    // "F" action) - no window-click transaction needed
    const offhandSlotItemName = () => {
        const item = bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')]
        return item && item.name
    }

    const swapHeldItemToOffhand = () => {
        log('SWAP_OFFHAND_BEFORE', { held: bot.heldItem && bot.heldItem.name, offhand: offhandSlotItemName() })
        bot._client.write('block_dig', {
            status: SWAP_TO_OFFHAND_STATUS,
            location: feetPosition(),
            face: 0
        })
        setTimeout(() => {
            log('SWAP_OFFHAND_AFTER', { held: bot.heldItem && bot.heldItem.name, offhand: offhandSlotItemName() })
        }, 1000)
    }

    const spin720 = () => {
        const steps = 24
        const stepRadians = (720 * Math.PI / 180) / steps
        let currentYaw = bot.entity.yaw
        let i = 0
        const step = () => {
            if (i >= steps) return
            currentYaw += stepRadians
            bot.look(currentYaw, 0, true)
            i++
            setTimeout(step, 50)
        }
        step()
    }

    const ARMOR_DESTINATION_BY_SUFFIX = [
        ['_helmet', 'head'],
        ['_chestplate', 'torso'],
        ['_leggings', 'legs'],
        ['_boots', 'feet'],
    ]
    const armorDestinationFor = (itemName) => {
        const match = ARMOR_DESTINATION_BY_SUFFIX.find(([suffix]) => itemName.endsWith(suffix))
        return match ? match[1] : null
    }

    const armorSlotsInProgress = new Set()

    const equipArmorPiece = (slot, destination) => {
        const inHotbar = slot >= bot.QUICK_BAR_START && slot < bot.QUICK_BAR_START + 9
        if (!inHotbar) {
            spin720() // no keybind-only way to move it into the hotbar - see Commands List.txt caveat
            return
        }
        if (armorSlotsInProgress.has(slot)) return // bot.equip's own optimistic slot updates can re-trigger this
        armorSlotsInProgress.add(slot)

        log('ARMOR_DETECTED', { slot, destination })
        bot.setQuickBarSlot(slot - bot.QUICK_BAR_START)
        setTimeout(() => {
            // right-clicking armor auto-equips it (vanilla behavior), swapping any
            // currently worn piece into hand - avoids window-click transactions
            bot.activateItem()
            setTimeout(() => {
                const held = bot.heldItem
                if (held && armorDestinationFor(held.name) === destination) {
                    dropHeldItemStack()
                }
                armorSlotsInProgress.delete(slot)
            }, 500)
        }, 300 + Math.random() * 200)
    }

    const equipTotem = (attempt = 1) => {
        const totem = bot.inventory.items().find(item => item.name === 'totem_of_undying')
        if (!totem) {
            bot.chat('Totem required')
            return
        }

        const inHotbar = totem.slot >= bot.QUICK_BAR_START && totem.slot < bot.QUICK_BAR_START + 9
        if (inHotbar) {
            // selecting a hotbar slot + swapping to offhand only needs simple
            // packets (held_item_slot, block_dig) - no window-click transaction,
            // which is the thing the server won't acknowledge (see EQUIP_ERROR).
            // Selecting the slot and swapping in the same tick reads as instant/
            // bot-like to anticheat, so space them out like a real key press.
            bot.setQuickBarSlot(totem.slot - bot.QUICK_BAR_START)
            setTimeout(swapHeldItemToOffhand, 300 + Math.random() * 200)
            return
        }

        bot.equip(totem, 'off-hand').catch(err => {
            log('EQUIP_ERROR', err.message)
            if (attempt < EQUIP_MAX_ATTEMPTS) {
                setTimeout(() => equipTotem(attempt + 1), EQUIP_RETRY_DELAY_MS)
            } else {
                spin720()
            }
        })
    }

    // finds a solid neighbor of `position` to place a block against, and the
    // face vector (from that neighbor) pointing at `position` - mirrors how
    // a player has to click an existing block's face to place a new one
    const NEIGHBOR_OFFSETS = [
        new Vec3(0, -1, 0), new Vec3(0, 1, 0),
        new Vec3(-1, 0, 0), new Vec3(1, 0, 0),
        new Vec3(0, 0, -1), new Vec3(0, 0, 1),
    ]
    const findPlacementReference = (position) => {
        for (const offset of NEIGHBOR_OFFSETS) {
            const neighborPos = position.plus(offset)
            const neighborBlock = bot.blockAt(neighborPos)
            if (neighborBlock && neighborBlock.boundingBox === 'block') {
                return { referenceBlock: neighborBlock, faceVector: offset.scaled(-1) }
            }
        }
        return null
    }

    // bot.pathfinder.goto() can hang indefinitely with no error and no
    // timeout of its own - most commonly when its built-in scaffolding
    // (jump + place a block underfoot to climb) gets stuck retrying a
    // placement that keeps losing the race against network latency. Once
    // hung, it can't even be interrupted by our own cancellation flags,
    // since those are only checked between awaits, not during one already
    // in flight. This wraps goto() with a hard timeout that force-stops
    // pathfinder (bot.pathfinder.stop(), which cleanly rejects the pending
    // goto()) instead of blocking whatever called it forever.
    const PATHFINDER_TIMEOUT_MS = 8000
    const gotoWithTimeout = (goal, timeoutMs = PATHFINDER_TIMEOUT_MS) => new Promise((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => {
            if (settled) return
            settled = true
            bot.pathfinder.stop()
            reject(new Error(`pathfinder timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        bot.pathfinder.goto(goal).then(
            () => { if (!settled) { settled = true; clearTimeout(timer); resolve() } },
            (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err) } }
        )
    })

    // custom vertical-bridging loop (jump + place a block underfoot to
    // climb), used as a fallback when normal pathfinding can't reach a
    // build position because it's higher than the bot can walk to. Replaces
    // relying on mineflayer-pathfinder's own built-in scaffolding, which
    // races the jump's physics against the network round-trip for
    // equipping/placing and almost always loses it (see gotoWithTimeout
    // above) - equips the scaffold block once upfront instead of re-equipping
    // every jump, and fires placeBlock the instant there's enough clearance
    // (polled every physics tick) rather than gating the whole attempt on a
    // slower check that only starts once the bot has already begun falling
    // back down.
    const findScaffoldItem = (avoidName) => {
        const items = bot.inventory.items().filter((item) => bot.registry.blocksByName[item.name])
        return items.find((item) => item.name !== avoidName) || items[0] || null
    }
    const BRIDGE_MAX_STEPS = 20
    const bridgeUp = async (targetY, avoidItemName) => {
        const scaffold = findScaffoldItem(avoidItemName)
        if (!scaffold) throw new Error('no scaffolding blocks available to bridge up')
        await bot.equip(scaffold, 'hand')
        for (let i = 0; i < BRIDGE_MAX_STEPS && bot.entity.position.y < targetY && !buildCancelled; i++) {
            const standingOn = bot.entity.position.offset(0, -1, 0).floored()
            const referenceBlock = bot.blockAt(standingOn)
            if (!referenceBlock || referenceBlock.boundingBox !== 'block') break
            bot.setControlState('jump', true)
            await new Promise((resolve) => {
                const onTick = () => {
                    if (bot.entity.position.y - standingOn.y >= 1) {
                        bot.removeListener('physicsTick', onTick)
                        resolve()
                    }
                }
                bot.on('physicsTick', onTick)
            })
            try {
                await bot.placeBlock(referenceBlock, new Vec3(0, 1, 0))
            } catch (err) {
                log('BRIDGE_ERROR', err.message)
                break
            } finally {
                bot.setControlState('jump', false)
            }
        }
        bot.setControlState('jump', false)
    }

    let buildCancelled = false

    const buildSchematic = async (payload) => {
        const hereMatch = payload && payload.match(/^(\S+)\s+here\.?$/i)
        const atMatch = payload && payload.match(/^(\S+)\s+at\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\.?$/i)
        if (!hereMatch && !atMatch) {
            bot.chat('Usage: Meow, build <name> at <x> <y> <z>. (or "Meow, build <name> here.")')
            return
        }
        const name = hereMatch ? hereMatch[1] : atMatch[1]

        const schematic = await schematicBuilder.loadSchematic(name).catch(err => {
            log('BUILD_LOAD_ERROR', err.message)
            return null
        })
        if (!schematic) {
            bot.chat(`Schematic not found: ${name}`)
            return
        }

        const anchor = hereMatch
            ? { x: Math.floor(bot.entity.position.x), y: Math.floor(bot.entity.position.y), z: Math.floor(bot.entity.position.z) }
            : { x: parseInt(atMatch[2], 10), y: parseInt(atMatch[3], 10), z: parseInt(atMatch[4], 10) }
        const plan = schematicBuilder.buildPlan(schematic, anchor)
        buildCancelled = false
        console.log(`[BUILD] Building ${name} (${plan.length} blocks)...`)

        let placed = 0
        let skipped = 0
        let announcedOutOfMaterials = false
        for (const step of plan) {
            if (buildCancelled) {
                console.log(`[BUILD] Build cancelled (${placed} placed, ${skipped} skipped).`)
                return
            }

            const position = new Vec3(step.x, step.y, step.z)
            const existing = bot.blockAt(position)
            if (existing && existing.name === step.blockName) {
                placed++
                continue
            }

            const item = bot.inventory.items().find(i => i.name === step.blockName)
            if (!item) {
                if (!announcedOutOfMaterials) {
                    console.log('[BUILD] Oops I ran out of materials')
                    announcedOutOfMaterials = true
                }
                skipped++
                continue
            }

            try {
                try {
                    await gotoWithTimeout(new goals.GoalPlaceBlock(position, bot.world, { range: 4, LOS: false }))
                } catch (gotoErr) {
                    // couldn't path there directly - if it's simply because the
                    // target is higher than we can reach, bridge up to it
                    // ourselves and retry once, instead of giving up immediately
                    if (bot.entity.position.y >= position.y - 1) throw gotoErr
                    await bridgeUp(position.y, step.blockName)
                    await gotoWithTimeout(new goals.GoalPlaceBlock(position, bot.world, { range: 4, LOS: false }))
                }
                const reference = findPlacementReference(position)
                if (!reference) {
                    skipped++
                    continue
                }
                await bot.equip(item, 'hand')
                await bot.placeBlock(reference.referenceBlock, reference.faceVector)
                placed++
            } catch (err) {
                log('BUILD_ERROR', { position: step, block: step.blockName, error: err.message })
                skipped++
            }
        }
        console.log(`[BUILD] Build complete: ${placed} placed, ${skipped} skipped.`)
    }

    // picks whatever tool matches the block's required category (using
    // minecraft-data's standardized "mineable/X" material field, which
    // covers axe/pickaxe/shovel/hoe) if one is carried; otherwise leaves
    // whatever's currently held alone - fist (or any hotbar item) still
    // breaks the block, just slower, rather than refusing to dig
    const TOOL_MATERIAL_SUFFIX = {
        'mineable/axe': '_axe',
        'mineable/pickaxe': '_pickaxe',
        'mineable/shovel': '_shovel',
        'mineable/hoe': '_hoe',
    }
    const equipCorrectToolFor = async (block) => {
        const toolSuffix = TOOL_MATERIAL_SUFFIX[block.material]
        if (!toolSuffix) return
        const tool = bot.inventory.items().find((item) => item.name.endsWith(toolSuffix))
        if (!tool || (bot.heldItem && bot.heldItem.type === tool.type)) return
        try {
            await bot.equip(tool, 'hand')
        } catch (err) {
            log('EQUIP_TOOL_ERROR', err.message)
        }
    }

    let gatherCancelled = false
    const isLogBlock = (block) => !!block && (block.name.endsWith('_log') || block.name.endsWith('_stem'))
    const GATHER_WOOD_TIMEOUT_MS = 10000

    // polls for a matching tree rather than a single findBlock call, since
    // the target may not be in a loaded chunk yet or may not exist at all -
    // gives up (returns null) after timeoutMs instead of searching forever.
    // unreachable positions are excluded so a log the bot already failed to
    // path to (e.g. sealed in a cave wall) doesn't just get found again
    // immediately as "the nearest match" and re-attempted forever
    const TREE_SEARCH_POLL_MS = 2000
    const findTree = async (matchName, timeoutMs, unreachable, rejectedOrigins) => {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
            if (gatherCancelled) return null
            const block = bot.findBlock({
                matching: (b) => {
                    if (matchName ? b.name !== matchName : !isLogBlock(b)) return false
                    // findBlock does a fast palette pre-check per chunk section using a
                    // synthetic Block.fromStateId() with no real position attached - only
                    // the name/type matters there; position-based exclusions only apply
                    // once a real per-block candidate (with a position) is being checked
                    if (!b.position) return true
                    if (unreachable.has(b.position.toString())) return false
                    if (rejectedOrigins.some((p) => b.position.distanceTo(p) < NON_TREE_EXCLUSION_RADIUS)) return false
                    return true
                },
                maxDistance: 48,
            })
            if (block) return block
            await new Promise((resolve) => setTimeout(resolve, TREE_SEARCH_POLL_MS))
        }
        return null
    }

    // flood-fills every connected log block of the same type starting from
    // the found tree (trunk plus any log-only branches) and chops them one
    // at a time, breaking off early the moment targetCount is reached rather
    // than finishing whatever's left of the current tree
    const LOG_NEIGHBOR_OFFSETS = [
        new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
        new Vec3(0, 1, 0), new Vec3(0, -1, 0),
        new Vec3(0, 0, 1), new Vec3(0, 0, -1),
    ]

    // avoid vandalizing player builds made of log blocks (cabins, fences,
    // etc.): a real tree always has leaves touching its trunk somewhere, so
    // walk the chain of connected same-type logs from the found block (up
    // to NON_TREE_CHAIN_LIMIT logs total, including the starting one)
    // looking for one with leaves adjacent to it. If none of the chain has
    // leaves, treat it as a built structure rather than a tree.
    const NON_TREE_CHAIN_LIMIT = 7
    const NON_TREE_EXCLUSION_RADIUS = 7
    const hasAdjacentLeaves = (pos) => LOG_NEIGHBOR_OFFSETS.some((offset) => {
        const neighbor = bot.blockAt(pos.plus(offset))
        return !!neighbor && neighbor.name.endsWith('leaves')
    })
    const isPartOfRealTree = (startBlock) => {
        const logName = startBlock.name
        const visited = new Set([startBlock.position.toString()])
        let current = startBlock
        for (let hop = 0; hop < NON_TREE_CHAIN_LIMIT; hop++) {
            if (hasAdjacentLeaves(current.position)) return true
            let next = null
            for (const offset of LOG_NEIGHBOR_OFFSETS) {
                const neighborPos = current.position.plus(offset)
                if (visited.has(neighborPos.toString())) continue
                const neighborBlock = bot.blockAt(neighborPos)
                if (neighborBlock && neighborBlock.name === logName) {
                    next = neighborBlock
                    break
                }
            }
            if (!next) return false
            visited.add(next.position.toString())
            current = next
        }
        return false
    }
    // returns the number of logs actually dug this call (normal log
    // breaking always drops exactly one item per block, so blocks-dug is an
    // accurate count of logs collected without needing to diff inventory).
    // `unreachable` is shared across the whole gather-wood run so a log the
    // pathfinder can't reach gets permanently skipped instead of being
    // re-selected as "the nearest tree" on the very next search
    const chopTree = async (startBlock, remaining, unreachable) => {
        const logName = startBlock.name
        const visited = new Set()
        const queue = [startBlock.position]
        visited.add(startBlock.position.toString())
        let dug = 0

        while (queue.length > 0) {
            if (gatherCancelled || dug >= remaining) return dug
            const pos = queue.shift()
            const block = bot.blockAt(pos)
            if (!block || block.name !== logName) continue

            try {
                // GoalBreakBlock is just a thin wrapper around GoalLookAtBlock,
                // but its isEnd() forgets to forward the `node` argument
                // (mineflayer-pathfinder@2.4.5, currently latest) - crashes
                // the whole process with "Cannot read properties of undefined
                // (reading 'distanceTo')" the moment the bot gets close. Using
                // GoalLookAtBlock directly sidesteps the buggy wrapper.
                await gotoWithTimeout(new goals.GoalLookAtBlock(pos, bot.world, { reach: 4 }))
                await equipCorrectToolFor(block)
                await bot.dig(block)
                dug++
                await new Promise((resolve) => setTimeout(resolve, 300)) // let the dropped item settle/get picked up
            } catch (err) {
                log('GATHER_WOOD_ERROR', { position: pos, error: err.message })
                unreachable.add(pos.toString())
                continue
            }

            for (const offset of LOG_NEIGHBOR_OFFSETS) {
                const neighborPos = pos.plus(offset)
                const key = neighborPos.toString()
                if (visited.has(key) || unreachable.has(key)) continue
                visited.add(key)
                const neighborBlock = bot.blockAt(neighborPos)
                if (neighborBlock && neighborBlock.name === logName) queue.push(neighborPos)
            }
        }
        return dug
    }

    const gatherWood = async (payload) => {
        const targetCount = parseInt(payload, 10)
        if (!payload || !Number.isFinite(targetCount) || targetCount <= 0) {
            bot.chat('Usage: Meow, gather wood (n).')
            return
        }
        gatherCancelled = false

        let collected = 0
        let targetLogName = null
        const unreachable = new Set()
        const rejectedOrigins = []
        console.log(`[GATHER_WOOD] Looking for a tree (target: ${targetCount} logs)...`)

        while (collected < targetCount) {
            const tree = await findTree(targetLogName, GATHER_WOOD_TIMEOUT_MS, unreachable, rejectedOrigins)
            if (gatherCancelled) {
                console.log(`[GATHER_WOOD] Cancelled (${collected}/${targetCount} collected).`)
                return
            }
            if (!tree) {
                console.log(`[GATHER_WOOD] No ${targetLogName || 'tree'} found nearby after ${GATHER_WOOD_TIMEOUT_MS / 1000}s, stopping (${collected}/${targetCount} collected).`)
                return
            }
            if (!isPartOfRealTree(tree)) {
                console.log(`[GATHER_WOOD] Log at ${tree.position} doesn't look like a real tree (no leaves nearby) - skipping, likely a player build.`)
                rejectedOrigins.push(tree.position)
                continue
            }
            targetLogName = tree.name
            collected += await chopTree(tree, targetCount - collected, unreachable)
        }
        console.log(`[GATHER_WOOD] Done, collected ${collected}/${targetCount} logs.`)
    }

    // "attack hostile mob" - while enabled, holds at HOSTILE_HOLD_DISTANCE
    // from the nearest hostile within HOSTILE_ATTACK_RANGE and periodically
    // lands a sprint-knockback hit: once the (approximate) attack cooldown
    // has elapsed, sprint in, hit, then immediately stop sprinting - vanilla
    // knockback is much stronger on a sprinting hit, so this pattern keeps
    // the mob repeatedly shoved back out to a safe distance instead of
    // letting it close in and land its own attack.
    const HOSTILE_ATTACK_RANGE = 15
    const HOSTILE_HOLD_DISTANCE = 3
    const HOSTILE_DISTANCE_TOLERANCE = 0.5
    // hard cap - never swing regardless of hold-distance tolerance, so the
    // bot doesn't attempt an attack while still closing in
    const HOSTILE_MELEE_RANGE = 3
    // core mineflayer doesn't expose the real per-item attack cooldown timer
    // (that's tracked client-side off attack-speed attributes) - 625ms is a
    // fixed approximation matching vanilla's sword cooldown (~1.6 hits/sec)
    const HOSTILE_ATTACK_COOLDOWN_MS = 625
    const HOSTILE_ATTACK_TICK_MS = 150
    let lastHostileAttackTime = 0
    let weaponEquipInProgress = false

    const stopCombatMovement = () => {
        bot.setControlState('forward', false)
        bot.setControlState('back', false)
        bot.setControlState('sprint', false)
        bot.setControlState('jump', false)
    }

    // swords take priority over axes for combat - axes are the tool of
    // choice for wood-gathering (see gatherWood above) but deal knockback
    // combat is best fought with whatever sword is available, falling back
    // to an axe only if no sword is carried
    const getBestMeleeWeapon = () => {
        const items = bot.inventory.items()
        return items.find((item) => item.name.endsWith('_sword')) || items.find((item) => item.name.endsWith('_axe')) || null
    }
    const ensureBestWeaponEquipped = () => {
        if (weaponEquipInProgress) return
        const weapon = getBestMeleeWeapon()
        if (!weapon || (bot.heldItem && bot.heldItem.type === weapon.type)) return
        weaponEquipInProgress = true
        bot.equip(weapon, 'hand')
            .catch((err) => log('ATTACK_HOSTILES_ERROR', err.message))
            .finally(() => { weaponEquipInProgress = false })
    }

    // minecraft-data classifies slime as type "mob" rather than "hostile"
    // (all size variants - tiny/small/medium/large - share the same "slime"
    // entity name, distinguished only by a size metadata property), but
    // they're hostile in practice, so they're special-cased in here
    const isHostileTarget = (entity) => entity.type === 'hostile' || entity.name === 'slime'

    const findNearestHostile = () => {
        if (!bot.entity) return null
        let nearest = null
        let nearestDistance = Infinity
        for (const entity of Object.values(bot.entities)) {
            if (!isHostileTarget(entity) || !entity.position) continue
            const distance = bot.entity.position.distanceTo(entity.position)
            if (distance <= HOSTILE_ATTACK_RANGE && distance < nearestDistance) {
                nearest = entity
                nearestDistance = distance
            }
        }
        return nearest ? { entity: nearest, distance: nearestDistance } : null
    }

    const attackHostilesTick = () => {
        if (!attackHostilesEnabled || !bot.entity) return
        const target = findNearestHostile()
        if (!target) {
            stopCombatMovement()
            return
        }

        const { entity: mob, distance } = target
        bot.lookAt(mob.position.offset(0, (mob.height || 1.8) / 2, 0)).catch(() => {})
        ensureBestWeaponEquipped()

        const cooldownReady = Date.now() - lastHostileAttackTime >= HOSTILE_ATTACK_COOLDOWN_MS
        if (cooldownReady && distance <= HOSTILE_MELEE_RANGE) {
            // gate immediately (before the wind-up below) so an overlapping
            // tick can't re-trigger a second attack while this one is still
            // winding up
            lastHostileAttackTime = Date.now()
            bot.setControlState('sprint', true)
            bot.setControlState('forward', true)
            // players (unlike most mobs) can't auto-step up a full block -
            // holding jump continuously while closing distance guarantees any
            // 1-block ledge gets cleared. A collision-flag-based "only jump
            // when actually blocked" version didn't reliably catch it in
            // practice (likely a polling-rate mismatch: this tick runs every
            // 150ms, slower than the physics engine's own state updates), so
            // this trades a bit of unnecessary hopping for actually working.
            bot.setControlState('jump', true)
            // swinging in the same instant as setting sprint/forward doesn't
            // give the server time to register the sprint state from an
            // actual movement tick first, so the sprinting-hit knockback
            // bonus wasn't reliably applying - a short wind-up fixes that
            setTimeout(() => {
                bot.attack(mob)
                // stop closing distance the instant the hit lands instead of
                // continuing to push forward for another 150ms, which was
                // chasing the bot straight back into the mob it just knocked
                // away (most visible as "creepers don't get knocked back
                // far enough" - the mob was knocked back fine, we just
                // immediately closed the gap again)
                bot.setControlState('forward', false)
                bot.setControlState('sprint', false)
                if (mob.name === 'creeper') {
                    // extra safety margin - creepers explode on proximity,
                    // so maximize separation after every hit instead of
                    // just holding position
                    bot.setControlState('back', true)
                    setTimeout(() => bot.setControlState('back', false), 300)
                }
            }, 100)
        } else if (distance > HOSTILE_HOLD_DISTANCE + HOSTILE_DISTANCE_TOLERANCE) {
            // sprint while closing distance too, not just during the attack
            // lunge - otherwise closing a large gap (e.g. chasing a
            // skeleton trying to keep its range) happens at walking speed.
            // Jump continuously too, same reasoning as the attack lunge above.
            bot.setControlState('sprint', true)
            bot.setControlState('back', false)
            bot.setControlState('forward', true)
            bot.setControlState('jump', true)
        } else if (distance < HOSTILE_HOLD_DISTANCE - HOSTILE_DISTANCE_TOLERANCE) {
            bot.setControlState('sprint', false)
            bot.setControlState('forward', false)
            bot.setControlState('jump', false)
            bot.setControlState('back', true)
        } else {
            stopCombatMovement()
        }
    }

    // some networks (e.g. ggsmp.net) put you in a lobby after login and
    // require right-clicking an NPC to actually enter the main server -
    // only used when server-config.json sets hubNpcName for this host
    const HUB_NPC_MAX_ATTEMPTS = 10
    const HUB_NPC_RETRY_DELAY_MS = 2000
    const entityNameMatches = (entity, needle) => {
        const candidates = [entity.username, entity.displayName && entity.displayName.toString(), entity.name]
            .filter(Boolean)
        return candidates.some(name => name.toLowerCase().includes(needle.toLowerCase()))
    }
    // ggsmp.net's hub NPC (confirmed via "Meow, list entities.") is a fake
    // player entity whose username is scrambled with obfuscated formatting
    // codes (e.g. "§o§d§l§f§6§8§k§8") rather than literal text, so a plain
    // substring match on hubNpcName never finds it - real players never have
    // "§" in their username, so this is a reliable heuristic fallback. When
    // several such entities exist, prefer whichever sits closest to an
    // armor_stand (these networks float NPC nametag/hologram text on stacked
    // armor stands just above the NPC's head).
    const looksLikeObfuscatedNpc = (entity) => entity.type === 'player' && typeof entity.username === 'string' && /§/.test(entity.username)
    // "armor_stand" was what this showed up as under the wrong protocol
    // version (see version auto-detect fix) - at the correct version it's
    // actually a "text_display" hologram entity, but both are kept here in
    // case a differently-versioned server still uses classic armor stands
    const looksLikeHologram = (entity) => entity.position && (entity.name === 'armor_stand' || entity.name === 'text_display')
    const findObfuscatedNpc = (entities) => {
        const candidates = entities.filter(looksLikeObfuscatedNpc)
        const holograms = entities.filter(looksLikeHologram)
        if (!holograms.length) return candidates[0]
        return candidates.sort((a, b) => {
            const distA = Math.min(...holograms.map(s => s.position.distanceTo(a.position)))
            const distB = Math.min(...holograms.map(s => s.position.distanceTo(b.position)))
            return distA - distB
        })[0]
    }
    const HUB_NPC_INTERACT_RANGE = 2
    const findAndClickHubNpc = (attempt = 1) => {
        const entities = Object.values(bot.entities)
        let npc = entities.find(e => entityNameMatches(e, HUB_NPC_NAME))
        let matchType = 'name'
        if (!npc) {
            npc = findObfuscatedNpc(entities)
            matchType = 'obfuscated-name-heuristic'
        }
        if (npc) {
            const distance = npc.position.distanceTo(bot.entity.position)
            log('HUB_NPC_FOUND', { hubNpcName: HUB_NPC_NAME, entityName: npc.username || npc.name, matchType, distance })
            // activateEntity sends an interact packet regardless of range, but
            // anti-cheat on these networks silently drops it if we're too far
            // away (this is why earlier attempts logged FOUND but never
            // actually entered the main server) - walk within range first
            gotoWithTimeout(new goals.GoalNear(npc.position.x, npc.position.y, npc.position.z, HUB_NPC_INTERACT_RANGE))
                .then(() => bot.activateEntity(npc))
                .catch(err => log('HUB_NPC_ERROR', err.message))
            return
        }
        if (attempt >= HUB_NPC_MAX_ATTEMPTS) {
            log('HUB_NPC_NOT_FOUND', { hubNpcName: HUB_NPC_NAME })
            return
        }
        setTimeout(() => findAndClickHubNpc(attempt + 1), HUB_NPC_RETRY_DELAY_MS)
    }
    const enterHubIfConfigured = () => {
        if (HUB_NPC_NAME) setTimeout(() => findAndClickHubNpc(), HUB_NPC_RETRY_DELAY_MS)
    }

    bot.once('spawn', () => {
        console.log('Meow')
        console.log('[VERSION]', bot.version, 'protocol', bot.protocolVersion, 'configured', VERSION)
        if (registeredHosts.has(hostAccountKey(HOST, USERNAME))) {
            // a real player takes at least a moment to type a command after
            // spawning in - sending /login in the same tick as spawn is a
            // mechanical tell some anti-bot systems watch for
            setTimeout(() => {
                bot.chat('/login smolbrain')
            }, 400 + Math.floor(Math.random() * 800))
        } else {
            // brand new server (or new account on a known server): register,
            // then log in shortly after (some auth plugins don't auto-login
            // on successful registration)
            bot.chat('/register smolbrain smolbrain')
            markHostRegistered(HOST, USERNAME)
            setTimeout(() => {
                bot.chat('/login smolbrain')
            }, 1500)
        }
        reportStatus()
        bot.on('health', reportStatus)

        const movements = new Movements(bot)
        // pathfinder's own built-in scaffolding (jump + place a block underfoot
        // to climb) has a race between the jump physics and the network
        // round-trip for equipping/placing that makes it place too late almost
        // every cycle - disabling it here makes pathfinder fail fast (NoPath)
        // instead of burning through gotoWithTimeout's full timeout attempting
        // it, so buildSchematic's own bridgeUp() fallback (see above) kicks in
        // immediately instead
        movements.scafoldingBlocks = []
        bot.pathfinder.setMovements(movements)

        attackHostilesInterval = setInterval(attackHostilesTick, HOSTILE_ATTACK_TICK_MS)

        bot.inventory.on('updateSlot', (slot, oldItem, newItem) => {
            if (totemModeActive && slot === bot.getEquipmentDestSlot('off-hand')) {
                const hadTotem = oldItem && oldItem.name === 'totem_of_undying'
                const stillHasTotem = newItem && newItem.name === 'totem_of_undying'
                if (hadTotem && !stillHasTotem) equipTotem()
            }

            if (newItem && (!oldItem || oldItem.type !== newItem.type)) {
                const destination = armorDestinationFor(newItem.name)
                if (destination && slot !== bot.getEquipmentDestSlot(destination)) {
                    equipArmorPiece(slot, destination)
                }
            }
        })
    })

    // mineflayer re-emits 'spawn' on every dimension/world change, not just
    // the first login - this includes the main server restarting, which on
    // a Velocity network falls the bot back to the lobby on the same
    // connection (no kick/reconnect, so the once-only login block above
    // never re-runs). Re-attempting hub entry here catches that: it's a
    // silent no-op (times out after HUB_NPC_MAX_ATTEMPTS) if we're not
    // actually back in the lobby, e.g. an ordinary death/respawn in survival.
    bot.on('spawn', () => enterHubIfConfigured())

    const CROUCH_TOGGLE_INTERVAL_MS = 400

    const crouch = (times) => {
        let toggles = 0
        const step = () => {
            if (toggles >= times * 2) return
            bot.setControlState('sneak', toggles % 2 === 0)
            toggles++
            setTimeout(step, CROUCH_TOGGLE_INTERVAL_MS)
        }
        step()
    }

    const reportStatus = () => {
        if (!process.send) return
        process.send({
            type: 'status',
            data: { connected: !!bot.entity, health: bot.health, totemModeActive, chatGamesEnabled, attackHostilesEnabled }
        })
    }

    // actions shared between the in-game chat triggers and the control
    // panel's IPC commands, so both paths do exactly the same thing
    const actions = {
        tpToMe: () => bot.chat('/tpa VOlcarona_Alt'),
        tpMeToYou: () => bot.chat('/tpahere VOlcarona_Alt'),
        enableTotemMode: () => {
            totemModeActive = true
            crouch(3)
            equipTotem()
            reportStatus()
        },
        disableTotemMode: () => {
            totemModeActive = false
            bot.chat('Totem mode disabled.')
            reportStatus()
        },
        dropItem: () => dropHeldItemStack(),
        offhand: () => swapHeldItemToOffhand(),
        doCommand: (payload) => {
            if (payload) bot.chat(`/${payload.trim()}`)
        },
        say: (payload) => {
            if (payload) bot.chat(payload.trim())
        },
        enableChatGames: () => {
            chatGamesEnabled = true
            bot.chat('Chat game solver enabled.')
            reportStatus()
        },
        disableChatGames: () => {
            chatGamesEnabled = false
            bot.chat('Chat game solver disabled.')
            reportStatus()
        },
        toggleChatGames: () => {
            chatGamesEnabled = !chatGamesEnabled
            bot.chat(`Chat game solver ${chatGamesEnabled ? 'enabled' : 'disabled'}.`)
            reportStatus()
        },
        enableAttackHostiles: () => {
            attackHostilesEnabled = true
            bot.chat('Attack hostile mobs enabled.')
            reportStatus()
        },
        disableAttackHostiles: () => {
            attackHostilesEnabled = false
            stopCombatMovement()
            bot.chat('Attack hostile mobs disabled.')
            reportStatus()
        },
        toggleAttackHostiles: () => {
            attackHostilesEnabled = !attackHostilesEnabled
            if (!attackHostilesEnabled) stopCombatMovement()
            bot.chat(`Attack hostile mobs ${attackHostilesEnabled ? 'enabled' : 'disabled'}.`)
            reportStatus()
        },
        walkToMe: (username) => {
            const target = username && bot.players[username] && bot.players[username].entity
            if (!target) {
                bot.chat(`Can't see ${username || 'you'}`)
                return
            }
            const { x, y, z } = target.position
            bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, 1))
        },
        stopWalking: () => bot.pathfinder.setGoal(null),
        build: (payload) => buildSchematic(payload),
        stopBuilding: () => { buildCancelled = true },
        gatherWood: (payload) => gatherWood(payload),
        stopGatheringWood: () => { gatherCancelled = true },
        reportInventory: () => {
            const items = bot.inventory.items().map((i) => ({ name: i.name, count: i.count }))
            log('INVENTORY_REPORT', { heldItem: bot.heldItem && bot.heldItem.name, items })
            console.log('[INVENTORY]', 'held:', bot.heldItem ? bot.heldItem.name : 'nothing', '| items:', items)
        },
        listEntities: () => {
            // holograms (text_display, or armor_stand on older versions) carry
            // the visible label as entity metadata rather than a real name -
            // reading it lets us tell multiple lookalike NPCs apart instead of
            // guessing purely from proximity
            const getHologramText = (e) => {
                if (!e.metadata || (e.name !== 'text_display' && e.name !== 'armor_stand')) return null
                const meta = bot.registry.entitiesByName[e.name]
                if (!meta) return null
                const index = meta.metadataKeys.indexOf('text') >= 0
                    ? meta.metadataKeys.indexOf('text')
                    : meta.metadataKeys.indexOf('custom_name')
                const raw = index >= 0 ? e.metadata[index] : null
                if (raw == null) return null
                return typeof raw === 'string' ? raw : JSON.stringify(raw)
            }
            const entities = Object.values(bot.entities)
                .filter(e => e !== bot.entity && e.position)
                .map(e => ({
                    type: e.type,
                    name: e.name || null,
                    username: e.username || null,
                    displayName: e.displayName ? e.displayName.toString() : null,
                    hologramText: getHologramText(e),
                    position: { x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z) },
                    distance: bot.entity ? +e.position.distanceTo(bot.entity.position).toFixed(1) : null,
                }))
                .sort((a, b) => (a.distance || 0) - (b.distance || 0))
            log('ENTITY_REPORT', { count: entities.length, entities })
            console.log(`[ENTITIES] ${entities.length} nearby:`)
            entities.forEach(e => {
                const label = e.hologramText || e.displayName || e.username || e.name || '?'
                console.log(`  [${e.type}] "${label}" @ (${e.position.x},${e.position.y},${e.position.z}) dist=${e.distance}`)
            })
        },
    }

    // only fires when launched via child_process.fork (e.g. by the control
    // panel) - process.on('message') is a no-op otherwise
    process.removeAllListeners('message')
    process.on('message', (msg) => {
        if (!msg || msg.type !== 'command') return
        const action = actions[msg.name]
        if (action) action(msg.payload)
    })

    let lastHudMessage = null
    const HUD_MESSAGE_PATTERN = /^❤ \d+\/\d+ \| ★ \d+\/\d+ \| ⛨ \d+$/

    bot.on('messagestr', (message) => {
        recordChatGameLine(message)

        const isHudMessage = HUD_MESSAGE_PATTERN.test(message)
        if (!isHudMessage || message !== lastHudMessage) {
            console.log('[CHAT]', message)
        }
        if (isHudMessage) lastHudMessage = message

        // land-protection plugins (WorldGuard etc.) send a message like this
        // instead of silently rejecting the dig - bail out of an in-progress
        // gather immediately rather than uselessly retrying the same spot
        if (/not allowed to break|don't have permission to break/i.test(message)) {
            if (!gatherCancelled) console.log('[GATHER_WOOD] Blocked from breaking blocks here, stopping.')
            gatherCancelled = true
        }

        if (message.includes('Meow, tp to me.')) {
            actions.tpToMe()
        } else if (message.includes('Meow, tp me to you.')) {
            actions.tpMeToYou()
        } else if (message.includes('Meow, stop.')) {
            actions.stopWalking()
            actions.stopBuilding()
            actions.stopGatheringWood()
        } else if (isFromOperator(message) && message.includes('Meow, walk to me.')) {
            const requester = OPERATORS.find(name => message.includes(name))
            actions.walkToMe(requester)
        } else if (isFromOperator(message) && message.includes('Meow, build ')) {
            const match = message.match(/Meow, build (.+)/)
            if (match) actions.build(match[1])
        } else if (isFromOperator(message) && message.includes('Meow, gather wood ')) {
            const match = message.match(/Meow, gather wood \((\d+)\)/)
            if (match) actions.gatherWood(match[1])
        } else if (isFromOperator(message) && message.includes('Meow, enable totem mode.')) {
            actions.enableTotemMode()
        } else if (isFromOperator(message) && message.includes('Meow, disable totem mode.')) {
            actions.disableTotemMode()
        } else if (isFromOperator(message) && message.includes('Meow, drop item.')) {
            actions.dropItem()
        } else if (isFromOperator(message) && message.includes('Meow, offhand.')) {
            actions.offhand()
        } else if (isFromOperator(message) && message.includes('Meow, say ')) {
            const match = message.match(/Meow, say (.+)/)
            if (match) actions.say(match[1])
        } else if (isFromOperator(message) && message.includes('Meow, enable chat games.')) {
            actions.enableChatGames()
        } else if (isFromOperator(message) && message.includes('Meow, disable chat games.')) {
            actions.disableChatGames()
        } else if (isFromOperator(message) && message.includes('Meow, toggle chat games.')) {
            actions.toggleChatGames()
        } else if (isFromOperator(message) && message.includes('Meow, toggle attack mode.')) {
            actions.toggleAttackHostiles()
        } else if (isFromOperator(message) && message.includes('Meow, list entities.')) {
            actions.listEntities()
        } else if (isFromOperator(message)) {
            const match = message.match(/Meow, do (.+)/)
            if (match) actions.doCommand(match[1])
        }
    })

    bot.on('death', () => {
        console.log('DIED, respawning')
        log('DEATH', 'bot died, calling respawn')
        bot.respawn()
    })

    // some hub NPCs open a server-selector GUI instead of teleporting
    // directly on interact - log what shows up so we can tell the
    // difference from a click that silently did nothing
    bot.on('windowOpen', (window) => {
        const items = window.slots.filter(Boolean).map(item => ({ slot: item.slot, name: item.name, count: item.count }))
        log('WINDOW_OPEN', { title: window.title, items })
        console.log('[WINDOW_OPEN]', JSON.stringify(window.title), items)
    })

    bot.on('kicked', (reason) => {
        console.log('KICKED', reason)
        log('KICKED', reason)
    })
    bot.on('end', (reason) => {
        console.log('END', reason)
        log('END', reason)
        if (attackHostilesInterval) clearInterval(attackHostilesInterval)
        if (process.send) process.send({ type: 'status', data: { connected: false } })
        scheduleReconnect(`end: ${reason}`, disconnectDelay())
    })
    bot.on('error', (err) => {
        console.log('ERROR', err)
        log('ERROR', err.stack || err.message || err)
        // reconnect is scheduled from 'end', not here: 'end' only fires once the
        // socket has actually finished closing, which can lag well behind 'error'
        // (e.g. a keepalive timeout emits 'error' immediately but the socket can
        // take ~30s more to close) - reconnecting here raced ahead of that and
        // caused "already connected" collisions with our own not-yet-closed session
    })
}

connect();
