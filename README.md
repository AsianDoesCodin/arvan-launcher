<p align="center"><img src="./build/icon.png" width="150" height="150" alt="Arvan RPG crest"></p>

<h1 align="center">Arvan RPG Launcher</h1>

The Windows launcher for the **Arvan RPG** Minecraft server (Minecraft 1.20.1, Forge 47.4.22).

- Name-only login (offline mode). Names are 3-16 characters, using letters, digits and `_`.
- Installs Java (the Mojang runtime) and Forge automatically. Keeps its own game folder in `%APPDATA%\.arvanrpg`.
- Before every Play, it downloads or updates the Arvan modpack through the server's AutoModPack host. Then it joins the server directly.
- Updates itself from this repo's GitHub releases.

## Install

1. Download `ArvanRPG-Setup-<version>.exe` from [Releases](https://github.com/AsianDoesCodin/arvan-launcher/releases/latest) and run it.
2. Enter a player name and press **Play**.
3. The first launch downloads the Arvan modpack and closes the game once. Press Play again.

The installer is not code-signed, so Windows SmartScreen may warn you. Choose "More info", then "Run anyway".

## Build

Requirements: Node.js 22+ and Windows.

```
npm install
npm start          # dev run
npm run dist:win   # installer in dist/
```

The bundled server list is in `app/assets/arvan/distribution.json`. The Arvan-specific code is in `app/assets/js/arvan.js`, and the modpack sync is in `app/assets/js/ampsync/`.

To publish a release, bump `version` in package.json and run `npm run dist:win`. Then upload the `.exe`, the `.exe.blockmap` and `latest.yml` to a GitHub release tagged `v<version>`.

## Credits

This launcher is a fork of [HeliosLauncher](https://github.com/dscalzi/HeliosLauncher) by Daniel Scalzi, under the MIT license (see [LICENSE](LICENSE.txt)). Minecraft is a trademark of Mojang. This project is not affiliated with Mojang or Microsoft.
