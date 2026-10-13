/**
 * Arvan login check: a tiny Minecraft 1.20.1 (protocol 763) login-phase client that answers the
 * Arvan Characters PasswordGate SRP-6a exchange and closes before the world is joined.
 *
 * checkLogin({ host, port, name, password, mode }) resolves to one of:
 *   ok             password verified (login) / password registered (create)
 *   ok_unsecured   create: the name is free but the server only joins it without a password
 *   wrong_password the server rejected the SRP proof
 *   no_account     login: the server never asked for a password (no secured account with that name)
 *   name_taken     create: the name already has a password
 *   rate_limited   PasswordGate lockout
 *   offline        could not reach the server
 *   error          anything else ({ detail } says what, never the password)
 *
 * The password only lives in memory long enough to compute SRP values; it is never logged.
 */
const net = require('net')
const zlib = require('zlib')
const crypto = require('crypto')

const PROTOCOL = 763
const PG_CHANNEL = 'arvancharacters:login'
const FML_HANDSHAKE = 'fml:handshake'
const FML_WRAPPER = 'fml:loginwrapper'
const CHARACTER_CHANNEL = 'arvancharacters:character_login'

// ---- SRP-6a, RFC 5054 3072-bit group, SHA-256, BouncyCastle SRP6Client conventions ----
const N = BigInt('0x' +
    'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E08' +
    '8A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B' +
    '302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9' +
    'A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE6' +
    '49286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8' +
    'FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D' +
    '670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C' +
    '180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF695581718' +
    '3995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D' +
    '04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7D' +
    'B3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D226' +
    '1AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200C' +
    'BBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFC' +
    'E0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF')
const G = 5n
const N_LEN = 384

function modPow(b, e, m){
    let r = 1n
    b %= m
    while(e > 0n){
        if(e & 1n) r = r * b % m
        e >>= 1n
        b = b * b % m
    }
    return r
}
function toBig(buf){ return buf.length ? BigInt('0x' + buf.toString('hex')) : 0n }
function unsigned(n){
    let h = n.toString(16)
    if(h.length % 2) h = '0' + h
    return Buffer.from(h, 'hex')
}
function pad(n){
    const b = unsigned(n)
    return b.length >= N_LEN ? b : Buffer.concat([Buffer.alloc(N_LEN - b.length), b])
}
function sha(...parts){
    const h = crypto.createHash('sha256')
    for(const p of parts) h.update(p)
    return h.digest()
}
function srpX(salt, identity, password){
    const inner = sha(Buffer.from(identity, 'utf8'), Buffer.from(':'), Buffer.from(password, 'utf8'))
    return toBig(sha(salt, inner))
}
/** Verifier for registration: v = g^x mod N. */
function srpVerifier(salt, identity, password){
    return modPow(G, srpX(salt, identity, password), N)
}

/** Client side of the challenge. Returns { A, M1, expectM2 }. */
function srpClient(salt, identity, password, B){
    if(B <= 0n || B % N === 0n) throw new Error('invalid SRP challenge')
    const x = srpX(salt, identity, password)
    const k = toBig(sha(pad(N), pad(G)))
    let a
    do { a = toBig(crypto.randomBytes(32)) } while(a === 0n)
    const A = modPow(G, a, N)
    const u = toBig(sha(pad(A), pad(B)))
    const tmp = k * modPow(G, x, N) % N
    const base = ((B - tmp) % N + N) % N
    const S = modPow(base, u * x + a, N)
    const M1 = toBig(sha(pad(A), pad(B), pad(S)))
    const M2 = toBig(sha(pad(A), pad(M1), pad(S)))
    return { A, M1, M2 }
}
exports._srpTest = { srpVerifier, srpClient }

