export type XmlAutoSettings = Readonly<{ stake: number; stopLoss: number; multiplier: number }>;
export const DEFAULT_XML_AUTO_SETTINGS: XmlAutoSettings = Object.freeze({ stake: 0.35, stopLoss: 100, multiplier: 2 });
export function validateXmlAutoSettings(settings: XmlAutoSettings): XmlAutoSettings {
    const { stake, stopLoss, multiplier } = settings;
    const money = (value: number) =>
        Number.isFinite(value) &&
        Number.isSafeInteger(Math.round(value * 100)) &&
        Math.abs(value * 100 - Math.round(value * 100)) < 1e-7;
    if (!money(stake) || stake < 0.35 || stake > 100)
        throw new Error('Stake must be between $0.35 and $100, with at most two decimal places.');
    if (!money(stopLoss) || stopLoss < stake)
        throw new Error('Session stop loss must be at least the stake, with at most two decimal places.');
    if (
        !Number.isFinite(multiplier) ||
        multiplier <= 1 ||
        !Number.isSafeInteger(Math.round(multiplier * 100)) ||
        Math.abs(multiplier * 100 - Math.round(multiplier * 100)) > 1e-7
    )
        throw new Error('Martingale multiplier must be greater than 1, with at most two decimal places.');
    return Object.freeze({ stake, stopLoss, multiplier });
}
