import { scannerExitGuard } from '@/utils/scanner-exit-guard';
import { NewApiTransport } from '../new-api-transport';
class FakeSocket extends EventTarget {
    readyState = 1;
    send = jest.fn();
    close = jest.fn();
    message(value: unknown) {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
    }
}
it('the wire gate blocks a fifth purchase after three prior losses and one recovery loss', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FakeSocket });
    const stop = jest.fn();
    scannerExitGuard.begin(stop);
    try {
        const transport = new NewApiTransport('ws://localhost', 'TEST', scannerExitGuard);
        for (let id = 1; id <= 4; id++) {
            if (id === 4) scannerExitGuard.trigger();
            transport.send(JSON.stringify({ buy: 'proposal', price: 0.35, req_id: id }));
            transport.socket.message({ req_id: id, buy: { contract_id: id } });
            transport.socket.message({ proposal_open_contract: { contract_id: id, is_sold: 1, profit: -0.35 } });
        }
        transport.send(JSON.stringify({ buy: 'proposal', price: 0.35, req_id: 5 }));
        expect(transport.socket.send).toHaveBeenCalledTimes(4);
        expect(scannerExitGuard.getSnapshot()).toMatchObject({ phase: 'stopped', losses: 4 });
        await Promise.resolve();
        expect(stop).toHaveBeenCalledTimes(1);
        transport.close();
    } finally {
        if (original) Object.defineProperty(globalThis, 'WebSocket', original);
        scannerExitGuard.begin(() => {});
        scannerExitGuard.cancel();
    }
});
