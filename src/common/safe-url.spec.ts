import { assertSafeUrl, isPrivateIp } from './safe-url';

describe('safe-url', () => {
    describe('isPrivateIp', () => {
        it('flags loopback, RFC1918, link-local, and cloud metadata IPs', () => {
            expect(isPrivateIp('127.0.0.1')).toBe(true);
            expect(isPrivateIp('10.0.0.5')).toBe(true);
            expect(isPrivateIp('172.16.10.1')).toBe(true);
            expect(isPrivateIp('192.168.1.1')).toBe(true);
            expect(isPrivateIp('169.254.169.254')).toBe(true);
            expect(isPrivateIp('::1')).toBe(true);
            expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
            expect(isPrivateIp('fe80::1')).toBe(true);
            expect(isPrivateIp('fc00::1')).toBe(true);
        });

        it('allows public IPv4 and IPv6 addresses', () => {
            expect(isPrivateIp('8.8.8.8')).toBe(false);
            expect(isPrivateIp('1.1.1.1')).toBe(false);
            expect(isPrivateIp('93.184.216.34')).toBe(false);
            expect(isPrivateIp('2606:4700:4700::1111')).toBe(false);
        });
    });

    describe('assertSafeUrl', () => {
        it('blocks non-http protocols', async () => {
            await expect(assertSafeUrl('file:///etc/passwd')).rejects.toThrow('CRITICAL_BLOCK');
            await expect(assertSafeUrl('javascript:alert(1)')).rejects.toThrow('CRITICAL_BLOCK');
        });

        it('blocks localhost and private IP literals', async () => {
            await expect(assertSafeUrl('http://localhost:3000/api')).rejects.toThrow('CRITICAL_BLOCK');
            await expect(assertSafeUrl('http://127.0.0.1/admin')).rejects.toThrow('CRITICAL_BLOCK');
            await expect(assertSafeUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow('CRITICAL_BLOCK');
            await expect(assertSafeUrl('http://[::1]:8080/')).rejects.toThrow('CRITICAL_BLOCK');
        });

        it('allows public IP URLs', async () => {
            const parsed = await assertSafeUrl('https://1.1.1.1/article');
            expect(parsed.hostname).toBe('1.1.1.1');
        });
    });
});
