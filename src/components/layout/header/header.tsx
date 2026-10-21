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
                            <label>
                                Account{' '}
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
                                    {accounts.map(account => (
                                        <option key={account.account_id} value={account.account_id}>
                                            {account.account_type === 'demo' ? 'Demo' : 'Real'} · {account.currency} ·{' '}
                                            {account.account_id}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        ) : (
                            <span>No active Options account. Create one in Deriv to trade.</span>
                        )}
                        {client?.is_logged_in && (
                            <span>
                                {client.balance} {client.currency}
                            </span>
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
