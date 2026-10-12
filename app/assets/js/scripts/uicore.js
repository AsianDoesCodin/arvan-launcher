/**
 * Core UI functions are initialized in this file. This prevents
 * unexpected errors from breaking the core features. Specifically,
 * actions in this file should not require the usage of any internal
 * modules, excluding dependencies.
 */
// Requirements
const $                              = require('jquery')
const {ipcRenderer, shell, webFrame} = require('electron')
const remote                         = require('@electron/remote')
const isDev                          = require('./assets/js/isdev')
const { LoggerUtil }                 = require('helios-core')
const Lang                           = require('./assets/js/langloader')

const loggerUICore             = LoggerUtil.getLogger('UICore')
const loggerAutoUpdater        = LoggerUtil.getLogger('AutoUpdater')

// Log deprecation and process warnings.
process.traceProcessWarnings = true
process.traceDeprecation = true

// Disable eval function.
window.eval = global.eval = function () {
    throw new Error('Sorry, this app does not support window.eval().')
}

// Display warning when devtools window is opened.
remote.getCurrentWebContents().on('devtools-opened', () => {
    console.log('%cThe console is dark and full of terrors.', 'color: white; -webkit-text-stroke: 4px #a02d2a; font-size: 60px; font-weight: bold')
    console.log('%cIf you\'ve been told to paste something here, you\'re being scammed.', 'font-size: 16px')
    console.log('%cUnless you know exactly what you\'re doing, close this window.', 'font-size: 16px')
})

// Disable zoom, needed for darwin.
webFrame.setZoomLevel(0)
webFrame.setVisualZoomLevelLimits(1, 1)

// Arvan: Play is blocked while the launcher is outdated.
//   checking -> Play disabled, "Checking for updates…"
//   updating -> Play disabled, "Updating… N%", then silent install + restart
//   failed   -> Play disabled, "Update failed — Retry" + link to the latest release
//   latest / unreachable (GitHub offline or rate-limited) / dev build -> Play allowed
// A running game is never interrupted: the downloaded update installs when the launcher quits.
const ARVAN_RELEASES_URL = 'https://github.com/AsianDoesCodin/arvan-launcher/releases/latest'
const ARVAN_RECHECK_MS = 30 * 60 * 1000
const ARVAN_CHECK_TIMEOUT_MS = 20000
const arvanUpdate = { state: isDev ? 'latest' : 'checking', checkedAt: isDev ? Date.now() : 0, percent: 0, waiters: [], timer: null }

function arvanUpdateAllowsPlay(){
    return arvanUpdate.state === 'latest' || arvanUpdate.state === 'unreachable'
}

function arvanRenderUpdateState(){
    const btn = document.getElementById('launch_button')
    const note = document.getElementById('arvanUpdateNote')
    if(btn == null) return
    if(btn.dataset.arvanLabel == null) btn.dataset.arvanLabel = btn.innerHTML
    btn.classList.toggle('arvanUpdateRetry', arvanUpdate.state === 'failed')
    if(arvanUpdate.state === 'checking'){
        btn.innerHTML = 'Checking for updates…'
        btn.disabled = true
    } else if(arvanUpdate.state === 'updating'){
        btn.innerHTML = 'Updating… ' + Math.floor(arvanUpdate.percent) + '%'
        btn.disabled = true
    } else if(arvanUpdate.state === 'installing'){
        btn.innerHTML = 'Installing update…'
        btn.disabled = true
    } else if(arvanUpdate.state === 'failed'){
        btn.innerHTML = 'Update failed — Retry'
        btn.disabled = false // the click retries instead of launching
    } else {
        btn.innerHTML = btn.dataset.arvanLabel
        if(btn.dataset.arvanWasGated === '1'){
            btn.disabled = false
            btn.dataset.arvanWasGated = '0'
        }
    }
    if(arvanUpdate.state !== 'latest' && arvanUpdate.state !== 'unreachable') btn.dataset.arvanWasGated = '1'
    if(note != null){
        if(arvanUpdate.state === 'failed'){
            note.innerHTML = 'The launcher could not update itself. <a href="' + ARVAN_RELEASES_URL + '">Download the latest version</a>'
            note.style.display = 'block'
        } else if(arvanUpdate.state === 'ready-later'){
            note.textContent = 'A launcher update is ready and installs when you close the launcher.'
            note.style.display = 'block'
        } else {
            note.style.display = 'none'
        }
    }
}

function arvanSetUpdateState(state){
    arvanUpdate.state = state
    if(state !== 'checking' && arvanUpdate.timer){
        clearTimeout(arvanUpdate.timer)
        arvanUpdate.timer = null
    }
    if(state === 'latest' || state === 'unreachable' || state === 'failed' || state === 'ready-later'){
        arvanUpdate.checkedAt = Date.now()
        const ok = state !== 'failed'
        const waiters = arvanUpdate.waiters.splice(0)
        waiters.forEach(w => w(ok))
    }
    arvanRenderUpdateState()
}

