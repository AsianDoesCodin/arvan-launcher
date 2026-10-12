'use strict'
/**
 * ampsync - pre-launch modpack sync against an AutoModpack 4.0.6 host.
 *
 * Speaks the AutoModpack host protocol directly (plain TCP "AMMH" magic ->
 * TLS 1.3 with SHA-256 certificate pinning -> raw configuration messages ->
 * length-framed protocol messages) and lays files out exactly the way the
 * in-game AutoModpack client expects, so its startup check finds nothing to do.
 *
 * Needs the player's client secret, which the server only issues during a
 * Minecraft login (stored in automodpack/.private/automodpack-client-secrets.json).
 */
const net = require('net')
const tls = require('tls')
const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const crypto = require('crypto')
const zlib = require('zlib')

// --- protocol constants (core/.../protocol/NetUtils.java) ---
const MAGIC_AMMH = 0x414D4D48
const MAGIC_AMOK = 0x414D4F4B
const PROTOCOL_VERSION = 0x01
const COMPRESSION_NONE = 0x00
const COMPRESSION_ZSTD = 0x01
const COMPRESSION_GZIP = 0x02
const FILE_REQUEST_TYPE = 0x01
const FILE_RESPONSE_TYPE = 0x02
const END_OF_TRANSMISSION = 0x04
const ERROR_TYPE = 0x05
const CONFIGURATION_COMPRESSION_TYPE = 0x41
const CONFIGURATION_CHUNK_SIZE_TYPE = 0x42
const CHUNK_SIZE = 256 * 1024
const CONTENT_FILE = 'automodpack-content.json'
const CACHE_FILE = 'ampsync-cache.json'

// Forge services that make AutoModpack install a mod into the standard mods/ dir
// (core/.../utils/FileInspection.java services set)
const WORKAROUND_SERVICES = new Set([
  'META-INF/services/net.minecraftforge.forgespi.locating.IModLocator',
  'META-INF/services/net.minecraftforge.forgespi.locating.IDependencyLocator',
  'META-INF/services/net.minecraftforge.forgespi.language.IModLanguageProvider',
  'META-INF/services/net.neoforged.neoforgespi.locating.IModLocator',
  'META-INF/services/net.neoforged.neoforgespi.locating.IDependencyLocator',
  'META-INF/services/net.neoforged.neoforgespi.locating.IModLanguageLoader',
  'META-INF/services/net.neoforged.neoforgespi.locating.IModFileCandidateLocator',
  'META-INF/services/net.neoforged.neoforgespi.earlywindow.GraphicsBootstrapper'
])

class AmpError extends Error {
  constructor (code, message) { super(message); this.code = code }
}

