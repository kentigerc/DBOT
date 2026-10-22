import { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { useNavigate } from 'react-router-dom';
import { DBOT_TABS } from '@/constants/bot-contents';
import useMarketPanelHeight from '@/hooks/useMarketPanelHeight';
import { useStore } from '@/hooks/useStore';
import { getDerivSession } from '@/utils/deriv-session';
import './free-bots.scss';

interface Bot {
    id: string;
    name: string;
    description: string;
    fileName: string;
    category: string;
    icon: string;
    unavailableReason?: string;
}

const BOTS: Bot[] = [
    {
        id: '12',
        name: 'Over Punisher',
        description: 'Automated trading bot by NetoAcademy.',
        fileName: 'over-punisher.xml',
        category: 'Over/Under',
        icon: '📈',
    },
    {
        id: '13',
        name: 'Over 1/Over 0',
        description: 'Automated Digit Over strategy for Volatility indices.',
        fileName: 'over-1-over-0.xml',
        category: 'Over/Under',
        icon: '📈',
    },
    {
        id: '14',
        name: 'Under Punisher',
        description: 'Automated trading bot by NetoAcademy.',
        fileName: 'under-punisher.xml',
        category: 'Over/Under',
        icon: '📉',
    },
];

const FreeBots = observer(() => {
    const panelRef = useMarketPanelHeight<HTMLDivElement>({ fitToContainer: true });
    const { dashboard, run_panel } = useStore();
    const navigate = useNavigate();
    const [error, setError] = useState('');
    const [loadingBotId, setLoadingBotId] = useState<string | null>(null);
    const [selectedCategory, setSelectedCategory] = useState<string>('All');

    const categories = ['All', ...Array.from(new Set(BOTS.map(bot => bot.category)))];

    const filteredBots = selectedCategory === 'All' ? BOTS : BOTS.filter(bot => bot.category === selectedCategory);

    const loadBot = async (bot: Bot) => {
        if (!getDerivSession().authenticated) {
            setError('Log in with Deriv to load a NetoAcademy bot.');
            return;
        }
        if (run_panel.is_running) {
            setError('Stop your running bot before loading another bot.');
            return;
        }
        try {
            setLoadingBotId(bot.id);

            setError('');
            // Load after the builder mounts and initializes its workspace.
            sessionStorage.setItem('neto.pendingBot', JSON.stringify({ fileName: bot.fileName, name: bot.name }));
            dashboard.setActiveTab(DBOT_TABS.BOT_BUILDER);
            navigate('/#bot_builder');
        } catch (error) {
            setError(error instanceof Error ? error.message : 'Unable to open this bot. Please try again.');
        } finally {
            setLoadingBotId(null);
        }
    };

    return (
        <div className='free-bots' ref={panelRef} tabIndex={0} aria-label='Available trading bots'>
            <div className='free-bots__header'>
                <h1 className='free-bots__title'>NetoAcademy Trading Bots</h1>
                <p className='free-bots__subtitle'>
                    Explore our collection of pre-built trading bots. Click on any bot to load it into the Bot Builder.
                </p>
            </div>

            {error && <p role='alert'>{error}</p>}
            <p className='free-bots__protection-note'>
                NetoAcademy bots are available to run here. Strategy downloads and exports are disabled.
            </p>
            <div className='free-bots__categories'>
                {categories.map(category => (
                    <button
                        key={category}
                        className={`free-bots__category-btn ${selectedCategory === category ? 'free-bots__category-btn--active' : ''}`}
                        onClick={() => setSelectedCategory(category)}
                    >
                        {category}
                    </button>
                ))}
            </div>

            <div className='free-bots__grid'>
                {filteredBots.map(bot => (
                    <div key={bot.id} className='free-bots__card'>
                        <div className='free-bots__card-header'>
                            <span className='free-bots__card-icon'>{bot.icon}</span>
                            <span className='free-bots__card-category'>{bot.category}</span>
                        </div>
                        <h3 className='free-bots__card-title'>{bot.name}</h3>
                        <p className='free-bots__card-description'>{bot.description}</p>
                        {bot.unavailableReason && <p>{bot.unavailableReason}</p>}
                        <button
                            className='free-bots__card-btn'
                            onClick={() => loadBot(bot)}
                            disabled={loadingBotId === bot.id || !!bot.unavailableReason}
                        >
                            {loadingBotId === bot.id ? (
                                <span className='free-bots__card-btn-loading'>Loading...</span>
                            ) : (
                                <>
                                    <span>{bot.unavailableReason ? 'Needs compatible XML' : 'Load Bot'}</span>
                                    <svg
                                        width='16'
                                        height='16'
                                        viewBox='0 0 24 24'
                                        fill='none'
                                        stroke='currentColor'
                                        strokeWidth='2'
                                    >
                                        <path d='M5 12h14M12 5l7 7-7 7' />
                                    </svg>
                                </>
                            )}
                        </button>
                    </div>
                ))}
            </div>

            <div className='free-bots__footer'>
                <p>All bots are provided for educational purposes. Always test with demo accounts first.</p>
            </div>
        </div>
    );
});

export default FreeBots;
