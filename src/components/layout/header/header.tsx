import { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Link } from 'react-router-dom';
import { CurrencyIcon } from '@/components/currency/currency-icon';
import { api_base } from '@/external/bot-skeleton';
import { useStore } from '@/hooks/useStore';
import { getDerivSession, logoutDerivSession, refreshDerivSession, startDerivLogin } from '@/utils/deriv-session';
import { affiliate_signup_url } from '@/utils/site-config';
import { AppLogo } from '../app-logo';
import './neto-header.scss';

const AppHeader = observer(() => {
    const { client } = useStore() ?? {};
    const [session, setSession] = useState(getDerivSession());
    const [error, setError] = useState('');
    const accountMenu = useRef<HTMLDetailsElement>(null);
    useEffect(() => {
        const close = (event: PointerEvent) => {
            if (accountMenu.current && !accountMenu.current.contains(event.target as Node))
                accountMenu.current.open = false;
        };
        const escape = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && accountMenu.current?.open) {
                accountMenu.current.open = false;
                accountMenu.current.querySelector('summary')?.focus();
            }
        };
        document.addEventListener('pointerdown', close);
        document.addEventListener('keydown', escape);
        return () => {
            document.removeEventListener('pointerdown', close);
            document.removeEventListener('keydown', escape);
        };
    }, []);
    useEffect(() => {
        const update = () => setSession(getDerivSession());
        window.addEventListener('neto-session', update);
        refreshDerivSession().catch(reason => setError(reason.message));
        return () => window.removeEventListener('neto-session', update);
    }, []);
    const accounts = session.accounts.filter(account => account.status === 'active');
    const activeAccount =
        accounts.find(account => account.account_id === localStorage.getItem('neto.account_id')) || accounts[0];
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
                    <details className='neto-header__account-menu' ref={accountMenu}>
                        <summary className='neto-header__account-trigger'>
                            <span
                                className='neto-header__currency-icon'
                                role='img'
                                aria-label={
                                    activeAccount?.account_type === 'demo' ? 'Demo account' : `${currency} account`
                                }
                            >
                                <CurrencyIcon currency={currency} isVirtual={activeAccount?.account_type === 'demo'} />
                            </span>
                            <span className='neto-header__account-caption'>
                                <strong className='neto-header__balance'>
                                    {formattedBalance} {currency}
                                </strong>
                                <span
                                    className={`neto-header__account-badge neto-header__account-badge--${activeAccount?.account_type || 'none'}`}
                                >
                                    {activeAccount
                                        ? activeAccount.account_type === 'demo'
                                            ? 'Demo'
                                            : 'Real'
                                        : 'No account'}
                                </span>
                            </span>
                            <span className='neto-header__chevron' aria-hidden='true' />
                        </summary>
                        <div className='neto-header__account-dropdown'>
                            <div className='neto-header__dropdown-title'>Your accounts</div>
                            {(['real', 'demo'] as const).map(type => {
                                const matching = accounts.filter(account => account.account_type === type);
                                return matching.length ? (
                                    <section
                                        className='neto-header__account-group'
                                        key={type}
                                        aria-label={`${type === 'demo' ? 'Demo' : 'Real'} accounts`}
                                    >
                                        <h2>{type === 'demo' ? 'Demo' : 'Real'} accounts</h2>
                                        {matching.map(account => {
                                            const selected = account.account_id === activeAccount?.account_id;
                                            return (
                                                <button
                                                    type='button'
                                                    className={`neto-header__account-option${selected ? ' neto-header__account-option--selected' : ''}`}
                                                    key={account.account_id}
                                                    aria-pressed={selected}
                                                    onClick={() => {
                                                        if (selected) {
                                                            if (accountMenu.current) accountMenu.current.open = false;
                                                            return;
                                                        }
                                                        if (api_base.is_running) {
                                                            setError('Stop your bot before switching accounts.');
                                                            return;
                                                        }
                                                        localStorage.setItem('neto.account_id', account.account_id);
                                                        window.location.assign('/');
                                                    }}
                                                >
                                                    <span className='neto-header__currency-icon' aria-hidden='true'>
                                                        <CurrencyIcon
                                                            currency={account.currency}
                                                            isVirtual={type === 'demo'}
                                                        />
                                                    </span>
                                                    <span className='neto-header__option-caption'>
                                                        <strong>
                                                            {account.currency} {type === 'demo' ? 'Demo' : 'Real'}
                                                        </strong>
                                                        <span>{account.account_id}</span>
                                                    </span>
                                                    {selected && (
                                                        <span
                                                            className='neto-header__selected-check'
                                                            aria-label='Selected'
                                                        >
                                                            ✓
                                                        </span>
                                                    )}
                                                </button>
                                            );
                                        })}
                                    </section>
                                ) : null;
                            })}
                            {!accounts.length && (
                                <p className='neto-header__empty-account'>
                                    No active Options account. Create one in Deriv to trade.
                                </p>
                            )}
                            <button
                                type='button'
                                className='neto-header__logout'
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
                        </div>
                    </details>
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
