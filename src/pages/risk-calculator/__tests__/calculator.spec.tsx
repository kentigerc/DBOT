import { fireEvent, render, screen } from '@testing-library/react';
import RiskCalculator from '..';
import { calculateRisk } from '../calculation';
jest.mock('@/hooks/useMarketPanelHeight', () => ({ __esModule: true, default: () => ({ current: null }) }));

it.each([
    ['100', 50],
    ['500', 250],
    ['1000', 500],
])('calculates the requested 0.5%% cycle budget for $%s', (balance, budgetCents) => {
    expect(calculateRisk(String(balance), '0.5')).toMatchObject({ budgetCents });
});
it('rounds a fractional cent down instead of exceeding the chosen percentage', () => {
    expect(calculateRisk('109.99', '0.5')).toMatchObject({
        balanceCents: 10999,
        budgetCents: 54,
        remainingCents: 10945,
    });
    expect(calculateRisk('0.35', '0.5')).toMatchObject({ budgetCents: 0, remainingCents: 35 });
    expect(calculateRisk('1000000000', '100')).toMatchObject({ budgetCents: 100000000000, remainingCents: 0 });
});
it.each([
    ['', '0.5'],
    ['-100', '0.5'],
    ['100', '0'],
    ['100', '101'],
    ['100.001', '0.5'],
    ['100', '0.005'],
    ['Infinity', '0.5'],
    ['1000000001', '0.5'],
])('rejects an invalid balance or percentage (%s / %s)', (balance, percentage) => {
    expect(calculateRisk(balance, percentage)).toHaveProperty('error');
});
it('updates the cycle budget immediately and provides the three balance examples', () => {
    render(<RiskCalculator />);
    const result = screen.getByLabelText('Risk budget per trading cycle');
    expect(result).toHaveTextContent('$0.50');
    fireEvent.change(screen.getByLabelText('Account balance (USD)'), { target: { value: '500' } });
    expect(result).toHaveTextContent('$2.50');
    fireEvent.click(screen.getByRole('button', { name: '1%' }));
    expect(result).toHaveTextContent('$5.00');
    fireEvent.click(screen.getByRole('button', { name: 'Use $1,000.00 balance at 0.5% risk' }));
    expect(result).toHaveTextContent('$5.00');
    expect(screen.getByLabelText('Risk per trading cycle (%)')).toHaveValue(0.5);
    expect(screen.getByText(/starting trade and every recovery loss/)).toBeTruthy();
    expect(screen.getByText(/does not change bot settings/)).toBeTruthy();
});
it('clears stale results on invalid input and flags budgets below the bot minimum', () => {
    render(<RiskCalculator />);
    fireEvent.change(screen.getByLabelText('Account balance (USD)'), { target: { value: '' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a balance');
    expect(screen.getByLabelText('Risk budget per trading cycle')).toHaveTextContent('—');
    fireEvent.change(screen.getByLabelText('Account balance (USD)'), { target: { value: '50' } });
    expect(screen.getByLabelText('Risk budget per trading cycle')).toHaveTextContent('$0.25');
    expect(screen.getByText(/below the \$0.35 minimum stake/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Risk per trading cycle (%)'), { target: { value: '-1' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a risk percentage');
});
