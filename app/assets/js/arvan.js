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
        exports.applyGraphicsSafe(ctx)
        ctx.logger.info('[ampsync] done', JSON.stringify({ files: res.files, downloaded: res.downloaded, downloadedBytes: res.downloadedBytes, deleted: res.deleted, upToDate: res.upToDate, modsDirConflicts: res.modsDirConflicts }))
        return res
    } catch(err) {
        if(err && (err.code === 'AMP_NO_SECRET' || err.code === 'AMP_AUTH_FAILED')){
            ctx.logger.info('[ampsync] ' + err.code + ', launching normally (AutoModPack handles the first join).')
            exports.applyGraphicsSafe(ctx)
            return null
        }
        throw err
    }
}

// ---- Graphics presets (packs arrive through the server's AutoModPack host) ----
exports.BASE_RESOURCE_PACKS = ['vanilla', 'mod_resources', 'fabric', 'efn_enhance_must', 'arvanservercore_armor']
exports.GRAPHICS_PRESETS = {
    dark: { label: 'Dark RPG', shader: 'Hysteria-Shaders-Universal-v1.2.2.zip', pack: 'Ashen_16x.zip' },
    colorful: { label: 'Colorful', shader: 'Fantasy Shaders Unbound v1.1.zip', pack: '[1.19-1.21] Yuushya Release 0.20.0.zip' },
    medieval: { label: 'Medieval', shader: 'Solas Shader V3.7b.zip', pack: 'Excalibur_V1.20.zip' },
    performance: { label: 'Performance', shader: null, pack: null }
}
exports.DEFAULT_GRAPHICS = 'dark'
// Single source of truth, shared with the in-game Graphics button (Server Core b33).
exports.GRAPHICS_FILE = 'arvan-graphics.json'

/** The preset saved in <gameDir>/arvan-graphics.json, or the default when missing/invalid. */
exports.readGraphicsPreset = function(gameDir){
    try {
        const v = JSON.parse(fs.readFileSync(path.join(gameDir, exports.GRAPHICS_FILE), 'utf8'))
        if(v && exports.GRAPHICS_PRESETS[v.preset]) return v.preset
    } catch(_e) { /* missing or invalid */ }
    return exports.DEFAULT_GRAPHICS
}

exports.writeGraphicsPreset = function(gameDir, presetId){
    if(!exports.GRAPHICS_PRESETS[presetId]) throw new Error('unknown graphics preset ' + presetId)
    fs.ensureDirSync(gameDir)
    const file = path.join(gameDir, exports.GRAPHICS_FILE)
    fs.writeFileSync(file + '.tmp', JSON.stringify({ preset: presetId }))
    fs.renameSync(file + '.tmp', file)
}

/** Make sure <gameDir>/<dir>/<file> exists, copying it from the AutoModPack modpack folder if needed. */
function ensureInGameDir(gameDir, dir, file, log){
    const dest = path.join(gameDir, dir, file)
    if(fs.existsSync(dest)) return true
    const mpRoot = path.join(gameDir, 'automodpack', 'modpacks')
    let ids = []
    try { ids = fs.readdirSync(mpRoot) } catch(_e) { /* none */ }
    for(const id of ids){
        const src = path.join(mpRoot, id, dir, file)
        if(fs.existsSync(src)){
            fs.ensureDirSync(path.dirname(dest))
            fs.copyFileSync(src, dest)
            log.info('[graphics] copied ' + dir + '/' + file + ' from modpack ' + id)
            return true
        }
    }
    log.warn('[graphics] missing ' + dir + '/' + file + ' (not synced from the server yet)')
    return false
}

function jsonList(value){
    try { const v = JSON.parse(value); return Array.isArray(v) ? v : [] } catch(_e) { return [] }
}

function readLines(file){
    let text = ''
    try { text = fs.readFileSync(file, 'utf8') } catch(_e) { /* new file */ }
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    const lines = text.length ? text.split(/\r?\n/) : []
    if(lines.length && lines[lines.length - 1] === '') lines.pop()
    return { lines, eol }
}

/**
 * Apply a graphics preset after the sync and before the game starts.
 * options.txt: only resourcePacks / incompatibleResourcePacks change.
 * config/oculus.properties: only shaderPack / enableShaders change.
 */
