// ===========================================================
// Nexus Autopilot — VS Code & Antigravity Extension
// ===========================================================
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const url = require('url');
const { execSync } = require('child_process');

// Script injection markers
const TAG_START = '<!-- NEXUS-AUTOPILOT-START -->';
const TAG_END = '<!-- NEXUS-AUTOPILOT-END -->';
const LEGACY_TAG_START = '<!-- AG-AUTO-CLICK-SCROLL-START -->';
const LEGACY_TAG_END = '<!-- AG-AUTO-CLICK-SCROLL-END -->';

let statusBarItem = null;
let _extensionContext = null;
let _autoAcceptEnabled = true;
let _httpScrollEnabled = true;
let _httpClickPatterns = ['Allow', 'Always Allow', 'Run', 'Keep Waiting', 'Accept', 'Submit', 'Yes, allow this time', 'Yes, and always allow'];
let _httpScrollConfig = { pauseScrollMs: 7000, scrollIntervalMs: 500, clickIntervalMs: 1000 };
let _clickStats = {};
let _totalClicks = 0;
let _clickLog = [];
let _resetStatsRequested = false;
let _httpServer = null;
let _actualPort = 0;
let _settingsPanel = null;
let _autoAcceptInterval = null;

const AG_HTTP_PORT_START = 48787;
const AG_HTTP_PORT_END = 48850;

/**
 * Helper ดึง Configuration ของ Nexus Autopilot (พร้อม fallback)
 */
function getAutopilotConfig() {
    const cfg = vscode.workspace.getConfiguration('nexus-autopilot');
    const legacy = vscode.workspace.getConfiguration('ag-auto');
    return {
        get: (key, defaultValue) => {
            const val = cfg.get(key);
            if (val !== undefined) return val;
            return legacy.get(key, defaultValue);
        },
        update: async (key, value) => {
            try {
                await cfg.update(key, value, vscode.ConfigurationTarget.Global);
            } catch (_) { }
            try {
                await legacy.update(key, value, vscode.ConfigurationTarget.Global);
            } catch (_) { }
        }
    };
}

/**
 * เขียนไฟล์พร้อมสิทธิ์ Administrator / Auto-elevation บน Linux/macOS
 */
function writeFileElevated(filePath, content) {
    try {
        fs.writeFileSync(filePath, content, 'utf8');
    } catch (err) {
        if (err.code !== 'EACCES' && err.code !== 'EPERM') throw err;

        const tmpPath = path.join(os.tmpdir(), 'nexus-autopilot-' + Date.now() + '.tmp');
        fs.writeFileSync(tmpPath, content, 'utf8');

        try {
            if (process.platform === 'linux') {
                execSync(`pkexec bash -c "cp '${tmpPath}' '${filePath}' && chmod 644 '${filePath}'"`, { timeout: 30000 });
                console.log('[Nexus Autopilot] ✅ บันทึกไฟล์ด้วยสิทธิ์ pkexec สำเร็จ →', path.basename(filePath));
            } else if (process.platform === 'darwin') {
                const cmd = `cp '${tmpPath}' '${filePath}' && chmod 644 '${filePath}'`;
                execSync(`osascript -e 'do shell script "${cmd}" with administrator privileges'`, { timeout: 30000 });
                console.log('[Nexus Autopilot] ✅ บันทึกไฟล์ด้วยสิทธิ์ osascript สำเร็จ →', path.basename(filePath));
            } else {
                throw err;
            }
        } catch (elevErr) {
            try { fs.unlinkSync(tmpPath); } catch (_) { }
            if (elevErr === err) throw err;
            console.error('[Nexus Autopilot] การขอสิทธิ์ล้มเหลว:', elevErr.message);
            throw new Error(`ไม่สามารถเข้าถึงไฟล์ได้ กรุณาตรวจสอบสิทธิ์การเขียน: ${path.dirname(filePath)}`);
        }

        try { fs.unlinkSync(tmpPath); } catch (_) { }
    }
}

/**
 * ค้นหาไฟล์ workbench.html ของ Antigravity / VS Code
 */
function getWorkbenchPath() {
    const appRoot = vscode.env.appRoot;
    console.log('[Nexus Autopilot] appRoot:', appRoot);

    const candidates = [
        path.join(appRoot, 'out', 'vs', 'code', 'electron-browser', 'workbench', 'workbench.html'),
        path.join(appRoot, 'out', 'vs', 'code', 'electron-sandbox', 'workbench', 'workbench.html'),
        path.join(appRoot, 'out', 'vs', 'workbench', 'workbench.html'),
        path.join(appRoot, 'out', 'vs', 'code', 'browser', 'workbench', 'workbench.html'),
        path.join(appRoot, 'out', 'vs', 'code', 'electron-main', 'workbench', 'workbench.html'),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    const outDir = path.join(appRoot, 'out');
    return findFileRecursive(outDir, 'workbench.html', 6);
}

function findFileRecursive(dir, filename, maxDepth) {
    if (maxDepth <= 0) return null;
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isFile() && entry.name === filename) return fullPath;
            if (entry.isDirectory()) {
                const result = findFileRecursive(fullPath, filename, maxDepth - 1);
                if (result) return result;
            }
        }
    } catch (_) { }
    return null;
}

/**
 * สร้างเนื้อหาสคริปต์ client renderer พร้อมค่า config
 */
function buildScriptContent(context) {
    const config = getAutopilotConfig();
    const pauseMs = config.get('scrollPauseMs', 7000);
    const scrollMs = config.get('scrollIntervalMs', 500);
    const clickMs = config.get('clickIntervalMs', 1000);
    const allPatterns = config.get('clickPatterns', ['Allow', 'Always Allow', 'Run', 'Keep Waiting', 'Accept', 'Submit', 'Yes, allow this time', 'Yes, and always allow', 'Retry', 'Continue', 'Allow Once', 'Allow This Conversion', 'Accept all']);
    const disabledPats = context.globalState.get('disabledClickPatterns', ['Accept all']);
    const patterns = allPatterns.filter(p => !disabledPats.includes(p) && p !== 'Accept');
    const enabled = config.get('enabled', true);

    const templatePath = path.join(context.extensionPath, 'media', 'autoScript.js');
    let script = fs.readFileSync(templatePath, 'utf8');

    script = script.replace(/\/\*\{\{PAUSE_SCROLL_MS\}\}\*\/\d+/, pauseMs.toString());
    script = script.replace(/\/\*\{\{SCROLL_INTERVAL_MS\}\}\*\/\d+/, scrollMs.toString());
    script = script.replace(/\/\*\{\{CLICK_INTERVAL_MS\}\}\*\/\d+/, clickMs.toString());
    script = script.replace(/\/\*\{\{CLICK_PATTERNS\}\}\*\/\[.*?\]/, JSON.stringify(patterns));
    script = script.replace(/\/\*\{\{ENABLED\}\}\*\/\w+/, enabled.toString());
    script = script.replace(/\/\*\{\{CURRENT_HTTP_PORT\}\}\*\/\d+/, (_actualPort || 48787).toString());

    return script;
}

/**
 * บันทึก config JSON สำหรับ Client Script
 */
function writeConfigJson(context) {
    try {
        const wbPath = getWorkbenchPath();
        if (!wbPath) return;
        const wbDir = path.dirname(wbPath);
        const config = getAutopilotConfig();
        const allPatterns = config.get('clickPatterns', ['Allow', 'Always Allow', 'Run', 'Keep Waiting', 'Accept', 'Submit', 'Yes, allow this time', 'Yes, and always allow', 'Retry', 'Continue', 'Allow Once', 'Allow This Conversion', 'Accept all']);
        const disabledPats = context.globalState.get('disabledClickPatterns', ['Accept all']);
        const activePatterns = allPatterns.filter(p => !disabledPats.includes(p) && p !== 'Accept');
        const acceptEnabled = allPatterns.includes('Accept') && !disabledPats.includes('Accept');
        const enabled = config.get('enabled', true);
        const configData = JSON.stringify({
            enabled: enabled,
            scrollEnabled: config.get('scrollEnabled', true),
            clickPatterns: activePatterns,
            acceptInChatOnly: acceptEnabled,
            pauseScrollMs: config.get('scrollPauseMs', 7000),
            scrollIntervalMs: config.get('scrollIntervalMs', 500),
            clickIntervalMs: config.get('clickIntervalMs', 1000)
        });
        writeFileElevated(path.join(wbDir, 'nexus-auto-config.json'), configData);
        writeFileElevated(path.join(wbDir, 'ag-auto-config.json'), configData);
    } catch (e) {
        console.error('[Nexus Autopilot] เกิดข้อผิดพลาดในการเขียน Config JSON:', e.message);
    }
}

/**
 * ค้นหาไฟล์ workbench.html ทั้งหมดของ Antigravity / VS Code (รวม workbench-jetski-agent.html)
 */
function getAllWorkbenchPaths() {
    const wbPath = getWorkbenchPath();
    if (!wbPath) return [];
    const wbDir = path.dirname(wbPath);
    const targets = new Set([wbPath]);

    try {
        const files = fs.readdirSync(wbDir);
        for (const file of files) {
            if (file.startsWith('workbench') && file.endsWith('.html')) {
                targets.add(path.join(wbDir, file));
            }
        }
    } catch (_) { }

    return Array.from(targets);
}

/**
 * ติดตั้ง (Inject) Script ลงใน Workbench HTML
 */
function installScript(context) {
    console.log('[Nexus Autopilot] เริ่มต้นกระบวนการ Inject Script...');
    const allPaths = getAllWorkbenchPaths();
    if (allPaths.length === 0) {
        vscode.window.showErrorMessage('[Nexus Autopilot] ไม่พบไฟล์ workbench.html กรุณาตรวจสอบการติดตั้ง Antigravity');
        return false;
    }

    const wbDir = path.dirname(allPaths[0]);
    const scriptContent = buildScriptContent(context);

    try {
        const ts = Date.now();
        writeFileElevated(path.join(wbDir, 'nexus-auto-script.js'), scriptContent);
        writeFileElevated(path.join(wbDir, 'ag-auto-script.js'), scriptContent);

        const legacyRegex = new RegExp(`${escapeRegex(LEGACY_TAG_START)}[\\s\\S]*?${escapeRegex(LEGACY_TAG_END)}`, 'g');
        const currentRegex = new RegExp(`${escapeRegex(TAG_START)}[\\s\\S]*?${escapeRegex(TAG_END)}`, 'g');
        const injection = `\n${TAG_START}\n<script src="nexus-auto-script.js?v=${ts}"></script>\n${TAG_END}`;

        for (const p of allPaths) {
            let html = fs.readFileSync(p, 'utf8');
            html = html.replace(legacyRegex, '').replace(currentRegex, '');
            html = html.replace('</html>', injection + '\n</html>');
            writeFileElevated(p, html);
            console.log('[Nexus Autopilot] ✅ ทำการ Inject Script สำเร็จ →', path.basename(p), `(v=${ts})`);
        }
        return true;
    } catch (err) {
        console.error('[Nexus Autopilot] เกิดข้อผิดพลาดขณะ Inject HTML:', err.message);
        return false;
    }
}

