/**
 * Arvan RPG launcher helpers: offline UUIDs, bundled distribution,
 * official Forge installer run, AutoModPack config seeding.
 */
const child_process = require('child_process')
const crypto        = require('crypto')
const fs            = require('fs-extra')
const got           = require('got')
const path          = require('path')

exports.MC_VERSION = '1.20.1'
exports.FORGE_VERSION = '47.4.22' // must match the server (AutoModPack syncLoaderVersion)
exports.FORGE_ID = `${exports.MC_VERSION}-forge-${exports.FORGE_VERSION}`
exports.FORGE_INSTALLER_URL = `https://maven.minecraftforge.net/net/minecraftforge/forge/${exports.MC_VERSION}-${exports.FORGE_VERSION}/forge-${exports.MC_VERSION}-${exports.FORGE_VERSION}-installer.jar`
exports.NAME_REGEX = /^[A-Za-z0-9_]{3,16}$/
exports.BUNDLED_DISTRO = path.join(__dirname, '..', 'arvan', 'distribution.json')

/** Standard offline UUID (v3 of "OfflinePlayer:<name>"), same as vanilla/SKLauncher. */
exports.offlineUUID = function(name){
    const b = crypto.createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest()
    b[6] = (b[6] & 0x0f) | 0x30
    b[8] = (b[8] & 0x3f) | 0x80
    return b.toString('hex')
}

exports.readBundledDistro = function(){
    return JSON.parse(fs.readFileSync(exports.BUNDLED_DISTRO, 'utf8'))
}

/**
 * Run the official Forge installer (--installClient) into the common dir once.
 * It writes versions/<forgeId>/<forgeId>.json and the processed libraries.
 */
exports.ensureForgeInstalled = async function(commonDir, javaExe, log){
    const verJson = path.join(commonDir, 'versions', exports.FORGE_ID, `${exports.FORGE_ID}.json`)
    const clientJar = path.join(commonDir, 'libraries', 'net', 'minecraftforge', 'forge',
        `${exports.MC_VERSION}-${exports.FORGE_VERSION}`, `forge-${exports.MC_VERSION}-${exports.FORGE_VERSION}-client.jar`)
    if(await fs.pathExists(verJson) && await fs.pathExists(clientJar)){
        return
    }
    await fs.ensureDir(commonDir)
    const profiles = path.join(commonDir, 'launcher_profiles.json')
    if(!await fs.pathExists(profiles)){
        await fs.writeJson(profiles, { profiles: {} })
    }
    const installer = path.join(commonDir, 'forge-installer', path.basename(exports.FORGE_INSTALLER_URL))
    if(!await fs.pathExists(installer)){
        log.info('Downloading Forge installer', exports.FORGE_INSTALLER_URL)
        await fs.ensureDir(path.dirname(installer))
        const buf = await got(exports.FORGE_INSTALLER_URL).buffer()
        await fs.writeFile(installer, buf)
    }
    // Use java.exe (console) rather than javaw.exe so installer output is captured.
    const java = javaExe.replace(/javaw(\.exe)?$/i, 'java$1')
    log.info('Running Forge installer with', java)
    await new Promise((resolve, reject) => {
        const p = child_process.spawn(fs.existsSync(java) ? java : javaExe,
            ['-jar', installer, '--installClient', commonDir], { cwd: path.dirname(installer) })
        p.stdout.on('data', d => log.info('[ForgeInstaller]', d.toString().trim()))
        p.stderr.on('data', d => log.warn('[ForgeInstaller]', d.toString().trim()))
        p.on('error', reject)
        p.on('close', code => code === 0 ? resolve() : reject(new Error('Forge installer exited with code ' + code)))
    })
    if(!await fs.pathExists(verJson)){
        throw new Error('Forge installer finished but ' + verJson + ' is missing')
    }
}

exports.MOJANG_RUNTIME_INDEX = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json'
exports.MOJANG_RUNTIME = 'java-runtime-gamma'

/**
 * Install Mojang's official java-runtime-gamma (Java 17, same as the vanilla launcher) into
 * <dataDir>/runtime/mojang/java-runtime-gamma and return its javaw.exe. Files are sha1-checked.
 * Removes the Temurin 17 builds Helios had installed under runtime/x64.
 */