function arvanStartUpdateCheck(){
    if(isDev) return
    arvanSetUpdateState('checking')
    arvanUpdate.timer = setTimeout(() => {
        // GitHub did not answer in time: do not lock players out.
        if(arvanUpdate.state === 'checking'){
            loggerAutoUpdater.warn('Update check timed out, allowing Play.')
            arvanSetUpdateState('unreachable')
        }
    }, ARVAN_CHECK_TIMEOUT_MS)
    ipcRenderer.send('autoUpdateAction', 'checkForUpdate')
}

/** Resolves true when Play may launch; re-checks first if the last check is older than 30 minutes. */
function arvanEnsureLatest(){
    if(isDev) return Promise.resolve(true) // dev builds never auto-update
    if(arvanUpdate.state === 'failed'){
        arvanStartUpdateCheck()
        return Promise.resolve(false)
    }
    if(arvanUpdateAllowsPlay() && Date.now() - arvanUpdate.checkedAt < ARVAN_RECHECK_MS) return Promise.resolve(true)
    if(arvanUpdate.state === 'ready-later'){
        // Downloaded while the game ran; the game is closed now, so install before playing.
        if(!arvanGameIsRunning()){
            arvanSetUpdateState('installing')
            ipcRenderer.send('autoUpdateAction', 'installUpdateNow')
        }
        return Promise.resolve(false)
    }
    return new Promise(resolve => {
        arvanUpdate.waiters.push(ok => resolve(ok && arvanUpdateAllowsPlay()))
        if(arvanUpdate.state !== 'checking' && arvanUpdate.state !== 'updating') arvanStartUpdateCheck()
    })
}

function arvanGameIsRunning(){
    try { return typeof arvanGameRunning === 'function' && arvanGameRunning() } catch(_e) { return false }
}

document.addEventListener('readystatechange', () => {
    if(document.readyState === 'interactive' || document.readyState === 'complete') arvanRenderUpdateState()
})

// Initialize auto updates in production environments.
let updateCheckListener
if(!isDev){
    ipcRenderer.on('autoUpdateNotification', (event, arg, info) => {
        switch(arg){
            case 'checking-for-update':
                loggerAutoUpdater.info('Checking for update..')
                settingsUpdateButtonStatus(Lang.queryJS('uicore.autoUpdate.checkingForUpdateButton'), true)
                break
            case 'download-progress':
                arvanUpdate.percent = info && info.percent ? info.percent : 0
                if(arvanUpdate.state === 'updating') arvanRenderUpdateState()
                break
            case 'update-available':
                loggerAutoUpdater.info('New update available', info.version)
                
                if(process.platform === 'darwin'){
                    info.darwindownload = `https://github.com/dscalzi/HeliosLauncher/releases/download/v${info.version}/Helios-Launcher-setup-${info.version}${process.arch === 'arm64' ? '-arm64' : '-x64'}.dmg`
                    showUpdateUI(info)
                }
                
                populateSettingsUpdateInformation(info)
                // Arvan: the download starts by itself (autoDownload); Play waits for it.
                arvanUpdate.percent = 0
                arvanSetUpdateState('updating')
                break
            case 'update-downloaded':
                loggerAutoUpdater.info('Update ' + info.version + ' ready to be installed.')
                settingsUpdateButtonStatus(Lang.queryJS('uicore.autoUpdate.installNowButton'), false, () => {
                    if(!isDev){
                        ipcRenderer.send('autoUpdateAction', 'installUpdateNow')
                    }
                })
                if(arvanGameIsRunning()){
                    // Never interrupt the game: install once it closes (or when the launcher quits).
                    loggerAutoUpdater.info('Game is running; the update installs after it closes.')
                    arvanSetUpdateState('ready-later')
                } else {
                    arvanSetUpdateState('installing')
                    setTimeout(() => ipcRenderer.send('autoUpdateAction', 'installUpdateNow'), 800)
                }
                break
            case 'update-not-available':
                loggerAutoUpdater.info('No new update found.')
                settingsUpdateButtonStatus(Lang.queryJS('uicore.autoUpdate.checkForUpdatesButton'))
                arvanSetUpdateState('latest')
                break
            case 'ready':
                updateCheckListener = setInterval(() => {
                    if(arvanUpdate.state === 'latest' || arvanUpdate.state === 'unreachable') arvanStartUpdateCheck()
                }, ARVAN_RECHECK_MS)
                arvanStartUpdateCheck()
                break
            case 'realerror':
                if(arvanUpdate.state === 'updating' || arvanUpdate.state === 'installing'){
                    loggerAutoUpdater.error('Launcher update failed.', info)
                    arvanSetUpdateState('failed')
                } else if(arvanUpdate.state === 'checking'){
                    // GitHub unreachable / rate-limited: let people play, the server still gates joins.
                    loggerAutoUpdater.warn('Update check could not reach GitHub, allowing Play.')
                    arvanSetUpdateState('unreachable')
                }
                if(info != null && info.code != null){
                    if(info.code === 'ERR_UPDATER_INVALID_RELEASE_FEED'){
                        loggerAutoUpdater.info('No suitable releases found.')
                    } else if(info.code === 'ERR_XML_MISSED_ELEMENT'){
                        loggerAutoUpdater.info('No releases found.')
                    } else {
                        loggerAutoUpdater.error('Error during update check..', info)
                        loggerAutoUpdater.debug('Error Code:', info.code)
                    }
                }
                break
            default:
                loggerAutoUpdater.info('Unknown argument', arg)
                break
        }
    })
}