exports.applyGraphicsPreset = function(gameDir, presetId, log = console){
    const id = exports.GRAPHICS_PRESETS[presetId] ? presetId : exports.DEFAULT_GRAPHICS
    const p = exports.GRAPHICS_PRESETS[id]
    if(p.pack) ensureInGameDir(gameDir, 'resourcepacks', p.pack, log)
    if(p.shader) ensureInGameDir(gameDir, 'shaderpacks', p.shader, log)

    const presetPackIds = Object.values(exports.GRAPHICS_PRESETS).filter(x => x.pack).map(x => 'file/' + x.pack)
    const packs = exports.BASE_RESOURCE_PACKS.concat(p.pack ? ['file/' + p.pack] : [])
    const optFile = path.join(gameDir, 'options.txt')
    const opt = readLines(optFile)
    const packLine = 'resourcePacks:' + JSON.stringify(packs)
    let sawPacks = false
    for(let i = 0; i < opt.lines.length; i++){
        if(opt.lines[i].startsWith('resourcePacks:')){
            opt.lines[i] = packLine
            sawPacks = true
        } else if(opt.lines[i].startsWith('incompatibleResourcePacks:')){
            const kept = jsonList(opt.lines[i].slice('incompatibleResourcePacks:'.length)).filter(x => !presetPackIds.includes(x))
            opt.lines[i] = 'incompatibleResourcePacks:' + JSON.stringify(kept)
        }
    }
    if(!sawPacks) opt.lines.push(packLine)
    fs.writeFileSync(optFile, opt.lines.join(opt.eol) + opt.eol)

    const ocFile = path.join(gameDir, 'config', 'oculus.properties')
    const oc = readLines(ocFile)
    const want = { shaderPack: p.shader || '', enableShaders: p.shader ? 'true' : 'false' }
    const seen = {}
    for(let i = 0; i < oc.lines.length; i++){
        const m = /^\s*([^#!=:\s]+)\s*[=:]/.exec(oc.lines[i])
        if(m && Object.prototype.hasOwnProperty.call(want, m[1])){
            oc.lines[i] = m[1] + '=' + want[m[1]]
            seen[m[1]] = true
        }
    }
    for(const k of Object.keys(want)) if(!seen[k]) oc.lines.push(k + '=' + want[k])
    fs.ensureDirSync(path.dirname(ocFile))
    fs.writeFileSync(ocFile, oc.lines.join(oc.eol) + oc.eol)

    log.info('[graphics] preset ' + id + ': packs ' + JSON.stringify(packs) + ', shader ' + (p.shader || 'off'))
    return { preset: id, resourcePacks: packs, shaderPack: want.shaderPack, enableShaders: !!p.shader }
}

// ---- Login check against the server (PasswordGate SRP over the Minecraft login phase) ----
/** Names nobody may create from the launcher. */
exports.RESERVED_NAMES = ['asiandoesmc']
const AMP_MODPACK_KEY = 'ip216.ip-139-99-4.net-25581'

/**
 * Store the AutoModpack secret the server issued during a login check, so the pre-launch sync
 * keeps working (the server replaces the player's secret on every login).
 */
exports.saveAmpSecret = function(gameDir, secret){
    if(!secret || typeof secret.secret !== 'string') return
    const file = path.join(gameDir, 'automodpack', '.private', 'automodpack-client-secrets.json')
    let data = {}
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')) } catch(_e) { /* new file */ }
    if(!data || typeof data !== 'object') data = {}
    if(!data.secrets || typeof data.secrets !== 'object') data.secrets = {}
    const keys = Object.keys(data.secrets)
    const key = keys.includes(AMP_MODPACK_KEY) || keys.length === 0 ? AMP_MODPACK_KEY : keys[0]
    data.secrets[key] = { secret: secret.secret, timestamp: secret.timestamp }
    fs.ensureDirSync(path.dirname(file))
    fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2))
    fs.renameSync(file + '.tmp', file)
}

/**
 * Check a name/password with the server before the launcher accepts it.
 * mode 'login' (I have an account) or 'create'. Resolves { result, detail }; see arvanauth.js.
 * The password is never logged.
 */
exports.checkAccount = async function(gameDir, name, password, mode, log = console){
    if(mode === 'create' && exports.RESERVED_NAMES.includes(String(name).toLowerCase())){
        return { result: 'name_taken', detail: 'reserved name' }
    }
    const { checkLogin } = require('./arvanauth')
    return checkLogin({
        host: exports.AMP_HOST, port: exports.AMP_PORT, name, password, mode,
        log: m => log.info(m),
        onAmpSecret: (_name, secret) => {
            try { exports.saveAmpSecret(gameDir, secret) } catch(err) { log.warn('[login-check] could not store the AutoModpack secret: ' + err.message) }
        }
    })
}

/** Text shown on the login screen for a failed check, or null when the account can be saved. */
exports.accountCheckMessage = function(res, mode){
    switch(res && res.result){
        case 'ok':
        case 'ok_unsecured':
            return null
        case 'wrong_password': return 'Wrong password.'
        case 'no_account': return mode === 'create' ? 'That name is already taken.' : 'No account with that name. Names are case-sensitive: check the capital letters, or use "Create account".'
        case 'name_taken': return 'This name already has an account. Use "I have an account" with your existing password.'
        case 'rate_limited': return 'Too many attempts. Wait 5 minutes and try again.'
        case 'offline': return 'Server offline, try later.'
        default: return 'Could not check the account with the server. Try again in a moment.'
    }
}

/** Apply the saved preset; never blocks the launch. */
exports.applyGraphicsSafe = function(ctx){
    try {
        exports.applyGraphicsPreset(ctx.gameDir, exports.readGraphicsPreset(ctx.gameDir), ctx.logger)
    } catch(err) {
        ctx.logger.warn('[graphics] could not apply preset', err)
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
exports.PASSWORD_MIN = 8 // matches the server (PasswordGate minimumPasswordLength)
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