/**
 * อัปเดต Checksums ใน product.json เพื่อป้องกันการแจ้งเตือน Corrupt Installation
 */
function updateProductChecksums() {
    try {
        let productJsonPath = null;
        if (process.resourcesPath) {
            const candidate = path.join(process.resourcesPath, 'app', 'product.json');
            if (fs.existsSync(candidate)) productJsonPath = candidate;
        }

        if (!productJsonPath) {
            const wbPath = getWorkbenchPath();
            if (!wbPath) return false;
            let searchDir = path.dirname(wbPath);
            for (let i = 0; i < 8; i++) {
                const candidate = path.join(searchDir, 'product.json');
                if (fs.existsSync(candidate)) {
                    productJsonPath = candidate;
                    break;
                }
                searchDir = path.dirname(searchDir);
            }
        }

        if (!productJsonPath) return false;

        const productJson = JSON.parse(fs.readFileSync(productJsonPath, 'utf8'));
        if (!productJson.checksums) return false;

        const appRoot = path.dirname(productJsonPath);
        const outDir = path.join(appRoot, 'out');
        let updated = false;

        for (const relativePath in productJson.checksums) {
            const nativePath = relativePath.split('/').join(path.sep);
            let filePath = path.join(outDir, nativePath);
            if (!fs.existsSync(filePath)) filePath = path.join(appRoot, nativePath);
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath);
                const hash = crypto.createHash('sha256').update(content).digest('base64').replace(/=+$/, '');
                if (productJson.checksums[relativePath] !== hash) {
                    productJson.checksums[relativePath] = hash;
                    updated = true;
                }
            }
        }

        if (updated) {
            writeFileElevated(productJsonPath, JSON.stringify(productJson, null, '\t'));
            console.log('[Nexus Autopilot] ✅ ซ่อมแซมและอัปเดต Checksums ใน product.json เรียบร้อยแล้ว');
        }
        return updated;
    } catch (e) {
        console.error('[Nexus Autopilot] อัปเดต Checksums ล้มเหลว:', e.message);
        return false;
    }
}

/**
 * เคลียร์แคช V8 Bytecode ใน Antigravity
 */
function clearV8CodeCache() {
    try {
        const appDataDir = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        const codeCacheDir = path.join(appDataDir, 'Antigravity', 'Code Cache', 'js');
        if (fs.existsSync(codeCacheDir)) {
            fs.rmSync(codeCacheDir, { recursive: true, force: true });
            console.log('[Nexus Autopilot] เคลียร์ V8 code cache สำเร็จ');
        }
    } catch (_) { }
}

/**
 * ถอนการติดตั้ง Script
 */
function uninstallScript() {
    const allPaths = getAllWorkbenchPaths();
    if (allPaths.length === 0) return false;

    const wbDir = path.dirname(allPaths[0]);
    try {
        const legacyRegex = new RegExp(`${escapeRegex(LEGACY_TAG_START)}[\\s\\S]*?${escapeRegex(LEGACY_TAG_END)}`, 'g');
        const currentRegex = new RegExp(`${escapeRegex(TAG_START)}[\\s\\S]*?${escapeRegex(TAG_END)}`, 'g');

        for (const p of allPaths) {
            let html = fs.readFileSync(p, 'utf8');
            html = html.replace(legacyRegex, '').replace(currentRegex, '');
            writeFileElevated(p, html);
        }

        const s1 = path.join(wbDir, 'nexus-auto-script.js');
        const s2 = path.join(wbDir, 'ag-auto-script.js');
        if (fs.existsSync(s1)) fs.unlinkSync(s1);
        if (fs.existsSync(s2)) fs.unlinkSync(s2);

        updateProductChecksums();
        return true;
    } catch (err) {
        vscode.window.showErrorMessage(`[Nexus Autopilot] ไม่สามารถถอนการติดตั้งได้: ${err.message}`);
        return false;
    }
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * ตรวจสอบว่า Script กำลังถูก Inject อยู่หรือไม่
 */
function isScriptInjected() {
    try {
        const allPaths = getAllWorkbenchPaths();
        if (allPaths.length === 0) return false;
        for (const p of allPaths) {
            const html = fs.readFileSync(p, 'utf8');
            if (!html.includes(TAG_START) || html.includes(LEGACY_TAG_START)) {
                return false;
            }
        }
        return true;
    } catch (_) {
        return false;
    }
}

let statusBarAccept = null;
let statusBarScroll = null;

/**
 * สร้างและอัปเดต Status Bar Item (Accept ON / Scroll ON)
 */
function createStatusBarItem(context) {
    if (!statusBarAccept) {
        statusBarAccept = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
        statusBarAccept.command = 'nexus-autopilot.openSettings';
        context.subscriptions.push(statusBarAccept);
    }
    if (!statusBarScroll) {
        statusBarScroll = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        statusBarScroll.command = 'nexus-autopilot.openSettings';
        context.subscriptions.push(statusBarScroll);
    }
    updateStatusBarItem();
    statusBarAccept.show();
    statusBarScroll.show();
}

function updateStatusBarItem() {
    const config = getAutopilotConfig();
    const enabled = config.get('enabled', true);
    const scrollEnabled = config.get('scrollEnabled', true);

    if (statusBarAccept) {
        if (enabled) {
            statusBarAccept.text = '$(check) Accept ON';
            statusBarAccept.tooltip = 'Nexus Autopilot: Auto Click [ON] (คลิกเพื่อเปิดการตั้งค่า)';
            statusBarAccept.color = '#38bdf8';
        } else {
            statusBarAccept.text = '$(x) Accept OFF';
            statusBarAccept.tooltip = 'Nexus Autopilot: Auto Click [OFF] (คลิกเพื่อเปิดการตั้งค่า)';
            statusBarAccept.color = '#f43f5e';
        }
    }

    if (statusBarScroll) {
        if (scrollEnabled) {
            statusBarScroll.text = '$(check) Scroll ON';
            statusBarScroll.tooltip = 'Nexus Autopilot: Auto Scroll [ON] (คลิกเพื่อเปิดการตั้งค่า)';
            statusBarScroll.color = '#38bdf8';
        } else {
            statusBarScroll.text = '$(x) Scroll OFF';
            statusBarScroll.tooltip = 'Nexus Autopilot: Auto Scroll [OFF] (คลิกเพื่อเปิดการตั้งค่า)';
            statusBarScroll.color = '#94a3b8';
        }
    }
}

/**
 * รัน Local HTTP Server สำหรับการสื่อสารหลายหน้าต่าง (Multi-Instance)
 */
function startHttpServer() {
    if (_httpServer) return;

    try {
        _httpServer = http.createServer((req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

            if (req.method === 'OPTIONS') {
                res.writeHead(200);
                res.end();
                return;
            }

            const parsed = url.parse(req.url, true);

            if (parsed.pathname === '/ag-status' || parsed.pathname === '/nexus-status') {
                if (parsed.query && parsed.query.stats) {
                    try {
                        const incoming = JSON.parse(decodeURIComponent(parsed.query.stats));
                        for (const key in incoming) {
                            if (!_clickStats[key]) _clickStats[key] = 0;
                            _clickStats[key] += incoming[key];
                        }
                        let total = 0;
                        for (const key in _clickStats) { total += _clickStats[key]; }
                        _totalClicks = total;
                        if (_extensionContext) {
                            _extensionContext.globalState.update('clickStats', _clickStats);
                            _extensionContext.globalState.update('totalClicks', _totalClicks);
                        }
                        if (_settingsPanel) {
                            _settingsPanel.webview.postMessage({
                                command: 'statsUpdated',
                                clickStats: _clickStats,
                                totalClicks: _totalClicks
                            });
                        }
                    } catch (_) { }
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                const safePatterns = _httpClickPatterns.filter(p => p !== 'Accept');
                const responseData = {
                    enabled: _autoAcceptEnabled,
                    scrollEnabled: _httpScrollEnabled,
                    clickPatterns: safePatterns,
                    acceptInChatOnly: _httpClickPatterns.includes('Accept'),
                    pauseScrollMs: _httpScrollConfig.pauseScrollMs,
                    scrollIntervalMs: _httpScrollConfig.scrollIntervalMs,
                    clickIntervalMs: _httpScrollConfig.clickIntervalMs,
                    clickStats: _clickStats,
                    totalClicks: _totalClicks,
                    port: _actualPort
                };
                if (_resetStatsRequested) {
                    responseData.resetStats = true;
                    _resetStatsRequested = false;
                }
                res.end(JSON.stringify(responseData));
                return;
            }

            if (parsed.pathname === '/api/click-log' && req.method === 'POST') {
                let body = '';
                req.on('data', chunk => { body += chunk; });
                req.on('end', () => {
                    try {
                        const data = JSON.parse(body);
                        const d = new Date();
                        const pad = n => (n < 10 ? '0' + n : n);
                        const timestamp = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
                        const entry = {
                            time: timestamp,
                            pattern: data.pattern || 'Click',
                            button: (data.button || '').substring(0, 150),
                            question: (data.question || '').replace(/[\r\n]*\s*➔\s*/g, '\n➔ ').substring(0, 500),
                            answer: (data.answer || '').substring(0, 300)
                        };
                        _clickLog.unshift(entry);
                        if (_clickLog.length > 200) _clickLog.pop();
                        if (_extensionContext) {
                            _extensionContext.globalState.update('clickLog', _clickLog);
                        }
                        if (_settingsPanel) {
                            _settingsPanel.webview.postMessage({ command: 'clickLogUpdate', log: _clickLog });
                        }
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ logged: true }));
                    } catch (e) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: e.message }));
                    }
                });
                return;
            }

            res.writeHead(404);
            res.end('Not Found');
        });

        function tryListenPort(port) {
            if (port > AG_HTTP_PORT_END) {
                console.log('[Nexus Autopilot] ❌ ไม่มีพอร์ตว่างในช่วง ' + AG_HTTP_PORT_START + '-' + AG_HTTP_PORT_END);
                return;
            }
            _httpServer.removeAllListeners('error');
            _httpServer.once('error', (e) => {
                if (e.code === 'EADDRINUSE') {
                    tryListenPort(port + 1);
                }
            });
            _httpServer.listen(port, '127.0.0.1', () => {
                _actualPort = port;
                console.log('[Nexus Autopilot] ✅ HTTP Server ทำงานที่พอร์ต ' + port);
                try {
                    const wbPath = getWorkbenchPath();
                    if (wbPath) {
                        const portFile = path.join(path.dirname(wbPath), 'nexus-auto-port-' + process.pid + '.txt');
                        fs.writeFileSync(portFile, String(port), 'utf8');
                    }
                } catch (_) { }
            });
        }
        tryListenPort(AG_HTTP_PORT_START);
    } catch (e) {
        console.error('[Nexus Autopilot] ไม่สามารถเริ่ม HTTP Server ได้:', e.message);
    }
}

