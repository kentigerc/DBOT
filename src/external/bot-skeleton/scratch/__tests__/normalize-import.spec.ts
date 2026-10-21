import { normalizeImportedBlocks } from '../normalize-import';
const parse = (body: string) => new DOMParser().parseFromString(`<xml>${body}</xml>`, 'text/xml').documentElement;

describe('third-party bot XML compatibility', () => {
    it('keeps the purchase contract selection and notification payload', () => {
        const xml = parse(
            '<block type="apollo_purchase"><field name="PURCHASE_LIST">DIGITODD</field></block><block type="btnotify"><field name="NOTIFICATION_TYPE">success</field><field name="NOTIFICATION_SOUND">silent</field><value name="MESSAGE"><shadow type="text"><field name="TEXT">Example</field></shadow></value></block>'
        );
        const result = normalizeImportedBlocks(xml);
        expect(result.querySelector('block[type="purchase"] field')?.textContent).toBe('DIGITODD');
        expect(result.querySelector('block[type="notify"] value field')?.textContent).toBe('Example');
    });
    it('leaves unknown risk-management blocks intact so normal validation rejects them', () => {
        expect(
            normalizeImportedBlocks(parse('<block type="set_sl"/>')).querySelector('block')?.getAttribute('type')
        ).toBe('set_sl');
    });
    it('refuses variants with extra trading inputs instead of discarding them', () => {
        expect(() =>
            normalizeImportedBlocks(parse('<block type="apollo_purchase"><field name="EXTRA_RISK">2</field></block>'))
        ).toThrow(/unsupported variant/);
    });
});
