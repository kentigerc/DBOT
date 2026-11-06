import { ReadableStream } from 'node:stream/web';
import { assertStrategyXml, fetchStrategyXml, MAX_STRATEGY_BYTES } from '../strategy-xml';
it('accepts ordinary bots and rejects DTDs, entities, oversized files and excessive blocks', () => {
    expect(() => assertStrategyXml('<xml><block type="trade" /></xml>')).not.toThrow();
    for (const xml of [
        '<!DOCTYPE xml SYSTEM "file:///etc/passwd"><xml/>',
        '<!ENTITY e SYSTEM "https://attacker.invalid/">',
        'x'.repeat(MAX_STRATEGY_BYTES + 1),
        '<xml>' + '<block/>'.repeat(10001) + '</xml>',
    ])
        expect(() => assertStrategyXml(xml)).toThrow();
});
it('refuses insecure remote bot URLs before fetching and strips browser credentials from HTTPS imports', async () => {
    const original = globalThis.fetch;
    const fetcher = jest.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        body: new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('<xml/>'));
                controller.close();
            },
        }),
    });
    globalThis.fetch = fetcher;
    try {
        await expect(fetchStrategyXml('http://169.254.169.254/latest/meta-data')).rejects.toThrow('HTTPS');
        await expect(fetchStrategyXml('https://user:pass@example.com/bot.xml')).rejects.toThrow('HTTPS');
        expect(fetcher).not.toHaveBeenCalled();
        await expect(fetchStrategyXml('https://example.com/bot.xml')).resolves.toBe('<xml/>');
        expect(fetcher).toHaveBeenCalledWith(
            'https://example.com/bot.xml',
            expect.objectContaining({ credentials: 'omit', redirect: 'error' })
        );
    } finally {
        globalThis.fetch = original;
    }
});