// ---------------------------------------------------------------- helpers
async function readJson (file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')) } catch { return fallback }
}
async function writeJson (file, obj) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2))
  await fsp.rename(tmp, file)
}
// AutoModpack FileInspection.fixFileName equivalent for host:port names
function fixFileName (name) { return name.replace(/[\\/:*?"<>|]/g, '-') }

function safeJoin (root, rel) {
  const p = path.resolve(root, '.' + path.posix.normalize('/' + rel))
  if (p !== root && !p.startsWith(root + path.sep)) throw new AmpError('AMP_BAD_PATH', 'Unsafe path from server: ' + rel)
  return p
}

function sha1File (file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1')
    fs.createReadStream(file).on('error', reject).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex')))
  })
}

class HashCache {
  constructor (file) { this.file = file; this.data = { files: {}, services: {} } }
  async load () {
    const d = await readJson(this.file, null)
    if (d && d.files) this.data = { files: d.files, services: d.services || {} }
  }
  save () { return writeJson(this.file, this.data) }
  // sha1 of a file, or null if it does not exist (cached by size+mtime)
  async hash (file) {
    let st
    try { st = await fsp.stat(file) } catch { return null }
    if (!st.isFile()) return null
    const key = file.toLowerCase()
    const c = this.data.files[key]
    if (c && c.s === st.size && c.m === st.mtimeMs) return c.h
    const h = await sha1File(file)
    this.data.files[key] = { s: st.size, m: st.mtimeMs, h }
    return h
  }
  async put (file, h) {
    const st = await fsp.stat(file)
    this.data.files[file.toLowerCase()] = { s: st.size, m: st.mtimeMs, h }
  }
}

// ---------------------------------------------------------------- minimal zip reader (service detection only)
function zipEntries (buf) {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) return []
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const out = []
  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break
    const method = buf.readUInt16LE(off + 10)
    const csize = buf.readUInt32LE(off + 20)
    const nlen = buf.readUInt16LE(off + 28)
    const xlen = buf.readUInt16LE(off + 30)
    const clen = buf.readUInt16LE(off + 32)
    const local = buf.readUInt32LE(off + 42)
    out.push({ name: buf.toString('utf8', off + 46, off + 46 + nlen), method, csize, local })
    off += 46 + nlen + xlen + clen
  }
  return out
}
function zipRead (buf, e) {
  const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28)
  const raw = buf.subarray(start, start + e.csize)
  return e.method === 0 ? raw : zlib.inflateRawSync(raw)
}
// mirrors FileInspection.hasSpecificServices: direct services, then META-INF/jarjar/*.jar one level down
function hasSpecificServices (buf, depth = 0) {
  let entries
  try { entries = zipEntries(buf) } catch { return false }
  if (entries.some(e => WORKAROUND_SERVICES.has(e.name))) return true
  if (depth > 0) return false
  for (const e of entries) {
    if (/^META-INF\/jarjar\/[^/]+\.jar$/.test(e.name)) {
      try { if (hasSpecificServices(zipRead(buf, e), depth + 1)) return true } catch {}
    }
  }
  return false
}

// ---------------------------------------------------------------- connection
class SockReader {
  constructor (sock) {
    this.bufs = []; this.len = 0; this.waiter = null; this.err = null; this.closed = false
    sock.on('data', d => { this.bufs.push(d); this.len += d.length; this._wake() })
    sock.on('error', e => { this.err = e; this._wake() })
    sock.on('close', () => { this.closed = true; this._wake() })
  }
  _wake () { const w = this.waiter; if (w) { this.waiter = null; w() } }
  async read (n) {
    while (this.len < n) {
      if (this.err) throw this.err
      if (this.closed) throw new AmpError('AMP_CLOSED', 'Connection closed by host')
      await new Promise(resolve => { this.waiter = resolve })
    }
    const all = this.bufs.length === 1 ? this.bufs[0] : Buffer.concat(this.bufs, this.len)
    const out = all.subarray(0, n)
    const rest = all.subarray(n)
    this.bufs = rest.length ? [rest] : []
    this.len = rest.length
    return out
  }
}

function withTimeout (p, ms, what) {
  let t
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new AmpError('AMP_TIMEOUT', what + ' timed out')), ms) })])
    .finally(() => clearTimeout(t))
}

class AmpConnection {
  constructor (opts) { this.o = opts }

