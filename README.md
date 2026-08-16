# stupidbotidk

A [mineflayer](https://github.com/PrismarineJS/mineflayer) Minecraft bot with a web-based control panel for launching it, watching its console, and sending it commands.

## Setup

```
npm install
```

Edit `server-config.json` with the server you want the bot to join:

```json
{
  "host": "localhost",
  "port": 25565,
  "username": "TestBot",
  "hubNpcName": null
}
```

`version` is optional — leave it out and the bot auto-detects the server's protocol version.

## Launching

1. Start the control panel:
   ```
   npm run panel
   ```
2. Open **http://localhost:4000** in a browser.
3. Click **Launch** to start the bot. **Shutdown** stops it. Editing `server-config.json` (or using the panel's Save Server field) only takes effect on the *next* launch, not live.

The Console panel streams the bot's live output. There are also buttons/inputs for running arbitrary commands, toggling features, etc.

## Using the bot

The bot is controlled either through the control panel buttons or by typing chat messages in-game starting with `"Meow, ..."`. A few examples:

- `Meow, tp to me.` / `Meow, tp me to you.` — teleport requests (operator-only, targets whichever operator sent it)
- `Meow, gather wood (n).` — chop trees until it has `n` logs
- `Meow, build <name> at <x> <y> <z>.` (or `Meow, build <name> here.`) — builds a schematic from the `schematics/` folder
- `Meow, toggle attack mode.` — toggles auto-attacking nearby hostile mobs (on by default)
- `Meow, list entities.` — logs every nearby entity, useful for debugging
- `Meow, stop.` — cancels whatever it's currently doing

Full command reference (including operator-only commands and automatic behaviors like auto-eating and auto-equipping armor) is in `Commands List.txt`.
