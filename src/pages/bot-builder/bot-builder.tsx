import React from 'react';
import classNames from 'classnames';
import { observer } from 'mobx-react-lite';
import { botNotification } from '@/components/bot-notification/bot-notification';
import { notification_message } from '@/components/bot-notification/bot-notification-utils';
import { DBOT_TABS } from '@/constants/bot-contents';
import { load, save_types } from '@/external/bot-skeleton';
import { useStore } from '@/hooks/useStore';
import {
    hostedBotLivePrediction,
    hostedBotForAuto,
    hostedBotLimits,
    hostedBotMarket,
    waitForHostedBotReady,
} from '@/utils/hosted-bot-market';
import { setScannerWatch } from '@/utils/scanner-watch';
import { xmlScannerCycle } from '@/utils/xml-scanner-cycle';
import { localize } from '@deriv-com/translations';
import { useDevice } from '@deriv-com/ui';
import { TBlocklyEvents } from 'Types';
import LoadModal from '../../components/load-modal';
import SaveModal from '../dashboard/bot-list/save-modal';
import BotBuilderTourHandler from '../tutorials/dbot-tours/bot-builder-tour';
import QuickStrategy1 from './quick-strategy';
import WorkspaceWrapper from './workspace-wrapper';

const BotBuilder = observer(() => {
    const { dashboard, app, run_panel, toolbar, quick_strategy, blockly_store } = useStore();
    const { active_tab, active_tour, is_preview_on_popup } = dashboard;
    const { is_open } = quick_strategy;
    const { is_running } = run_panel;
    const { is_loading } = blockly_store;
    const is_blockly_listener_registered = React.useRef(false);
    const is_blockly_delete_listener_registered = React.useRef(false);
    const { isDesktop } = useDevice();
    const { onMount, onUnmount } = app;
    const el_ref = React.useRef<HTMLInputElement | null>(null);

    const [importError, setImportError] = React.useState('');
    const [pendingVersion, setPendingVersion] = React.useState(0);
    React.useEffect(() => {
        const changed = () => setPendingVersion(value => value + 1);
        window.addEventListener('neto-pending-bot', changed);
        return () => window.removeEventListener('neto-pending-bot', changed);
    }, []);
    const importing = React.useRef(false);
    React.useEffect(() => {
        const workspace = window.Blockly?.derivWorkspace;
        const pending = sessionStorage.getItem('neto.pendingBot');
        if (!pending || active_tab !== DBOT_TABS.BOT_BUILDER || is_loading || !workspace || importing.current) return;
        importing.current = true;
        setImportError('');
        (async () => {
            try {
                const bot = JSON.parse(pending);
                if (typeof bot.fileName !== 'string' || typeof bot.name !== 'string' || bot.fileName.includes('/'))
                    throw new Error('Invalid bot selection.');
                const automatic = Number.isSafeInteger(bot.autoGeneration);
                if (automatic && !xmlScannerCycle.valid(bot.autoGeneration)) return;
                const response = await fetch(`/api/bots/load?file=${encodeURIComponent(bot.fileName)}`, {
                    credentials: 'same-origin',
                    cache: 'no-store',
                });
                if (response.status === 401) throw new Error('Log in with Deriv before loading a NetoAcademy bot.');
                if (!response.ok) throw new Error('This bot could not be loaded. Please choose another bot.');
                const content = await response.text();
                if (
                    content.length > 2_000_000 ||
                    new DOMParser().parseFromString(content, 'text/xml').querySelector('parsererror')
                )
                    throw new Error('This bot does not contain valid XML.');
                if (automatic && !xmlScannerCycle.valid(bot.autoGeneration)) return;
                const configuredContent = hostedBotLivePrediction(
                    automatic
                        ? hostedBotForAuto(content, bot.symbol, bot.submarket, xmlScannerCycle.getSnapshot().settings)
                        : hostedBotMarket(content, bot.symbol, bot.submarket)
                );
                const result = await load({
                    block_string: configuredContent,
                    file_name: bot.name,
                    workspace,
                    from: save_types.LOCAL,
                    drop_event: null,
                    strategy_id: null,
                    showIncompatibleStrategyDialog: null,
                });
                if (result?.error) throw new Error(result.error);
                if (automatic && !xmlScannerCycle.valid(bot.autoGeneration)) return;
                const hostedSide =
                    bot.fileName === 'over-punisher.xml'
                        ? 'over'
                        : bot.fileName === 'under-punisher.xml'
                          ? 'under'
                          : undefined;
                const monitorSide =
                    bot.scannerSide === 'over' || bot.scannerSide === 'under' ? bot.scannerSide : hostedSide;
                const monitorSymbol =
                    bot.symbol ||
                    workspace
                        .getAllBlocks()
                        .find(block => block.type === 'trade_definition_market')
                        ?.getFieldValue('SYMBOL_LIST');
                setScannerWatch(
                    monitorSide && typeof monitorSymbol === 'string' && /^(R_\d+|1HZ\d+V)$/.test(monitorSymbol)
                        ? {
                              symbol: monitorSymbol,
                              side: monitorSide,
                              sampleSize: [100, 500, 1000].includes(bot.sampleSize) ? bot.sampleSize : 1000,
                              name: bot.name,
                              automatic: automatic || bot.scannerSide === 'over' || bot.scannerSide === 'under',
                              baselineCounts:
                                  Array.isArray(bot.baselineCounts) &&
                                  bot.baselineCounts.length === 10 &&
                                  bot.baselineCounts.every(
                                      (count: number) =>
                                          Number.isInteger(count) && count >= 0 && count <= bot.sampleSize
                                  )
                                      ? bot.baselineCounts
                                      : undefined,
                          }
                        : null
                );
                sessionStorage.removeItem('neto.pendingBot');
                if (
                    automatic &&
                    !(await waitForHostedBotReady(workspace, bot.symbol, () =>
                        xmlScannerCycle.valid(bot.autoGeneration)
                    ))
                )
                    return;
                if (automatic && xmlScannerCycle.loaded(bot.autoGeneration, hostedBotLimits(configuredContent))) {
                    const launch = await run_panel.onRunButtonClick(true);
                    if (xmlScannerCycle.valid(bot.autoGeneration) && !launch?.started)
                        xmlScannerCycle.stop(
                            launch?.reason || 'The XML launch was not accepted. Check the Builder journal.'
                        );
                }
            } catch (reason) {
                xmlScannerCycle.stop(reason instanceof Error ? reason.message : 'Unable to import this bot.');
                setImportError(reason instanceof Error ? reason.message : 'Unable to import this bot.');
                sessionStorage.removeItem('neto.pendingBot');
            } finally {
                if (sessionStorage.getItem('neto.pendingBot') === pending) sessionStorage.removeItem('neto.pendingBot');
                importing.current = false;
            }
        })();
    }, [is_loading, active_tab, run_panel, pendingVersion]);

    // TODO: fix
    // const isMounted = useIsMounted();
    // const { data: remote_config_data } = useRemoteConfig(isMounted());
    let deleted_block_id: null | string = null;

    React.useEffect(() => {
        onMount();
        return () => onUnmount();
    }, [onMount, onUnmount]);

    React.useEffect(() => {
        const workspace = window.Blockly?.derivWorkspace;
        if (workspace && is_running && !is_blockly_listener_registered.current) {
            is_blockly_listener_registered.current = true;
            workspace.addChangeListener(handleBlockChangeOnBotRun);
        } else {
            removeBlockChangeListener();
        }

        return () => {
            if (workspace && is_blockly_listener_registered.current) {
                removeBlockChangeListener();
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [is_running]);

    const handleBlockChangeOnBotRun = (e: Event) => {
        const { is_reset_button_clicked } = toolbar;
        if (e.type !== 'selected' && !is_reset_button_clicked) {
            botNotification(notification_message().workspace_change);
            removeBlockChangeListener();
        } else if (is_reset_button_clicked) {
            removeBlockChangeListener();
        }
    };

    const removeBlockChangeListener = () => {
        is_blockly_listener_registered.current = false;
        window.Blockly?.derivWorkspace?.removeChangeListener(handleBlockChangeOnBotRun);
    };
    React.useEffect(() => {
        const workspace = window.Blockly?.derivWorkspace;
        if (workspace && !is_blockly_delete_listener_registered.current) {
            is_blockly_delete_listener_registered.current = true;
            workspace.addChangeListener(handleBlockDelete);
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [is_loading]);

    const handleBlockDelete = (e: TBlocklyEvents) => {
        const { is_reset_button_clicked, setResetButtonState } = toolbar;
        if (e.type === 'undo') {
            deleted_block_id = null;
            return;
        }
        if (e.type === 'delete' && !is_reset_button_clicked) {
            deleted_block_id = e.blockId;
        }
        if (e.type === 'selected' && deleted_block_id === e.oldElementId) {
            handleBlockDeleteNotification();
            deleted_block_id = null;
        }
        if (
            e.type === 'change' &&
            e.name === 'AMOUNT_LIMITS' &&
            e.newValue === '(min: 0.35 - max: 50000)' &&
            is_reset_button_clicked
        ) {
            setResetButtonState(false);
        }
    };

    const handleBlockDeleteNotification = () => {
        botNotification(notification_message().block_delete, {
            label: localize('Undo'),
            onClick: closeToast => {
                window.Blockly.derivWorkspace.undo();
                closeToast?.();
            },
        });
    };

    return (
        <>
            {importError && <p role='alert'>{importError}</p>}
            <div
                className={classNames('bot-builder', {
                    'bot-builder--active': active_tab === 1 && !is_preview_on_popup,
                    'bot-builder--inactive': is_preview_on_popup,
                    'bot-builder--tour-active': active_tour,
                })}
            >
                <div id='scratch_div' ref={el_ref}>
                    <WorkspaceWrapper />
                </div>
            </div>
            {active_tab === 1 && <BotBuilderTourHandler is_mobile={!isDesktop} />}
            {/* removed this outside from toolbar becuase it needs to loaded seperately without dependency */}
            <LoadModal />
            <SaveModal />
            {is_open && <QuickStrategy1 />}
        </>
    );
});

export default BotBuilder;