  async open () {
    const { host, port, secret } = this.o
    this.secret = secret
    // 1) plain TCP + AMMH magic (needed because the host shares the game port)
    const plain = await withTimeout(new Promise((resolve, reject) => {
      const s = net.connect({ host, port }, () => resolve(s))
      s.once('error', reject)
    }), 10000, 'TCP connect')
    const hostBytes = Buffer.from(host, 'utf8')
    const magic = Buffer.alloc(6 + hostBytes.length)
    magic.writeUInt32BE(MAGIC_AMMH, 0); magic.writeUInt16BE(hostBytes.length, 4); hostBytes.copy(magic, 6)
    const ok = await withTimeout(new Promise((resolve, reject) => {
      let acc = Buffer.alloc(0)
      const onData = d => {
        acc = Buffer.concat([acc, d])
        if (acc.length >= 4) { plain.removeListener('data', onData); plain.pause(); resolve(acc.readUInt32BE(0)) }
      }
      plain.on('data', onData)
      plain.once('error', reject)
      plain.once('close', () => reject(new AmpError('AMP_CLOSED', 'Host closed during magic handshake')))
      plain.write(magic)
    }), 10000, 'Magic handshake')
    plain.removeAllListeners('error'); plain.removeAllListeners('close')
    if (ok !== MAGIC_AMOK) { plain.destroy(); throw new AmpError('AMP_NO_HOST', 'Not an AutoModpack host (bad magic reply)') }

    // 2) TLS 1.3 over the same socket, self-signed cert pinned by SHA-256 of DER
    const sock = await withTimeout(new Promise((resolve, reject) => {
      const t = tls.connect({
        socket: plain,
        rejectUnauthorized: false,
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        servername: net.isIP(host) ? undefined : host
      }, () => resolve(t))
      t.once('error', reject)
    }), 15000, 'TLS handshake')
    sock.removeAllListeners('error')
    const cert = sock.getPeerCertificate(false)
    const fp = cert && cert.raw ? crypto.createHash('sha256').update(cert.raw).digest('hex') : null
    this.fingerprint = fp
    if (this.o.fingerprint && fp !== this.o.fingerprint.toLowerCase()) {
      sock.destroy()
      throw new AmpError('AMP_CERT_MISMATCH', `Host certificate ${fp} does not match pinned ${this.o.fingerprint}`)
    }
    this.sock = sock
    this.r = new SockReader(sock)
    sock.setTimeout(60000, () => sock.destroy(new AmpError('AMP_TIMEOUT', 'Host stopped responding')))

    // 3) raw (unframed) configuration messages: compression NONE, chunk size.
    //    The echo-config message is intentionally not sent: the first framed message
    //    starts with 0x00 0x00, which the server's ConfigurationHandler passes through
    //    and then removes itself, so nothing can be lost between the two.
    sock.write(Buffer.from([PROTOCOL_VERSION, CONFIGURATION_COMPRESSION_TYPE, COMPRESSION_NONE]))
    let b = await this.r.read(3)
    if (b[1] !== CONFIGURATION_COMPRESSION_TYPE) throw new AmpError('AMP_PROTOCOL', 'Unexpected compression config reply ' + b[1])
    this.compression = b[2]
    const cs = Buffer.alloc(6); cs[0] = PROTOCOL_VERSION; cs[1] = CONFIGURATION_CHUNK_SIZE_TYPE; cs.writeInt32BE(CHUNK_SIZE, 2)
    sock.write(cs)
    b = await this.r.read(6)
    if (b[1] !== CONFIGURATION_CHUNK_SIZE_TYPE) throw new AmpError('AMP_PROTOCOL', 'Unexpected chunk config reply ' + b[1])
    this.chunkSize = b.readInt32BE(2)
    return this
  }

  async readFrame () {
    const h = await this.r.read(8)
    const clen = h.readInt32BE(0); const olen = h.readInt32BE(4)
    if (clen < 0 || clen > this.chunkSize + 8192 || olen < 0 || olen > this.chunkSize) {
      throw new AmpError('AMP_PROTOCOL', `Bad frame ${clen}/${olen}`)
    }
    const data = Buffer.from(await this.r.read(clen))
    if (this.compression === COMPRESSION_NONE) return data
    if (this.compression === COMPRESSION_GZIP) return zlib.gunzipSync(data)
    throw new AmpError('AMP_PROTOCOL', 'Host forced zstd compression, unsupported')
  }

