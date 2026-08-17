/**
 * Nexus Autopilot — Client Renderer Injection Script
 *
 * Responsibilities:
 * 1. Suppress "corrupt installation" banners automatically
 * 2. Discover dynamic HTTP micro-server port (48787-48850)
 * 3. Smart Auto-Click for approval buttons (Run, Allow, Accept in chat only)
 * 4. Diff Editor protection (Never clicks Accept/Reject in diff editor)
 * 5. Smart Auto-Scroll for Antigravity chat panel with stick-to-bottom logic
 * 6. Send live click telemetry back to Extension Host
 */
(function () {
    // --- Guard: prevent double execution (workbench.js + HTML script tag) ---
    if (window._nexusAutoLoaded || window._agAutoLoaded) return;
    window._nexusAutoLoaded = true;
    window._agAutoLoaded = true;

    // --- Cleanup previous intervals and event listeners if any ---
    if (window._nexusToolIntervals) {
        window._nexusToolIntervals.forEach(clearInterval);
        if (window._nexusScrollListener) {
            window.removeEventListener('scroll', window._nexusScrollListener, true);
        }
    }
    if (window._agToolIntervals) {
        window._agToolIntervals.forEach(clearInterval);
        if (window._agScrollListener) {
            window.removeEventListener('scroll', window._agScrollListener, true);
        }
    }
    window._nexusToolIntervals = [];
    window._agToolIntervals = window._nexusToolIntervals;

    // --- 1. Auto-dismiss "corrupt installation" notification ---
    (function suppressCorruptBanner() {
        function dismissCorrupt() {
            var banners = document.querySelectorAll('.notifications-toasts .notification-toast, .notification-list-item');
            banners.forEach(function (b) {
                var text = (b.textContent || '').toLowerCase();
                if (text.indexOf('corrupt') !== -1 || text.indexOf('reinstall') !== -1) {
                    var closeBtn = b.querySelector('.codicon-notifications-clear, .codicon-close, .action-label[aria-label*="Close"], .action-label[aria-label*="clear"], .clear-notification-action');
                    if (closeBtn) {
                        closeBtn.click();
                        console.log('[Nexus Autopilot] 🧹 ปิดการแจ้งเตือน Corrupt อัตโนมัติ');
                    } else {
                        b.style.display = 'none';
                        console.log('[Nexus Autopilot] 🧹 ซ่อนการแจ้งเตือน Corrupt');
                    }
                }
            });
        }
        dismissCorrupt();
        var attempts = 0;
        var timer = setInterval(function () {
            dismissCorrupt();
            if (++attempts > 30) clearInterval(timer);
        }, 1000);
        try {
            var observer = new MutationObserver(function () { dismissCorrupt(); });
            var target = document.body || document.documentElement;
            observer.observe(target, { childList: true, subtree: true });
            setTimeout(function () { observer.disconnect(); }, 30000);
        } catch (_) { }
    })();

    // Default configuration tokens
    var PAUSE_SCROLL_MS = /*{{PAUSE_SCROLL_MS}}*/7000;
    var CLICK_INTERVAL_MS = /*{{CLICK_INTERVAL_MS}}*/1000;
    var SCROLL_INTERVAL_MS = /*{{SCROLL_INTERVAL_MS}}*/500;
    var CLICK_PATTERNS = /*{{CLICK_PATTERNS}}*/["Allow", "Always Allow", "Run", "Keep Waiting", "Accept all"];
    
    // Accept is handled separately (chat-only) — never mixed into general patterns
    window._nexusAcceptChatOnly = true;
    window._agAcceptChatOnly = window._nexusAcceptChatOnly;

    // Master live toggles
    window._nexusAutoEnabled = /*{{ENABLED}}*/true;
    window._agAutoEnabled = window._nexusAutoEnabled;
    window._nexusScrollEnabled = true;
    window._agScrollEnabled = window._nexusScrollEnabled;

    // --- Dynamic Port Discovery ---
    var HTTP_PORT_START = 48787;
    var HTTP_PORT_END = 48850;
    var CURRENT_HTTP_PORT = 0;
    var _pollCount = 0;
    var _pollErrors = 0;
    var _portScanning = false;
    var _sessionStats = {};
    var _sessionTotal = 0;

    function discoverPort(callback) {
        if (_portScanning) return;
        _portScanning = true;
        var found = false;
        var pending = 0;

        function tryBatch(from) {
            if (from > HTTP_PORT_END || found) {
                if (!found) {
                    _portScanning = false;
                    console.log('[Nexus Autopilot] ไม่พบเซิร์ฟเวอร์ในช่วงพอร์ต ' + HTTP_PORT_START + '-' + HTTP_PORT_END);
                }
                return;
            }
            var batchEnd = Math.min(from + 7, HTTP_PORT_END);
            pending = 0;
            for (var p = from; p <= batchEnd; p++) {
                (function (port) {
                    pending++;
                    var xhr = new XMLHttpRequest();
                    xhr.open('GET', 'http://127.0.0.1:' + port + '/ag-status?t=' + Date.now(), true);
                    xhr.timeout = 800;
                    xhr.onload = function () {
                        if (found) return;
                        if (xhr.status === 200) {
                            try {
                                var cfg = JSON.parse(xhr.responseText);
                                if (typeof cfg.enabled === 'boolean') {
                                    found = true;
                                    CURRENT_HTTP_PORT = port;
                                    _portScanning = false;
                                    console.log('[Nexus Autopilot] ✅ เชื่อมต่อเซิร์ฟเวอร์สำเร็จที่พอร์ต ' + port);
                                    if (callback) callback(port, cfg);
                                }
                            } catch (_) { }
                        }
                        pending--;
                        if (pending <= 0 && !found) tryBatch(batchEnd + 1);
                    };
                    xhr.onerror = function () { pending--; if (pending <= 0 && !found) tryBatch(batchEnd + 1); };
                    xhr.ontimeout = function () { pending--; if (pending <= 0 && !found) tryBatch(batchEnd + 1); };
                    xhr.send();
                })(p);
            }
        }
        tryBatch(HTTP_PORT_START);
    }

    function applyConfig(cfg) {
        if (typeof cfg.enabled === 'boolean') {
            if (window._nexusAutoEnabled !== cfg.enabled) {
                console.log('[Nexus Autopilot] ' + (cfg.enabled ? '✅ เปิดทำงาน (ON)' : '❌ ปิดทำงาน (OFF)'));
            }
            window._nexusAutoEnabled = cfg.enabled;
            window._agAutoEnabled = cfg.enabled;
        }
        if (typeof cfg.scrollEnabled === 'boolean') {
            window._nexusScrollEnabled = cfg.scrollEnabled;
            window._agScrollEnabled = cfg.scrollEnabled;
        }
        if (cfg.clickPatterns && Array.isArray(cfg.clickPatterns)) {
            CLICK_PATTERNS = cfg.clickPatterns.filter(function (p) { return p !== 'Accept'; });
        }
        if (typeof cfg.acceptInChatOnly === 'boolean') {
            window._nexusAcceptChatOnly = cfg.acceptInChatOnly;
            window._agAcceptChatOnly = cfg.acceptInChatOnly;
        }
        if (cfg.pauseScrollMs) PAUSE_SCROLL_MS = cfg.pauseScrollMs;
        if (cfg.scrollIntervalMs) SCROLL_INTERVAL_MS = cfg.scrollIntervalMs;
        if (cfg.clickIntervalMs) CLICK_INTERVAL_MS = cfg.clickIntervalMs;
        if (cfg.clickStats) {
            window._nexusClickStats = cfg.clickStats;
            window._agClickStats = cfg.clickStats;
        }
        if (typeof cfg.totalClicks === 'number') {
            window._nexusTotalClicks = cfg.totalClicks;
            window._agTotalClicks = cfg.totalClicks;
        }
        if (cfg.resetStats) {
            window._nexusClickStats = {};
            window._agClickStats = {};
            window._nexusTotalClicks = 0;
            window._agTotalClicks = 0;
            _sessionStats = {};
            _sessionTotal = 0;
            console.log('[Nexus Autopilot] 🔄 รีเซ็ตสถิติเรียบร้อย');
        }
    }

    // Initial port discovery
    discoverPort(function (port, cfg) {
        applyConfig(cfg);
        _pollErrors = 0;
    });

    // Configuration polling & stats sync loop
    var configReload = setInterval(function () {
        _pollCount++;
        if (CURRENT_HTTP_PORT === 0) {
            if (_pollCount % 5 === 0) {
                discoverPort(function (port, cfg) { applyConfig(cfg); _pollErrors = 0; });
            }
            return;
        }
        if (_pollErrors > 3) {
            CURRENT_HTTP_PORT = 0;
            _pollErrors = 0;
            discoverPort(function (port, cfg) { applyConfig(cfg); });
            return;
        }
        try {
            var xhr = new XMLHttpRequest();
            var statsParam = '';
            if (_sessionTotal > 0) {
                statsParam = '&total=' + _sessionTotal + '&stats=' + encodeURIComponent(JSON.stringify(_sessionStats));
                _sessionStats = {};
                _sessionTotal = 0;
            }
            xhr.open('GET', 'http://127.0.0.1:' + CURRENT_HTTP_PORT + '/ag-status?t=' + Date.now() + statsParam, true);
            xhr.timeout = 1500;
            xhr.onload = function () {
                if (xhr.status === 200) {
                    _pollErrors = 0;
                    var cfg = JSON.parse(xhr.responseText);
                    applyConfig(cfg);
                }
            };
            xhr.onerror = function () { _pollErrors++; };
            xhr.ontimeout = function () { _pollErrors++; };
            xhr.send();
        } catch (_) {
            _pollErrors++;
        }
    }, 2000);
    window._nexusToolIntervals.push(configReload);

    var lastManualScrollTime = 0;
    var isAutoScrolling = false;

    // Words indicating a rejection/cancellation sibling button
    var REJECT_WORDS = ['Reject', 'Deny', 'Cancel', 'Dismiss', "Don't Allow", 'Decline', 'Skip', 'skip', 'No', 'Close'];

    function isApprovalButton(btn) {
        var parent = btn.parentElement;
        if (!parent) return false;

        // Check if button is inside a dialog/modal container
        if (btn.closest && (
            btn.closest('[role="dialog"]') ||
            btn.closest('.monaco-dialog-box') ||
            btn.closest('[class*="dialog"]') ||
            btn.closest('[class*="modal"]') ||
            btn.closest('[class*="popup"]')
        )) {
            return true;
        }

        // Check if button has primary action button styling
        if (btn.classList && (
            btn.classList.contains('bg-primary') ||
            btn.classList.contains('btn-primary') ||
            btn.classList.contains('monaco-text-button') ||
            Array.from(btn.classList).some(function (c) { return c.indexOf('bg-blue') !== -1 || c.indexOf('bg-sky') !== -1 || c.indexOf('bg-primary') !== -1; })
        )) {
            return true;
        }

        for (var level = 0; level < 4; level++) {
            if (!parent) break;
            var siblingBtns = parent.querySelectorAll('button, a.action-label, [role="button"], .monaco-button, span.bg-ide-button-background, div.cursor-pointer, span.cursor-pointer');
            for (var i = 0; i < siblingBtns.length; i++) {
                var sib = siblingBtns[i];
                if (sib === btn) continue;
                var sibText = (sib.innerText || sib.textContent || '').trim().toLowerCase();
                for (var j = 0; j < REJECT_WORDS.length; j++) {
                    var rWord = REJECT_WORDS[j].toLowerCase();
                    if (sibText === rWord || sibText.indexOf(rWord) === 0 || sibText.startsWith(rWord)) {
                        return true;
                    }
                }
            }
            parent = parent.parentElement;
        }
        return false;
    }

    function matchesPatternText(btnText, pattern) {
        if (!btnText || !pattern) return false;
        var normBtn = btnText.toLowerCase().replace(/[\r\n\t↵\s]+/g, ' ').trim();
        var normPat = pattern.toLowerCase().trim();
        if (normBtn === normPat) return true;
        if (normBtn.indexOf(normPat) !== -1) return true;
        return false;
    }

    var EDITOR_SKIP_WORDS = ['Accept Changes', 'Accept All', 'Accept Incoming', 'Accept Current', 'Accept Both', 'Accept Combination'];
    var _clicked = new WeakSet();

    if (!window._nexusClickStats) window._nexusClickStats = {};
    if (!window._nexusTotalClicks) window._nexusTotalClicks = 0;
    window._agClickStats = window._nexusClickStats;
    window._agTotalClicks = window._nexusTotalClicks;

    // Recursive document collector across iframes and shadow DOMs
    function getAllDocuments() {
        var docs = [document];
        function collectFromDoc(d) {
            if (!d) return;
            try {
                var iframes = d.querySelectorAll('iframe');
                for (var i = 0; i < iframes.length; i++) {
                    try {
                        var fDoc = iframes[i].contentDocument || iframes[i].contentWindow?.document;
                        if (fDoc && docs.indexOf(fDoc) === -1) {
                            docs.push(fDoc);
                            collectFromDoc(fDoc);
                        }
                    } catch (_) { }
                }
            } catch (_) { }
        }
        collectFromDoc(document);
        return docs;
    }

    function getAllClickables() {
        var docs = getAllDocuments();
        var all = [];
        var selector = 'button, a.action-label, [role="button"], .monaco-button, span.cursor-pointer, div.cursor-pointer, [class*="bg-primary"], [class*="bg-ide-button"], .monaco-text-button, [class*="button"], [class*="btn"]';

        docs.forEach(function (doc) {
            try {
                var list = Array.from(doc.querySelectorAll(selector));
                doc.querySelectorAll('*').forEach(function (el) {
                    if (el.shadowRoot) {
                        try {
                            var sList = Array.from(el.shadowRoot.querySelectorAll(selector));
                            list = list.concat(sList);
                        } catch (_) { }
                    }
                });
                all = all.concat(list);
            } catch (_) { }
        });
        return all;
    }

    function triggerClick(el) {
        try {
            if (el.focus) el.focus();
            var view = el.ownerDocument ? el.ownerDocument.defaultView || window : window;
            var peDown = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: view });
            var meDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: view });
            var peUp = new PointerEvent('pointerup', { bubbles: true, cancelable: true, view: view });
            var meUp = new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: view });
            el.dispatchEvent(peDown);
            el.dispatchEvent(meDown);
            el.dispatchEvent(peUp);
            el.dispatchEvent(meUp);
            el.click();
        } catch (_) {
            try { el.click(); } catch (_) { }
        }
    }

    function extractActionContext(btn) {
        var commandDetails = '';
        var selectedOption = '';
        try {
            var doc = btn.ownerDocument || document;
            var modal = null;
            if (btn.closest) {
                modal = btn.closest('.monaco-dialog-box, [role="dialog"], .modal, .quick-input-widget, .interactive-input, .dialog-box, .antigravity-agent-side-panel, [class*="dialog"], [class*="modal"], [class*="card"]');
            }
            if (!modal) {
                modal = btn.parentElement ? (btn.parentElement.parentElement ? btn.parentElement.parentElement.parentElement : btn.parentElement) : null;
            }

            if (modal) {
                // 1. Look for selected choice / radio / active option in modal
                var checkedOption = modal.querySelector('input[type="radio"]:checked, [aria-checked="true"], [class*="selected"], [class*="active"]');
                if (checkedOption) {
                    var optLabel = (checkedOption.closest && checkedOption.closest('label')) || checkedOption.parentElement;
                    if (optLabel) {
                        selectedOption = (optLabel.innerText || optLabel.textContent || '').trim().replace(/\s+/g, ' ');
                    }
                }

                // 2. Look for code/command block
                var codeEl = modal.querySelector('code, pre, .monaco-code-block, [class*="code"], [class*="terminal"], [class*="command"]');
                if (codeEl) {
                    commandDetails = (codeEl.innerText || codeEl.textContent || '').trim().replace(/\s+/g, ' ');
                }

                // 3. Look for header / question prompt
                if (!commandDetails) {
                    var titleEl = modal.querySelector('h1, h2, h3, h4, .dialog-message, .message, [class*="title"], [class*="header"], [class*="prompt"]');
                    if (titleEl) {
                        commandDetails = (titleEl.innerText || titleEl.textContent || '').trim().replace(/\s+/g, ' ');
                    }
                }
            }

            if (!commandDetails && btn.parentElement) {
                var pText = (btn.parentElement.innerText || btn.parentElement.textContent || '').trim().replace(/\s+/g, ' ');
                var bText = (btn.innerText || btn.textContent || '').trim();
                if (pText.length > 5 && pText.length < 150) {
                    commandDetails = pText.replace(bText, '').trim();
                }
            }
        } catch (_) { }

        return {
            command: commandDetails ? commandDetails.substring(0, 160) : '',
            selectedChoice: selectedOption ? selectedOption.substring(0, 80) : ''
        };
    }

    // --- 2. AUTO CLICK ENGINE ---
    var autoClick = setInterval(function () {
        if (!window._nexusAutoEnabled) return;

        var clickables = getAllClickables();
        var targetBtn = null;
        var matchedPattern = '';

        for (var i = 0; i < clickables.length; i++) {
            var b = clickables[i];
            if (b.offsetParent === null && b.offsetWidth === 0 && b.offsetHeight === 0) continue;
            if (_clicked.has(b)) continue;

            var text = (b.innerText || b.textContent || '').trim();
            if (!text || text.length > 50) continue;

            // Skip diff/merge editor buttons
            var skipEditor = false;
            for (var se = 0; se < EDITOR_SKIP_WORDS.length; se++) {
                if (text.indexOf(EDITOR_SKIP_WORDS[se]) === 0) { skipEditor = true; break; }
            }
            if (skipEditor) continue;

            // Skip buttons inside editor areas
            if (b.closest && (
                b.closest('.monaco-diff-editor') || b.closest('.merge-editor-view') ||
                b.closest('.inline-merge-region') || b.closest('.merged-editor') ||
                b.closest('.view-zones') || b.closest('.view-lines') ||
                b.closest('[id*="workbench.parts.editor"]')
            )) continue;

            // Skip diff hunk buttons
            if (b.classList && (b.classList.contains('diff-hunk-button') || b.classList.contains('accept') || b.classList.contains('revert'))) {
                var editorAncestor = b.closest && b.closest('[class*="editor"], [id*="editor"]');
                if (editorAncestor) continue;
            }

            var matchesPattern = false;
            for (var p = 0; p < CLICK_PATTERNS.length; p++) {
                var pat = CLICK_PATTERNS[p];
                if (matchesPatternText(text, pat)) {
                    matchesPattern = true;
                    matchedPattern = pat;
                    break;
                }
            }
            if (!matchesPattern) continue;

            if (b.tagName === 'SPAN' && b.classList.contains('cursor-pointer')) {
                targetBtn = b;
                break;
            }

            if (isApprovalButton(b) || matchedPattern.toLowerCase() === 'submit' || matchedPattern.toLowerCase() === 'run' || matchedPattern.toLowerCase() === 'allow') {
                targetBtn = b;
                break;
            }
        }

        // --- Separate Accept handling (chat-only) ---
        if (!targetBtn && window._nexusAcceptChatOnly) {
            for (var ai = 0; ai < clickables.length; ai++) {
                var ab = clickables[ai];
                if (ab.offsetParent === null && ab.offsetWidth === 0 && ab.offsetHeight === 0) continue;
                if (_clicked.has(ab)) continue;
                var aText = (ab.innerText || ab.textContent || '').trim();

                if (aText.indexOf('Accept') !== 0) continue;
                if (/^Accept\s+(all|changes|incoming|current|both|combination)/i.test(aText)) continue;

                if (ab.closest && (
                    ab.closest('.editor-scrollable') ||
                    ab.closest('.monaco-diff-editor') ||
                    ab.closest('.view-zones') ||
                    ab.closest('.merge-editor-view')
                )) {
                    continue;
                }

                if (ab.classList && (ab.classList.contains('diff-hunk-button') || ab.classList.contains('revert'))) {
                    continue;
                }

                targetBtn = ab;
                matchedPattern = 'Accept';
                break;
            }
        }

        if (targetBtn) {
            var ctx = extractActionContext(targetBtn);
            var btnText = (targetBtn.innerText || targetBtn.textContent || '').trim();
            var fullDesc = btnText;
            if (ctx.selectedChoice && ctx.selectedChoice !== btnText) {
                fullDesc += ' (เลือก: ' + ctx.selectedChoice + ')';
            }

            try {
                var _lx = new XMLHttpRequest();
                _lx.open('POST', 'http://127.0.0.1:' + CURRENT_HTTP_PORT + '/api/click-log', true);
                _lx.setRequestHeader('Content-Type', 'application/json');
                _lx.timeout = 3000;
                _lx.send(JSON.stringify({
                    button: fullDesc.substring(0, 120),
                    pattern: matchedPattern,
                    command: ctx.command || ''
                }));
            } catch (_) { }

            console.log('[Nexus Autopilot] 🎯 คลิกอัตโนมัติ: [' + fullDesc + ']' + (ctx.command ? ' → ' + ctx.command : ''));
            _clicked.add(targetBtn);
            triggerClick(targetBtn);

            _sessionTotal++;
            if (!_sessionStats[matchedPattern]) _sessionStats[matchedPattern] = 0;
            _sessionStats[matchedPattern]++;

            window._nexusTotalClicks = (window._nexusTotalClicks || 0) + 1;
            if (!window._nexusClickStats[matchedPattern]) window._nexusClickStats[matchedPattern] = 0;
            window._nexusClickStats[matchedPattern]++;
            window._agTotalClicks = window._nexusTotalClicks;
            window._agClickStats = window._nexusClickStats;
        }
    }, CLICK_INTERVAL_MS);
    window._nexusToolIntervals.push(autoClick);

    // --- 3. SMART AUTO-SCROLL ENGINE ---
    var _wasAtBottom = new WeakMap();
    var _justScrolled = new WeakSet();
    var BOTTOM_THRESHOLD = 150;

    var autoScroll = setInterval(function () {
        if (!window._nexusAutoEnabled || !window._nexusScrollEnabled) return;

        var docs = getAllDocuments();
        var scrollables = [];
        docs.forEach(function (doc) {
            try {
                var list = Array.from(doc.querySelectorAll('*')).filter(function (el) {
                    var style = (doc.defaultView || window).getComputedStyle(el);
                    var hasScrollbar = el.scrollHeight > el.clientHeight &&
                        (style.overflowY === 'auto' || style.overflowY === 'scroll');
                    if (!hasScrollbar) return false;
                    if (el.tagName === 'TEXTAREA') return false;
                    return true;
                });
                scrollables = scrollables.concat(list);
            } catch (_) { }
        });

        if (scrollables.length > 0) {
            isAutoScrolling = true;
            scrollables.forEach(function (el) {
                var gap = el.scrollHeight - el.scrollTop - el.clientHeight;
                var wasBottom = _wasAtBottom.get(el);

                if (wasBottom === undefined) {
                    wasBottom = gap <= BOTTOM_THRESHOLD;
                    _wasAtBottom.set(el, wasBottom);
                }

                if (wasBottom && gap > 5) {
                    _justScrolled.add(el);
                    el.scrollTop = el.scrollHeight;
                }
            });
            setTimeout(function () { isAutoScrolling = false; }, 50);
        }
    }, SCROLL_INTERVAL_MS);
    window._nexusToolIntervals.push(autoScroll);

    window._nexusScrollListener = function (e) {
        var el = e.target;
        if (!el || el.nodeType !== 1 || !el.closest || !el.closest('.antigravity-agent-side-panel')) return;

        if (_justScrolled.has(el)) {
            _justScrolled.delete(el);
            return;
        }
        if (isAutoScrolling) return;

        var gap = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (gap <= BOTTOM_THRESHOLD) {
            _wasAtBottom.set(el, true);
        } else {
            _wasAtBottom.set(el, false);
        }
    };
    window.addEventListener('scroll', window._nexusScrollListener, true);
    window._agScrollListener = window._nexusScrollListener;

    console.log('[Nexus Autopilot] 🚀 พร้อมทำงาน | Patterns:', JSON.stringify(CLICK_PATTERNS));
})();
