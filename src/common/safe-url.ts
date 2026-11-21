import { lookup } from 'dns/promises';
import { isIP } from 'net';

/**
 * Returns true if an IPv4 or IPv6 address belongs to a private, loopback,
 * link-local, or otherwise non-publicly-routable range.
 */
export function isPrivateIp(ip: string): boolean {
    const normalized = ip.trim().toLowerCase();

    // Handle IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1)
    if (normalized.startsWith('::ffff:')) {
        const mapped = normalized.slice('::ffff:'.length);
        if (isIP(mapped) === 4) {
            return isPrivateIp(mapped);
        }
    }

    const version = isIP(normalized);
    if (version === 4) {
        const parts = normalized.split('.').map(Number);
        if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
            return true;
        }
        const [a, b] = parts;
        if (a === 0) return true; // 0.0.0.0/8 (unspecified)
        if (a === 10) return true; // 10.0.0.0/8 (RFC 1918)
        if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
        if (a === 127) return true; // 127.0.0.0/8 (loopback)
        if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / cloud metadata)
        if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC 1918)
        if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC 1918)
        if (a >= 224) return true; // multicast / reserved
        return false;
    }

    if (version === 6) {
        if (normalized === '::' || normalized === '::1') return true;
        if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // fc00::/7 ULA
        if (
            normalized.startsWith('fe8') ||
            normalized.startsWith('fe9') ||
            normalized.startsWith('fea') ||
            normalized.startsWith('feb')
        ) {
            return true; // fe80::/10 link-local
        }
        if (normalized.startsWith('ff')) return true; // multicast
        return false;
    }

    return true;
}

/**
 * Validates that a URL uses http(s) and does not resolve to a private,
 * loopback, or cloud-metadata IP address (SSRF defense).
 */
export async function assertSafeUrl(rawUrl: string): Promise<URL> {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error('CRITICAL_BLOCK: Invalid URL format.');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`CRITICAL_BLOCK: Unsupported URL protocol "${parsed.protocol}".`);
    }

    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
        throw new Error('CRITICAL_BLOCK: Requests to local or internal hosts are not allowed.');
    }

    if (isIP(hostname)) {
        if (isPrivateIp(hostname)) {
            throw new Error('CRITICAL_BLOCK: Requests to private IP addresses are not allowed.');
        }
        return parsed;
    }

    const records = await lookup(hostname, { all: true });
    if (!records.length || records.some((r) => isPrivateIp(r.address))) {
        throw new Error('CRITICAL_BLOCK: URL resolves to a private or non-public IP address.');
    }

    return parsed;
}