  // Requests a file by sha1 hex ('' = modpack content json). onData(chunk) may be async.
  async request (sha1, onData) {
    const hash = Buffer.from(sha1, 'utf8')
    const payload = Buffer.alloc(2 + 32 + 4 + hash.length)
    payload[0] = PROTOCOL_VERSION; payload[1] = FILE_REQUEST_TYPE
    this.secret.copy(payload, 2); payload.writeInt32BE(hash.length, 34); hash.copy(payload, 38)
    const frame = Buffer.alloc(8); frame.writeInt32BE(payload.length, 0); frame.writeInt32BE(payload.length, 4)
    this.sock.write(Buffer.concat([frame, payload]))

    const head = await this.readFrame()
    const type = head[1]
    if (type === ERROR_TYPE) {
      const msg = head.toString('utf8', 6, 6 + head.readInt32BE(2))
      this.close()
      throw new AmpError(msg === 'Authentication failed' ? 'AMP_AUTH_FAILED' : 'AMP_HOST_ERROR', 'Host error: ' + msg)
    }
    if (type === END_OF_TRANSMISSION) return 0
    if (type !== FILE_RESPONSE_TYPE) throw new AmpError('AMP_PROTOCOL', 'Unexpected message type ' + type)
    const size = Number(head.readBigInt64BE(2))
    let got = 0
    while (got < size) {
      const f = await this.readFrame()
      const take = Math.min(f.length, size - got)
      await onData(take === f.length ? f : f.subarray(0, take))
      got += take
    }
    const eot = await this.readFrame()
    if (eot[1] !== END_OF_TRANSMISSION) throw new AmpError('AMP_PROTOCOL', 'Missing end of transmission')
    return size
  }

  close () { try { this.sock && this.sock.destroy() } catch {} }
}

