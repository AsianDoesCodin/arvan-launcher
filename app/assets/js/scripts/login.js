/**
 * Script for login.ejs
 */
// Validation Regexes.
const validUsername         = /^[a-zA-Z0-9_]{3,16}$/ // Arvan: offline name rule
const basicEmail            = /^\S+@\S+\.\S+$/
//const validEmail          = /^(([^<>()\[\]\.,;:\s@\"]+(\.[^<>()\[\]\.,;:\s@\"]+)*)|(\".+\"))@(([^<>()[\]\.,;:\s@\"]+\.)+[^<>()[\]\.,;:\s@\"]{2,})$/i

// Login Elements
const loginCancelContainer  = document.getElementById('loginCancelContainer')
const loginCancelButton     = document.getElementById('loginCancelButton')
const loginEmailError       = document.getElementById('loginEmailError')
const loginUsername         = document.getElementById('loginUsername')
const loginPasswordError    = document.getElementById('loginPasswordError')
const loginPassword         = document.getElementById('loginPassword')
const checkmarkContainer    = document.getElementById('checkmarkContainer')
const loginRememberOption   = document.getElementById('loginRememberOption')
const loginButton           = document.getElementById('loginButton')
const loginForm             = document.getElementById('loginForm')
// Arvan: password login elements.
const arvanPasswordConfirm  = document.getElementById('arvanPasswordConfirm')
const arvanConfirmError     = document.getElementById('arvanConfirmError')
const arvanConfirmContainer = document.getElementById('arvanConfirmContainer')
const arvanLoginMessage     = document.getElementById('arvanLoginMessage')
const ARVAN_PW_MIN          = 8

// Control variables.
let lu = false, lp = false
let arvanMode = 'create' // Arvan: 'create' (name, password, confirm) or 'login' (name, password)

/**
 * Arvan: show a message above the form (empty string hides it).
 * Optional action = { label, onClick } adds a one-click button under the text.
 */
function arvanSetLoginMessage(text, action){
    arvanLoginMessage.textContent = text || ''
    if(text && action){
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'arvanLoginMessageAction'
        b.textContent = action.label
        b.onclick = (e) => { e.preventDefault(); action.onClick() }
        arvanLoginMessage.appendChild(b)
    }
    arvanLoginMessage.style.display = text ? 'block' : 'none'
}

/** Arvan: minimum password length for the current mode. Existing accounts may predate the 8-character rule. */
function arvanPwMin(){
    return arvanMode === 'create' ? ARVAN_PW_MIN : 1
}

/** Arvan: confirm field must match in create mode. */
function arvanConfirmOk(){
    if(arvanMode !== 'create') return true
    return arvanPasswordConfirm.value === loginPassword.value
}

function arvanRefreshButton(){
    if(arvanMode === 'create' && arvanPasswordConfirm.value.length > 0 && !arvanConfirmOk()){
        showError(arvanConfirmError, '* Passwords do not match')
    } else {
        arvanConfirmError.style.opacity = 0
    }
    loginDisabled(!(lu && lp && arvanConfirmOk() && (arvanMode !== 'create' || arvanPasswordConfirm.value.length > 0)))
}

function arvanSetMode(mode){
    arvanMode = mode
    document.getElementById('arvanModeCreate').classList.toggle('active', mode === 'create')
    document.getElementById('arvanModeLogin').classList.toggle('active', mode === 'login')
    arvanConfirmContainer.style.display = mode === 'create' ? '' : 'none'
    if(mode !== 'create') arvanPasswordConfirm.value = ''
    if(loginPassword.value) validatePassword(loginPassword.value)
    arvanRefreshButton()
}
document.getElementById('arvanModeCreate').onclick = () => arvanSetMode('create')
document.getElementById('arvanModeLogin').onclick = () => arvanSetMode('login')

/**
 * Arvan: open the login screen (used by Play when no password is stored, by logout,
 * and after a failed server check). Prefills the name, never the failed password.
 */
function arvanOpenLogin(name, message, mode = 'login'){
    loginViewOnSuccess = VIEWS.landing
    loginCancelEnabled(false)
    loginUsername.value = name || ''
    loginPassword.value = ''
    arvanPasswordConfirm.value = ''
    lp = false
    if(name) validateEmail(name)
    arvanSetMode(mode)
    arvanSetLoginMessage(message)
    if(getCurrentView() !== VIEWS.login){
        switchView(getCurrentView(), VIEWS.login, 500, 500)
    }
}


