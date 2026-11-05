import { checkTradingBalance } from '../balance';
it.each([0, 0.34, -1])('rejects insufficient live balance %s', async balance => {
    const send = jest.fn().mockResolvedValue({ balance: { balance, currency: 'USD' } });
    await expect(checkTradingBalance(send, 'USD', 0.35)).rejects.toMatchObject({ code: 'InsufficientBalance' });
    expect(send).toHaveBeenCalledWith({ balance: 1 });
});
it.each([0.35, 100])('allows sufficient live balance %s', async balance => {
    await expect(
        checkTradingBalance(async () => ({ balance: { balance, currency: 'USD' } }), 'USD', 0.35)
    ).resolves.toBe(balance);
});
it.each([
    {},
    { balance: { balance: '100', currency: 'USD' } },
    { balance: { balance: NaN, currency: 'USD' } },
    { balance: { balance: 100, currency: 'EUR' } },
    { error: { code: 'Denied' } },
])('blocks trading when balance cannot be verified', async response => {
    await expect(checkTradingBalance(async () => response, 'USD', 0.35)).rejects.toMatchObject({
        code: 'BalanceUnavailable',
    });
});
it('blocks trading after a balance request fails', async () => {
    await expect(
        checkTradingBalance(
            async () => {
                throw new Error('Offline');
            },
            'USD',
            0.35
        )
    ).rejects.toMatchObject({ code: 'BalanceUnavailable' });
});
