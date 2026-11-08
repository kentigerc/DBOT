import { useState } from 'react';
import useMarketPanelHeight from '@/hooks/useMarketPanelHeight';
import { calculateRisk, dollars } from './calculation';
import './risk-calculator.scss';

const examples = [100, 500, 1000];
const presets = ['0.25', '0.5', '1', '2'];
export default function RiskCalculator({ active = true }: { active?: boolean }) {
    const panel = useMarketPanelHeight<HTMLElement>({ enabled: active });
    const [balance, setBalance] = useState('100');
    const [percentage, setPercentage] = useState('0.5');
    const result = calculateRisk(balance, percentage);
    const budget = 'error' in result ? undefined : result;
    const error = 'error' in result ? result.error : '';
    return (
        <section className='risk-calculator' ref={panel} aria-labelledby='risk-calculator-title' tabIndex={0}>
            <div className='risk-calculator__inner'>
                <header className='risk-calculator__heading'>
                    <div className='risk-calculator__icon' aria-hidden='true'>
                        <svg viewBox='0 0 32 32' fill='none'>
                            <path
                                d='M16 3 27 7v8c0 7-7 12-11 14C12 27 5 22 5 15V7l11-4Z'
                                stroke='currentColor'
                                strokeWidth='1.5'
                            />
                            <path
                                d='m11 16 3 3 7-7'
                                stroke='currentColor'
                                strokeWidth='2'
                                strokeLinecap='round'
                                strokeLinejoin='round'
                            />
                        </svg>
                    </div>
                    <div>
                        <p className='risk-calculator__eyebrow'>A PLAN BEFORE EVERY CYCLE</p>
                        <h1 id='risk-calculator-title'>Risk Calculator</h1>
                        <p>Give your next trading cycle a clear budget, based on your account balance.</p>
                    </div>
                    <span className='risk-calculator__default'>0.5% default</span>
                </header>

                <div className='risk-calculator__desk'>
                    <div className='risk-calculator__settings'>
                        <div className='risk-calculator__section-title'>
                            <span>01</span>
                            <h2>Set your budget</h2>
                        </div>
                        <label htmlFor='risk-balance'>Account balance (USD)</label>
                        <div className='risk-calculator__input'>
                            <span aria-hidden='true'>$</span>
                            <input
                                id='risk-balance'
                                type='number'
                                min='0.01'
                                max='1000000000'
                                step='0.01'
                                inputMode='decimal'
                                value={balance}
                                onChange={event => setBalance(event.target.value)}
                                aria-describedby={error ? 'risk-calculator-error' : undefined}
                            />
                        </div>
                        <label htmlFor='risk-percentage'>Risk per trading cycle (%)</label>
                        <div className='risk-calculator__input'>
                            <input
                                id='risk-percentage'
                                type='number'
                                min='0.01'
                                max='100'
                                step='0.01'
                                inputMode='decimal'
                                value={percentage}
                                onChange={event => setPercentage(event.target.value)}
                                aria-describedby={error ? 'risk-calculator-error' : 'risk-cycle-note'}
                            />
                            <span aria-hidden='true'>%</span>
                        </div>
                        <div className='risk-calculator__presets' role='group' aria-label='Risk percentage presets'>
                            {presets.map(value => (
                                <button
                                    key={value}
                                    type='button'
                                    aria-pressed={Number(percentage) === Number(value)}
                                    onClick={() => setPercentage(value)}
                                >
                                    {value}%
                                </button>
                            ))}
                        </div>
                        {error && (
                            <p id='risk-calculator-error' className='risk-calculator__error' role='alert'>
                                {error}
                            </p>
                        )}
                        <div className='risk-calculator__formula'>
                            <span>THE CALCULATION</span>
                            <p>Account balance × risk percentage ÷ 100</p>
                            <small>Results round down to the nearest cent.</small>
                        </div>
                    </div>

                    <div className='risk-calculator__result' aria-live='polite' aria-atomic='true'>
                        <div className='risk-calculator__result-heading'>
                            <span className='risk-calculator__eyebrow'>YOUR CYCLE BUDGET</span>
                            <span className='risk-calculator__live-dot' aria-hidden='true' />
                        </div>
                        <p>Planned maximum loss</p>
                        <output aria-label='Risk budget per trading cycle' className='risk-calculator__amount'>
                            {budget ? dollars(budget.budgetCents) : '—'}
                        </output>
                        <span className='risk-calculator__per-cycle'>for the entire trading cycle</span>
                        <div className='risk-calculator__allocation'>
                            <div>
                                <span>Allocated risk</span>
                                <strong>{budget ? `${budget.riskBasisPoints / 100}%` : '—'}</strong>
                            </div>
                            <div
                                className='risk-calculator__allocation-bar'
                                role='meter'
                                aria-label='Account balance allocated to risk'
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={budget ? budget.riskBasisPoints / 100 : 0}
                            >
                                <span style={{ width: `${budget ? budget.riskBasisPoints / 100 : 0}%` }} />
                            </div>
                        </div>
                        <div className='risk-calculator__remaining'>
                            <span>Balance after a full-budget loss</span>
                            <strong>{budget ? dollars(budget.remainingCents) : '—'}</strong>
                        </div>
                        {budget && budget.budgetCents < 35 && (
                            <p className='risk-calculator__minimum'>
                                This budget is below the $0.35 minimum stake used by NetoAcademy’s digit bots. A $0.35
                                trade would exceed your chosen cycle budget.
                            </p>
                        )}
                    </div>
                </div>

                <aside className='risk-calculator__cycle-note' id='risk-cycle-note'>
                    <span aria-hidden='true'>
                        <svg width='24' height='24' viewBox='0 0 24 24' fill='none'>
                            <path
                                d='M5 4v8a4 4 0 0 0 4 4h10m-4-4 4 4-4 4'
                                stroke='currentColor'
                                strokeWidth='1.5'
                                strokeLinecap='round'
                                strokeLinejoin='round'
                            />
                        </svg>
                    </span>
                    <div>
                        <h2>One budget. The whole cycle.</h2>
                        <p>
                            Include the starting trade and every recovery loss in this amount. It is not a separate
                            allowance for each recovery attempt.
                        </p>
                    </div>
                </aside>

                <div className='risk-calculator__examples'>
                    <div className='risk-calculator__section-title'>
                        <span>02</span>
                        <h2>Try an example at 0.5%</h2>
                    </div>
                    <div className='risk-calculator__example-grid'>
                        {examples.map(amount => (
                            <button
                                type='button'
                                key={amount}
                                aria-label={`Use ${dollars(amount * 100)} balance at 0.5% risk`}
                                aria-pressed={Number(balance) === amount && Number(percentage) === 0.5}
                                onClick={() => {
                                    setBalance(String(amount));
                                    setPercentage('0.5');
                                }}
                            >
                                <span>{dollars(amount * 100)} account</span>
                                <strong>{dollars(amount / 2)}</strong>
                                <span>
                                    risk per cycle{' '}
                                    <i aria-hidden='true'>
                                        <svg width='16' height='16' viewBox='0 0 24 24' fill='none'>
                                            <path
                                                d='M6 18 18 6M6 6h12v12'
                                                stroke='currentColor'
                                                strokeWidth='1.5'
                                                strokeLinecap='round'
                                                strokeLinejoin='round'
                                            />
                                        </svg>
                                    </i>
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
                <p className='risk-calculator__footnote'>
                    Planning only: this calculator does not change bot settings or enforce a loss limit. Set your bot’s
                    limits separately. Trading can result in losses.
                </p>
            </div>
        </section>
    );
}