/**
 * Show a login error.
 * 
 * @param {HTMLElement} element The element on which to display the error.
 * @param {string} value The error text.
 */
function showError(element, value){
    element.innerHTML = value
    element.style.opacity = 1
}

/**
 * Shake a login error to add emphasis.
 * 
 * @param {HTMLElement} element The element to shake.
 */
function shakeError(element){
    if(element.style.opacity == 1){
        element.classList.remove('shake')
        void element.offsetWidth
        element.classList.add('shake')
    }
}

/**
 * Validate that an email field is neither empty nor invalid.
 * 
 * @param {string} value The email value.
 */
function validateEmail(value){
    if(value){
        if(!validUsername.test(value)){
            showError(loginEmailError, Lang.queryJS('login.error.invalidValue'))
            loginDisabled(true)
            lu = false
        } else {
            loginEmailError.style.opacity = 0
            lu = true
            arvanRefreshButton()
        }
    } else {
        lu = false
        showError(loginEmailError, Lang.queryJS('login.error.requiredValue'))
        loginDisabled(true)
    }
}

/**
 * Validate that the password field is not empty.
 * 
 * @param {string} value The password value.
 */
function validatePassword(value){
    if(value && value.length >= arvanPwMin()){
        loginPasswordError.style.opacity = 0
        lp = true
        arvanRefreshButton()
    } else {
        lp = false
        showError(loginPasswordError, value ? '* At least ' + arvanPwMin() + ' characters' : Lang.queryJS('login.error.requiredValue'))
        loginDisabled(true)
    }
}

// Emphasize errors with shake when focus is lost.
loginUsername.addEventListener('focusout', (e) => {
    validateEmail(e.target.value)
    shakeError(loginEmailError)
})
loginPassword.addEventListener('focusout', (e) => {
    validatePassword(e.target.value)
    shakeError(loginPasswordError)
})

// Validate input for each field.
loginUsername.addEventListener('input', (e) => {
    validateEmail(e.target.value)
})
loginPassword.addEventListener('input', (e) => {
    validatePassword(e.target.value)
})
arvanPasswordConfirm.addEventListener('input', () => {
    arvanRefreshButton()
})
// Arvan: Enter submits.
for(const el of [loginUsername, loginPassword, arvanPasswordConfirm]){
    el.addEventListener('keydown', (e) => { if(e.key === 'Enter' && !loginButton.disabled) loginButton.click() })
}

/**
 * Enable or disable the login button.
 * 
 * @param {boolean} v True to enable, false to disable.
 */
function loginDisabled(v){
    if(loginButton.disabled !== v){
        loginButton.disabled = v
    }
}

/**
 * Enable or disable loading elements.
 * 
 * @param {boolean} v True to enable, false to disable.
 */
function loginLoading(v){
    if(v){
        loginButton.setAttribute('loading', v)
        loginButton.innerHTML = loginButton.innerHTML.replace(Lang.queryJS('login.login'), Lang.queryJS('login.loggingIn'))
    } else {
        loginButton.removeAttribute('loading')
        loginButton.innerHTML = loginButton.innerHTML.replace(Lang.queryJS('login.loggingIn'), Lang.queryJS('login.login'))
    }
}

/**
 * Enable or disable login form.
 * 
 * @param {boolean} v True to enable, false to disable.
 */
function formDisabled(v){
    loginDisabled(v)
    loginCancelButton.disabled = v
    loginUsername.disabled = v
    loginPassword.disabled = v
    arvanPasswordConfirm.disabled = v
    if(v){
        checkmarkContainer.setAttribute('disabled', v)
    } else {
        checkmarkContainer.removeAttribute('disabled')
    }
    loginRememberOption.disabled = v
}

let loginViewOnSuccess = VIEWS.landing
let loginViewOnCancel = VIEWS.settings
let loginViewCancelHandler

function loginCancelEnabled(val){
    if(val){
        $(loginCancelContainer).show()
    } else {
        $(loginCancelContainer).hide()
    }
}

loginCancelButton.onclick = (e) => {
    switchView(getCurrentView(), loginViewOnCancel, 500, 500, () => {
        loginUsername.value = ''
        loginPassword.value = ''
        arvanPasswordConfirm.value = ''
        loginCancelEnabled(false)
        if(loginViewCancelHandler != null){
            loginViewCancelHandler()
            loginViewCancelHandler = null
        }
    })
}

