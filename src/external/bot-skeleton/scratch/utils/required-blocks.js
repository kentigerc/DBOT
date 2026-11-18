import { config } from '../../constants/config';
import { error_message_map } from '../../utils/error-config';
import { observer as globalObserver } from '../../utils/observer';

export const getSelectedTradeType = (workspace = window.Blockly.derivWorkspace) => {
    const trade_type_block = workspace.getAllBlocks(true).find(block => block.type === 'trade_definition_tradetype');
    const selected_trade_type = trade_type_block?.getFieldValue('TRADETYPE_LIST');
    let mandatory_tradeoptions_block = 'trade_definition_tradeoptions';
    if (selected_trade_type === 'multiplier') mandatory_tradeoptions_block = 'trade_definition_multiplier';
    if (selected_trade_type === 'accumulator') mandatory_tradeoptions_block = 'trade_definition_accumulator';
    return mandatory_tradeoptions_block;
};

const disabled = block => block.disabled || block.isEnabled?.() === false;
export const isAllRequiredBlocksEnabled = workspace => {
    if (!workspace) return false;
    const blocks = workspace.getAllBlocks();
    const required = [getSelectedTradeType(workspace), ...config().mandatoryMainBlocks];
    const missing = required.filter(type => !blocks.some(block => block.type === type));
    const inactive = blocks.filter(block => required.includes(block.type) && disabled(block));
    const messages = error_message_map();
    for (const type of missing) globalObserver.emit('ui.log.error', messages[type]?.missing);
    for (const block of inactive) globalObserver.emit('ui.log.error', messages[block.type]?.disabled);
    return missing.length === 0 && inactive.length === 0;
};
