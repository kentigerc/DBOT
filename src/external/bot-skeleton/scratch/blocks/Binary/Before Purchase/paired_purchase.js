import { localize } from '@deriv-com/translations';
window.Blockly.Blocks.neto_higher_lower_pair = {
    init() {
        this.appendDummyInput().appendField(localize('Paired Higher +1 / Lower −1 · USD demo only'));
        this.appendDummyInput()
            .appendField(localize('Market search'))
            .appendField(
                new window.Blockly.FieldDropdown([
                    [localize('Automatic Volatility scan'), 'AUTO'],
                    [localize('Selected Trade parameters market'), 'SELECTED'],
                ]),
                'MARKET_SEARCH'
            );
        for (const [name, label] of [
            ['STOP_LOSS', 'Session stop loss'],
            ['TAKE_PROFIT', 'Session take profit'],
            ['MAX_PAIRS', 'Maximum pairs'],
        ])
            this.appendValueInput(name).setCheck('Number').appendField(localize(label));
        this.setPreviousStatement(true);
        this.setNextStatement(false);
        this.setColour(window.Blockly.Colours.Base.colour);
        this.setTooltip(
            localize(
                'Scans live Volatility markets and submits one Higher +1 and one Lower −1 order. Both can lose. Separate orders are not atomic. Stops on partial or uncertain execution.'
            )
        );
    },
    restricted_parents: ['before_purchase'],
};
window.Blockly.JavaScript.javascriptGenerator.forBlock.neto_higher_lower_pair = block => {
    const generator = window.Blockly.JavaScript.javascriptGenerator;
    const options = block.workspace.getAllBlocks(false).find(b => b.type === 'trade_definition_tradeoptions');
    const market = block.workspace.getAllBlocks(false).find(b => b.type === 'trade_definition_market');
    if (
        !options ||
        options.getFieldValue('DURATIONTYPE_LIST') !== 't' ||
        options.getFieldValue('CURRENCY_LIST') !== 'USD'
    )
        throw new Error('Paired XML requires USD and a tick duration in Trade parameters.');
    const read = (b, name) => {
        const value = generator.valueToCode(b, name, generator.ORDER_NONE);
        if (!value) throw new Error(`Connect the paired XML ${name} input.`);
        return value;
    };
    const args = [
        read(options, 'AMOUNT'),
        read(options, 'DURATION'),
        ...['STOP_LOSS', 'TAKE_PROFIT', 'MAX_PAIRS'].map(name => read(block, name)),
        read(options, 'BARRIEROFFSET'),
        block.getFieldValue('MARKET_SEARCH') === 'SELECTED'
            ? JSON.stringify(market?.getFieldValue('SYMBOL_LIST'))
            : 'undefined',
    ];
    if (options.getFieldValue('BARRIEROFFSETTYPE_LIST') !== '+')
        throw new Error('Paired XML requires the positive +1 barrier in Trade parameters.');
    return `Bot.runHigherLowerPair(${args.join(', ')});\n`;
};
