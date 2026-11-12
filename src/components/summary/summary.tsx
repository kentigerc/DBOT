import classnames from 'classnames';
import { useSyncExternalStore } from 'react';
import DemoPauseStatus from '@/components/demo-pause-status';
import { builderDemoPause } from '@/utils/builder-demo-pause';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { useDevice } from '@deriv-com/ui';
import ThemedScrollbars from '../shared_ui/themed-scrollbars';
import SummaryCard from './summary-card';

type TSummary = {
    is_drawer_open: boolean;
};

const Summary = observer(({ is_drawer_open }: TSummary) => {
    const builderDemo = useSyncExternalStore(builderDemoPause.subscribe, builderDemoPause.getSnapshot);
    const { dashboard, summary_card } = useStore();
    const { is_contract_loading, contract_info, is_bot_running } = summary_card;
    const { active_tour } = dashboard;
    const { isDesktop } = useDevice();
    return (
        <div
            className={classnames({
                'run-panel-tab__content': isDesktop,
                'run-panel-tab__content--mobile': !isDesktop && is_drawer_open,
                'run-panel-tab__content--summary-tab': (isDesktop && is_drawer_open) || active_tour,
            })}
            data-testid='mock-summary'
        >
            <ThemedScrollbars
                className={classnames({
                    'summary--demo-pause': !!builderDemo.demoPause && builderDemo.demoPause.status !== 'done',
                    summary: (!is_contract_loading && !contract_info) || is_bot_running,
                    'summary--loading':
                        (!isDesktop && is_contract_loading) || (!isDesktop && !is_contract_loading && contract_info),
                })}
            >
                <DemoPauseStatus state={builderDemo.demoPause} />
                <SummaryCard
                    is_contract_loading={is_contract_loading}
                    contract_info={contract_info}
                    is_bot_running={is_bot_running}
                />
            </ThemedScrollbars>
        </div>
    );
});

export default Summary;
