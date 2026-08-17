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
    var CLICK_PATTERNS = /*{{CLICK_PATTERNS}}*/["Allow", "Always Allow", "Run", "Keep Waiting", "Submit", "Yes, allow this time", "Yes, and always allow", "Retry", "Continue", "Allow Once", "Allow This Conversion", "Accept all"];
    
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
    var CURRENT_HTTP_PORT = /*{{CURRENT_HTTP_PORT}}*/48787;
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
            el.click();
        } catch (_) { }
        try {
            var view = el.ownerDocument ? (el.ownerDocument.defaultView || window) : window;
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: view }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: view }));
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: view }));
        } catch (_) { }
    }

    var _lastClickSig = '';
    var _lastClickTime = 0;
    var _clickCooldownMs = 4000;

    function extractQuestionAndAnswer(btn) {
        var question = '';
        var answer = '';
        try {
            var doc = btn.ownerDocument || document;
            
            // Traverse up until we get the full modal/card container (has question + options + action buttons)
            var container = btn.parentElement;
            for (var lvl = 0; lvl < 8; lvl++) {
                if (!container || container === doc.body) break;
                var text = (container.innerText || container.textContent || '').trim();
                if (text.length > 25 && (text.indexOf('Submit') !== -1 || text.indexOf('Skip') !== -1 || text.indexOf('Run') !== -1 || text.indexOf('Allow') !== -1)) {
                    var parentEl = container.parentElement;
                    if (parentEl && parentEl !== doc.body && !parentEl.classList.contains('monaco-workbench')) {
                        var pText = (parentEl.innerText || parentEl.textContent || '').trim();
                        if (pText.length < 800 && (pText.indexOf('Submit') !== -1 || pText.indexOf('Skip') !== -1)) {
                            container = parentEl;
                        }
                    }
                    break;
                }
                container = container.parentElement;
            }
            if (!container) container = btn.parentElement ? (btn.parentElement.parentElement || btn.parentElement) : null;

            if (container) {
                var rawText = (container.innerText || container.textContent || '');
                var allLines = rawText.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);

                // Collect content lines excluding standard action buttons
                var contentLines = [];
                for (var i = 0; i < allLines.length; i++) {
                    var l = allLines[i];
                    var lLow = l.toLowerCase();
                    if (l === 'Submit' || l === 'Submit ↵' || l === 'Skip' || l === 'Cancel' || l === 'Reject' || l === 'Close' || l === 'Dismiss' || l === "Don't Allow") continue;
                    if (lLow === 'run' || lLow === 'allow' || lLow === 'accept') continue;
                    contentLines.push(l);
                }

                // 1. Live Question Title (first line):
                if (contentLines.length > 0) {
                    question = contentLines[0].replace(/^\[\?\]\s*/, '').replace(/^[?\s\[\]🗩>_]+\s*/, '').trim();
                }

                // 2. Extract Command / Code Snippet (between question header and options):
                var commandSnippet = '';
                var codeEl = container.querySelector('code, pre, [class*="code"], [class*="command"], [class*="cmd"], [class*="terminal"], [class*="monaco-editor"]');
                if (codeEl && codeEl !== container && codeEl !== btn && !codeEl.contains(btn)) {
                    var cText = (codeEl.innerText || codeEl.textContent || '').trim();
                    if (cText && cText !== question && cText.length > 1) {
                        commandSnippet = cText;
                    }
                }

                if (!commandSnippet && contentLines.length > 1) {
                    for (var cl = 1; cl < contentLines.length; cl++) {
                        var clLine = contentLines[cl];
                        var isOptCheck = clLine.match(/^[0-9]+[\.\s\)]/) || 
                                         clLine.indexOf('Yes, allow') === 0 || 
                                         clLine.indexOf('Yes, and always') === 0 || 
                                         clLine.indexOf('No (tell') === 0 || 
                                         clLine.indexOf('(Recommended)') !== -1 ||
                                         clLine.indexOf('Other (write') === 0;
                        if (!isOptCheck && clLine !== question && clLine.length > 1) {
                            commandSnippet = clLine;
                            break;
                        }
                    }
                }

                // Append command to question for full context
                if (commandSnippet) {
                    if (question.toLowerCase().indexOf('command') !== -1 || question.toLowerCase().indexOf('allow') !== -1 || question.toLowerCase().indexOf('run') !== -1 || question.length < 35) {
                        if (question.indexOf(commandSnippet) === -1) {
                            question = question + ' ➔ ' + commandSnippet;
                        }
                    }
                }

                // 3. Live Selected Option / Answer:
                var activeOptEl = container.querySelector('input[type="radio"]:checked, [aria-checked="true"], [aria-selected="true"], [data-selected="true"], [class*="selected"], [class*="active"]');
                if (activeOptEl && activeOptEl !== container && activeOptEl !== btn && !activeOptEl.contains(btn)) {
                    var actText = (activeOptEl.innerText || activeOptEl.textContent || '').trim();
                    if (actText && actText !== question && actText !== commandSnippet && actText !== 'Submit' && actText !== 'Skip' && actText.length > 1) {
                        answer = actText;
                    }
                }

                if (!answer && contentLines.length > 1) {
                    for (var o = 1; o < contentLines.length; o++) {
                        var oLine = contentLines[o];
                        if (oLine === commandSnippet) continue;
                        var isOpt = oLine.match(/^[0-9]+[\.\s\)]/) || 
                                    oLine.indexOf('Yes, allow') === 0 || 
                                    oLine.indexOf('Yes, and always') === 0 || 
                                    oLine.indexOf('(Recommended)') !== -1 ||
                                    oLine.indexOf('No (tell') === 0;
                        if (isOpt && oLine !== question && oLine.length > 1) {
                            answer = oLine;
                            break;
                        }
                    }
                }

                if (!answer && contentLines.length > 1) {
                    for (var f = 1; f < contentLines.length; f++) {
                        var fLine = contentLines[f];
                        if (fLine !== question && fLine !== commandSnippet && fLine.length > 1) {
                            answer = fLine;
                            break;
                        }
                    }
                }
            }
        } catch (_) { }

        // Sanity check: Answer must NEVER be identical to question
        if (answer === question) {
            answer = '';
        }

        return {
            question: question ? question.substring(0, 200).trim() : '',
            answer: answer ? answer.replace(/^[0-9]+[\.\s\)]+/, '').substring(0, 200).trim() : ''
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
            var text = (b.innerText || b.textContent || '').trim();
            if (!text || text.length > 80) continue;

            // NEVER click menubar, titlebar, statusbar, activitybar, or editor tabs
            if (b.closest && (
                b.closest('.menubar') ||
                b.closest('.titlebar') ||
                b.closest('[id*="workbench.parts.titlebar"]') ||
                b.closest('.menubar-menu-button') ||
                b.closest('[role="menubar"]') ||
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

            // Skip buttons inside dedicated diff/merge editors
            if (b.closest && (
                b.closest('.monaco-diff-editor') || b.closest('.merge-editor-view') ||
                b.closest('.inline-merge-region') || b.closest('.merged-editor')
            )) continue;

            // Skip diff hunk buttons
            if (b.classList && (b.classList.contains('diff-hunk-button') || b.classList.contains('revert'))) {
                var editorAncestor = b.closest && b.closest('.monaco-diff-editor, .merge-editor-view');
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

            if (isApprovalButton(b)) {
                targetBtn = b;
                break;
            }
        }

        // --- Separate Accept handling (chat-only) ---
        if (!targetBtn && window._nexusAcceptChatOnly) {
            for (var ai = 0; ai < clickables.length; ai++) {
                var ab = clickables[ai];
                if (ab.offsetParent === null && ab.offsetWidth === 0 && ab.offsetHeight === 0) continue;
                var aText = (ab.innerText || ab.textContent || '').trim();

                // Skip status bar items like "Accept ON", "Accept OFF", etc.
                if (aText === 'Accept ON' || aText === 'Accept OFF' || aText.indexOf('Accept ON') !== -1 || aText.indexOf('Accept OFF') !== -1) continue;

                // MUST start with "Accept"
                if (aText.indexOf('Accept') !== 0) continue;
                if (/^Accept\s+(all|changes|incoming|current|both|combination)/i.test(aText)) continue;

                // NEVER click statusbar, menubar, titlebar, activitybar, tabs, diff editors
                if (ab.closest && (
                    ab.closest('.statusbar') ||
                    ab.closest('[id*="workbench.parts.statusbar"]') ||
                    ab.closest('.menubar') ||
                    ab.closest('.titlebar') ||
                    ab.closest('[id*="workbench.parts.titlebar"]') ||
                    ab.closest('.activitybar') ||
                    ab.closest('[id*="workbench.parts.activitybar"]') ||
                    ab.closest('.editor-scrollable') ||
                    ab.closest('.monaco-diff-editor') ||
                    ab.closest('.view-zones') ||
                    ab.closest('.merge-editor-view') ||
                    ab.closest('.tabs-and-actions-container') ||
                    ab.closest('.tab')
                )) {
                    continue;
                }

                if (ab.classList && (ab.classList.contains('diff-hunk-button') || ab.classList.contains('revert'))) {
                    continue;
                }

                // Accept is only valid inside chat panel or approval dialog
                var inChatOrDialog = ab.closest && (
                    ab.closest('.antigravity-agent-side-panel') ||
                    ab.closest('.interactive-session') ||
                    ab.closest('.chat-widget') ||
                    ab.closest('.interactive-editor') ||
                    ab.closest('[class*="chat"]') ||
                    ab.closest('[role="dialog"]') ||
                    ab.closest('.monaco-dialog-box') ||
                    isApprovalButton(ab)
                );
                if (!inChatOrDialog) continue;

                targetBtn = ab;
                matchedPattern = 'Accept';
                break;
            }
        }

        if (targetBtn) {
            var qa = extractQuestionAndAnswer(targetBtn);
            var btnText = (targetBtn.innerText || targetBtn.textContent || '').trim();
            var clickSig = matchedPattern + ':::' + (qa.question || '') + ':::' + (qa.answer || '') + ':::' + btnText;

            // Debounce duplicate clicks during waiting period
            if (clickSig === _lastClickSig && (Date.now() - _lastClickTime < _clickCooldownMs)) {
                return;
            }
            _lastClickSig = clickSig;
            _lastClickTime = Date.now();

            try {
                var _lx = new XMLHttpRequest();
                _lx.open('POST', 'http://127.0.0.1:' + CURRENT_HTTP_PORT + '/api/click-log', true);
                _lx.setRequestHeader('Content-Type', 'application/json');
                _lx.timeout = 3000;
                _lx.send(JSON.stringify({
                    button: btnText.substring(0, 150),
                    pattern: matchedPattern,
                    question: qa.question || '',
                    answer: qa.answer || ''
                }));
            } catch (_) { }

            console.log('[Nexus Autopilot] 🎯 คลิกอัตโนมัติ: [' + btnText + ']' + (qa.question ? ' | คำถาม: ' + qa.question : '') + (qa.answer ? ' | คำตอบ: ' + qa.answer : ''));
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
                    var inChatPanel = el.closest && el.closest('.antigravity-agent-side-panel');
                    if (!inChatPanel) return false;
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