// Background chat-safe accept command runner
const CHAT_ACCEPT_COMMANDS = [
    'antigravity.agent.acceptAgentStep',
    'antigravity.prioritized.supercompleteAccept',
    'antigravity.terminalCommand.accept',
    'antigravity.acceptCompletion'
];

function startCommandsLoop() {
    const config = getAutopilotConfig();
    _autoAcceptEnabled = config.get('enabled', true);
    const clickMs = config.get('clickIntervalMs', 1000);

    if (_autoAcceptInterval) clearInterval(_autoAcceptInterval);

    _autoAcceptInterval = setInterval(() => {
        if (!_autoAcceptEnabled) return;
        const wantsAccept = _httpClickPatterns.some(p => p.toLowerCase().includes('accept'));
        if (!wantsAccept) return;

        Promise.allSettled(
            CHAT_ACCEPT_COMMANDS.map(cmd => vscode.commands.executeCommand(cmd))
        ).catch(() => { });
    }, clickMs);
}

/**
 * ฟังก์ชันดึงเลขเวอร์ชันจาก package.json แบบไดนามิก
 */
function getExtensionVersion(context) {
    try {
        if (context && context.extension && context.extension.packageJSON && context.extension.packageJSON.version) {
            return context.extension.packageJSON.version;
        }
        const pkgPath = path.join(context ? context.extensionPath : __dirname, 'package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            if (pkg && pkg.version) return pkg.version;
        }
        const parentPkgPath = path.join(__dirname, '..', 'package.json');
        if (fs.existsSync(parentPkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(parentPkgPath, 'utf8'));
            if (pkg && pkg.version) return pkg.version;
        }
    } catch (_) { }
    return '1.1.5';
}

/**
 * หน้าต่างตั้งค่า Settings Panel
 */