// ---------------------------------------------------------------- sync
async function sync ({
  instanceDir,
  host = '139.99.4.216',
  port = 25581,
  onProgress = () => {},
  onLog = () => {},
  parallel = 4,
  secretLifetimeHours = 336,
  trustOnFirstUse = true
} = {}) {
  if (!instanceDir) throw new AmpError('AMP_ARGS', 'instanceDir is required')
  instanceDir = path.resolve(instanceDir)
  const ampDir = path.join(instanceDir, 'automodpack')
  const clientCfgFile = path.join(ampDir, 'automodpack-client.json')
  const secretsFile = path.join(ampDir, '.private', 'automodpack-client-secrets.json')
  const knownHostsFile = path.join(ampDir, '.private', 'automodpack-known-hosts.json')
  const serverAddress = `${host}:${port}`

  const clientCfg = await readJson(clientCfgFile, null) || {
    DO_NOT_CHANGE_IT: 2, selectedModpack: '', installedModpacks: {}, updateSelectedModpackOnLaunch: true
  }
  clientCfg.installedModpacks = clientCfg.installedModpacks || {}

  // which modpack folder belongs to this server
  let name = null
  const sel = clientCfg.selectedModpack
  if (sel && clientCfg.installedModpacks[sel] && clientCfg.installedModpacks[sel].serverAddress === serverAddress) name = sel
  if (!name) name = Object.keys(clientCfg.installedModpacks).find(k => clientCfg.installedModpacks[k].serverAddress === serverAddress) || null

  // secret (issued by the server on Minecraft login, saved by the in-game client)
  const secrets = (await readJson(secretsFile, {})).secrets || {}
  const secretKey = name && secrets[name] ? name : Object.keys(secrets).find(k => clientCfg.installedModpacks[k] && clientCfg.installedModpacks[k].serverAddress === serverAddress)
  const secretEntry = secretKey && secrets[secretKey]
  if (!secretEntry || !secretEntry.secret) {
    throw new AmpError('AMP_NO_SECRET', 'No AutoModpack secret for this server yet. Join the server once from the game to get one.')
  }
  if (!name) name = secretKey
  const secret = Buffer.from(secretEntry.secret, 'base64url')
  if (secret.length !== 32) throw new AmpError('AMP_NO_SECRET', 'Stored AutoModpack secret is malformed')
  const expiresAt = (Number(secretEntry.timestamp) + secretLifetimeHours * 3600) * 1000
  if (Date.now() > expiresAt) onLog(`secret looks expired since ${new Date(expiresAt).toISOString()}, trying anyway`)

  // pinned certificate
  const knownHosts = await readJson(knownHostsFile, { hosts: {} })
  knownHosts.hosts = knownHosts.hosts || {}
  const entry = clientCfg.installedModpacks[name]
  const hostAddrHost = entry && entry.hostAddress ? entry.hostAddress.replace(/:\d+$/, '') : null
  let fingerprint = knownHosts.hosts[host] || (hostAddrHost && knownHosts.hosts[hostAddrHost]) || null
  if (!fingerprint && !trustOnFirstUse) throw new AmpError('AMP_CERT_UNKNOWN', 'Host certificate not pinned yet')

  const cache = new HashCache(path.join(ampDir, CACHE_FILE))
  await cache.load()

  const conns = []
  const connOpts = { host, port, secret, fingerprint }
  const connect = async () => {
    const c = await new AmpConnection(connOpts).open()
    if (!connOpts.fingerprint) { // trust on first use: pin it like the in-game "trust" button does
      connOpts.fingerprint = c.fingerprint
      knownHosts.hosts[host] = c.fingerprint
      if (hostAddrHost) knownHosts.hosts[hostAddrHost] = c.fingerprint
      await writeJson(knownHostsFile, knownHosts)
      onLog('pinned host certificate ' + c.fingerprint)
    }
    conns.push(c)
    return c
  }

  const stats = {
    modpack: name, files: 0, totalBytes: 0, downloaded: 0, downloadedBytes: 0,
    deleted: 0, copiedToGameDir: 0, workaroundMods: 0, modsDirConflicts: [], upToDate: false
  }
  try {
    // --- content list
    const first = await connect()
    const parts = []
    await first.request('', d => { parts.push(Buffer.from(d)) })
    const contentRaw = Buffer.concat(parts)
    const content = JSON.parse(contentRaw.toString('utf8'))
    if (!content || !Array.isArray(content.list)) throw new AmpError('AMP_PROTOCOL', 'Bad modpack content')

    if (content.modpackName) name = fixFileName(content.modpackName)
    if (!name) name = fixFileName(serverAddress)
    stats.modpack = name
    const modpackDir = path.join(ampDir, 'modpacks', name)
    await fsp.mkdir(modpackDir, { recursive: true })

    // --- compare (mirrors ModpackUtils.isUpdate: missing -> update, editable -> skip hash)
    const items = content.list
    stats.files = items.length
    const todo = []
    for (const it of items) {
      const p = safeJoin(modpackDir, it.file)
      stats.totalBytes += Number(it.size) || 0
      const h = await cache.hash(p)
      if (h === null) todo.push(it)
      else if (!it.editable && h !== it.sha1) todo.push(it)
    }
    const downloadedNow = new Set()

    // --- download
    const total = todo.reduce((a, it) => a + (Number(it.size) || 0), 0)
    let done = 0
    onProgress(0, total, null)
    let next = 0
    const worker = async (conn) => {
      while (next < todo.length) {
        const it = todo[next++]
        const dest = safeJoin(modpackDir, it.file)
        for (let attempt = 0; ; attempt++) {
          const tmp = dest + '.ampsync'
          let fileDone = 0
          try {
            if (!conn) conn = await connect()
            await fsp.mkdir(path.dirname(dest), { recursive: true })
            const fh = await fsp.open(tmp, 'w')
            const hash = crypto.createHash('sha1')
            try {
              await conn.request(it.sha1, async chunk => {
                hash.update(chunk); await fh.write(chunk)
                fileDone += chunk.length; done += chunk.length
                onProgress(done, total, it.file)
              })
            } finally { await fh.close() }
            const got = hash.digest('hex')
            if (got !== it.sha1) throw new AmpError('AMP_HASH', `Hash mismatch for ${it.file}`)
            await fsp.rm(dest, { force: true })
            await fsp.rename(tmp, dest)
            await cache.put(dest, got)
            downloadedNow.add(it.file)
            stats.downloaded++; stats.downloadedBytes += fileDone
            break
          } catch (e) {
            await fsp.rm(tmp, { force: true }).catch(() => {})
            done -= fileDone
            if (conn) { conn.close(); conn = null }
            if (e.code === 'AMP_AUTH_FAILED' || attempt >= 2) throw e
            onLog(`retry ${it.file}: ${e.message}`)
          }
        }
      }
    }
    const workers = []
    for (let i = 0; i < Math.min(parallel, Math.max(1, todo.length)); i++) workers.push(worker(i === 0 ? first : null))
    if (todo.length === 0) first.close()
    await Promise.all(workers)

    // --- delete files the server no longer lists (only inside the modpack folder;
    //     same rule as ModpackUpdater.deleteNonModpackFiles, which would otherwise force a restart)
    const keep = new Set(items.map(it => it.file))
    const walk = async (dir) => {
      let ents = []
      try { ents = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
      for (const e of ents) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) {
          await walk(p)
          try { if ((await fsp.readdir(p)).length === 0) await fsp.rmdir(p) } catch {}
        } else {
          const rel = '/' + path.relative(modpackDir, p).split(path.sep).join('/')
          if (rel === '/' + CONTENT_FILE || keep.has(rel)) continue
          await fsp.rm(p, { force: true }); stats.deleted++
        }
      }
    }
    await walk(modpackDir)

    // --- game-dir copies AutoModpack would make (ModpackUtils.correctFilesLocations):
    //     non-mod files -> <instance>/<file>; forceCopy or "service" mods -> <instance>/mods/
    //     Editable files are only placed when missing or freshly downloaded.
    const modsDir = path.join(instanceDir, 'mods')
    for (const it of items) {
      const src = safeJoin(modpackDir, it.file)
      const isMod = it.type === 'mod'
      let copy = !isMod || it.forceCopy
      if (isMod && !copy) {
        let svc = cache.data.services[it.sha1]
        if (svc === undefined) {
          try { svc = hasSpecificServices(await fsp.readFile(src)) } catch { svc = false }
          cache.data.services[it.sha1] = svc
        }
        if (svc) { copy = true; stats.workaroundMods++ }
      }
      if (!copy) continue
      const run = isMod ? safeJoin(modsDir, it.file.replace(/^\/mods\//, '')) : safeJoin(instanceDir, it.file)
      const runHash = await cache.hash(run)
      if (runHash === it.sha1) continue
      if (it.editable && runHash !== null && !downloadedNow.has(it.file)) continue
      await fsp.mkdir(path.dirname(run), { recursive: true })
      await fsp.copyFile(src, run)
      await cache.put(run, it.sha1)
      stats.copiedToGameDir++
    }

    // --- report (never delete) regular modpack mods sitting in mods/: AutoModpack deletes them and restarts
    const modpackModHashes = new Map(items.filter(it => it.type === 'mod' && !it.forceCopy && cache.data.services[it.sha1] === false).map(it => [it.sha1, it.file]))
    try {
      for (const f of await fsp.readdir(modsDir)) {
        const h = await cache.hash(path.join(modsDir, f))
        if (h && modpackModHashes.has(h)) stats.modsDirConflicts.push(f)
      }
    } catch {}

    // --- content file + client config (what AutoModpack reads at startup)
    await fsp.writeFile(path.join(modpackDir, CONTENT_FILE), contentRaw)
    if (!clientCfg.installedModpacks[name]) {
      clientCfg.installedModpacks[name] = {
        hostAddress: (entry && entry.hostAddress) || serverAddress,
        serverAddress,
        requiresMagic: true
      }
    }
    clientCfg.selectedModpack = name
    await writeJson(clientCfgFile, clientCfg)
    stats.upToDate = stats.downloaded === 0 && stats.deleted === 0
    return stats
  } finally {
    for (const c of conns) c.close()
    await cache.save().catch(() => {})
  }
}

module.exports = { sync, AmpError, _internal: { AmpConnection, hasSpecificServices } }
