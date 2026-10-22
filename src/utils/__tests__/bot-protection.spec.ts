import { HOSTED_BOT_MARKER, installBotProtection, isProtectedBotWorkspace, isProtectedBotXml } from '../bot-protection';
const dom = (text: string) => new DOMParser().parseFromString(text, 'application/xml').documentElement;
describe('hosted bot export provenance', () => {
    it('recognizes protected XML and serialized block metadata, while allowing personal bots', () => {
        expect(isProtectedBotXml('<xml><block type="purchase"/></xml>')).toBe(false);
        expect(isProtectedBotXml('<xml neto_protected="true"/>')).toBe(true);
        expect(isProtectedBotXml(`<xml><block><data>${HOSTED_BOT_MARKER}catalog.xml</data></block></xml>`)).toBe(true);
        expect(isProtectedBotXml('<xml><block><data>user-owned data</data></block></xml>')).toBe(false);
    });
    it('keeps copied protected blocks restricted in mixed workspaces', () => {
        expect(
            isProtectedBotWorkspace({
                getAllBlocks: () => [{ data: 'personal' }, { data: HOSTED_BOT_MARKER + 'copy' }],
            } as any)
        ).toBe(true);
        expect(isProtectedBotWorkspace({ getAllBlocks: () => [{ data: 'personal' }] } as any)).toBe(false);
    });
    it('retains protection after edits or serialization and clears it on an explicit personal replacement', () => {
        const workspace = { netoHostedBot: false, getAllBlocks: () => [] };
        const blockly = {
            Xml: {
                workspaceToDom: jest.fn<Element, [unknown?]>(() => dom('<xml/>')),
                clearWorkspaceAndLoadFromXml: jest.fn(),
            },
        };
        installBotProtection(blockly);
        installBotProtection(blockly);
        blockly.Xml.clearWorkspaceAndLoadFromXml(dom('<xml neto_protected="true"/>'), workspace);
        expect(isProtectedBotWorkspace(workspace as any)).toBe(true);
        expect(isProtectedBotXml(blockly.Xml.workspaceToDom(workspace))).toBe(true);
        blockly.Xml.clearWorkspaceAndLoadFromXml(dom('<xml><block type="personal"/></xml>'), workspace);
        expect(isProtectedBotWorkspace(workspace as any)).toBe(false);
        expect(isProtectedBotXml(blockly.Xml.workspaceToDom(workspace))).toBe(false);
    });
});
