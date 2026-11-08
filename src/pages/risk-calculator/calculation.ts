export type RiskBudget = {
    balanceCents: number;
    riskBasisPoints: number;
    budgetCents: number;
    targetCents: number;
    remainingCents: number;
};

const decimal = /^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/;
export function calculateRisk(balance: string, percentage: string): RiskBudget | { error: string } {
    const amount = Number(balance);
    if (!decimal.test(balance) || !Number.isFinite(amount) || amount < 0.01 || amount > 1_000_000_000)
        return { error: 'Enter a balance from $0.01 to $1,000,000,000, using up to two decimal places.' };
    const percent = Number(percentage);
    if (!decimal.test(percentage) || !Number.isFinite(percent) || percent < 0.01 || percent > 100)
        return { error: 'Enter a risk percentage from 0.01% to 100%, using up to two decimal places.' };
    const balanceCents = Math.round(amount * 100);
    const riskBasisPoints = Math.round(percent * 100);
    // Both operands are integers. Round down so a cent never exceeds the chosen budget.
    const budgetCents = Math.floor((balanceCents * riskBasisPoints) / 10_000);
    // Calculate the 10× target before rounding to avoid amplifying a fractional-cent loss.
    const targetCents = Math.floor((balanceCents * riskBasisPoints) / 1_000);
    return { balanceCents, riskBasisPoints, budgetCents, targetCents, remainingCents: balanceCents - budgetCents };
}
export const dollars = (cents: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