exports.ensureMojangJava = async function(dataDir, log, onProgress = () => {}){
    const root = path.join(dataDir, 'runtime', 'mojang', exports.MOJANG_RUNTIME)
    const javaw = path.join(root, 'bin', 'javaw.exe')
    const marker = path.join(root, '.arvan-complete')
    if(!(await fs.pathExists(marker) && await fs.pathExists(javaw))){
        const plat = process.arch === 'ia32' ? 'windows-x86' : (process.arch === 'arm64' ? 'windows-arm64' : 'windows-x64')
        const index = await got(exports.MOJANG_RUNTIME_INDEX).json()
        const entry = (index[plat] || {})[exports.MOJANG_RUNTIME]?.[0]
        if(entry == null){
            throw new Error(`No ${exports.MOJANG_RUNTIME} for ${plat} in Mojang's runtime index`)
        }
        log.info('Installing Mojang Java runtime', entry.version.name)
        const manifest = await got(entry.manifest.url).json()
        const files = Object.entries(manifest.files)
        const queue = files.slice()
        let done = 0
        const worker = async () => {
            while(queue.length){
                const [rel, f] = queue.shift()
                const dst = path.join(root, rel)
                if(f.type === 'directory'){
                    await fs.ensureDir(dst)
                } else if(f.type === 'file'){
                    const ok = await fs.pathExists(dst) && crypto.createHash('sha1').update(await fs.readFile(dst)).digest('hex') === f.downloads.raw.sha1
                    if(!ok){
                        const buf = await got(f.downloads.raw.url).buffer()
                        if(crypto.createHash('sha1').update(buf).digest('hex') !== f.downloads.raw.sha1){
                            throw new Error('Checksum mismatch for ' + rel)
                        }
                        await fs.ensureDir(path.dirname(dst))
                        await fs.writeFile(dst, buf)
                    }
                }
                onProgress(++done, files.length)
            }
        }
        await Promise.all(Array.from({ length: 8 }, worker))
        await fs.writeFile(marker, entry.version.name)
    }
    const x64 = path.join(dataDir, 'runtime', 'x64')
    if(await fs.pathExists(x64)){
        for(const d of await fs.readdir(x64)){
            if(/^jdk-17\./.test(d)){
                log.info('Removing old Java runtime', d)
                await fs.remove(path.join(x64, d)).catch(e => log.warn('Could not remove', d, e))
            }
        }
    }
    return javaw
}

/**
 * JDK 17.0.9+ creates the NIO selector pipe as an AF_UNIX socket in the temp dir. That fails when
 * %TEMP% is an 8.3 short path or the user name has spaces/non-ASCII ("failed to open a new selector").
 * Return a plain ASCII dir for -Djdk.net.unixdomain.tmpdir.
 */
exports.unixDomainTmpDir = function(){
    const env = process.env
    const candidates = [
        env.PUBLIC && path.join(env.PUBLIC, 'ArvanRPG', 'tmp'),
        path.join((env.SystemDrive || 'C:') + path.sep, 'Users', 'Public', 'ArvanRPG', 'tmp'),
        env.ProgramData && path.join(env.ProgramData, 'ArvanRPG', 'tmp')
    ].filter(Boolean)
    for(const dir of candidates){
        try {
            fs.mkdirSync(dir, { recursive: true })
            return dir
        } catch(_e) { /* try next */ }
    }
    return null
}

exports.AMP_HOST = '139.99.4.216'
exports.AMP_PORT = 25581

/**
 * Single pre-launch hook, called from landing.js dlAsync right before ProcessBuilder.
 * Runs the ampsync "Update" step (modpack download from the server's AutoModPack host).
 * Resolves normally when the player has no AutoModPack secret yet (first join is done in-game).
 * ctx = { gameDir, setDetails(text), setPercent(n), logger }. Throws other AmpErrors (err.code).
 */
/** Whole-pack size from the last sync (our cache or AutoModPack's content list), 0 if unknown. */
exports.knownPackBytes = function(gameDir){
    const ampDir = path.join(gameDir, 'automodpack')
    try { const n = Number(fs.readFileSync(path.join(ampDir, '.arvan-pack-bytes'), 'utf8')); if(n > 0) return n } catch(_e) { /* none */ }
    try {
        for(const d of fs.readdirSync(path.join(ampDir, 'modpacks'))){
            try {
                const c = JSON.parse(fs.readFileSync(path.join(ampDir, 'modpacks', d, 'automodpack-content.json'), 'utf8'))
                const n = (c.list || []).reduce((a, it) => a + (Number(it.size) || 0), 0)
                if(n > 0) return n
            } catch(_e) { /* skip */ }
        }
    } catch(_e) { /* none */ }
    return 0
}

