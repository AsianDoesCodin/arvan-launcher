const { DistributionAPI } = require('helios-core/common')

const ConfigManager = require('./configmanager')

// Old WesterosCraft url.
// exports.REMOTE_DISTRO_URL = 'http://mc.westeroscraft.com/WesterosCraftLauncher/distribution.json'
exports.REMOTE_DISTRO_URL = 'https://helios-files.geekcorner.eu.org/distribution.json'

const api = new DistributionAPI(
    ConfigManager.getLauncherDirectory(),
    null, // Injected forcefully by the preloader.
    null, // Injected forcefully by the preloader.
    exports.REMOTE_DISTRO_URL,
    false
)

// Arvan: no distribution host yet, so serve the distribution.json bundled in the app.
// To switch to a hosted file later, delete this override and set REMOTE_DISTRO_URL.
const { readBundledDistro } = require('./arvan')
const { RestResponseStatus } = require('helios-core/common')
api.pullRemote = async function(){
    return { data: readBundledDistro(), responseStatus: RestResponseStatus.SUCCESS }
}

exports.DistroAPI = api