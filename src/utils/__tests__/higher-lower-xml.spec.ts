import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pairedWorkspace } from '@/utils/higher-lower-builder';
const Blockly = require('blockly');
require('blockly/blocks');
const { javascriptGenerator } = require('blockly/javascript');
jest.mock('@deriv-com/translations', () => ({ localize: (s: string) => s }));
const source = readFileSync(path.join(__dirname, '../../../server/bots/higher-lower-pair.xml'), 'utf8');
beforeAll(() => {
    (window as any).Blockly = Object.assign(Blockly, {
        JavaScript: { javascriptGenerator },
        Colours: { Base: { colour: '#7560a8' } },
    });
    Blockly.Blocks.trade_definition = {
        init() {
            this.appendStatementInput('INITIALIZATION');
            this.appendStatementInput('SUBMARKET');
        },
    };
    Blockly.Blocks.before_purchase = {
        init() {
            this.appendStatementInput('BEFOREPURCHASE_STACK');
        },
    };
    Blockly.Blocks.trade_definition_market = {
        init() {
            this.appendDummyInput().appendField(new Blockly.FieldTextInput('R_100'), 'SYMBOL_LIST');
        },
    };
    Blockly.Blocks.trade_definition_tradeoptions = {
        init() {
            this.appendDummyInput()
                .appendField(new Blockly.FieldTextInput('t'), 'DURATIONTYPE_LIST')
                .appendField(new Blockly.FieldTextInput('USD'), 'CURRENCY_LIST')
                .appendField(new Blockly.FieldTextInput('+'), 'BARRIEROFFSETTYPE_LIST');
            for (const name of ['AMOUNT', 'DURATION', 'BARRIEROFFSET']) this.appendValueInput(name).setCheck('Number');
            this.setPreviousStatement(true);
        },
    };
    require('@/external/bot-skeleton/scratch/blocks/Binary/Before Purchase/paired_purchase');
});
it('uses the same standard Blockly roots, variable initialization and trade parameter fields as hosted bots', () => {
    const doc = new DOMParser().parseFromString(source, 'application/xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    expect(doc.documentElement.getAttribute('is_dbot')).toBe('true');
    expect(doc.querySelectorAll('variables > variable')).toHaveLength(5);
    for (const type of ['trade_definition', 'before_purchase', 'after_purchase'])
        expect(doc.querySelector(`xml > block[type="${type}"]`)).not.toBeNull();
    expect(
        doc.querySelector('block[type="trade_definition_tradeoptions"] field[name="CURRENCY_LIST"]')?.textContent
    ).toBe('USD');
    expect(
        doc.querySelector('block[type="trade_definition_tradeoptions"] field[name="DURATIONTYPE_LIST"]')?.textContent
    ).toBe('t');
});
it('loads the paired block into Blockly and generates purchases from the normal stake, duration and market inputs', () => {
    const doc = new DOMParser().parseFromString(source, 'application/xml');
    doc.querySelector('statement[name="TRADE_OPTIONS"]')?.remove();
    doc.querySelector('block[type="after_purchase"]')?.remove();
    const workspace = new Blockly.Workspace();
    try {
        Blockly.Xml.domToWorkspace(doc.documentElement, workspace);
        workspace.newBlock('trade_definition_market');
        javascriptGenerator.init(workspace);
        const pair = workspace.getAllBlocks().find((b: any) => b.type === 'neto_higher_lower_pair');
        expect(pairedWorkspace(workspace)).toBe(true);
        const code = javascriptGenerator.blockToCode(pair);
        expect(code).toContain('Bot.runHigherLowerPair(');
        expect(code).toContain(', undefined);');
        pair.setFieldValue('SELECTED', 'MARKET_SEARCH');
        expect(javascriptGenerator.blockToCode(pair)).toContain('"R_100"');
        const trade = workspace.getAllBlocks().find((b: any) => b.type === 'trade_definition_tradeoptions');
        trade.getInputTargetBlock('AMOUNT').unplug();
        const stake = workspace.newBlock('math_number');
        stake.setFieldValue('1.25', 'NUM');
        trade.getInput('AMOUNT').connection.connect(stake.outputConnection);
        expect(javascriptGenerator.blockToCode(pair)).toContain('1.25');
        trade.setFieldValue('-', 'BARRIEROFFSETTYPE_LIST');
        expect(() => javascriptGenerator.blockToCode(pair)).toThrow('positive +1 barrier');
    } finally {
        workspace.dispose();
    }
});