function openSettingsPanel(context) {
    if (_settingsPanel) {
        _settingsPanel.reveal(vscode.ViewColumn.One);
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'nexusAutoSettings',
        'Nexus Autopilot: แดชบอร์ด & การตั้งค่า',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    _settingsPanel = panel;

    panel.onDidDispose(() => {
        _settingsPanel = null;
    });

    const config = getAutopilotConfig();
    const iconPath = vscode.Uri.file(path.join(context.extensionPath, 'media', 'icon.png'));
    const iconUri = panel.webview.asWebviewUri(iconPath).toString();
    const version = getExtensionVersion(context);

    panel.webview.html = getSettingsHtml({
        enabled: config.get('enabled', true),
        scrollEnabled: config.get('scrollEnabled', true),
        scrollPauseMs: config.get('scrollPauseMs', 7000),
        scrollIntervalMs: config.get('scrollIntervalMs', 500),
        clickIntervalMs: config.get('clickIntervalMs', 1000),
        clickPatterns: config.get('clickPatterns', ['Allow', 'Always Allow', 'Run', 'Keep Waiting', 'Accept', 'Submit', 'Yes, allow this time', 'Yes, and always allow', 'Retry', 'Continue', 'Allow Once', 'Allow This Conversion', 'Accept all']),
        disabledClickPatterns: context.globalState.get('disabledClickPatterns', ['Accept all']),
        clickStats: _clickStats,
        totalClicks: _totalClicks,
        actualPort: _actualPort,
        clickLog: _clickLog,
        iconUri: iconUri,
        version: version
    });

    panel.webview.onDidReceiveMessage(async (msg) => {
        const cfg = getAutopilotConfig();
        if (msg.command === 'toggle') {
            _autoAcceptEnabled = msg.enabled;
            await cfg.update('enabled', msg.enabled);
            writeConfigJson(context);
            updateStatusBarItem();
            return;
        }
        if (msg.command === 'scrollToggle') {
            _httpScrollEnabled = msg.enabled;
            await cfg.update('scrollEnabled', msg.enabled);
            writeConfigJson(context);
            updateStatusBarItem();
            return;
        }
        if (msg.command === 'save') {
            await cfg.update('enabled', msg.data.enabled);
            await cfg.update('scrollEnabled', msg.data.scrollEnabled);
            await cfg.update('scrollPauseMs', msg.data.scrollPauseMs);
            await cfg.update('scrollIntervalMs', msg.data.scrollIntervalMs);
            await cfg.update('clickIntervalMs', msg.data.clickIntervalMs);
            await cfg.update('clickPatterns', msg.data.clickPatterns);
            await context.globalState.update('disabledClickPatterns', msg.data.disabledClickPatterns);

            _autoAcceptEnabled = msg.data.enabled;
            _httpScrollEnabled = msg.data.scrollEnabled;
            _httpClickPatterns = msg.data.clickPatterns.filter(p => !msg.data.disabledClickPatterns.includes(p));
            _httpScrollConfig = {
                pauseScrollMs: msg.data.scrollPauseMs || 7000,
                scrollIntervalMs: msg.data.scrollIntervalMs || 500,
                clickIntervalMs: msg.data.clickIntervalMs || 1000
            };

            writeConfigJson(context);
            updateStatusBarItem();
            vscode.window.setStatusBarMessage('$(check) [Nexus Autopilot] ✅ บันทึกการตั้งค่าเรียบร้อย!', 3000);
            return;
        }
        if (msg.command === 'reload' || msg.command === 'refreshData') {
            const config = getAutopilotConfig();
            panel.webview.postMessage({
                command: 'dataRefreshed',
                config: {
                    enabled: config.get('enabled', true),
                    scrollEnabled: config.get('scrollEnabled', true),
                    scrollPauseMs: config.get('scrollPauseMs', 7000),
                    scrollIntervalMs: config.get('scrollIntervalMs', 500),
                    clickIntervalMs: config.get('clickIntervalMs', 1000),
                    clickPatterns: config.get('clickPatterns', ['Allow', 'Always Allow', 'Run', 'Keep Waiting', 'Accept', 'Submit', 'Yes, allow this time', 'Yes, and always allow', 'Retry', 'Continue', 'Allow Once', 'Allow This Conversion', 'Accept all']),
                    disabledClickPatterns: context.globalState.get('disabledClickPatterns', ['Accept all']),
                    clickStats: _clickStats,
                    totalClicks: _totalClicks,
                    actualPort: _actualPort,
                    clickLog: _clickLog
                }
            });
            vscode.window.setStatusBarMessage('$(sync) [Nexus Autopilot] 🔄 รีเฟรชข้อมูลแดชบอร์ดเรียบร้อย!', 2500);
            return;
        }
        if (msg.command === 'resetStats') {
            _clickStats = {};
            _totalClicks = 0;
            _resetStatsRequested = true;
            context.globalState.update('clickStats', {});
            context.globalState.update('totalClicks', 0);
            panel.webview.postMessage({ command: 'statsUpdated', clickStats: {}, totalClicks: 0 });
        }
        if (msg.command === 'getClickLog') {
            panel.webview.postMessage({ command: 'clickLogUpdate', log: _clickLog });
            return;
        }
        if (msg.command === 'clearClickLog') {
            _clickLog = [];
            context.globalState.update('clickLog', []);
            panel.webview.postMessage({ command: 'clickLogUpdate', log: [] });
            return;
        }
        if (msg.command === 'getClickLog') {
            panel.webview.postMessage({ command: 'clickLogUpdate', log: _clickLog });
        }
        if (msg.command === 'getStats') {
            panel.webview.postMessage({ command: 'statsUpdated', clickStats: _clickStats, totalClicks: _totalClicks });
        }
    }, undefined, context.subscriptions);

    const statsTimer = setInterval(() => {
        try {
            panel.webview.postMessage({
                command: 'statsUpdated',
                clickStats: _clickStats,
                totalClicks: _totalClicks,
                actualPort: _actualPort,
                clickLog: _clickLog
            });
        } catch (_) { clearInterval(statsTimer); }
    }, 2000);
    panel.onDidDispose(() => clearInterval(statsTimer));
}

/**
 * ฟังก์ชันสร้าง HTML สำหรับ Settings Webview สไตล์ Cyberpunk Glassmorphism พร้อม Balanced 2-Column Grid & Sticky Footer
 */
function getSettingsHtml(cfg) {
    const patternsBase64 = Buffer.from(JSON.stringify(cfg.clickPatterns || [])).toString('base64');
    const disabledPatternsBase64 = Buffer.from(JSON.stringify(cfg.disabledClickPatterns || [])).toString('base64');
    const initialStatsBase64 = Buffer.from(JSON.stringify(cfg.clickStats || {})).toString('base64');
    const initialLogBase64 = Buffer.from(JSON.stringify(cfg.clickLog || [])).toString('base64');

    return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nexus Autopilot Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
    :root {
        --bg-dark: #07090e;
        --card-bg: rgba(15, 23, 42, 0.75);
        --card-border: rgba(255, 255, 255, 0.08);
        --card-hover: rgba(56, 189, 248, 0.25);
        --neon-cyan: #00f2fe;
        --neon-blue: #38bdf8;
        --neon-purple: #a855f7;
        --neon-green: #10b981;
        --neon-amber: #f59e0b;
        --neon-rose: #f43f5e;
        --text-primary: #f8fafc;
        --text-secondary: #94a3b8;
        --text-muted: #64748b;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    
    body {
        font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
        background-color: var(--bg-dark);
        background-image: 
            radial-gradient(at 0% 0%, rgba(0, 242, 254, 0.08) 0px, transparent 50%),
            radial-gradient(at 100% 0%, rgba(168, 85, 247, 0.08) 0px, transparent 50%),
            radial-gradient(at 50% 100%, rgba(15, 23, 42, 0.8) 0px, transparent 50%);
        color: var(--text-primary);
        padding: 24px 24px 100px 24px;
        line-height: 1.5;
        min-height: 100vh;
    }

    .container {
        max-width: 1140px;
        margin: 0 auto;
    }

    /* Header */
    .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 24px;
        padding-bottom: 20px;
        border-bottom: 1px solid var(--card-border);
        flex-wrap: wrap;
        gap: 16px;
    }

    .brand {
        display: flex;
        align-items: center;
        gap: 16px;
    }

    .brand-icon {
        width: 48px;
        height: 48px;
        border-radius: 12px;
        background: linear-gradient(135deg, rgba(0,242,254,0.2), rgba(168,85,247,0.2));
        border: 1px solid rgba(0, 242, 254, 0.4);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 24px;
        box-shadow: 0 0 16px rgba(0, 242, 254, 0.2);
    }

    .brand-text h1 {
        font-size: 1.75em;
        font-weight: 800;
        background: linear-gradient(135deg, #00f2fe 0%, #38bdf8 50%, #a855f7 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        letter-spacing: -0.5px;
    }

    .brand-text p {
        color: var(--text-secondary);
        font-size: 0.88em;
    }

    .header-badges {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
    }

    .version-pill {
        display: inline-flex;
        align-items: center;
        background: linear-gradient(135deg, rgba(0, 242, 254, 0.15), rgba(168, 85, 247, 0.15));
        border: 1px solid rgba(0, 242, 254, 0.45);
        color: #00f2fe;
        padding: 3px 10px;
        border-radius: 20px;
        font-size: 0.76em;
        font-weight: 700;
        font-family: 'JetBrains Mono', monospace;
        letter-spacing: 0.5px;
        box-shadow: 0 0 12px rgba(0, 242, 254, 0.25);
    }

    .status-pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        background: rgba(16, 185, 129, 0.1);
        border: 1px solid rgba(16, 185, 129, 0.3);
        color: #34d399;
        padding: 6px 14px;
        border-radius: 24px;
        font-size: 0.82em;
        font-weight: 600;
        box-shadow: 0 0 10px rgba(16, 185, 129, 0.15);
    }

    .pulse-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #34d399;
        box-shadow: 0 0 8px #34d399;
        animation: pulse 2s infinite;
    }

    @keyframes pulse {
        0% { transform: scale(0.95); opacity: 0.8; }
        50% { transform: scale(1.3); opacity: 1; box-shadow: 0 0 12px #34d399; }
        100% { transform: scale(0.95); opacity: 0.8; }
    }

    .port-pill {
        background: rgba(56, 189, 248, 0.1);
        border: 1px solid rgba(56, 189, 248, 0.3);
        color: #38bdf8;
        padding: 6px 14px;
        border-radius: 24px;
        font-size: 0.82em;
        font-weight: 600;
        font-family: 'JetBrains Mono', monospace;
    }

    /* KPI Grid */
    .kpi-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 14px;
        margin-bottom: 24px;
    }

    @media (max-width: 900px) { .kpi-grid { grid-template-columns: repeat(2, 1fr); } }
    @media (max-width: 500px) { .kpi-grid { grid-template-columns: 1fr; } }

    .kpi-card {
        background: var(--card-bg);
        backdrop-filter: blur(16px);
        border: 1px solid var(--card-border);
        border-radius: 14px;
        padding: 16px;
        position: relative;
        overflow: hidden;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .kpi-card:hover {
        border-color: var(--card-hover);
        transform: translateY(-2px);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    }

    .kpi-card::before {
        content: '';
        position: absolute;
        top: 0; left: 0; right: 0; height: 2px;
        background: linear-gradient(90deg, transparent, rgba(56, 189, 248, 0.5), transparent);
    }

    .kpi-label {
        font-size: 0.78em;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--text-secondary);
        font-weight: 600;
        margin-bottom: 6px;
    }

    .kpi-val {
        font-size: 1.65em;
        font-weight: 800;
        color: #fff;
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .kpi-val.glow {
        background: linear-gradient(135deg, #00f2fe, #38bdf8);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
    }

    .kpi-sub {
        font-size: 0.75em;
        color: var(--text-muted);
        margin-top: 4px;
    }

    /* Responsive 2-Column Grids */
    .analytics-grid, .features-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 20px;
        margin-bottom: 20px;
        align-items: start;
    }

    @media (max-width: 960px) {
        .analytics-grid, .features-grid {
            grid-template-columns: 1fr;
        }
    }

    .card {
        background: var(--card-bg);
        backdrop-filter: blur(16px);
        border: 1px solid var(--card-border);
        border-radius: 14px;
        padding: 20px;
        transition: border-color 0.2s;
    }

    .card:hover { border-color: rgba(255, 255, 255, 0.15); }

    .card-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 16px;
    }

    .card-title {
        font-size: 1.05em;
        font-weight: 700;
        color: #f1f5f9;
        display: flex;
        align-items: center;
        gap: 10px;
    }

    .card-title-icon { color: var(--neon-blue); }

    /* Controls & Form fields */
    .field-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 0;
        border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }

    .field-row:last-child { border-bottom: none; }

    .field-text .field-label {
        font-size: 0.9em;
        font-weight: 600;
        color: #f8fafc;
    }

    .field-text .field-desc {
        font-size: 0.78em;
        color: var(--text-secondary);
        margin-top: 2px;
    }

    /* Custom Number Input */
    .num-input-wrap {
        display: flex;
        align-items: center;
        gap: 6px;
    }

    input[type="number"] {
        width: 105px;
        padding: 7px 12px;
        background: rgba(10, 15, 29, 0.8);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 8px;
        color: #f8fafc;
        font-family: 'JetBrains Mono', monospace;
        font-size: 0.88em;
        outline: none;
        transition: all 0.2s;
        text-align: right;
    }

    input[type="number"]:focus {
        border-color: var(--neon-blue);
        box-shadow: 0 0 10px rgba(56, 189, 248, 0.3);
    }

    .unit-label {
        font-size: 0.78em;
        color: var(--text-muted);
        min-width: 22px;
    }

    /* Toggle Switch */
    .toggle-switch {
        position: relative;
        width: 48px;
        height: 26px;
        cursor: pointer;
        flex-shrink: 0;
    }

    .toggle-switch input { display: none; }

    .toggle-slider {
        position: absolute;
        inset: 0;
        background: #1e293b;
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 26px;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .toggle-slider::before {
        content: '';
        position: absolute;
        top: 3px;
        left: 3px;
        width: 18px;
        height: 18px;
        background: #94a3b8;
        border-radius: 50%;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .toggle-switch input:checked + .toggle-slider {
        background: linear-gradient(135deg, #00f2fe, #38bdf8);
        border-color: transparent;
        box-shadow: 0 0 14px rgba(0, 242, 254, 0.4);
    }

    .toggle-switch input:checked + .toggle-slider::before {
        transform: translateX(22px);
        background: #0f172a;
    }

    /* Preset Buttons Bar */
    .presets-bar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 14px;
    }

    .btn-preset {
        padding: 7px 14px;
        background: rgba(15, 23, 42, 0.85);
        border: 1px solid rgba(56, 189, 248, 0.2);
        border-radius: 8px;
        color: #e2e8f0;
        font-size: 0.82em;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        display: inline-flex;
        align-items: center;
        gap: 6px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
    }

    .btn-preset:hover {
        background: linear-gradient(135deg, rgba(56, 189, 248, 0.25), rgba(0, 242, 254, 0.15));
        color: #00f2fe;
        border-color: #00f2fe;
        transform: translateY(-2px);
        box-shadow: 0 4px 16px rgba(0, 242, 254, 0.35);
    }

    /* Template Checklist Items */
    .template-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        background: rgba(10, 15, 29, 0.6);
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 8px;
        margin-bottom: 6px;
        transition: all 0.2s;
    }

    .template-item:hover {
        border-color: rgba(56, 189, 248, 0.35);
        background: rgba(15, 23, 42, 0.85);
        box-shadow: 0 2px 12px rgba(0, 0, 0, 0.25);
    }

    .template-left {
        display: flex;
        align-items: center;
        gap: 10px;
    }

    .template-checkbox {
        width: 17px;
        height: 17px;
        cursor: pointer;
        accent-color: #00f2fe;
    }

    .template-name {
        font-size: 0.88em;
        font-weight: 600;
        color: #f1f5f9;
    }

    .template-right {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .badge-status {
        font-size: 0.72em;
        padding: 3px 9px;
        border-radius: 4px;
        font-weight: 700;
        letter-spacing: 0.5px;
    }

    .badge-on { background: rgba(16, 185, 129, 0.18); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); box-shadow: 0 0 8px rgba(16, 185, 129, 0.2); }
    .badge-off { background: rgba(244, 63, 94, 0.18); color: #fb7185; border: 1px solid rgba(244, 63, 94, 0.4); }

    .btn-del-item {
        color: #64748b;
        cursor: pointer;
        font-size: 1.1em;
        padding: 0 4px;
        transition: color 0.15s;
    }

    .btn-del-item:hover { color: #f43f5e; }

    .add-pattern-row {
        display: flex;
        gap: 8px;
        margin-top: 12px;
    }

    .add-pattern-row input {
        flex: 1;
        padding: 8px 14px;
        background: rgba(10, 15, 29, 0.8);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 8px;
        color: #f8fafc;
        font-size: 0.85em;
        outline: none;
    }

    .add-pattern-row input:focus { border-color: var(--neon-blue); }

    .btn-add {
        background: rgba(56, 189, 248, 0.15);
        color: var(--neon-blue);
        border: 1px solid rgba(56, 189, 248, 0.3);
        border-radius: 8px;
        padding: 8px 16px;
        font-size: 0.85em;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
    }

    .btn-add:hover {
        background: var(--neon-blue);
        color: #090d16;
    }

    /* Live Distribution Progress Bars */
    .dist-row { margin-bottom: 12px; }
    .dist-row:last-child { margin-bottom: 0; }

    .dist-info {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 0.82em;
        margin-bottom: 4px;
    }

    .dist-name { font-weight: 600; color: #e2e8f0; display: flex; align-items: center; gap: 6px; }
    .dist-count { color: var(--text-secondary); font-family: 'JetBrains Mono', monospace; }

    .progress-track {
        height: 10px;
        background: rgba(15, 23, 42, 0.8);
        border-radius: 6px;
        overflow: hidden;
        border: 1px solid rgba(255, 255, 255, 0.05);
    }

    .progress-fill {
        height: 100%;
        border-radius: 6px;
        transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .bar-0 { background: linear-gradient(90deg, #00f2fe, #38bdf8); }
    .bar-1 { background: linear-gradient(90deg, #a855f7, #c084fc); }
    .bar-2 { background: linear-gradient(90deg, #10b981, #34d399); }
    .bar-3 { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
    .bar-4 { background: linear-gradient(90deg, #f43f5e, #fb7185); }
    .bar-5 { background: linear-gradient(90deg, #ec4899, #f472b6); }

    /* Live Activity Log Stream */
    .log-filter-bar {
        display: flex;
        gap: 10px;
        margin-bottom: 14px;
        align-items: center;
        flex-wrap: wrap;
    }

    .log-search-wrap { flex: 1; min-width: 180px; }

    .log-search-wrap input {
        width: 100%;
        padding: 9px 14px;
        background: rgba(10, 15, 29, 0.85);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 8px;
        color: #f8fafc;
        font-size: 0.86em;
        outline: none;
        transition: all 0.2s;
    }

    .log-search-wrap input:focus {
        border-color: var(--neon-blue);
        box-shadow: 0 0 10px rgba(56, 189, 248, 0.3);
    }

    .log-select-wrap { display: flex; gap: 8px; }

    .log-select-wrap select {
        padding: 9px 12px;
        background: rgba(10, 15, 29, 0.85);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 8px;
        color: #f8fafc;
        font-size: 0.84em;
        outline: none;
        cursor: pointer;
        transition: all 0.2s;
    }

    .log-select-wrap select:focus {
        border-color: var(--neon-blue);
        box-shadow: 0 0 10px rgba(56, 189, 248, 0.3);
    }

    .log-count-badge {
        background: rgba(56, 189, 248, 0.15);
        border: 1px solid rgba(56, 189, 248, 0.4);
        color: #00f2fe;
        padding: 3px 10px;
        border-radius: 14px;
        font-size: 0.76em;
        font-weight: 700;
        font-family: 'JetBrains Mono', monospace;
        letter-spacing: 0.5px;
        box-shadow: 0 0 10px rgba(0, 242, 254, 0.2);
    }

    .log-box {
        background: #05070c;
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 10px;
        height: 480px;
        max-height: 520px;
        overflow-y: auto;
        padding: 12px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 0.9em;
    }

    .log-item {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 10px 14px;
        border-radius: 8px;
        background: rgba(10, 15, 29, 0.6);
        border: 1px solid rgba(255, 255, 255, 0.05);
        margin-bottom: 8px;
        transition: all 0.15s;
    }

    .log-item:hover {
        background: rgba(15, 23, 42, 0.95);
        border-color: rgba(56, 189, 248, 0.3);
    }

    .log-header-line {
        display: flex;
        align-items: center;
        justify-content: space-between;
    }

    .log-time { color: #94a3b8; font-size: 0.88em; font-weight: 600; font-family: 'JetBrains Mono', monospace; }
    
    .log-badge {
        background: rgba(56, 189, 248, 0.15);
        color: #38bdf8;
        padding: 3px 10px;
        border-radius: 6px;
        font-size: 0.95em;
        font-weight: 700;
        border: 1px solid rgba(56, 189, 248, 0.3);
        display: inline-block;
    }

    .log-badge.badge-Submit { background: rgba(0, 242, 254, 0.18); color: #00f2fe; border-color: rgba(0, 242, 254, 0.45); box-shadow: 0 0 12px rgba(0, 242, 254, 0.25); }
    .log-badge.badge-Run { background: rgba(16, 185, 129, 0.18); color: #34d399; border-color: rgba(16, 185, 129, 0.45); box-shadow: 0 0 12px rgba(16, 185, 129, 0.25); }
    .log-badge.badge-Allow, .log-badge.badge-Allow_Once, .log-badge.badge-Allow_This_Conversion { background: rgba(56, 189, 248, 0.18); color: #38bdf8; border-color: rgba(56, 189, 248, 0.45); box-shadow: 0 0 12px rgba(56, 189, 248, 0.25); }
    .log-badge.badge-Always_Allow, .log-badge.badge-Yes__and_always_allow { background: rgba(99, 102, 241, 0.18); color: #818cf8; border-color: rgba(99, 102, 241, 0.45); box-shadow: 0 0 12px rgba(99, 102, 241, 0.25); }
    .log-badge.badge-Accept, .log-badge.badge-Accept_all { background: rgba(168, 85, 247, 0.18); color: #c084fc; border-color: rgba(168, 85, 247, 0.45); box-shadow: 0 0 12px rgba(168, 85, 247, 0.25); }
    .log-badge.badge-Keep_Waiting { background: rgba(245, 158, 11, 0.18); color: #fbbf24; border-color: rgba(245, 158, 11, 0.45); box-shadow: 0 0 12px rgba(245, 158, 11, 0.25); }
    .log-badge.badge-Retry { background: rgba(244, 63, 94, 0.18); color: #fb7185; border-color: rgba(244, 63, 94, 0.45); box-shadow: 0 0 12px rgba(244, 63, 94, 0.25); }
    .log-badge.badge-Continue { background: rgba(20, 184, 166, 0.18); color: #2dd4bf; border-color: rgba(20, 184, 166, 0.45); box-shadow: 0 0 12px rgba(20, 184, 166, 0.25); }
    .log-badge.badge-Yes__allow_this_time { background: rgba(14, 165, 233, 0.18); color: #38bdf8; border-color: rgba(14, 165, 233, 0.45); box-shadow: 0 0 12px rgba(14, 165, 233, 0.25); }

    .log-question {
        font-size: 0.92em;
        color: #f1f5f9;
        margin-top: 2px;
        line-height: 1.45;
        word-break: break-all;
    }

    .log-cmd-snippet {
        margin-top: 4px;
        padding: 6px 10px;
        background: rgba(56, 189, 248, 0.08);
        border-left: 2px solid #38bdf8;
        border-radius: 6px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 0.9em;
        color: #7dd3fc;
        word-break: break-all;
        white-space: pre-wrap;
        line-height: 1.4;
    }

    .log-answer {
        font-size: 0.88em;
        color: #34d399;
        margin-top: 2px;
        line-height: 1.4;
        padding: 4px 10px;
        background: rgba(16, 185, 129, 0.1);
        border-radius: 6px;
        border-left: 2px solid #34d399;
        word-break: break-all;
    }

    .log-target {
        color: #f8fafc;
        font-size: 0.92em;
        margin-top: 3px;
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
    }

    /* Sticky Footer Bar */
    .sticky-footer {
        position: fixed;
        bottom: 0;
        left: 0;
        right: 0;
        background: rgba(7, 9, 14, 0.85);
        backdrop-filter: blur(20px);
        border-top: 1px solid rgba(255, 255, 255, 0.12);
        padding: 14px 24px;
        z-index: 999;
        box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.6);
    }

    .footer-inner {
        max-width: 1140px;
        margin: 0 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 12px;
    }

    .btn-group { display: flex; align-items: center; gap: 10px; }

    .btn {
        padding: 10px 22px;
        border-radius: 8px;
        font-size: 0.88em;
        font-weight: 700;
        cursor: pointer;
        transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border: none;
        outline: none;
        font-family: inherit;
    }

    .btn-save {
        background: linear-gradient(135deg, #00f2fe 0%, #38bdf8 50%, #6366f1 100%);
        color: #040813;
        box-shadow: 0 4px 20px rgba(0, 242, 254, 0.4);
    }

    .btn-save:hover {
        transform: translateY(-2px);
        box-shadow: 0 6px 28px rgba(0, 242, 254, 0.65);
        filter: brightness(1.1);
    }

    .btn-outline {
        background: rgba(15, 23, 42, 0.85);
        color: #94a3b8;
        border: 1px solid rgba(56, 189, 248, 0.25);
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
    }

    .btn-outline:hover {
        background: rgba(56, 189, 248, 0.18);
        color: #00f2fe;
        border-color: #00f2fe;
        transform: translateY(-1px);
        box-shadow: 0 4px 14px rgba(0, 242, 254, 0.3);
    }

    .empty-state {
        color: var(--text-muted);
        text-align: center;
        padding: 30px 10px;
        font-size: 0.85em;
        font-style: italic;
    }
</style>
</head>
<body>
<div class="container">
    <!-- Header -->
    <div class="header">
        <div class="brand">
            ${cfg.iconUri ? `<img src="${cfg.iconUri}" alt="Nexus Autopilot" style="width: 52px; height: 52px; border-radius: 14px; object-fit: cover; box-shadow: 0 4px 16px rgba(0, 242, 254, 0.35); border: 1px solid rgba(0, 242, 254, 0.4); flex-shrink: 0;">` : `<div class="brand-icon">⚡</div>`}
            <div class="brand-text">
                <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                    <h1>Nexus Autopilot</h1>
                    <span class="version-pill">v${cfg.version || '1.1.4'}</span>
                </div>
                <p>ระบบคลิกปุ่มและเลื่อนหน้าจออัตโนมัติสำหรับ Google Antigravity & VS Code • <span style="color: #38bdf8; font-weight: 600;">พัฒนาโดย Jakkrich Changgon</span></p>
            </div>
        </div>
        <div class="header-badges">
            <div class="status-pill" id="livePill">
                <div class="pulse-dot"></div>
                <span>พร้อมทำงาน (Active)</span>
            </div>
            <div class="port-pill" id="portPill">Port: ${cfg.actualPort || 48787}</div>
        </div>
    </div>

    <!-- 4 KPI Summary Cards -->
    <div class="kpi-grid">
        <div class="kpi-card">
            <div class="kpi-label">จำนวนการคลิกทั้งหมด</div>
            <div class="kpi-val glow" id="kpiTotalClicks">${cfg.totalClicks || 0}</div>
            <div class="kpi-sub">🎯 ยอดคลิกสะสมทุกเซสชัน</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-label">สถานะระบบหลัก</div>
            <div class="kpi-val" id="kpiMasterStatus" style="font-size: 1.25em; color: ${cfg.enabled ? '#34d399' : '#f43f5e'};">
                ${cfg.enabled ? '🟢 เปิดทำงาน' : '🔴 ปิดอยู่'}
            </div>
            <div class="kpi-sub">สวิตช์ควบคุมระบบหลัก</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-label">ระบบ Auto Scroll</div>
            <div class="kpi-val" id="kpiScrollStatus" style="font-size: 1.25em; color: ${cfg.scrollEnabled ? '#38bdf8' : '#64748b'};">
                ${cfg.scrollEnabled ? '📜 เลื่อนอัตโนมัติ' : '⏸️ หยุดชั่วคราว'}
            </div>
            <div class="kpi-sub">หน่วงเวลา: ${cfg.scrollPauseMs} ms</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-label">ความเร็วการสแกน</div>
            <div class="kpi-val" style="font-size: 1.25em; color: #c084fc;">
                ${cfg.clickIntervalMs} <span style="font-size: 0.6em; color: var(--text-muted);">ms</span>
            </div>
            <div class="kpi-sub">ความเร็วเลื่อนจอ: ${cfg.scrollIntervalMs} ms</div>
        </div>
    </div>

    <!-- ROW 1: สถิติการคลิกแยกตามปุ่ม & บันทึกประวัติการคลิก (2 Columns on Desktop, 1 on Mobile) -->
    <div class="analytics-grid">
        <!-- 1. Click Distribution Progress Bars -->
        <div class="card">
            <div class="card-header">
                <div class="card-title">
                    <span class="card-title-icon">📊</span> สถิติการคลิกแยกตามปุ่ม
                </div>
                <button class="btn btn-outline" style="padding: 4px 10px; font-size: 0.75em;" onclick="resetStats()">
                    🔄 รีเซ็ต
                </button>
            </div>
            <div id="distributionContainer"></div>
        </div>

        <!-- 2. Live Activity Stream Log -->
        <div class="card">
            <div class="card-header">
                <div class="card-title">
                    <span class="card-title-icon">📡</span> บันทึกประวัติการคลิก (Click Log)
                </div>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span id="logCountBadge" class="log-count-badge">0/0</span>
                    <button class="btn btn-outline" style="padding: 4px 10px; font-size: 0.75em;" onclick="clearClickLog()">
                        🧹 ล้างประวัติ
                    </button>
                </div>
            </div>

            <div class="log-filter-bar">
                <div class="log-search-wrap">
                    <input type="text" id="logSearchInput" placeholder="🔍 ค้นหาตามข้อความปุ่ม, ชนิด, คำสั่ง, เวลา..." oninput="renderFilteredLog()">
                </div>
                <div class="log-select-wrap">
                    <select id="logPatternSelect" onchange="renderFilteredLog()">
                        <option value="ALL">ทุกประเภท (All)</option>
                    </select>
                    <select id="logLimitSelect" onchange="renderFilteredLog()">
                        <option value="10">10 แถว</option>
                        <option value="30" selected>30 แถว</option>
                        <option value="100">100 แถว</option>
                    </select>
                </div>
            </div>

            <div class="log-box" id="logContainer"></div>
        </div>
    </div>

    <!-- ROW 2: 2 Feature Config Boxes (Auto Click & Auto Scroll) (2 Columns on Desktop, 1 on Mobile) -->
    <div class="features-grid">
        <!-- BOX 1: 🎯 Auto Click -->
        <div class="card">
            <div class="card-header">
                <div class="card-title">
                    <span class="card-title-icon">🎯</span> ระบบคลิกอัตโนมัติ (Auto Click)
                </div>
                <label class="toggle-switch">
                    <input type="checkbox" id="masterToggle" ${cfg.enabled ? 'checked' : ''} onchange="onMasterToggle(this.checked)">
                    <span class="toggle-slider"></span>
                </label>
            </div>

            <!-- Click Interval -->
            <div class="field-row">
                <div class="field-text">
                    <div class="field-label">ความถี่สแกนปุ่มคลิก (Click Interval)</div>
                    <div class="field-desc">ช่วงเวลาตรวจหาปุ่ม Run/Allow/Accept/Submit ในแชต</div>
                </div>
                <div class="num-input-wrap">
                    <input type="number" id="clickIntervalMs" value="${cfg.clickIntervalMs}" step="100" min="200">
                    <span class="unit-label">ms</span>
                </div>
            </div>

            <!-- Presets Bar -->
            <div style="margin-top: 16px; margin-bottom: 8px;">
                <div style="font-size: 0.85em; font-weight: 700; color: #f1f5f9; margin-bottom: 8px;">เทมเพลตปุ่มอัตโนมัติ (Button Templates)</div>
                <div class="presets-bar">
                    <button class="btn-preset" onclick="applyPreset('standard')">⚡ มาตรฐาน</button>
                    <button class="btn-preset" onclick="applyPreset('full')">🚀 ปลดล็อกทั้งหมด</button>
                    <button class="btn-preset" onclick="applyPreset('safe')">🛡️ ปลอดภัย</button>
                    <button class="btn-preset" onclick="applyPreset('reset')">🔄 คืนค่าเริ่มต้น</button>
                </div>
            </div>

            <!-- Template Checklist Items Container -->
            <div id="templateListContainer"></div>

            <!-- Add Custom Pattern -->
            <div class="add-pattern-row">
                <input type="text" id="newPatternInput" placeholder="พิมพ์ข้อความปุ่ม เช่น Accept all, Retry...">
                <button class="btn-add" onclick="addPattern()">+ เพิ่มปุ่ม</button>
            </div>

            <div style="margin-top: 14px; padding: 12px; background: rgba(0, 242, 254, 0.05); border: 1px solid rgba(0, 242, 254, 0.15); border-radius: 8px;">
                <p style="font-size: 0.78em; color: #38bdf8; line-height: 1.4;">
                    🛡️ <strong>ความปลอดภัยสูง:</strong> ปุ่ม Accept จะถูกคลิกเฉพาะในหน้าต่างแชตเท่านั้น โดยไม่คลิกใน Diff Editor เด็ดขาด
                </p>
            </div>
        </div>

        <!-- BOX 2: 📜 Auto Scroll -->
        <div class="card">
            <div class="card-header">
                <div class="card-title">
                    <span class="card-title-icon">📜</span> ระบบเลื่อนจออัตโนมัติ (Auto Scroll)
                </div>
                <label class="toggle-switch">
                    <input type="checkbox" id="scrollToggle" ${cfg.scrollEnabled ? 'checked' : ''} onchange="onScrollToggle(this.checked)">
                    <span class="toggle-slider"></span>
                </label>
            </div>

            <!-- Scroll Pause Time -->
            <div class="field-row">
                <div class="field-text">
                    <div class="field-label">หน่วงเวลาเมื่อเลื่อนจอด้วยมือ (Scroll Pause)</div>
                    <div class="field-desc">หยุดเลื่อนชั่วคราวเพื่อให้คุณอ่านข้อความด้านบนได้สะดวก</div>
                </div>
                <div class="num-input-wrap">
                    <input type="number" id="scrollPauseMs" value="${cfg.scrollPauseMs}" step="500" min="1000">
                    <span class="unit-label">ms</span>
                </div>
            </div>

            <!-- Scroll Interval -->
            <div class="field-row">
                <div class="field-text">
                    <div class="field-label">ความถี่การเลื่อนจอ (Scroll Interval)</div>
                    <div class="field-desc">ค่าน้อย = เลื่อนนุ่มนวลขึ้นแต่ใช้พลังประมวลผลเพิ่มขึ้นเล็กน้อย</div>
                </div>
                <div class="num-input-wrap">
                    <input type="number" id="scrollIntervalMs" value="${cfg.scrollIntervalMs}" step="50" min="100">
                    <span class="unit-label">ms</span>
                </div>
            </div>

            <div style="margin-top: 16px; padding: 14px; background: rgba(56, 189, 248, 0.05); border: 1px solid rgba(56, 189, 248, 0.15); border-radius: 10px;">
                <div style="font-size: 0.85em; font-weight: 700; color: #38bdf8; margin-bottom: 6px;">💡 Smart Stick-to-Bottom:</div>
                <p style="font-size: 0.78em; color: var(--text-secondary); line-height: 1.5;">
                    • หากหน้าจออยู่ที่ขอบล่าง ➔ ระบบจะเลื่อนหน้าต่างแชตลงอัตโนมัติตามที่ AI กำลังพิมพ์<br/>
                    • หากคุณเลื่อนหน้าจอขึ้นเพื่ออ่านข้อความเดิม ➔ ระบบจะหยุดเลื่อนอัตโนมัติทันทีเพื่อให้คุณอ่านได้อย่างต่อเนื่อง
                </p>
            </div>
        </div>
    </div>
</div>

<!-- Sticky Bottom Footer Bar -->
<div class="sticky-footer">
    <div class="footer-inner">
        <div class="btn-group">
            <button class="btn btn-outline" onclick="reloadData()">🔄 รีโหลดข้อมูล (Reload Data)</button>
            <button class="btn btn-outline" onclick="resetStats()">🔄 รีเซ็ตสถิติ</button>
        </div>
        <div style="font-size: 0.82em; color: var(--text-muted); text-align: center;">Nexus Autopilot <span style="color: #38bdf8; font-weight: 700;">v${cfg.version || '1.1.4'}</span> • พัฒนาโดย <span style="color: #38bdf8; font-weight: 600;">Jakkrich Changgon</span></div>
        <div class="btn-group">
            <button class="btn btn-save" onclick="saveSettings()">💾 บันทึกและนำไปใช้ (Save & Apply)</button>
        </div>
    </div>
</div>

<script>
    const vscode = acquireVsCodeApi();
    
    const DEFAULT_TEMPLATES = [
        'Run',
        'Allow',
        'Accept',
        'Always Allow',
        'Keep Waiting',
        'Submit',
        'Yes, allow this time',
        'Yes, and always allow',
        'Retry',
        'Continue',
        'Allow Once',
        'Allow This Conversion',
        'Accept all'
    ];
    const DEFAULT_DISABLED = ['Accept all'];

    function safeB64Decode(b64, fallback) {
        try {
            var str = decodeURIComponent(escape(atob(b64)));
            return JSON.parse(str);
        } catch (_) {
            try {
                return JSON.parse(atob(b64));
            } catch (_) {
                return fallback;
            }
        }
    }

    let patterns = safeB64Decode("${patternsBase64}", []);
    let disabledPatterns = safeB64Decode("${disabledPatternsBase64}", []);
    let clickStats = safeB64Decode("${initialStatsBase64}", {});
    let clickLog = safeB64Decode("${initialLogBase64}", []);

    // Ensure all default templates are present in the list
    DEFAULT_TEMPLATES.forEach(p => {
        if (patterns.indexOf(p) === -1 && disabledPatterns.indexOf(p) === -1) {
            if (DEFAULT_DISABLED.indexOf(p) !== -1) {
                disabledPatterns.push(p);
            } else {
                patterns.push(p);
            }
        }
    });

    function renderTemplates() {
        const container = document.getElementById('templateListContainer');
        container.innerHTML = '';

        const allItems = [];
        const seen = {};
        DEFAULT_TEMPLATES.concat(patterns).concat(disabledPatterns).forEach(p => {
            if (!seen[p]) { seen[p] = true; allItems.push(p); }
        });

        allItems.forEach(p => {
            const isOn = patterns.indexOf(p) !== -1;
            const isCustom = DEFAULT_TEMPLATES.indexOf(p) === -1;

            const row = document.createElement('div');
            row.className = 'template-item';

            row.innerHTML = 
                '<div class="template-left">' +
                    '<input type="checkbox" class="template-checkbox" ' + (isOn ? 'checked' : '') + '>' +
                    '<span class="template-name">' + p + '</span>' +
                '</div>' +
                '<div class="template-right">' +
                    '<span class="badge-status ' + (isOn ? 'badge-on' : 'badge-off') + '">' + (isOn ? 'ON' : 'OFF') + '</span>' +
                    (isCustom ? '<span class="btn-del-item" title="ลบ">&times;</span>' : '') +
                '</div>';

            const checkbox = row.querySelector('.template-checkbox');
            checkbox.onchange = () => togglePattern(p);

            const delBtn = row.querySelector('.btn-del-item');
            if (delBtn) {
                delBtn.onclick = (e) => {
                    e.stopPropagation();
                    removePattern(p);
                };
            }

            container.appendChild(row);
        });
    }

    function togglePattern(p) {
        if (patterns.indexOf(p) !== -1) {
            patterns = patterns.filter(x => x !== p);
            if (disabledPatterns.indexOf(p) === -1) disabledPatterns.push(p);
        } else {
            disabledPatterns = disabledPatterns.filter(x => x !== p);
            if (patterns.indexOf(p) === -1) patterns.push(p);
        }
        renderTemplates();
    }

    function removePattern(p) {
        patterns = patterns.filter(x => x !== p);
        disabledPatterns = disabledPatterns.filter(x => x !== p);
        renderTemplates();
    }

    function addPattern() {
        const input = document.getElementById('newPatternInput');
        const val = (input.value || '').trim();
        if (val && patterns.indexOf(val) === -1 && disabledPatterns.indexOf(val) === -1) {
            patterns.push(val);
            input.value = '';
            renderTemplates();
        }
    }

    function applyPreset(type) {
        if (type === 'standard') {
            patterns = ['Run', 'Allow', 'Always Allow', 'Keep Waiting', 'Accept', 'Submit', 'Yes, allow this time'];
            disabledPatterns = ['Yes, and always allow', 'Retry', 'Continue', 'Allow Once', 'Allow This Conversion', 'Accept all'];
        } else if (type === 'full') {
            patterns = ['Run', 'Allow', 'Always Allow', 'Keep Waiting', 'Accept', 'Submit', 'Yes, allow this time', 'Yes, and always allow', 'Retry', 'Continue', 'Allow Once', 'Allow This Conversion'];
            disabledPatterns = ['Accept all'];
        } else if (type === 'safe') {
            patterns = ['Run', 'Allow', 'Accept'];
            disabledPatterns = ['Always Allow', 'Keep Waiting', 'Submit', 'Yes, allow this time', 'Yes, and always allow', 'Retry', 'Continue', 'Allow Once', 'Allow This Conversion', 'Accept all'];
        } else if (type === 'reset') {
            patterns = ['Run', 'Allow', 'Always Allow', 'Keep Waiting', 'Accept', 'Submit', 'Yes, allow this time', 'Yes, and always allow'];
            disabledPatterns = ['Retry', 'Continue', 'Allow Once', 'Allow This Conversion', 'Accept all'];
        }
        renderTemplates();
    }

    function renderDistribution() {
        const container = document.getElementById('distributionContainer');
        const keys = Object.keys(clickStats);
        if (keys.length === 0) {
            container.innerHTML = '<div class="empty-state">ยังไม่มีข้อมูลการคลิกอัตโนมัติในเซสชันนี้</div>';
            return;
        }

        let maxCount = 1;
        let topKey = '';
        keys.forEach(k => {
            if (clickStats[k] > maxCount) {
                maxCount = clickStats[k];
                topKey = k;
            }
        });

        let total = 0;
        keys.forEach(k => { total += clickStats[k]; });

        let html = '';
        keys.sort((a,b) => clickStats[b] - clickStats[a]).forEach((k, idx) => {
            const count = clickStats[k];
            const pct = Math.min(100, Math.round((count / (maxCount || 1)) * 100));
            const isCrown = k === topKey && count > 0;
            const barClass = 'bar-' + (idx % 6);

            html += '<div class="dist-row">' +
                '<div class="dist-info">' +
                '<span class="dist-name">' + (isCrown ? '👑 ' : '') + k + '</span>' +
                '<span class="dist-count">' + count + ' ครั้ง</span>' +
                '</div>' +
                '<div class="progress-track">' +
                '<div class="progress-fill ' + barClass + '" style="width: ' + pct + '%;"></div>' +
                '</div>' +
                '</div>';
        });
        container.innerHTML = html;
    }

    function updatePatternDropdown() {
        const select = document.getElementById('logPatternSelect');
        if (!select) return;
        const currentVal = select.value || 'ALL';
        const distinctPatterns = [];
        if (clickLog && clickLog.length > 0) {
            clickLog.forEach(e => {
                const p = e.pattern || 'Click';
                if (distinctPatterns.indexOf(p) === -1) distinctPatterns.push(p);
            });
        }
        let html = '<option value="ALL">ทุกประเภท (All Patterns)</option>';
        distinctPatterns.forEach(p => {
            html += '<option value="' + p + '"' + (currentVal === p ? ' selected' : '') + '>' + p + '</option>';
        });
        select.innerHTML = html;
    }

    function renderFilteredLog() {
        const container = document.getElementById('logContainer');
        const countBadge = document.getElementById('logCountBadge');
        if (!container) return;

        if (!clickLog || clickLog.length === 0) {
            container.innerHTML = '<div class="empty-state">ยังไม่มีกิจกรรมที่ถูกบันทึกในเซสชันนี้</div>';
            if (countBadge) countBadge.innerText = '0/0';
            return;
        }

        const query = (document.getElementById('logSearchInput')?.value || '').toLowerCase().trim();
        const selectedPattern = document.getElementById('logPatternSelect')?.value || 'ALL';
        const limit = parseInt(document.getElementById('logLimitSelect')?.value, 10) || 30;
        let filtered = clickLog.filter(entry => {
            const matchesPattern = (selectedPattern === 'ALL') || (entry.pattern === selectedPattern);
            if (!matchesPattern) return false;
            if (!query) return true;
            const textMatch = (entry.button || '').toLowerCase().includes(query);
            const patMatch = (entry.pattern || '').toLowerCase().includes(query);
            const timeMatch = (entry.time || '').toLowerCase().includes(query);
            const qMatch = (entry.question || '').toLowerCase().includes(query);
            const aMatch = (entry.answer || '').toLowerCase().includes(query);
            return textMatch || patMatch || timeMatch || qMatch || aMatch;
        });

        if (countBadge) {
            countBadge.innerText = Math.min(filtered.length, limit) + '/' + clickLog.length;
        }

        if (filtered.length === 0) {
            container.innerHTML = '<div class="empty-state">ไม่พบบันทึกที่ตรงกับเงื่อนไขการค้นหา</div>';
            return;
        }

        function escapeHtml(str) {
            return String(str || '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        let html = '';
        filtered.slice(0, limit).forEach(entry => {
            const pat = entry.pattern || 'Click';
            const safeClass = 'badge-' + pat.replace(/[^a-zA-Z0-9]/g, '_');
            const hasQ = entry.question && entry.question.trim().length > 0;
            const hasA = entry.answer && entry.answer.trim().length > 0;
            const btnText = (entry.button || pat || '').trim();

            let qHtml = '';
            if (hasQ) {
                const escapedQ = escapeHtml(entry.question);
                if (escapedQ.indexOf('➔') !== -1) {
                    const parts = escapedQ.split('➔');
                    const qMain = (parts[0] || '').trim();
                    const qCmd = parts.slice(1).join('➔').trim();
                    qHtml = '<div class="log-question">❓ <span style="color: #38bdf8; font-weight: 600;">คำถาม:</span> ' + qMain + 
                            (qCmd ? '<div class="log-cmd-snippet">➔ ' + qCmd + '</div>' : '') + '</div>';
                } else {
                    qHtml = '<div class="log-question" style="white-space: pre-wrap;">❓ <span style="color: #38bdf8; font-weight: 600;">คำถาม:</span> ' + escapedQ + '</div>';
                }
            }

            html += '<div class="log-item">' +
                '<div class="log-header-line">' +
                    '<span class="log-time">🕒 ' + escapeHtml(entry.time || '') + '</span>' +
                '</div>' +
                qHtml +
                (hasA ? '<div class="log-answer">✅ <span style="font-weight: 600;">เลือก:</span> ' + escapeHtml(entry.answer) + '</div>' : '') +
                '<div class="log-target">👉 <span class="log-badge ' + safeClass + '">[' + escapeHtml(btnText) + ']</span></div>' +
            '</div>';
        });
        container.innerHTML = html;
    }

    function renderLog() {
        updatePatternDropdown();
        renderFilteredLog();
    }

    function onMasterToggle(checked) {
        vscode.postMessage({ command: 'toggle', enabled: checked });
        const kpi = document.getElementById('kpiMasterStatus');
        if (kpi) {
            kpi.innerHTML = checked ? '🟢 เปิดทำงาน' : '🔴 ปิดอยู่';
            kpi.style.color = checked ? '#34d399' : '#f43f5e';
        }
    }

    function onScrollToggle(checked) {
        vscode.postMessage({ command: 'scrollToggle', enabled: checked });
        const kpi = document.getElementById('kpiScrollStatus');
        if (kpi) {
            kpi.innerHTML = checked ? '📜 เลื่อนอัตโนมัติ' : '⏸️ หยุดชั่วคราว';
            kpi.style.color = checked ? '#38bdf8' : '#64748b';
        }
    }

    function resetStats() {
        clickStats = {};
        const el = document.getElementById('kpiTotalClicks');
        if (el) el.innerText = '0';
        renderDistribution();
        vscode.postMessage({ command: 'resetStats' });
    }

    function clearClickLog() {
        clickLog = [];
        renderLog();
        vscode.postMessage({ command: 'clearClickLog' });
    }

    function reloadData() {
        vscode.postMessage({ command: 'refreshData' });
    }

    function showToast(msg) {
        let toast = document.getElementById('nexusToast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'nexusToast';
            toast.style.cssText = 'position:fixed;top:20px;right:20px;background:rgba(15,23,42,0.95);border:1px solid #00f2fe;color:#fff;padding:10px 20px;border-radius:10px;font-size:0.85em;font-weight:600;box-shadow:0 8px 24px rgba(0,242,254,0.3);z-index:99999;transition:all 0.3s cubic-bezier(0.4,0,0.2,1);opacity:0;transform:translateY(-10px);';
            document.body.appendChild(toast);
        }
        toast.innerText = msg;
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(-10px)';
        }, 2200);
    }

    function saveSettings() {
        const data = {
            enabled: document.getElementById('masterToggle').checked,
            scrollEnabled: document.getElementById('scrollToggle').checked,
            scrollPauseMs: parseInt(document.getElementById('scrollPauseMs').value, 10) || 7000,
            scrollIntervalMs: parseInt(document.getElementById('scrollIntervalMs').value, 10) || 500,
            clickIntervalMs: parseInt(document.getElementById('clickIntervalMs').value, 10) || 1000,
            clickPatterns: patterns,
            disabledClickPatterns: disabledPatterns
        };
        vscode.postMessage({ command: 'save', data: data });
        showToast('💾 บันทึกการตั้งค่าเรียบร้อยแล้ว!');
    }

    window.addEventListener('message', event => {
        const msg = event.data;
        if (msg.command === 'dataRefreshed') {
            const c = msg.config;
            if (c) {
                const elM = document.getElementById('masterToggle');
                if (elM) elM.checked = !!c.enabled;
                const elS = document.getElementById('scrollToggle');
                if (elS) elS.checked = !!c.scrollEnabled;
                const elP = document.getElementById('scrollPauseMs');
                if (elP) elP.value = c.scrollPauseMs || 7000;
                const elSi = document.getElementById('scrollIntervalMs');
                if (elSi) elSi.value = c.scrollIntervalMs || 500;
                const elCi = document.getElementById('clickIntervalMs');
                if (elCi) elCi.value = c.clickIntervalMs || 1000;

                patterns = c.clickPatterns || [];
                disabledPatterns = c.disabledClickPatterns || [];
                clickStats = c.clickStats || {};
                clickLog = c.clickLog || [];

                const kpiM = document.getElementById('kpiMasterStatus');
                if (kpiM) {
                    kpiM.innerHTML = c.enabled ? '🟢 เปิดทำงาน' : '🔴 ปิดอยู่';
                    kpiM.style.color = c.enabled ? '#34d399' : '#f43f5e';
                }
                const kpiS = document.getElementById('kpiScrollStatus');
                if (kpiS) {
                    kpiS.innerHTML = c.scrollEnabled ? '📜 เลื่อนอัตโนมัติ' : '⏸️ หยุดชั่วคราว';
                    kpiS.style.color = c.scrollEnabled ? '#38bdf8' : '#64748b';
                }
                const kpiT = document.getElementById('kpiTotalClicks');
                if (kpiT) kpiT.innerText = c.totalClicks || 0;

                renderTemplates();
                renderDistribution();
                renderLog();
                showToast('🔄 รีโหลดข้อมูลแดชบอร์ดล่าสุดสำเร็จ!');
            }
        }
        if (msg.command === 'statsUpdated') {
            if (msg.clickStats) clickStats = msg.clickStats;
            if (typeof msg.totalClicks === 'number') {
                const el = document.getElementById('kpiTotalClicks');
                if (el) el.innerText = msg.totalClicks;
            }
            if (msg.actualPort) {
                const pill = document.getElementById('portPill');
                if (pill) pill.innerText = 'Port: ' + msg.actualPort;
            }
            if (msg.clickLog && Array.isArray(msg.clickLog)) {
                clickLog = msg.clickLog;
                renderLog();
            }
            renderDistribution();
        }
        if (msg.command === 'clickLogUpdate') {
            clickLog = msg.log || [];
            renderLog();
        }
    });

    renderTemplates();
    renderDistribution();
    renderLog();
    vscode.postMessage({ command: 'getClickLog' });
</script>
</body>
</html>`;
}

/**
 * การเริ่มต้นการทำงานของ Extension
 */
function activate(context) {
    const currentVersion = getExtensionVersion(context);
    console.log('[Nexus Autopilot] Extension เริ่มต้นการทำงาน (v' + currentVersion + ')...');
    _extensionContext = context;

    _clickStats = context.globalState.get('clickStats', {});
    _totalClicks = context.globalState.get('totalClicks', 0);
    const storedLog = context.globalState.get('clickLog', []);
    if (storedLog && storedLog.length > 0) _clickLog = storedLog;

    // Win32 Native Dialog Handler สำหรับปุ่ม "Keep Waiting"
    if (process.platform === 'win32') {
        const { execFile } = require('child_process');
        const keepWaitingScript = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class NexusWin32 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hwnd, EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr w, IntPtr l);
}
"@
$global:clicked = $false
[NexusWin32]::EnumWindows({
    param($hWnd, $lp)
    if (-not [NexusWin32]::IsWindowVisible($hWnd)) { return $true }
    if ($global:clicked) { return $false }
    [NexusWin32]::EnumChildWindows($hWnd, {
        param($ch, $lp2)
        $cls = New-Object System.Text.StringBuilder 64
        [NexusWin32]::GetClassName($ch, $cls, 64) | Out-Null
        if ($cls.ToString() -eq 'Button') {
            $txt = New-Object System.Text.StringBuilder 256
            [NexusWin32]::GetWindowText($ch, $txt, 256) | Out-Null
            if ($txt.ToString() -match 'Keep Waiting') {
                [NexusWin32]::PostMessage($ch, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
                $global:clicked = $true
            }
        }
        return $true
    }, [IntPtr]::Zero) | Out-Null
    return (-not $global:clicked)
}, [IntPtr]::Zero) | Out-Null
if ($global:clicked) { Write-Output 'CLICKED' }
`.trim();

        const keepWaitingInterval = setInterval(() => {
            if (!_autoAcceptEnabled) return;
            if (!_httpClickPatterns.includes('Keep Waiting')) return;

            execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', keepWaitingScript], { timeout: 5000 }, (err, stdout) => {
                if (stdout && stdout.trim() === 'CLICKED') {
                    console.log('[Nexus Autopilot] 🎯 Win32 Dialog: คลิกปุ่ม Keep Waiting อัตโนมัติ');
                    _totalClicks++;
                    if (!_clickStats['Keep Waiting']) _clickStats['Keep Waiting'] = 0;
                    _clickStats['Keep Waiting']++;
                    if (_extensionContext) {
                        _extensionContext.globalState.update('clickStats', _clickStats);
                        _extensionContext.globalState.update('totalClicks', _totalClicks);
                    }
                }
            });
        }, 3000);
        context.subscriptions.push({ dispose: () => clearInterval(keepWaitingInterval) });
    }

    startHttpServer();
    startCommandsLoop();
    writeConfigJson(context);
    createStatusBarItem(context);

    // Auto injection & version check
    const needsInject = !isScriptInjected();
    const lastVersion = context.globalState.get('nexus-injected-version', '0');
    const versionChanged = currentVersion !== lastVersion;

    if (needsInject || versionChanged) {
        try {
            installScript(context);
            context.globalState.update('nexus-injected-version', currentVersion);
            clearV8CodeCache();
            updateProductChecksums();
            setTimeout(() => {
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            }, 1000);
        } catch (e) {
            console.error('[Nexus Autopilot] เกิดข้อผิดพลาดในการ Inject อัตโนมัติ:', e.message);
        }
    } else {
        try {
            const wbPath = getWorkbenchPath();
            if (wbPath) {
                const scriptContent = buildScriptContent(context);
                writeFileElevated(path.join(path.dirname(wbPath), 'nexus-auto-script.js'), scriptContent);
                writeFileElevated(path.join(path.dirname(wbPath), 'ag-auto-script.js'), scriptContent);
            }
        } catch (_) { }
        updateProductChecksums();
    }

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('nexus-autopilot') || e.affectsConfiguration('ag-auto')) {
                updateStatusBarItem();
                writeConfigJson(context);
            }
        })
    );

    // Command: Enable
    const enableHandler = async () => {
        const success = installScript(context);
        if (success) {
            updateProductChecksums();
            updateStatusBarItem();
            const choice = await vscode.window.showInformationMessage(
                '[Nexus Autopilot] ✅ ติดตั้งสคริปต์เรียบร้อย! กรุณา Reload เพื่อเริ่มต้นการทำงาน',
                'Reload ทันที'
            );
            if (choice === 'Reload ทันที') {
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        }
    };
    context.subscriptions.push(vscode.commands.registerCommand('nexus-autopilot.enable', enableHandler));
    context.subscriptions.push(vscode.commands.registerCommand('ag-auto.enable', enableHandler));

    // Command: Disable
    const disableHandler = async () => {
        const success = uninstallScript();
        if (success) {
            updateStatusBarItem();
            const choice = await vscode.window.showInformationMessage(
                '[Nexus Autopilot] 🗑️ ถอนการติดตั้งสคริปต์เรียบร้อย! กรุณา Reload เพื่อคืนค่าระบบเดิม',
                'Reload ทันที'
            );
            if (choice === 'Reload ทันที') {
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        }
    };
    context.subscriptions.push(vscode.commands.registerCommand('nexus-autopilot.disable', disableHandler));
    context.subscriptions.push(vscode.commands.registerCommand('ag-auto.disable', disableHandler));

    // Command: Open Settings
    const openSettingsHandler = () => {
        openSettingsPanel(context);
    };
    context.subscriptions.push(vscode.commands.registerCommand('nexus-autopilot.openSettings', openSettingsHandler));
    context.subscriptions.push(vscode.commands.registerCommand('ag-auto.openSettings', openSettingsHandler));
}

function deactivate() {
    if (statusBarAccept) {
        statusBarAccept.dispose();
    }
    if (statusBarScroll) {
        statusBarScroll.dispose();
    }
    if (_autoAcceptInterval) {
        clearInterval(_autoAcceptInterval);
    }
    if (_httpServer) {
        try { _httpServer.close(); } catch (_) { }
    }
    try {
        const wbPath = getWorkbenchPath();
        if (wbPath) {
            const portFile = path.join(path.dirname(wbPath), 'nexus-auto-port-' + process.pid + '.txt');
            if (fs.existsSync(portFile)) fs.unlinkSync(portFile);
        }
    } catch (_) { }
}

module.exports = { activate, deactivate, getSettingsHtml };
