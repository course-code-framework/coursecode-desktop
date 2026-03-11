/**
 * cloud-certs.js — System CA certificate injection for corporate networks.
 *
 * Corporate machines with SSL-inspecting proxies (Zscaler, Netskope, etc.)
 * use custom root CAs that Node.js doesn't trust by default. This module
 * injects the OS certificate store into Node's TLS context so HTTPS calls
 * from the main process (LLM providers, cloud proxy, auto-updater) succeed.
 *
 * Platform strategy (mirrors the coursecode framework's cloud-certs.js):
 *   - Windows: win-ca native addon calls CryptoAPI, patches tls in-process.
 *   - macOS: `security` CLI exports system keychains to PEM.
 *   - Linux: reads well-known CA bundle file paths.
 *
 * Unlike the CLI (which can re-exec with NODE_EXTRA_CA_CERTS), Electron
 * cannot restart itself. On macOS/Linux we patch tls.createSecureContext()
 * directly and set NODE_EXTRA_CA_CERTS for child processes (CLI spawns).
 *
 * Never throws. Silent no-op on non-corporate machines.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import tls from 'tls';

const execFileAsync = promisify(execFile);

/** Guard: only run once per process lifetime. */
let _applied = false;

/**
 * Inject the OS system root certificates into Node's TLS context.
 *
 * Call this as early as possible in the main process, before any HTTPS calls.
 */
export async function injectSystemCerts() {
    if (_applied) return;
    _applied = true;

    try {
        // Collect PEM certs from the OS store (platform-specific).
        let pem;

        if (process.platform === 'win32') {
            // Patch the main process TLS in-place via win-ca.
            injectWindowsCerts();
            // Also export the certs to PEM so child processes get them too.
            pem = exportWindowsCertsPem();
        } else if (process.platform === 'darwin') {
            pem = await readMacosCerts();
        } else {
            pem = readLinuxCerts();
        }

        if (!pem || !pem.trim()) return;

        // Write a cached PEM file (hash-named to avoid stale rewrites).
        const hash = crypto.createHash('sha1').update(pem).digest('hex').slice(0, 8);
        const certPath = path.join(os.tmpdir(), `coursecode-ca-${hash}.pem`);

        if (!fs.existsSync(certPath)) {
            fs.writeFileSync(certPath, pem, { mode: 0o600 });
        }

        // Electron can't re-exec, so patch tls.createSecureContext() directly
        // to include the extra CAs for all in-process HTTPS calls.
        // On Windows, win-ca already patched tls above, so skip this.
        if (process.platform !== 'win32') {
            const origCreateSecureContext = tls.createSecureContext;
            tls.createSecureContext = function (options = {}) {
                const ctx = origCreateSecureContext.call(this, options);
                for (const block of pem.split(/(?=-----BEGIN CERTIFICATE-----)/)) {
                    const trimmed = block.trim();
                    if (trimmed) {
                        try { ctx.context.addCACert(trimmed); } catch { /* skip invalid */ }
                    }
                }
                return ctx;
            };
        }

        // Set for child processes so CLI spawns also get system certs.
        process.env.NODE_EXTRA_CA_CERTS = certPath;
    } catch {
        // Best-effort; failure is non-fatal.
    }
}

// ---------------------------------------------------------------------------
// Platform-specific cert readers
// ---------------------------------------------------------------------------

/**
 * Windows: inject system root certs via win-ca.
 *
 * win-ca is a native N-API addon that calls Windows CryptoAPI directly.
 * The { inject: '+' } mode patches tls.createSecureContext() so system
 * certs are used *in addition to* Node's built-in CA bundle.
 */
function injectWindowsCerts() {
    const require = createRequire(import.meta.url);
    const winCa = require('win-ca/api');
    winCa({ inject: '+' });
}

/**
 * Windows: export system root certs as a PEM string.
 *
 * Uses win-ca to enumerate all CAs from the Windows certificate store,
 * returning them concatenated in PEM format. This is written to a temp file
 * and passed to child processes via NODE_EXTRA_CA_CERTS.
 */
function exportWindowsCertsPem() {
    const require = createRequire(import.meta.url);
    const winCa = require('win-ca/api');

    const pems = [];
    winCa({
        inject: false, // don't patch TLS again, just enumerate
        format: winCa.der2.pem,
        store: ['root', 'ca'],
        ondata: (pem) => { pems.push(pem); },
    });
    return pems.join('\n');
}

/**
 * macOS: export the system root keychain via the `security` CLI tool.
 * Includes roots installed via Apple MDM and System Preferences.
 */
async function readMacosCerts() {
    const keychains = [
        '/Library/Keychains/SystemRootCertificates.keychain',
        '/System/Library/Keychains/SystemRootCertificates.keychain',
        '/Library/Keychains/System.keychain',
    ];

    const pems = [];
    for (const keychain of keychains) {
        try {
            const { stdout } = await execFileAsync('security', [
                'find-certificate', '-a', '-p', keychain,
            ], { maxBuffer: 16 * 1024 * 1024 });
            if (stdout) pems.push(stdout);
        } catch {
            // Keychain not present on this OS version
        }
    }

    return pems.join('\n');
}

/**
 * Linux: read the system CA bundle from well-known locations.
 */
function readLinuxCerts() {
    const candidates = [
        '/etc/ssl/certs/ca-certificates.crt',            // Debian/Ubuntu
        '/etc/pki/tls/certs/ca-bundle.crt',              // RHEL/CentOS/Fedora
        '/etc/ssl/ca-bundle.pem',                         // OpenSUSE
        '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem', // RHEL 7+
    ];

    for (const p of candidates) {
        if (fs.existsSync(p)) {
            return fs.readFileSync(p, 'utf-8');
        }
    }

    return null;
}
