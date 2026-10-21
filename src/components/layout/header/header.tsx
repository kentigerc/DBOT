import { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Link } from 'react-router-dom';
import { api_base } from '@/external/bot-skeleton';
import { useStore } from '@/hooks/useStore';
import { affiliate_signup_url } from '@/utils/site-config';
import { getDerivSession, logoutDerivSession, refreshDerivSession, startDerivLogin } from '@/utils/deriv-session';
import { AppLogo } from '../app-logo';
import './neto-header.scss';

const AppHeader = observer(() => {
    const { client } = useStore() ?? {};
    const [session, setSession] = useState(getDerivSession());
    const [error, setError] = useState('');
    useEffect(() => {
        const update = () => setSession(getDerivSession());
        window.addEventListener('neto-session', update);
        refreshDerivSession().catch(reason => setError(reason.message));
        return () => window.removeEventListener('neto-session', update);
    }, []);
    const accounts = session.accounts.filter(account => account.status === 'active');
    const activeAccount = accounts.find(account => account.account_id === localStorage.getItem('neto.account_id'));
    const balance = Number(client?.is_logged_in ? client.balance : activeAccount?.balance);
    const currency = activeAccount?.currency || '';
    const formattedBalance = Number.isFinite(balance)
        ? new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(balance)
        : '—';
    return (
        <header className='neto-header'>
            <AppLogo />
            <nav aria-label='Main navigation'>
                <Link to='/#bot_builder'>Bot Builder</Link>
                <Link to='/free-bots'>Trading Bots</Link>
            </nav>
            <div className='neto-header__account'>
                {session.authenticated ? (
                    <>
                        {accounts.length ? (
                            <div className='neto-header__trading-account'>
                                {activeAccount && (
                                    <div className='neto-header__account-summary' aria-live='polite'>
                                        <span
                                            className={`neto-header__account-type neto-header__account-type--${activeAccount.account_type}`}
                                        >
                                            {activeAccount.account_type === 'demo' ? 'Demo account' : 'Real account'}
                                        </span>
                                        <strong className='neto-header__balance'>
                                            {formattedBalance} {currency}
                                        </strong>
                                    </div>
                                )}
                                <label className='neto-header__account-switcher'>
                                    <span>Switch account</span>
                                    <select
                                        aria-label='Trading account'
                                        value={localStorage.getItem('neto.account_id') || ''}
                                        onChange={event => {
                                            if (api_base.is_running) {
                                                setError('Stop your bot before switching accounts.');
                                                return;
                                            }
                                            localStorage.setItem('neto.account_id', event.target.value);
                                            window.location.assign('/');
                                        }}
                                    >
                                        {(['demo', 'real'] as const).map(type => {
                                            const matching = accounts.filter(account => account.account_type === type);
                                            return matching.length ? (
                                                <optgroup
                                                    key={type}
                                                    label={type === 'demo' ? 'Demo accounts' : 'Real accounts'}
                                                >
                                                    {matching.map(account => (
                                                        <option key={account.account_id} value={account.account_id}>
                                                            {account.account_type === 'demo' ? 'Demo' : 'Real'} ·{' '}
                                                            {account.currency} · {account.account_id}
                                                        </option>
                                                    ))}
                                                </optgroup>
                                            ) : null;
                                        })}
                                    </select>
                                </label>
                            </div>
                        ) : (
                            <span>No active Options account. Create one in Deriv to trade.</span>
                        )}
                        <button
                            onClick={() => {
                                if (api_base.is_running) {
                                    setError('Stop your bot before logging out.');
                                    return;
                                }
                                logoutDerivSession().catch(reason => setError(reason.message));
                            }}
                        >
                            Log out
                        </button>
                    </>
                ) : (
                    <>
                        <button onClick={startDerivLogin}>Log in with Deriv</button>
                        <a
                            className='neto-header__signup'
                            href={affiliate_signup_url}
                            target='_blank'
                            rel='noopener noreferrer'
                        >
                            Create Deriv account
                        </a>
                    </>
                )}
            </div>
            {error && (
                <p role='alert' className='neto-header__error'>
                    {error}
                </p>
            )}
        </header>
    );
});
export default AppHeader;