/**
 * Send a notification to the main process changing the value of
 * allowPrerelease. If we are running a prerelease version, then
 * this will always be set to true, regardless of the current value
 * of val.
 * 
 * @param {boolean} val The new allow prerelease value.
 */
function changeAllowPrerelease(val){
    ipcRenderer.send('autoUpdateAction', 'allowPrereleaseChange', val)
}

function showUpdateUI(info){
    //TODO Make this message a bit more informative `${info.version}`
    document.getElementById('image_seal_container').setAttribute('update', true)
    document.getElementById('image_seal_container').onclick = () => {
        /*setOverlayContent('Update Available', 'A new update for the launcher is available. Would you like to install now?', 'Install', 'Later')
        setOverlayHandler(() => {
            if(!isDev){
                ipcRenderer.send('autoUpdateAction', 'installUpdateNow')
            } else {
                console.error('Cannot install updates in development environment.')
                toggleOverlay(false)
            }
        })
        setDismissHandler(() => {
            toggleOverlay(false)
        })
        toggleOverlay(true, true)*/
        switchView(getCurrentView(), VIEWS.settings, 500, 500, () => {
            settingsNavItemListener(document.getElementById('settingsNavUpdate'), false)
        })
    }
}

/* jQuery Example
$(function(){
    loggerUICore.info('UICore Initialized');
})*/

document.addEventListener('readystatechange', function () {
    if (document.readyState === 'interactive'){
        loggerUICore.info('UICore Initializing..')

        // Bind close button.
        Array.from(document.getElementsByClassName('fCb')).map((val) => {
            val.addEventListener('click', e => {
                const window = remote.getCurrentWindow()
                window.close()
            })
        })

        // Bind restore down button.
        Array.from(document.getElementsByClassName('fRb')).map((val) => {
            val.addEventListener('click', e => {
                const window = remote.getCurrentWindow()
                if(window.isMaximized()){
                    window.unmaximize()
                } else {
                    window.maximize()
                }
                document.activeElement.blur()
            })
        })

        // Bind minimize button.
        Array.from(document.getElementsByClassName('fMb')).map((val) => {
            val.addEventListener('click', e => {
                const window = remote.getCurrentWindow()
                window.minimize()
                document.activeElement.blur()
            })
        })

        // Remove focus from social media buttons once they're clicked.
        Array.from(document.getElementsByClassName('mediaURL')).map(val => {
            val.addEventListener('click', e => {
                document.activeElement.blur()
            })
        })

    } else if(document.readyState === 'complete'){

        //266.01
        //170.8
        //53.21
        // Bind progress bar length to length of bot wrapper
        //const targetWidth = document.getElementById("launch_content").getBoundingClientRect().width
        //const targetWidth2 = document.getElementById("server_selection").getBoundingClientRect().width
        //const targetWidth3 = document.getElementById("launch_button").getBoundingClientRect().width

        document.getElementById('launch_details').style.maxWidth = 266.01
        document.getElementById('launch_progress').style.width = 170.8
        document.getElementById('launch_details_right').style.maxWidth = 170.8
        document.getElementById('launch_progress_label').style.width = 53.21
        
    }

}, false)

/**
 * Open web links in the user's default browser.
 */
$(document).on('click', 'a[href^="http"]', function(event) {
    event.preventDefault()
    shell.openExternal(this.href)
})

/**
 * Opens DevTools window if you hold (ctrl + shift + i).
 * This will crash the program if you are using multiple
 * DevTools, for example the chrome debugger in VS Code. 
 */
document.addEventListener('keydown', function (e) {
    if((e.key === 'I' || e.key === 'i') && e.ctrlKey && e.shiftKey){
        let window = remote.getCurrentWindow()
        window.toggleDevTools()
    }
})