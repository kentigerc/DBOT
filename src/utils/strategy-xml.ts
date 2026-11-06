export const MAX_STRATEGY_BYTES = 2 * 1024 * 1024;
export function assertStrategyXml(value: unknown): asserts value is string {
    if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > MAX_STRATEGY_BYTES)
        throw new Error('Bot XML must be no larger than 2 MB.');
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(value))
        throw new Error('Bot XML must not contain document types or entity declarations.');
    if ((value.match(/<\s*(?:[\w-]+:)?block\b/g) || []).length > 10000)
        throw new Error('Bot XML contains too many blocks.');
}
export async function fetchStrategyXml(value: string): Promise<string> {
    const url = new URL(value, window.location.origin);
    if (url.protocol !== 'https:' || url.username || url.password)
        throw new Error('Remote bots must use an HTTPS URL without embedded credentials.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
        const response = await fetch(url.toString(), {
            credentials: 'omit',
            redirect: 'error',
            signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error('Unable to load remote bot XML.');
        if (Number(response.headers.get('content-length')) > MAX_STRATEGY_BYTES)
            throw new Error('Bot XML must be no larger than 2 MB.');
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
            while (true) {
                const { done, value: chunk } = await reader.read();
                if (done) break;
                size += chunk.byteLength;
                if (size > MAX_STRATEGY_BYTES) throw new Error('Bot XML must be no larger than 2 MB.');
                chunks.push(chunk);
            }
        } finally {
            await reader.cancel().catch(() => {});
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        const xml = new TextDecoder().decode(bytes);
        assertStrategyXml(xml);
        return xml;
    } finally {
        clearTimeout(timeout);
    }
}
