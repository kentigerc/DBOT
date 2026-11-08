import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isProtectedBotXml } from '@/utils/bot-protection';
import { hostedBotLimits } from '@/utils/hosted-bot-market';
describe.each(['over-punisher.xml', 'over-1-over-0.xml', 'under-punisher.xml', 'under-8-under-9.xml'])(
    '%s startup',
    filename => {
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
                document.querySelector(
                    'block[type="text_prompt_ext"], block[type="text_prompt"], block[type="text_print"]'
                )
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
    }
);

it('keeps the new Under 8 / Under 9 bot at one tick without embedded Telegram reporting', () => {
    const source = readFileSync(path.join(__dirname, '../../../../server/bots/under-8-under-9.xml'), 'utf8');
    const document = new DOMParser().parseFromString(source, 'application/xml');
    expect(document.querySelector('parsererror')).toBeNull();
    expect(document.querySelector('block[type="notify_telegram"]')).toBeNull();
    expect(
        document.querySelector('block[type="trade_definition_tradeoptions"] > value[name="DURATION"] > block > field')
            ?.textContent
    ).toBe('1');
    const purchases = [...document.querySelectorAll('block[type="purchase"] > field[name="PURCHASE_LIST"]')];
    expect(purchases).toHaveLength(4);
    expect(purchases.every(field => field.textContent === 'DIGITUNDER')).toBe(true);
});

describe('Switcher risk settings and recovery', () => {
    const read = (name: string) => readFileSync(path.join(__dirname, '../../../../server/bots', name), 'utf8');
    const parse = (name: string) => new DOMParser().parseFromString(read(name), 'application/xml');
    const over = () => parse('over-1-over-0.xml');
    const under = () => parse('under-8-under-9.xml');
    it.each(['over-1-over-0.xml', 'under-8-under-9.xml'])('sets %s session take profit to ten dollars', filename => {
        expect(hostedBotLimits(read(filename))).toEqual({ takeProfit: 1000, stopLoss: 10000 });
    });
    it('uses Over for normal trades and Under 5 for recovery, including the normal zero-digit barrier', () => {
        const document = over();
        const branch = document.querySelector('block[type="before_purchase"] block[id="{se08yd!M!}ThlUHp%,%"]')!;
        expect(branch.querySelector('value[name="IF0"] field[name="VAR"]')?.textContent).toBe('Loss');
        expect(branch.querySelector('value[name="IF0"] field[name="OP"]')?.textContent).toBe('EQ');
        expect(branch.querySelector('value[name="IF0"] field[name="NUM"]')?.textContent).toBe('0');
        expect(branch.querySelector('statement[name="DO0"] field[name="PURCHASE_LIST"]')?.textContent).toBe(
            'DIGITOVER'
        );
        expect(branch.querySelector('statement[name="ELSE"] field[name="PURCHASE_LIST"]')?.textContent).toBe(
            'DIGITUNDER'
        );
        expect(
            document.querySelector('block[type="trade_definition_contracttype"] field[name="TYPE_LIST"]')?.textContent
        ).toBe('both');
        const prediction = document.querySelector('value[name="PREDICTION"] > block')!;
        const value = (node: Element, name: string) =>
            [...node.children].find(child => child.localName === 'value' && child.getAttribute('name') === name)!;
        const normal = value(prediction, 'THEN').querySelector('block')!;
        expect(value(normal, 'THEN').querySelector('field[name="NUM"]')?.textContent).toBe('1');
        expect(value(normal, 'ELSE').querySelector('field[name="NUM"]')?.textContent).toBe('0');
        expect(value(prediction, 'ELSE').querySelector('field[name="NUM"]')?.textContent).toBe('5');
    });
    it('matches Under Switcher’s loss stake progression and win reset', () => {
        const semantics = (node: Element): unknown => ({
            tag: node.localName,
            type: node.getAttribute('type'),
            name: node.getAttribute('name'),
            value: node.children.length ? undefined : node.textContent,
            children: [...node.children].filter(child => child.localName !== 'data').map(semantics),
        });
        for (const result of ['DO0', 'DO1']) {
            const selector = `block[type="after_purchase"] > statement > block > statement[name="${result}"]`;
            expect(semantics(over().querySelector(selector)!)).toEqual(semantics(under().querySelector(selector)!));
        }
        for (const document of [over(), under()]) {
            const multiplier = [...document.querySelectorAll('block[type="math_arithmetic"]')].find(block =>
                block.querySelector('block[type="read_details"]')
            )!;
            expect(multiplier.querySelector('value[name="B"] field[name="NUM"]')?.textContent).toBe('2.1');
            expect(
                document.querySelector(
                    'block[type="trade_definition_tradeoptions"] > value[name="DURATION"] field[name="NUM"]'
                )?.textContent
            ).toBe('1');
        }
    });
});
