/**
 * Nexus Autopilot — Client Renderer Injection Script (Smooth & Robust Engine)
 *
 * Responsibilities:
 * 1. Suppress "corrupt installation" banners automatically
 * 2. Discover dynamic HTTP micro-server port (48787-48850)
 * 3. Smart Auto-Click for approval buttons (Run, Allow, Always Allow, Submit, Accept in chat only)
 * 4. Zero focus-stealing — completely eliminates auto-tab and editor corruption
 * 5. Strict editor isolation — never clicks diff editors, suggestions, or autocomplete popups
 * 6. Smart Auto-Scroll for Antigravity chat panel with stick-to-bottom logic
 */
(function () {
    // --- Guard: prevent double execution (workbench.js + HTML script tag) ---
    if (window._nexusAutoLoaded) return;
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

    var PAUSE_SCROLL_MS = /*{{PAUSE_SCROLL_MS}}*/7000;
    var CLICK_INTERVAL_MS = /*{{CLICK_INTERVAL_MS}}*/1000;
    var SCROLL_INTERVAL_MS = /*{{SCROLL_INTERVAL_MS}}*/500;
    var CLICK_PATTERNS = /*{{CLICK_PATTERNS}}*/["Allow", "Always Allow", "Run", "Keep Waiting", "Submit", "Yes, allow this time", "Yes, and always allow", "Retry", "Continue", "Allow Once", "Accept all"];

    // Accept is handled SEPARATELY (chat-only) — never in regular CLICK_PATTERNS
    window._nexusAcceptChatOnly = true;
    window._agAcceptChatOnly = true;

    // Master live toggles
    window._nexusAutoEnabled = /*{{ENABLED}}*/true;
    window._agAutoEnabled = window._nexusAutoEnabled;
    window._nexusScrollEnabled = true;
    window._agScrollEnabled = window._nexusScrollEnabled;

    // --- Dynamic Multi-Port Discovery ---
    var HTTP_PORT_START = 48787;
    var HTTP_PORT_END = 48850;
    var CURRENT_HTTP_PORT = /*{{CURRENT_HTTP_PORT}}*/48787;
    var ACTIVE_HTTP_PORTS = [CURRENT_HTTP_PORT];
    var _pollCount = 0;
    var _pollErrors = 0;
    var _portScanning = false;
    var _sessionStats = {};
    var _sessionTotal = 0;

    function discoverPort(callback) {
        if (_portScanning) return;
        _portScanning = true;
        var foundPorts = [];
        var pending = 0;

        function scanBatch(from) {
            if (from > HTTP_PORT_END) {
                _portScanning = false;
                if (foundPorts.length > 0) {
                    ACTIVE_HTTP_PORTS = foundPorts;
                    CURRENT_HTTP_PORT = foundPorts[0];
                    console.log('[Nexus Autopilot] ✅ Multi-Port Discovery: ตรวจพบ ' + foundPorts.length + ' พอร์ต (' + foundPorts.join(', ') + ')');
                }
                if (callback) callback(CURRENT_HTTP_PORT, window._nexusLastConfig || {});
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
                        if (xhr.status === 200) {
                            try {
                                var cfg = JSON.parse(xhr.responseText);
                                if (typeof cfg.enabled === 'boolean') {
                                    if (foundPorts.indexOf(port) === -1) foundPorts.push(port);
                                    window._nexusLastConfig = cfg;
                                    applyConfig(cfg);
                                }
                            } catch (_) { }
                        }
                        pending--;
                        if (pending <= 0) scanBatch(batchEnd + 1);
                    };
                    xhr.onerror = function () { pending--; if (pending <= 0) scanBatch(batchEnd + 1); };
                    xhr.ontimeout = function () { pending--; if (pending <= 0) scanBatch(batchEnd + 1); };
                    xhr.send();
                })(p);
            }
        }
        scanBatch(HTTP_PORT_START);
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
        if (cfg.port && typeof cfg.port === 'number') {
            CURRENT_HTTP_PORT = cfg.port;
            if (ACTIVE_HTTP_PORTS.indexOf(cfg.port) === -1) ACTIVE_HTTP_PORTS.push(cfg.port);
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
        if (cfg) applyConfig(cfg);
        _pollErrors = 0;
    });

    var _pendingLogs = [];

    // Configuration polling & stats sync loop
    var configReload = setInterval(function () {
        _pollCount++;
        // Periodic port re-discovery every 10 ticks (20s)
        if (_pollCount % 10 === 0 || ACTIVE_HTTP_PORTS.length === 0) {
            discoverPort(function (port, cfg) { if (cfg) applyConfig(cfg); });
        }
        if (ACTIVE_HTTP_PORTS.length === 0 && CURRENT_HTTP_PORT === 0) return;

        var targetPorts = ACTIVE_HTTP_PORTS.length > 0 ? ACTIVE_HTTP_PORTS : [CURRENT_HTTP_PORT];
        var statsParam = '';
        if (_sessionTotal > 0) {
            statsParam = '&total=' + _sessionTotal + '&stats=' + encodeURIComponent(JSON.stringify(_sessionStats));
            _sessionStats = {};
            _sessionTotal = 0;
        }
        var logsToSend = [];
        var logsParam = '';
        if (_pendingLogs.length > 0) {
            logsToSend = _pendingLogs.slice();
            logsParam = '&logs=' + encodeURIComponent(JSON.stringify(logsToSend));
        }

        targetPorts.forEach(function (port) {
            try {
                var xhr = new XMLHttpRequest();
                xhr.open('GET', 'http://127.0.0.1:' + port + '/ag-status?t=' + Date.now() + statsParam + logsParam, true);
                xhr.timeout = 1500;
                xhr.onload = function () {
                    if (xhr.status === 200) {
                        _pollErrors = 0;
                        if (logsToSend.length > 0) {
                            _pendingLogs = _pendingLogs.filter(function (item) {
                                return logsToSend.indexOf(item) === -1;
                            });
                        }
                        try {
                            var cfg = JSON.parse(xhr.responseText);
                            applyConfig(cfg);
                        } catch (_) { }
                    }
                };
                xhr.onerror = function () { };
                xhr.ontimeout = function () { };
                xhr.send();
            } catch (_) { }
        });
    }, 2000);
    window._nexusToolIntervals.push(configReload);

    // =================================================================
    // Approval and Pattern Matching Logic
    // =================================================================
    var REJECT_WORDS = ['Reject', 'Deny', 'Cancel', 'Dismiss', "Don't Allow", 'Decline', 'Skip', 'No'];
    var EDITOR_SKIP_WORDS = ['Accept Changes', 'Accept All', 'Accept Incoming', 'Accept Current', 'Accept Both', 'Accept Combination'];
    var _clicked = new WeakSet();

    if (!window._nexusClickStats) window._nexusClickStats = {};
    if (!window._nexusTotalClicks) window._nexusTotalClicks = 0;
    window._agClickStats = window._nexusClickStats;
    window._agTotalClicks = window._nexusTotalClicks;

    function isApprovalButton(btn) {
        var parent = btn.parentElement;
        if (!parent) return false;
        for (var level = 0; level < 4; level++) {
            if (!parent) break;
            var siblingBtns = parent.querySelectorAll('button, a.action-label, [role="button"], .monaco-button, span.bg-ide-button-background, [class*="cursor-pointer"]');
            for (var i = 0; i < siblingBtns.length; i++) {
                var sib = siblingBtns[i];
                if (sib === btn || sib.contains(btn) || btn.contains(sib)) continue;
                var sibText = (sib.innerText || sib.textContent || '').trim().toLowerCase();
                var sibAria = (sib.getAttribute ? (sib.getAttribute('aria-label') || '') : '').toLowerCase();
                for (var j = 0; j < REJECT_WORDS.length; j++) {
                    var rWord = REJECT_WORDS[j].toLowerCase();
                    if (sibText === rWord || sibText.indexOf(rWord) === 0 || sibAria.indexOf(rWord) !== -1) {
                        return true;
                    }
                }
            }
            parent = parent.parentElement;
        }
        return false;
    }

    function matchesPattern(text, pattern) {
        if (!text || !pattern) return false;
        var norm = text.replace(/[\r\n\t↵\s]+/g, ' ').trim().toLowerCase();
        var pat = pattern.toLowerCase().trim();

        if (norm === pat) return true;
        if (norm.indexOf(pat + ' ') === 0) return true;

        // Smart Phrasing handling
        if (pat === 'allow' || pat === 'always allow') {
            if (norm.indexOf('yes, allow') === 0 || norm.indexOf('yes, and always allow') === 0 || norm.indexOf('allow once') === 0 || norm.indexOf('always allow') === 0) {
                return true;
            }
        }
        if (pat === 'run') {
            if (norm === 'run' || norm.indexOf('run ') === 0 || norm.indexOf('▶ run') !== -1 || norm.indexOf('run in terminal') !== -1) {
                return true;
            }
        }
        if (pat === 'submit') {
            if (norm === 'submit' || norm.indexOf('submit ') === 0 || norm.indexOf('submit ↵') === 0) return true;
        }

        return false;
    }

    function triggerSafeClick(el) {
        _clicked.add(el);
        // Native click first
        try { el.click(); } catch (_) { }
        // Bubbling mouse events for React synthetic event trees — NEVER CALL el.focus()
        try {
            var view = el.ownerDocument ? (el.ownerDocument.defaultView || window) : window;
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: view }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: view }));
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: view }));
        } catch (_) { }
    }

    // --- 2. AUTO CLICK ENGINE (Smooth, Robust, Zero Focus Stealing) ---
    var autoClick = setInterval(function () {
        if (!window._nexusAutoEnabled) return;

        // 1. Gather clickables
        var clickables = Array.from(document.querySelectorAll('button, a.action-label, [role="button"], .monaco-button, span.cursor-pointer'));
        // Include div.cursor-pointer strictly inside chat panel or interactive sessions
        document.querySelectorAll('.antigravity-agent-side-panel div.cursor-pointer, .interactive-session div.cursor-pointer, .chat-widget div.cursor-pointer').forEach(function (d) {
            clickables.push(d);
        });

        var targetBtn = null;
        var matchedPattern = '';

        for (var i = 0; i < clickables.length; i++) {
            var b = clickables[i];
            if (b.offsetParent === null && b.offsetWidth === 0 && b.offsetHeight === 0) continue;
            if (_clicked.has(b)) continue;

            var text = (b.innerText || b.textContent || '').trim();
            if (!text || text.length > 50) continue;

            // STRICT EXCLUSION: Never click anything inside Monaco Editor, Autocomplete Suggest Widget, Menubar, etc.
            if (b.closest && (
                b.closest('.monaco-editor') ||
                b.closest('.suggest-widget') ||
                b.closest('.monaco-list') ||
                b.closest('.quick-input-widget') ||
                b.closest('.context-view') ||
                b.closest('.monaco-diff-editor') ||
                b.closest('.merge-editor-view') ||
                b.closest('.inline-merge-region') ||
                b.closest('.merged-editor') ||
                b.closest('.view-zones') ||
                b.closest('.view-lines') ||
                b.closest('[id*="workbench.parts.editor"]') ||
                b.closest('.menubar') ||
                b.closest('.titlebar') ||
                b.closest('[id*="workbench.parts.titlebar"]') ||
                b.closest('.statusbar') ||
                b.closest('[id*="workbench.parts.statusbar"]') ||
                b.closest('.activitybar') ||
                b.closest('[id*="workbench.parts.activitybar"]') ||
                b.closest('.tabs-and-actions-container') ||
                b.closest('.tab')
            )) continue;

            // Skip diff/merge editor buttons
            var skipEditor = false;
            for (var se = 0; se < EDITOR_SKIP_WORDS.length; se++) {
                if (text.indexOf(EDITOR_SKIP_WORDS[se]) === 0) { skipEditor = true; break; }
            }
            if (skipEditor) continue;

            // Check if element is inside safe Chat Panel
            var inChatPanel = !!(b.closest && (
                b.closest('.antigravity-agent-side-panel') ||
                b.closest('.interactive-session') ||
                b.closest('.chat-widget') ||
                b.closest('[class*="chat"]')
            ));

            var matchesAny = false;
            for (var p = 0; p < CLICK_PATTERNS.length; p++) {
                var pat = CLICK_PATTERNS[p];
                if (matchesPattern(text, pat)) {
                    matchesAny = true;
                    matchedPattern = pat;
                    break;
                }
            }
            if (!matchesAny) continue;

            // Decision: In Chat Panel -> Direct Approval; Outside -> isApprovalButton check
            if (inChatPanel || isApprovalButton(b) || (b.tagName === 'SPAN' && b.classList.contains('cursor-pointer'))) {
                targetBtn = b;
                break;
            }
        }

        // --- Separate Accept handling (chat-only, never via regular patterns) ---
        if (!targetBtn && window._nexusAcceptChatOnly) {
            for (var ai = 0; ai < clickables.length; ai++) {
                var ab = clickables[ai];
                if (ab.offsetParent === null && ab.offsetWidth === 0 && ab.offsetHeight === 0) continue;
                if (_clicked.has(ab)) continue;
                var aText = (ab.innerText || ab.textContent || '').trim();

                // Must start with "Accept"
                if (aText.indexOf('Accept') !== 0) continue;
                if (/^Accept\s+(all|changes|incoming|current|both|combination)/i.test(aText)) continue;

                // STRICT EXCLUSION for Accept
                if (ab.closest && (
                    ab.closest('.monaco-editor') ||
                    ab.closest('.suggest-widget') ||
                    ab.closest('.monaco-list') ||
                    ab.closest('.quick-input-widget') ||
                    ab.closest('.context-view') ||
                    ab.closest('.editor-scrollable') ||
                    ab.closest('.monaco-diff-editor') ||
                    ab.closest('.view-zones') ||
                    ab.closest('.merge-editor-view') ||
                    ab.closest('.menubar') ||
                    ab.closest('.titlebar') ||
                    ab.closest('.statusbar')
                )) continue;

                // Accept is only valid inside chat panel
                var inChat = ab.closest && (
                    ab.closest('.antigravity-agent-side-panel') ||
                    ab.closest('.interactive-session') ||
                    ab.closest('.chat-widget') ||
                    ab.closest('[class*="chat"]')
                );
                if (!inChat) continue;

                targetBtn = ab;
                matchedPattern = 'Accept';
                break;
            }
        }

        if (targetBtn) {
            var btnLabel = (targetBtn.innerText || targetBtn.textContent || '').trim();
            var d = new Date();
            var pad = function (n) { return n < 10 ? '0' + n : n; };
            var timestamp = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + ' ' + pad(d.getDate()) + '/' + pad(d.getMonth() + 1);

            // Extract lightweight question/command context if available
            var questionSnippet = '';
            try {
                var searchCard = (targetBtn.closest && targetBtn.closest('.interactive-item-container, [class*="chat-item"], [class*="message"], [class*="turn"], [class*="response"]')) || targetBtn.parentElement;
                if (searchCard) {
                    var codeBlock = searchCard.querySelector('pre, code, [class*="command"]');
                    if (codeBlock) {
                        var codeText = (codeBlock.innerText || codeBlock.textContent || '').trim();
                        if (codeText && codeText.length > 2 && codeText !== btnLabel) {
                            questionSnippet = codeText.split('\n')[0].substring(0, 150);
                        }
                    }
                }
            } catch (_) { }

            var logEntry = {
                time: timestamp,
                button: btnLabel.substring(0, 100),
                pattern: matchedPattern,
                question: questionSnippet ? ('➔ ' + questionSnippet) : ''
            };
            _pendingLogs.push(logEntry);

            // Immediate POST attempt to all active ports (Multi-Instance Broadcast)
            var targetPorts = ACTIVE_HTTP_PORTS.length > 0 ? ACTIVE_HTTP_PORTS : [CURRENT_HTTP_PORT];
            targetPorts.forEach(function (port) {
                if (port > 0) {
                    try {
                        var _lx = new XMLHttpRequest();
                        _lx.open('POST', 'http://127.0.0.1:' + port + '/api/click-log', true);
                        _lx.setRequestHeader('Content-Type', 'application/json');
                        _lx.timeout = 1500;
                        _lx.onload = function () {
                            if (_lx.status === 200) {
                                var idx = _pendingLogs.indexOf(logEntry);
                                if (idx !== -1) _pendingLogs.splice(idx, 1);
                            }
                        };
                        _lx.send(JSON.stringify(logEntry));
                    } catch (_) { }
                }
            });

            console.log('[Nexus Autopilot] 🎯 Auto-Click: [' + btnLabel + '] (Pattern: ' + matchedPattern + ')');
            triggerSafeClick(targetBtn);

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

    // --- 3. SMART AUTO-SCROLL (Stick-to-bottom) ---
    var _wasAtBottom = new WeakMap();
    var _justScrolled = new WeakSet();
    var BOTTOM_THRESHOLD = 150;
    var isAutoScrolling = false;

    var autoScroll = setInterval(function () {
        if (!window._nexusAutoEnabled || !window._nexusScrollEnabled) return;

        var scrollables = Array.from(document.querySelectorAll('*')).filter(function (el) {
            var style = window.getComputedStyle(el);
            var hasScrollbar = el.scrollHeight > el.clientHeight &&
                (style.overflowY === 'auto' || style.overflowY === 'scroll');
            if (!hasScrollbar) return false;
            if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return false;
            // Only scroll inside chat panel
            var inChatPanel = el.closest && el.closest('.antigravity-agent-side-panel');
            if (!inChatPanel) return false;
            return true;
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

    console.log('[Nexus Autopilot] 🚀 พร้อมทำงานแบบ Smooth & Robust | Patterns:', JSON.stringify(CLICK_PATTERNS));
})();
