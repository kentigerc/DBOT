import { checkTradingBalance } from '@/services/digit-strategy/balance';
import { scanXmlParityRecovery, refreshXmlParityRecovery } from '@/utils/xml-parity-recovery';
import { generateDerivApiInstance } from '../../api/appId';
import { xmlScannerCycle } from '@/utils/xml-scanner-cycle';
import { LogTypes } from '../../../constants/messages';
import { api_base } from '../../api/api-base';
import { contractStatus, info, log } from '../utils/broadcast';
import { doUntilDone, getUUID, recoverFromError, tradeOptionToBuy } from '../utils/helpers';
import { purchaseSuccessful } from './state/actions';
import { BEFORE_PURCHASE } from './state/constants';

let delayIndex = 0;
let purchase_reference;

export default Engine =>
    class Purchase extends Engine {
        async purchase(contract_type, prediction) {
            // Prevent calling purchase twice
            if (this.store.getState().scope !== BEFORE_PURCHASE) {
                return Promise.resolve();
            }

            const entryContract =
                ['DIGITOVER', 'DIGITUNDER'].includes(contract_type) && !xmlScannerCycle.isRecovering()
                    ? { direction: contract_type, barrier: Number(prediction ?? this.tradeOptions.prediction) }
                    : undefined;
            if (!(await xmlScannerCycle.beforePurchase(this.tradeOptions.symbol, entryContract))) return;
            let purchaseOptions = prediction === undefined ? this.tradeOptions : { ...this.tradeOptions, prediction };
            const parityRecovery = xmlScannerCycle.isRecovering();
            const generation = xmlScannerCycle.getSnapshot().generation;
            let recoveryPlan;
            if (parityRecovery) {
                const stake = xmlScannerCycle.recoveryStake(this.xmlLastPurchaseStake);
                if (stake === undefined) return;
                const controller = new AbortController();
                const valid = () =>
                    xmlScannerCycle.isRecovering() &&
                    xmlScannerCycle.valid(generation) &&
                    this.store.getState().scope === BEFORE_PURCHASE;
                const unsubscribe = xmlScannerCycle.subscribe(() => {
                    if (!valid()) controller.abort();
                });
                try {
                    while (valid()) {
                        const locked = xmlScannerCycle.recoveryPlan();
                        const plan = locked
                            ? await refreshXmlParityRecovery(api_base.api, locked, controller.signal)
                            : await scanXmlParityRecovery(
                                  () => generateDerivApiInstance({ publicOnly: true }),
                                  1000,
                                  controller.signal,
                                  message => xmlScannerCycle.recoveryStatus(message),
                                  xmlScannerCycle.recoveryScope(),
                                  this.tradeOptions.duration || 1
                              );
                        if (!plan || !valid()) return;
                        // Recheck the original market's live guard after the recovery scan.
                        if (!(await xmlScannerCycle.beforePurchase(this.tradeOptions.symbol)) || !valid()) return;
                        if (Date.now() / 1000 - plan.epoch > 6) continue;
                        recoveryPlan = plan;
                        contract_type = plan.direction;
                        purchaseOptions = {
                            amount: stake,
                            basis: 'stake',
                            currency: this.tradeOptions.currency,
                            duration: this.tradeOptions.duration || 1,
                            duration_unit: 't',
                            symbol: plan.symbol,
                            app_markup_percentage: this.tradeOptions.app_markup_percentage,
                        };
                        xmlScannerCycle.recoveryStatus(`Continuing recovery · ${plan.symbol}`);
                        break;
                    }
                    if (!valid()) return;
                } finally {
                    controller.abort();
                    unsubscribe();
                }
            }
            if (this.store.getState().scope !== BEFORE_PURCHASE) return;
            const onSuccess = response => {
                // Don't unnecessarily send a forget request for a purchased contract.
                const { buy } = response;
                this.xmlLastPurchaseStake = Number(buy.buy_price);
                if (parityRecovery && recoveryPlan) xmlScannerCycle.lockRecoveryPlan(recoveryPlan);

                contractStatus({
                    id: 'contract.purchase_received',
                    data: buy.transaction_id,
                    buy,
                });

                this.contractId = buy.contract_id;
                this.store.dispatch(purchaseSuccessful());

                if (this.is_proposal_subscription_required) {
                    this.renewProposalsOnPurchase();
                }

                delayIndex = 0;
                log(LogTypes.PURCHASE, { longcode: buy.longcode, transaction_id: buy.transaction_id });
                info({
                    accountID: this.accountInfo.loginid,
                    totalRuns: this.updateAndReturnTotalRuns(),
                    transaction_ids: { buy: buy.transaction_id },
                    contract_type,
                    buy_price: buy.buy_price,
                });
            };

            if (this.is_proposal_subscription_required && !parityRecovery && prediction === undefined) {
                const { id, askPrice } = this.selectProposal(contract_type);

                const action = async () => {
                    await checkTradingBalance(
                        body => api_base.api.send(body),
                        purchaseOptions.currency,
                        Number(askPrice)
                    );
                    contractStatus({ id: 'contract.purchase_sent', data: askPrice });
                    return api_base.api.send({ buy: id, price: askPrice });
                };

                this.isSold = false;

                if (!this.options.timeMachineEnabled) {
                    return doUntilDone(action).then(onSuccess);
                }

                return recoverFromError(
                    action,
                    (errorCode, makeDelay) => {
                        // if disconnected no need to resubscription (handled by live-api)
                        if (errorCode !== 'DisconnectError') {
                            this.renewProposalsOnPurchase();
                        } else {
                            this.clearProposals();
                        }

                        const unsubscribe = this.store.subscribe(() => {
                            const { scope, proposalsReady } = this.store.getState();
                            if (scope === BEFORE_PURCHASE && proposalsReady) {
                                makeDelay().then(() => this.observer.emit('REVERT', 'before'));
                                unsubscribe();
                            }
                        });
                    },
                    ['PriceMoved', 'InvalidContractProposal'],
                    delayIndex++
                ).then(onSuccess);
            }
            const trade_option = tradeOptionToBuy(contract_type, purchaseOptions);
            const action = async () => {
                await checkTradingBalance(
                    body => api_base.api.send(body),
                    purchaseOptions.currency,
                    Number(trade_option.price)
                );
                contractStatus({ id: 'contract.purchase_sent', data: purchaseOptions.amount });
                return api_base.api.send(trade_option);
            };

            this.isSold = false;

            if (!this.options.timeMachineEnabled) {
                return doUntilDone(action).then(onSuccess);
            }

            return recoverFromError(
                action,
                (errorCode, makeDelay) => {
                    if (errorCode === 'DisconnectError') {
                        this.clearProposals();
                    }
                    const unsubscribe = this.store.subscribe(() => {
                        const { scope } = this.store.getState();
                        if (scope === BEFORE_PURCHASE) {
                            makeDelay().then(() => this.observer.emit('REVERT', 'before'));
                            unsubscribe();
                        }
                    });
                },
                ['PriceMoved', 'InvalidContractProposal'],
                delayIndex++
            ).then(onSuccess);
        }
        getPurchaseReference = () => purchase_reference;
        regeneratePurchaseReference = () => {
            purchase_reference = getUUID();
        };
    };
