import { DEFAULT_XML_AUTO_SETTINGS, validateXmlAutoSettings } from '../xml-auto-settings';
it('uses the current defaults and takes an immutable copy of session settings', () => {
    expect(DEFAULT_XML_AUTO_SETTINGS).toEqual({ stake: 0.35, stopLoss: 100, takeProfit: 10, multiplier: 2.1 });
    const draft = { stake: 1.25, stopLoss: 30, takeProfit: 10, multiplier: 3 };
    const settings = validateXmlAutoSettings(draft);
    draft.stake = 99;
    expect(settings.stake).toBe(1.25);
    expect(Object.isFrozen(settings)).toBe(true);
});
it.each([
    { stake: 0 },
    { stake: 0.34 },
    { stake: 101 },
    { stake: 0.355 },
    { stopLoss: 0.2 },
    { stopLoss: NaN },
    { takeProfit: 0 },
    { takeProfit: -1 },
    { takeProfit: NaN },
    { takeProfit: 0.001 },
    { multiplier: 1 },
    { multiplier: Infinity },
    { multiplier: 2.123 },
])('rejects invalid session settings %j', invalid => {
    expect(() => validateXmlAutoSettings({ ...DEFAULT_XML_AUTO_SETTINGS, ...invalid })).toThrow();
});
