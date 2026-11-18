import { higherLowerBuilder } from '@/utils/higher-lower-builder';
import { observer as globalObserver } from '../../../utils/observer';
import { createDetails } from '../utils/helpers';

const getBotInterface = tradeEngine => {
    const getDetail = i => createDetails(tradeEngine.data.contract)[i];

    return {
        runHigherLowerPair: (...args) => {
            let lastMessage = '';
            const unsubscribe = higherLowerBuilder.subscribe(() => {
                const state = higherLowerBuilder.getSnapshot();
                if (state.message && state.message !== lastMessage) {
                    lastMessage = state.message;
                    globalObserver.emit('ui.log.notify', {
                        message: `Higher Lower Hedging: ${state.message}`,
                        message_type: 'notify',
                        className: 'journal__text--info',
                        sound: 'silent',
                    });
                }
            });
            return higherLowerBuilder.run(...args).finally(unsubscribe);
        },
        init: (...args) => tradeEngine.init(...args),
        start: (...args) => tradeEngine.start(...args),
        stop: (...args) => tradeEngine.stop(...args),
        purchase: (contract_type, prediction) => tradeEngine.purchase(contract_type, prediction),
        getAskPrice: contract_type => Number(getProposal(contract_type, tradeEngine).ask_price),
        getPayout: contract_type => Number(getProposal(contract_type, tradeEngine).payout),
        getPurchaseReference: () => tradeEngine.getPurchaseReference(),
        isSellAvailable: () => tradeEngine.isSellAtMarketAvailable(),
        sellAtMarket: () => tradeEngine.sellAtMarket(),
        getSellPrice: () => getSellPrice(tradeEngine),
        isResult: result => getDetail(10) === result,
        isTradeAgain: result => globalObserver.emit('bot.trade_again', result),
        readDetails: i => getDetail(i - 1),
    };
};

const getProposal = (contract_type, tradeEngine) => {
    return tradeEngine.data.proposals.find(
        proposal =>
            proposal.contract_type === contract_type &&
            proposal.purchase_reference === tradeEngine.getPurchaseReference()
    );
};

const getSellPrice = tradeEngine => {
    return tradeEngine.getSellPrice();
};

export default getBotInterface;
