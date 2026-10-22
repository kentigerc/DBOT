import { botNotification } from '@/components/bot-notification/bot-notification';
import { saveAs } from '@/external/bot-skeleton/scratch/shared';
jest.mock('file-saver', () => ({ saveAs: jest.fn() }));
const filesaver = jest.requireMock<{ saveAs: jest.Mock }>('file-saver');
jest.mock('@/components/bot-notification/bot-notification', () => ({ botNotification: jest.fn() }));
describe('hosted strategy downloads', () => {
    beforeEach(() => jest.clearAllMocks());
    it('refuses protected XML rather than writing an invalid file', () => {
        expect(saveAs({ data: '<xml neto_protected="true"/>', filename: 'hosted.xml', type: 'text/xml' })).toBe(false);
        expect(filesaver.saveAs).not.toHaveBeenCalled();
        expect(botNotification).toHaveBeenCalled();
    });
    it('allows personal XML and transaction history exports', () => {
        saveAs({ data: '<xml><block type="personal"/></xml>', filename: 'personal.xml', type: 'text/xml' });
        saveAs({ data: 'Market,Profit\nR_100,1', filename: 'transactions.csv', type: 'text/csv' });
        expect(filesaver.saveAs).toHaveBeenCalledTimes(2);
        expect(botNotification).not.toHaveBeenCalled();
    });
});
