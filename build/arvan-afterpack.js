// Arvan: signAndEditExecutable is off (winCodeSign extraction needs symlink rights),
// so stamp the crest icon and product name into the packed exe here.
const path = require('path')
const rcedit = require('rcedit')

exports.default = async function(context){
    if(context.electronPlatformName !== 'win32') return
    const exe = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.exe')
    await rcedit(exe, {
        icon: path.join(__dirname, 'icon.ico'),
        'version-string': {
            ProductName: 'Arvan RPG',
            FileDescription: 'Arvan RPG Launcher',
            CompanyName: 'Arvan RPG',
            OriginalFilename: path.basename(exe)
        }
    })
}
