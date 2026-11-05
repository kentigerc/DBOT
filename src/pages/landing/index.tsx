import { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { getDerivSession, refreshDerivSession, startDerivLogin } from '@/utils/deriv-session';
import { affiliate_signup_url } from '@/utils/site-config';
import UsageTracker from '@/components/usage-tracker';
import './landing.scss';
const PLATFORM = '/platform#bot_builder';
const tools = [
    {
        n: '01',
        title: 'Build your own approach.',
        tag: 'BOT BUILDER',
        text: 'Turn your trading ideas into visual blocks. Load a bot, adjust its settings, or bring your own XML strategy.',
        href: PLATFORM,
        icon: 'blocks',
    },
    {
        n: '02',
        title: 'See the market differently.',
        tag: 'DIGIT ANALYSIS',
        text: 'Explore live digit distributions and market conditions in a dedicated analysis workspace.',
        href: '/platform#digit_analysis',
        icon: 'digits',
    },
    {
        n: '03',
        title: 'Keep the bigger picture.',
        tag: 'CHARTS & TOOLS',
        text: 'Move between charts, indicators and your trading workspace without losing your place.',
        href: '/platform#deriv_charts',
        icon: 'chart',
    },
];
function Arrow({ diagonal = false }: { diagonal?: boolean }) {
    return (
        <svg
            aria-hidden='true'
            width='18'
            height='18'
            viewBox='0 0 24 24'
            fill='none'
            style={{ flexShrink: 0, verticalAlign: 'middle' }}
        >
            <path
                d={diagonal ? 'M6 18 18 6M6 6h12v12' : 'M4 12h16m-6-6 6 6-6 6'}
                stroke='currentColor'
                strokeWidth='1.5'
                strokeLinecap='round'
                strokeLinejoin='round'
            />
        </svg>
    );
}
export default function Landing() {
    const location = useLocation();
    const [session, setSession] = useState(getDerivSession());
    const [error, setError] = useState('');
    useEffect(() => {
        const oldTitle = document.title;
        document.body.classList.add('neto-landing-page');
        document.title = 'NetoAcademy — Your Deriv trading workspace';
        const update = () => setSession(getDerivSession());
        window.addEventListener('neto-session', update);
        refreshDerivSession().catch(() => {});
        return () => {
            document.title = oldTitle;
            document.body.classList.remove('neto-landing-page');
            window.removeEventListener('neto-session', update);
        };
    }, []);
    const legacy = [
        'dashboard',
        'bot_builder',
        'chart',
        'digit_analysis',
        'deriv_charts',
        'free_bots',
        'analysis_tool',
    ];
    if (legacy.includes(location.hash.slice(1))) return <Navigate replace to={`/platform${location.hash}`} />;
    return (
        <div className='neto-landing'>
            <UsageTracker />
            <a className='nl-skip' href='#nl-main'>
                Skip to content
            </a>
            <header className='nl-nav'>
                <a className='nl-brand' href='/' aria-label='NetoAcademy home'>
                    <span className='nl-brand__mark' aria-hidden='true'>
                        N<span>.</span>
                    </span>
                    <span>NetoAcademy</span>
                </a>
                <nav aria-label='Landing page navigation'>
                    <a href='#toolkit'>The toolkit</a>
                    <a href='#how-it-works'>How it works</a>
                    <a href='#questions'>Questions</a>
                </nav>
                <div className='nl-nav__actions'>
                    {session.authenticated ? (
                        <span className='nl-connected'>
                            <i /> Account connected
                        </span>
                    ) : (
                        <button
                            className='nl-login'
                            onClick={() => {
                                setError('');
                                try {
                                    startDerivLogin();
                                } catch {
                                    setError('Login could not open. Please try again.');
                                }
                            }}
                        >
                            Log in with Deriv
                        </button>
                    )}
                    <a className='nl-nav__launch' href={PLATFORM}>
                        Open platform <Arrow diagonal />
                    </a>
                </div>
            </header>
            <main id='nl-main'>
                <section className='nl-hero'>
                    <div className='nl-hero__glow' aria-hidden='true' />
                    <div className='nl-hero__copy'>
                        <p className='nl-eyebrow'>
                            <span /> YOUR NEXT TRADING CHAPTER
                        </p>
                        <h1>
                            A clearer way
                            <br />
                            to trade.
                            <br />
                            <em>On your terms.</em>
                        </h1>
                        <p className='nl-hero__intro'>
                            Your Deriv account. Your strategies. One thoughtfully built workspace for bots, charts and
                            market analysis.
                        </p>
                        <div className='nl-hero__actions'>
                            <a className='nl-button nl-button--red' href={PLATFORM}>
                                {session.authenticated ? 'Enter your workspace' : 'Launch trading platform'}{' '}
                                <Arrow diagonal />
                            </a>
                            <a className='nl-text-link' href='#toolkit'>
                                Explore the toolkit <Arrow />
                            </a>
                        </div>
                        <div className='nl-hero__foot'>
                            <span className='nl-provider'>
                                Built for <img src='/deriv-logo.svg' width='18' height='18' alt='' /> <b>Deriv</b>
                            </span>
                            <span>Start with a demo. Trade with a plan.</span>
                        </div>
                        {error && <p role='alert'>{error}</p>}
                    </div>
                    <div className='nl-preview' aria-label='Illustrative NetoAcademy workspace preview'>
                        <div className='nl-preview__top'>
                            <span>
                                <i />
                                <i />
                                <i />
                            </span>
                            <p>netoacademy / workspace</p>
                            <b>DEMO</b>
                        </div>
                        <div className='nl-preview__body'>
                            <div className='nl-preview__sidebar' aria-hidden='true'>
                                <strong>
                                    N<span>.</span>
                                </strong>
                                <i>⌘</i>
                                <i className='is-active'>▥</i>
                                <i>⌁</i>
                                <i>⋮</i>
                            </div>
                            <div className='nl-preview__main'>
                                <div className='nl-preview__heading'>
                                    <div>
                                        <small>YOUR WORKSPACE</small>
                                        <h2>
                                            Make room for
                                            <br />
                                            your next move.
                                        </h2>
                                    </div>
                                    <span className='nl-preview__demo'>Demo account</span>
                                </div>
                                <div className='nl-preview__chart'>
                                    <div className='nl-preview__chart-label'>
                                        <span>Market view</span>
                                        <span>Illustrative chart</span>
                                    </div>
                                    <svg
                                        viewBox='0 0 520 190'
                                        role='img'
                                        aria-label='Decorative market chart, not live prices'
                                    >
                                        <defs>
                                            <linearGradient id='nl-chart-fill' x1='0' y1='0' x2='0' y2='1'>
                                                <stop offset='0%' stopColor='#ff514e' stopOpacity='.25' />
                                                <stop offset='100%' stopColor='#ff514e' stopOpacity='0' />
                                            </linearGradient>
                                        </defs>
                                        {[40, 90, 140].map(y => (
                                            <path key={y} d={`M0 ${y}H520`} stroke='#ffffff10' />
                                        ))}
                                        <path
                                            d='M0 153 24 143 45 154 66 126 87 136 107 108 131 121 152 91 175 106 196 83 218 96 240 64 261 78 284 60 305 88 328 67 350 79 372 48 394 61 415 34 436 50 457 27 480 43 502 18 520 29V190H0Z'
                                            fill='url(#nl-chart-fill)'
                                        />
                                        <path
                                            d='M0 153 24 143 45 154 66 126 87 136 107 108 131 121 152 91 175 106 196 83 218 96 240 64 261 78 284 60 305 88 328 67 350 79 372 48 394 61 415 34 436 50 457 27 480 43 502 18 520 29'
                                            fill='none'
                                            stroke='#ff655e'
                                            strokeWidth='2.5'
                                            strokeLinejoin='round'
                                        />
                                        <circle cx='502' cy='18' r='4' fill='#ffb29f' />
                                    </svg>
                                    <div className='nl-preview__axis'>
                                        <span>Analyse</span>
                                        <span>Plan</span>
                                        <span>Execute</span>
                                    </div>
                                </div>
                                <div className='nl-preview__digits'>
                                    <div>
                                        <small>DIGIT WORKSPACE</small>
                                        <span>A different perspective.</span>
                                    </div>
                                    <div aria-hidden='true'>
                                        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => (
                                            <i key={d} className={d === 7 ? 'is-highlight' : ''}>
                                                {d}
                                            </i>
                                        ))}
                                    </div>
                                </div>
                                <div className='nl-preview__bottom'>
                                    <span>
                                        <i /> Your strategy, in focus
                                    </span>
                                    <b>
                                        Explore the platform <Arrow />
                                    </b>
                                </div>
                            </div>
                        </div>
                        <div className='nl-preview__caption'>WORKSPACE PREVIEW · ILLUSTRATIVE DATA</div>
                        <div className='nl-preview__float'>
                            <span aria-hidden='true'>⌘</span>
                            <div>
                                <b>Built around your process.</b>
                                <small>Bots. Analysis. Perspective.</small>
                            </div>
                        </div>
                    </div>
                    <div className='nl-hero__index' aria-hidden='true'>
                        <span>01 — WELCOME TO NETOACADEMY</span>
                        <span>SCROLL TO DISCOVER ↓</span>
                    </div>
                </section>
                <div className='nl-strip'>
                    <span>LESS FRICTION. MORE FOCUS.</span>
                    <p>
                        Visual bot building <i /> Live market analysis <i /> Integrated charts <i /> Your Deriv account
                    </p>
                </div>
                <section className='nl-toolkit nl-section' id='toolkit'>
                    <div className='nl-section__heading'>
                        <p className='nl-eyebrow'>THE TOOLKIT</p>
                        <h2>
                            Everything in its place.
                            <br />
                            <span>You in control.</span>
                        </h2>
                        <p>Move from an idea to a trading setup with tools that belong together.</p>
                    </div>
                    <div className='nl-toolkit__grid'>
                        {tools.map(tool => (
                            <a className={`nl-tool-card nl-tool-card--${tool.icon}`} href={tool.href} key={tool.n}>
                                <div className='nl-tool-card__top'>
                                    <span>{tool.n} /</span>
                                    <Arrow diagonal />
                                </div>
                                <div className='nl-tool-card__art' aria-hidden='true'>
                                    {tool.icon === 'blocks' ? (
                                        <div className='nl-blocks'>
                                            <span>SET YOUR PARAMETERS</span>
                                            <span>DEFINE YOUR APPROACH</span>
                                            <span>
                                                RUN WITH YOUR LIMITS <i>↗</i>
                                            </span>
                                        </div>
                                    ) : tool.icon === 'digits' ? (
                                        <div className='nl-digit-art'>
                                            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => (
                                                <span key={d}>{d}</span>
                                            ))}
                                        </div>
                                    ) : (
                                        <svg viewBox='0 0 260 110'>
                                            <path
                                                d='M0 90 30 72 47 80 68 48 93 63 115 41 136 54 162 26 182 39 209 14 231 30 260 8'
                                                fill='none'
                                                stroke='currentColor'
                                                strokeWidth='2'
                                            />
                                            {[25, 65, 105, 145, 185, 225].map((x, i) => (
                                                <g key={x}>
                                                    <path
                                                        d={`M${x} ${20 + (i % 3) * 12}V${80 + (i % 2) * 8}`}
                                                        stroke='#6b7773'
                                                    />
                                                    <rect
                                                        x={x - 5}
                                                        y={38 + (i % 3) * 12}
                                                        width='10'
                                                        height='22'
                                                        fill={i % 2 ? '#537e6b' : '#d68164'}
                                                    />
                                                </g>
                                            ))}
                                        </svg>
                                    )}
                                </div>
                                <p className='nl-eyebrow'>{tool.tag}</p>
                                <h3>{tool.title}</h3>
                                <p>{tool.text}</p>
                                <span className='nl-tool-card__link'>
                                    Explore tool <Arrow />
                                </span>
                            </a>
                        ))}
                    </div>
                </section>
                <section className='nl-start nl-section' id='how-it-works'>
                    <div>
                        <p className='nl-eyebrow'>A SIMPLE WAY IN</p>
                        <h2>
                            Bring your account.
                            <br />
                            <span>Find your flow.</span>
                        </h2>
                        <p>
                            You don’t need a new trading identity. Connect your existing Deriv account and explore a
                            workspace built around it.
                        </p>
                        <a className='nl-text-link' href={PLATFORM}>
                            Find your starting point <Arrow diagonal />
                        </a>
                    </div>
                    <ol>
                        {[
                            [
                                'Open your workspace',
                                'Enter the platform and take a look around. Start with the tools that fit your process.',
                            ],
                            [
                                'Connect with Deriv',
                                'Use Deriv’s authorisation screen to connect your account. NetoAcademy never asks for your Deriv password.',
                            ],
                            [
                                'Test before you trade',
                                'Use a demo account, choose your settings and set your risk limits before starting a strategy.',
                            ],
                        ].map(([title, text], i) => (
                            <li key={title}>
                                <span>0{i + 1}</span>
                                <div>
                                    <h3>{title}</h3>
                                    <p>{text}</p>
                                </div>
                            </li>
                        ))}
                    </ol>
                </section>
                <section className='nl-principle nl-section'>
                    <div className='nl-principle__symbol' aria-hidden='true'>
                        N<span>.</span>
                    </div>
                    <div>
                        <p className='nl-eyebrow'>BUILT FOR INTENTION</p>
                        <h2>
                            A strategy is a plan.
                            <br />
                            Not a promise.
                        </h2>
                        <p>
                            Good tools help you see more clearly. They don’t remove risk. Past digit frequencies and
                            market patterns do not predict the next outcome, and automated strategies can lose money.
                        </p>
                        <a href={PLATFORM}>
                            Explore with a demo account <Arrow />
                        </a>
                    </div>
                </section>
                <section className='nl-faq nl-section' id='questions'>
                    <div>
                        <p className='nl-eyebrow'>BEFORE YOU BEGIN</p>
                        <h2>
                            A little clarity
                            <br />
                            <span>goes a long way.</span>
                        </h2>
                    </div>
                    <div>
                        {[
                            [
                                'Do I need a Deriv account?',
                                'You can explore the platform first. To run trades, connect an eligible Deriv account through Deriv’s authorisation flow. If you are new, you can create an account using the link below.',
                            ],
                            [
                                'Can I bring my own bot?',
                                'Yes. The visual Bot Builder supports compatible XML bots. You can also explore the bots available in the Trading Bots section.',
                            ],
                            [
                                'Can I practise before using real money?',
                                'Yes. Start with a Deriv demo account to explore tools and test settings. Demo performance does not guarantee results on a real account.',
                            ],
                            [
                                'Where are my funds held?',
                                'Your trading account is with Deriv. NetoAcademy is an independent third-party interface that connects to Deriv to provide its trading tools.',
                            ],
                            [
                                'How does NetoAcademy earn commission?',
                                'NetoAcademy may receive affiliate or application commission from eligible activity. Review the contract price and payout shown on the platform before trading.',
                            ],
                        ].map(([q, a]) => (
                            <details key={q}>
                                <summary>
                                    {q}
                                    <span aria-hidden='true'>+</span>
                                </summary>
                                <p>{a}</p>
                            </details>
                        ))}
                        <a
                            className='nl-faq__signup'
                            href={affiliate_signup_url}
                            target='_blank'
                            rel='noopener noreferrer'
                        >
                            New to Deriv? Create an account <Arrow diagonal />
                        </a>
                    </div>
                </section>
                <section className='nl-final nl-section'>
                    <p className='nl-eyebrow'>YOUR WORKSPACE IS WAITING</p>
                    <h2>
                        Make your
                        <br />
                        <em>next move.</em>
                    </h2>
                    <a className='nl-button' href={PLATFORM}>
                        Enter NetoAcademy <Arrow diagonal />
                    </a>
                    <span>Start with a demo. Keep your limits in sight.</span>
                </section>
            </main>
            <footer className='nl-footer'>
                <div>
                    <a className='nl-brand' href='/'>
                        NetoAcademy<span className='nl-brand__dot'>.</span>
                    </a>
                    <p>An independent workspace for your Deriv trading journey.</p>
                </div>
                <div className='nl-footer__links'>
                    <a href={PLATFORM}>Trading platform</a>
                    <a href='/free-bots'>Trading bots</a>
                    <a href='#questions'>Questions</a>
                    <a href='https://deriv.com' target='_blank' rel='noopener noreferrer'>
                        Deriv <Arrow diagonal />
                    </a>
                </div>
                <div className='nl-footer__legal'>
                    <p>
                        Trading involves risk. You can lose your stake. Only trade money you can afford to lose.
                        Availability depends on your country and Deriv account eligibility. For adults aged 18 and over.
                    </p>
                    <p>
                        NetoAcademy is an independent third-party platform and is not operated by Deriv. Deriv’s name
                        and logo belong to their respective owner.
                    </p>
                    <span>© {new Date().getFullYear()} NetoAcademy</span>
                </div>
            </footer>
        </div>
    );
}
