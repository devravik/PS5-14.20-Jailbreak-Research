// p469-recovery.js — Safe recovery probe, no UAF, no crash risk
// Just beacon and auto-refresh to confirm PS5 browser is responsive
(function() {
    var RUN = 'p469-' + Date.now().toString(36);
    function B(tag, body) {
        try {
            var x = new XMLHttpRequest();
            x.open('POST', '/beacon/' + tag + '/' + RUN, false);
            x.send(typeof body === 'object' ? JSON.stringify(body) : String(body));
        } catch(e) {}
    }
    B('BOOT', navigator.userAgent);
    B('ALIVE', 'recovery-probe-ok');
    B('DONE', RUN);
})();