// Disable default form behavior.
loginForm.onsubmit = () => { return false }

// Bind login button behavior.
loginButton.addEventListener('click', () => {
    if(!arvanConfirmOk()){
        arvanRefreshButton()
        return
    }
    arvanSetLoginMessage('')
    // Disable form.
    formDisabled(true)

    // Show loading stuff.
    loginLoading(true)

    // Arvan: one server check per click (the form stays disabled while it runs).
    const arvanName = loginUsername.value
    const arvanMode0 = arvanMode
    const Arvan = require('./assets/js/arvan')
    const arvanGameDir = path.join(ConfigManager.getInstanceDirectory(), ConfigManager.getSelectedServer() || 'arvan')
    Arvan.checkAccount(arvanGameDir, arvanName, loginPassword.value, arvanMode0, msftLoginLogger).then((check) => {
        const problem = Arvan.accountCheckMessage(check, arvanMode0)
        if(problem){
            msftLoginLogger.info('Account check for ' + arvanName + ': ' + check.result)
            loginLoading(false)
            formDisabled(false)
            if(arvanMode0 === 'create' && check.result === 'name_taken'){
                // The name already has a password (set in game or earlier): one click to the login tab, name kept.
                arvanSetLoginMessage(problem, { label: 'Switch to "I have an account"', onClick: () => {
                    arvanOpenLogin(arvanName, '', 'login')
                    loginPassword.focus()
                } })
                return
            }
            arvanSetLoginMessage(problem)
            if(check.result === 'wrong_password'){
                loginPassword.value = ''
                arvanPasswordConfirm.value = ''
                lp = false
                loginDisabled(true)
                loginPassword.focus()
            }
            return
        }
        return arvanSaveAccount()
    }).catch((err) => {
        msftLoginLogger.error('Account check failed.', err && err.message)
        loginLoading(false)
        formDisabled(false)
        arvanSetLoginMessage(Arvan.accountCheckMessage({ result: 'error' }, arvanMode0))
    })
})

/** Arvan: store the checked account and continue (the original Helios success flow). */
function arvanSaveAccount(){
    return AuthManager.addMojangAccount(loginUsername.value, loginPassword.value).then((value) => {
        try { localStorage.setItem('arvanLastName', value.displayName) } catch(_e) { /* ignore */ }
        updateSelectedAccount(value)
        loginButton.innerHTML = loginButton.innerHTML.replace(Lang.queryJS('login.loggingIn'), Lang.queryJS('login.success'))
        $('.circle-loader').toggleClass('load-complete')
        $('.checkmark').toggle()
        setTimeout(() => {
            switchView(VIEWS.login, loginViewOnSuccess, 500, 500, async () => {
                // Temporary workaround
                if(loginViewOnSuccess === VIEWS.settings){
                    await prepareSettings()
                }
                loginViewOnSuccess = VIEWS.landing // Reset this for good measure.
                loginCancelEnabled(false) // Reset this for good measure.
                loginViewCancelHandler = null // Reset this for good measure.
                loginUsername.value = ''
                loginPassword.value = ''
                arvanPasswordConfirm.value = ''
                $('.circle-loader').toggleClass('load-complete')
                $('.checkmark').toggle()
                loginLoading(false)
                loginButton.innerHTML = loginButton.innerHTML.replace(Lang.queryJS('login.success'), Lang.queryJS('login.login'))
                formDisabled(false)
            })
        }, 1000)
    }).catch((displayableError) => {
        loginLoading(false)

        let actualDisplayableError
        if(isDisplayableError(displayableError)) {
            msftLoginLogger.error('Error while logging in.', displayableError)
            actualDisplayableError = displayableError
        } else {
            // Uh oh.
            msftLoginLogger.error('Unhandled error during login.', displayableError)
            actualDisplayableError = Lang.queryJS('login.error.unknown')
        }

        setOverlayContent(actualDisplayableError.title, actualDisplayableError.desc, Lang.queryJS('login.tryAgain'))
        setOverlayHandler(() => {
            formDisabled(false)
            toggleOverlay(false)
        })
        toggleOverlay(true)
    })
}

// Arvan: remember the last name; returning players start in 'I have an account' mode.
arvanSetLoginMessage('')
try {
    const last = localStorage.getItem('arvanLastName')
    if(last){
        loginUsername.value = last
        validateEmail(last)
        arvanSetMode('login')
    } else {
        arvanSetMode('create')
    }
} catch(_e) { arvanSetMode('create') }