/** Offline-mode player UUID (UUID v3 of "OfflinePlayer:<name>"), as Minecraft computes it. */
function offlineUuid(name){
    const h = crypto.createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest()
    h[6] = (h[6] & 0x0f) | 0x30
    h[8] = (h[8] & 0x3f) | 0x80
    return h
}
function uuidString(b){
    const x = b.toString('hex')
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`
}
exports.offlineUuid = name => uuidString(offlineUuid(name))

// ---- Wire helpers ----
function varint(n){
    const out = []
    n >>>= 0
    do {
        let b = n & 0x7f
        n >>>= 7
        if(n) b |= 0x80
        out.push(b)
    } while(n)
    return Buffer.from(out)
}
function str(s){
    const b = Buffer.from(s, 'utf8')
    return Buffer.concat([varint(b.length), b])
}
function bytes(b){ return Buffer.concat([varint(b.length), b]) }

class Reader {
    constructor(buf){ this.b = buf; this.o = 0 }
    varint(){
        let n = 0, shift = 0, b
        do {
            if(this.o >= this.b.length) throw new Error('short varint')
            b = this.b[this.o++]
            n |= (b & 0x7f) << shift
            shift += 7
            if(shift > 35) throw new Error('varint too long')
        } while(b & 0x80)
        return n >>> 0
    }
    take(n){
        if(n < 0 || this.o + n > this.b.length) throw new Error('short read')
        const r = this.b.subarray(this.o, this.o + n)
        this.o += n
        return r
    }
    str(){ return this.take(this.varint()).toString('utf8') }
    bytes(){ return this.take(this.varint()) }
    rest(){ return this.take(this.b.length - this.o) }
    more(){ return this.o < this.b.length }
}

// ---- PasswordGate packet (SimpleChannel discriminator 0 + AuthPacket) ----
const TYPES = ['PREMIUM_PROOF_REQUEST', 'PREMIUM_PROOF_COMPLETE', 'PREMIUM_PROOF_FAILED', 'REGISTER_REQUEST',
    'REGISTER_SUBMIT', 'CHALLENGE', 'CLIENT_PROOF', 'SERVER_PROOF', 'ACK']
function decodeAuth(buf){
    const r = new Reader(buf)
    const disc = r.take(1)[0]
    const version = r.varint()
    const session = r.take(16)
    const identity = r.take(16)
    const type = TYPES[r.varint()]
    const parameter = r.varint()
    const first = r.bytes()
    const second = r.bytes()
    return { disc, version, session, identity, type, parameter, first, second }
}
function encodeAuth(p, type, parameter = 0, first = Buffer.alloc(0), second = Buffer.alloc(0)){
    return Buffer.concat([Buffer.from([p.disc]), varint(2), p.session, p.identity,
        varint(TYPES.indexOf(type)), varint(parameter), bytes(first), bytes(second)])
}

// ---- Forge handshake replies ----
function fmlReply(inner){
    const r = new Reader(inner)
    const idx = r.varint()
    if(idx === 1){
        // S2CModList: mods, channels (name -> version), registries, [datapack registries]
        const mods = []
        for(let i = r.varint(); i > 0; i--) mods.push(r.str())
        const channels = []
        for(let i = r.varint(); i > 0; i--) channels.push([r.str(), r.str()])
        const registries = []
        for(let i = r.varint(); i > 0; i--) registries.push(r.str())
        const parts = [varint(2), varint(mods.length), ...mods.map(str), varint(channels.length)]
        for(const [k, v] of channels) parts.push(str(k), str(v))
        parts.push(varint(registries.length))
        for(const k of registries) parts.push(str(k), str(''))
        return Buffer.concat(parts)
    }
    return varint(99) // C2SAcknowledge for registries, configs, mod data
}

function chatText(json){
    try {
        const c = JSON.parse(json)
        const keys = []
        const walk = v => {
            if(!v || typeof v !== 'object') return
            if(v.translate) keys.push(v.translate)
            ;(v.with || []).forEach(walk)
            ;(v.extra || []).forEach(walk)
        }
        walk(c)
        return { keys, text: JSON.stringify(c).slice(0, 300) }
    } catch(_e) {
        return { keys: [], text: String(json).slice(0, 300) }
    }
}

/**
 * Run one login check. Never logs the password; `log` receives protocol notes only.
 */
exports.checkLogin = function({ host, port, name, password, mode = 'login', timeoutMs = 25000, log = () => {}, onAmpSecret = null }){
    return new Promise(resolve => {
        // SRP identity = the UUID string the server sends in each gate packet (the in-game client does
        // the same: packet.identity().toString()). For this offline-mode server that is the case-sensitive
        // offline UUID of the name, but taking it from the packet keeps the verifier identical either way.
        const loginUuid = offlineUuid(name)
        let threshold = -1
        let buf = Buffer.alloc(0)
        let done = false
        let connected = false
        let submitted = false
        let expectM2 = null
        let acked = false
        let sawGate = false
        const sock = net.connect({ host, port })
        const timer = setTimeout(() => finish(connected ? 'error' : 'offline', 'timeout'), timeoutMs)

        function finish(result, detail){
            if(done) return
            done = true
            clearTimeout(timer)
            password = null
            try { sock.destroy() } catch(_e) { /* closed */ }
            log('[login-check] result ' + result + (detail ? ' (' + detail + ')' : ''))
            resolve({ result, detail })
        }
        function send(id, payload){
            let body = Buffer.concat([varint(id), payload])
            if(threshold >= 0){
                if(body.length >= threshold) body = Buffer.concat([varint(body.length), zlib.deflateSync(body)])
                else body = Buffer.concat([varint(0), body])
            }
            sock.write(Buffer.concat([varint(body.length), body]))
        }
        function pluginResponse(msgId, data){
            send(0x02, Buffer.concat([varint(msgId), Buffer.from([data ? 1 : 0]), data || Buffer.alloc(0)]))
        }
        function wrapped(msgId, channel, payload){
            pluginResponse(msgId, Buffer.concat([str(channel), bytes(payload)]))
        }

        function onGate(msgId, p){
            sawGate = true
            log('[login-check] gate ' + p.type)
            if(p.type === 'PREMIUM_PROOF_REQUEST'){
                wrapped(msgId, PG_CHANNEL, encodeAuth(p, 'PREMIUM_PROOF_FAILED'))
            } else if(p.type === 'REGISTER_REQUEST'){
                if(mode !== 'create') return finish('no_account', 'server asks to register')
                if(password.length < p.parameter) return finish('password_too_short', 'server minimum ' + p.parameter)
                const v = srpVerifier(p.first, uuidString(p.identity), password)
                submitted = true
                wrapped(msgId, PG_CHANNEL, encodeAuth(p, 'REGISTER_SUBMIT', 0, unsigned(v)))
            } else if(p.type === 'CHALLENGE'){
                if(mode === 'create' && !submitted) return finish('name_taken')
                const c = srpClient(p.first, uuidString(p.identity), password, toBig(p.second))
                expectM2 = c.M2
                submitted = true
                wrapped(msgId, PG_CHANNEL, encodeAuth(p, 'CLIENT_PROOF', 0, unsigned(c.A), unsigned(c.M1)))
            } else if(p.type === 'SERVER_PROOF'){
                if(expectM2 == null || toBig(p.second) !== expectM2) return finish('error', 'server proof mismatch')
                if(mode === 'create'){
                    // ACK makes the server save the new password; close once it moves on.
                    wrapped(msgId, PG_CHANNEL, encodeAuth(p, 'ACK'))
                    acked = true
                    setTimeout(() => finish('ok'), 1500)
                } else {
                    // Verified. Close without ACK: no parent session is committed for a mere check.
                    finish('ok')
                }
            } else {
                finish('error', 'unexpected gate packet ' + p.type)
            }
        }

        function onPacket(id, r){
            if(id === 0x00){
                const reason = chatText(r.str())
                const key = reason.keys.find(k => k.startsWith('disconnect.passwordgate.')) || reason.keys[0] || ''
                if(key === 'disconnect.passwordgate.lockout') return finish('rate_limited')
                if(key === 'disconnect.passwordgate.authentication_failed') return finish(submitted ? 'wrong_password' : 'error', key)
                return finish('error', 'disconnected: ' + (key || reason.text))
            }
            if(id === 0x01) return finish('error', 'server asked for encryption (online mode)')
            if(id === 0x02) return finish(mode === 'create' ? 'ok_unsecured' : 'no_account', 'login completed without a password')
            if(id === 0x03){ threshold = r.varint(); return }
            if(id === 0x04){
                const msgId = r.varint()
                const channel = r.str()
                if(channel === FML_WRAPPER){
                    const inner = r.str()
                    const payload = r.bytes()
                    if(inner === FML_HANDSHAKE){
                        wrapped(msgId, FML_HANDSHAKE, fmlReply(payload))
                    } else if(inner === PG_CHANNEL){
                        onGate(msgId, decodeAuth(payload))
                    } else if(inner === CHARACTER_CHANNEL){
                        // Past the password gate: the server moved on to character selection.
                        // After a create ACK this is the normal next step: the password is already saved.
                        if(acked) return finish('ok')
                        if(submitted) return finish('error', 'character selection after a password exchange')
                        if(!sawGate) return finish('error', 'character selection without the password gate')
                        // No password was asked: the name has no secured account.
                        finish(mode === 'create' ? 'ok_unsecured' : 'no_account', 'joined without a password')
                    } else {
                        log('[login-check] unknown wrapped channel ' + inner)
                        pluginResponse(msgId, null)
                    }
                } else if(channel === 'automodpack:handshake'){
                    // Answer like the AutoModpack client: same loaders / versions as the server sent.
                    pluginResponse(msgId, str(r.str()))
                } else if(channel === 'automodpack:data'){
                    // The server issues a fresh modpack secret per login; hand it to the caller so the
                    // launcher's pre-launch sync keeps working. Answer "false" = modpack installed.
                    try {
                        const data = JSON.parse(r.str())
                        if(data && data.secret && onAmpSecret) onAmpSecret(data.modpackName, data.secret)
                    } catch(err) {
                        log('[login-check] could not read the AutoModpack data packet: ' + err.message)
                    }
                    pluginResponse(msgId, str('false'))
                } else {
                    log('[login-check] plugin query ' + channel)
                    pluginResponse(msgId, null)
                }
                return
            }
            finish('error', 'unexpected login packet 0x' + id.toString(16))
        }

        sock.on('connect', () => {
            connected = true
            send(0x00, Buffer.concat([varint(PROTOCOL), str(host + '\0FML3\0'),
                Buffer.from([(port >> 8) & 0xff, port & 0xff]), varint(2)]))
            send(0x00, Buffer.concat([str(name), Buffer.from([1]), loginUuid]))
        })
        sock.on('data', chunk => {
            buf = Buffer.concat([buf, chunk])
            try {
                for(;;){
                    const r = new Reader(buf)
                    let len
                    try { len = r.varint() } catch(_e) { return }
                    if(buf.length - r.o < len) return
                    let body = buf.subarray(r.o, r.o + len)
                    buf = buf.subarray(r.o + len)
                    if(threshold >= 0){
                        const br = new Reader(body)
                        const dataLen = br.varint()
                        body = dataLen > 0 ? zlib.inflateSync(br.rest()) : br.rest()
                    }
                    const pr = new Reader(body)
                    onPacket(pr.varint(), pr)
                    if(done) return
                }
            } catch(err) {
                finish('error', 'protocol: ' + err.message)
            }
        })
        sock.on('error', err => finish(connected ? 'error' : 'offline', err.code || err.message))
        sock.on('close', () => finish(connected ? 'error' : 'offline', 'connection closed'))
    })
}
