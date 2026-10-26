import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isProtectedBotXml } from '@/utils/bot-protection';
describe.each(['over-punisher.xml', 'over-1-over-0.xml', 'under-punisher.xml'])('%s startup', filename => {
    const source = readFileSync(path.join(__dirname, '../../../../server/bots', filename), 'utf8');
    const parse = () => new DOMParser().parseFromString(source, 'application/xml');
    it('resolves every function call using a Blockly mutation instead of a block ID', () => {
        const document = parse();
        const namespace = document.documentElement.namespaceURI;
        const definitions = Array.from(document.querySelectorAll('block[type="procedures_defnoreturn"]')).map(
            block =>
                Array.from(block.children).find(
                    child => child.localName === 'field' && child.getAttribute('name') === 'NAME'
                )?.textContent
        );
        const calls = Array.from(document.querySelectorAll('block[type="procedures_callnoreturn"]'));
        expect(calls.length).toBeGreaterThan(0);
        calls.forEach(call => {
            const mutation = Array.from(call.children).find(child => child.localName === 'mutation');
            expect(mutation?.namespaceURI).toBe(namespace);
            expect(definitions).toContain(mutation?.getAttribute('name'));
        });
        const startup = calls.find(call => call.getAttribute('id') === '~4gXRl4o4.H!v=z-H:0|');
        expect(startup?.querySelector('mutation')?.getAttribute('name')).toBe('Trade');
    });
    it('runs setup without a password prompt and retains hosted export protection', () => {
        const document = parse();
        expect(
            document.querySelector('block[type="text_prompt_ext"], block[type="text_prompt"], block[type="text_print"]')
        ).toBeNull();
        const startupMessage = Array.from(document.querySelectorAll('block[type="notify"]')).find(
            block => block.getAttribute('id') === ')J1(pHFl]elGq*pgN)0Q'
        );
        expect(startupMessage?.querySelector('field[name="NOTIFICATION_SOUND"]')?.textContent).toBe('silent');
        expect(startupMessage?.querySelector('value[name="MESSAGE"] field[name="TEXT"]')?.textContent).toBe(
            'NetoAcademy bot started.'
        );
        const setup = Array.from(document.querySelectorAll('block[type="procedures_defnoreturn"]')).find(block =>
            Array.from(block.children).some(child => child.localName === 'field' && child.textContent === 'werttyg')
        );
        expect(setup?.querySelector('statement > block')?.getAttribute('type')).toBe('procedures_callnoreturn');
        expect(setup?.querySelector('statement > block > mutation')?.getAttribute('name')).toBe('uytre');
        expect(isProtectedBotXml(document.documentElement)).toBe(true);
    });
});