exports.beforeGameStart = async function(ctx){
    const { sync } = require('./ampsync')
    ctx.setDetails('Updating Arvan..')
    ctx.setPercent(0)
    // ampsync reports bytes still to download; show them against the whole pack size when known.
    const packTotal = exports.knownPackBytes(ctx.gameDir)
    let last = 0
    try {
        const res = await sync({
            instanceDir: ctx.gameDir,
            host: exports.AMP_HOST,
            port: exports.AMP_PORT,
            onProgress: (done, total) => {
                const now = Date.now()
                if(now - last < 150 && done < total) return
                last = now
                const mb = n => (n / 1048576).toFixed(0)
                const all = packTotal >= total ? packTotal : total
                const have = all - total + done
                ctx.setDetails(`Updating Arvan… ${mb(have)} / ${mb(all)} MB`)
                ctx.setPercent(all > 0 ? Math.min(100, Math.floor(have / all * 100)) : 100)
            },
            onLog: m => ctx.logger.info('[ampsync]', m)
        })
        try { if(res && res.totalBytes > 0) fs.writeFileSync(path.join(ctx.gameDir, 'automodpack', '.arvan-pack-bytes'), String(res.totalBytes)) } catch(_e) { /* best effort */ }
        ctx.logger.info('[ampsync] done', JSON.stringify({ files: res.files, downloaded: res.downloaded, downloadedBytes: res.downloadedBytes, deleted: res.deleted, upToDate: res.upToDate, modsDirConflicts: res.modsDirConflicts }))
        return res
    } catch(err) {
        if(err && (err.code === 'AMP_NO_SECRET' || err.code === 'AMP_AUTH_FAILED')){
            ctx.logger.info('[ampsync] ' + err.code + ', launching normally (AutoModPack handles the first join).')
            return null
        }
        throw err
    }
}

/**
 * Pre-seed AutoModPack client config + server fingerprint so the first launch
 * downloads the pack without a trust prompt. Never overwrites existing files.
 */
exports.seedAutoModpack = async function(gameDir){
    const src = path.join(__dirname, '..', 'arvan', 'automodpack')
    const dst = path.join(gameDir, 'automodpack')
    const pairs = [
        [path.join(src, 'automodpack-client.json'), path.join(dst, 'automodpack-client.json')],
        [path.join(src, 'known-hosts.json'), path.join(dst, '.private', 'automodpack-known-hosts.json')]
    ]
    for(const [from, to] of pairs){
        if(!await fs.pathExists(to)){
            await fs.ensureDir(path.dirname(to))
            await fs.writeFile(to, fs.readFileSync(from))
        }
    }
}

// ---- Arvan password login (Arvan Characters 2.3.0+) ----
exports.PASSWORD_MIN = 6
exports.PASSWORD_ENV = 'ARVAN_LAUNCHER_PASSWORD'
exports.AUTH_RESULT_FILE = 'arvan-auth-result.json'

/** Encrypt with Electron safeStorage (main process). Resolves base64 or null if unavailable. */
exports.encryptPassword = function(pw){
    return require('electron').ipcRenderer.invoke('arvanSecret', 'encrypt', pw)
}

/** Stored password for an account, decrypted, or null. */
exports.accountPassword = async function(acc){
    if(acc == null || !acc.arvanPw) return null
    return require('electron').ipcRenderer.invoke('arvanSecret', 'decrypt', acc.arvanPw)
}

/**
 * Read <gameDir>/arvan-auth-result.json written by the mod, if it is newer than the launch.
 * The file is always deleted once read. Returns {result, name, ts} or null.
 */
exports.takeAuthResult = function(gameDir, launchedAt){
    const f = path.join(gameDir, exports.AUTH_RESULT_FILE)
    let st
    try { st = fs.statSync(f) } catch(_e) { return null }
    let res = null
    if(st.mtimeMs >= launchedAt - 2000){
        try { res = JSON.parse(fs.readFileSync(f, 'utf8')) } catch(_e) { res = { result: 'error' } }
    }
    try { fs.removeSync(f) } catch(_e) { /* ignore */ }
    if(res != null && typeof res.result !== 'string') res.result = 'error'
    return res
}

/** Message for a failed auth result. */
exports.authResultMessage = function(result){
    if(result === 'rate_limited') return 'Too many attempts, wait a minute.'
    return 'Wrong password, or that name is already taken by another player.'
}
